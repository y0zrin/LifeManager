//! 送信待ちの変更を、つながったときに順に GitHub へ送る。
//! 変更は、今の GitHub の内容と比べてから送る（オフラインのあいだに GitHub 側でも変わっていたら、まとめられるものはまとめ、
//! まとめられないものは上書きしないで知らせる）
use super::config;
use super::merge::{merge_set, merge_text, merge_value, normalize_newlines, same_set, Merge};
use super::store::{self, Changes, Conflict, Op};
use crate::github::client::{is_network_error, GitHubClient};
use crate::journal::generator;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use tauri::AppHandle;

/// 同時に 2 回送らないようにする
static SYNC_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Debug, Default, Serialize)]
pub struct SyncResult {
    /// 送れた件数
    pub sent: usize,
    /// まだ残っている件数
    pub pending: usize,
    /// つながらなかった（あとでもう一度送る）
    pub offline: bool,
    /// 送るのを止めた理由（トークンが無効など。直るまで送信待ちは残す）
    pub stopped: Option<String>,
    /// 仮の番号 → GitHub の番号
    pub mapping: HashMap<String, i64>,
}

/// 送れたときに、手元の写しに入れるものなど
#[derive(Default)]
struct Done {
    created: Option<(i64, i64)>,
    issue: Option<Value>,
    comment: Option<(i64, Value)>,
    conflicts: Vec<Conflict>,
    /// 手元の写しに入れるもの（キー → 内容）
    reads: Vec<(String, String)>,
    /// GitHub を実際に書き換えたときの Issue の番号（お知らせに使う）
    notify: Option<i64>,
}

enum Outcome {
    Done(Done),
    /// つながらない（送信待ちはそのまま）
    Offline,
    /// GitHub が受け付けない状態（トークンが無効・GitHub の不調など）。送信待ちはそのまま残して止める
    Stop(String),
    /// この変更は送れない（Issue が消されたなど）。送信待ちから外し、使う人に知らせる
    Failed(String),
}

fn status_of(error: &str) -> u16 {
    error.strip_prefix("HTTP ").and_then(|s| s.get(..3)).and_then(|s| s.parse().ok()).unwrap_or(0)
}

fn classify(error: String) -> Outcome {
    if is_network_error(&error) {
        return Outcome::Offline;
    }
    match status_of(&error) {
        // 409: 読んでから書くまでのあいだにファイルが変わった。次に送るときに読み直す
        401 | 403 | 409 | 429 => Outcome::Stop(error),
        // 422 の「sha がない」も、読んだ版がずれていただけ（次に送るときに読み直す）
        422 if error.contains("sha") => Outcome::Stop(error),
        s if s >= 500 => Outcome::Stop(error),
        _ => Outcome::Failed(error),
    }
}

fn parse(json: &str) -> Value {
    serde_json::from_str(json).unwrap_or(Value::Null)
}

fn names(issue: &Value, key: &str, field: &str) -> Vec<String> {
    issue[key]
        .as_array()
        .map(|xs| xs.iter().filter_map(|x| x[field].as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default()
}

/// Issue の項目がぶつかったときの記録。「自分の変更で上書き」なら force を比べずに送る
fn conflict(number: i64, remote: &Value, field: &str, values: (String, String, String), force: Changes) -> Conflict {
    let (local, remote_value, base) = values;
    Conflict {
        id: 0,
        number,
        title: remote["title"].as_str().unwrap_or("").to_string(),
        field: field.to_string(),
        local,
        remote: remote_value,
        base,
        message: String::new(),
        kind: String::new(),
        retry: Some(Op::UpdateIssue { number, changes: force, base: None, at: store::now(), notice: None }),
    }
}

/// 今の GitHub の内容と比べて、送る変更と、ぶつかったものを決める
fn decide(number: i64, remote: &Value, changes: &Changes, base: Option<&Changes>) -> (Changes, Vec<Conflict>) {
    let Some(base) = base else {
        // 「自分の変更で上書き」は比べずに送る
        return (changes.clone(), Vec::new());
    };
    let mut send = Changes::default();
    let mut conflicts = Vec::new();
    let text = |key: &str| remote[key].as_str().unwrap_or("").to_string();

    for (field, local, base_value, remote_value) in [
        ("title", &changes.title, &base.title, text("title")),
        ("state", &changes.state, &base.state, text("state")),
    ] {
        let Some(local) = local else { continue };
        let base_value = base_value.clone().unwrap_or_default();
        match merge_value(&base_value, local, &remote_value) {
            Merge::Keep => {}
            Merge::Send(v) => {
                if field == "title" {
                    send.title = Some(v);
                } else {
                    send.state = Some(v);
                }
            }
            Merge::Conflict => {
                let force = if field == "title" {
                    Changes { title: Some(local.clone()), ..Default::default() }
                } else {
                    Changes {
                        state: Some(local.clone()),
                        state_reason: changes.state_reason.clone(),
                        duplicate_issue_id: changes.duplicate_issue_id,
                        ..Default::default()
                    }
                };
                conflicts.push(conflict(number, remote, field, (local.clone(), remote_value, base_value), force));
            }
        }
    }

    // 閉じる理由は、状態を送るときだけ一緒に送る
    if send.state.is_some() {
        send.state_reason = changes.state_reason.clone();
        send.duplicate_issue_id = changes.duplicate_issue_id;
    }

    if let Some(local) = &changes.body {
        let remote_body = text("body");
        let base_body = base.body.clone().unwrap_or_default();
        match merge_text(&base_body, local, &remote_body) {
            Some(merged) if merged != normalize_newlines(&remote_body) => send.body = Some(merged),
            Some(_) => {}
            None => conflicts.push(conflict(
                number,
                remote,
                "body",
                (local.clone(), remote_body, base_body),
                Changes { body: Some(local.clone()), ..Default::default() },
            )),
        }
    }

    if let Some(local) = changes.milestone {
        let remote_value = remote["milestone"]["number"].as_u64().unwrap_or(0) as u32;
        let base_value = base.milestone.unwrap_or(0);
        match merge_value(&base_value, &local, &remote_value) {
            Merge::Keep => {}
            Merge::Send(v) => send.milestone = Some(v),
            Merge::Conflict => conflicts.push(conflict(
                number,
                remote,
                "milestone",
                (local.to_string(), remote_value.to_string(), base_value.to_string()),
                Changes { milestone: Some(local), ..Default::default() },
            )),
        }
    }

    // ラベル・担当者は、足したもの・外したものだけを当てる（ぶつからない）
    if let Some(local) = &changes.labels {
        let remote_names = names(remote, "labels", "name");
        let merged = merge_set(base.labels.as_deref().unwrap_or(&[]), local, &remote_names);
        if !same_set(&merged, &remote_names) {
            send.labels = Some(merged);
        }
    }
    if let Some(local) = &changes.assignees {
        let remote_logins = names(remote, "assignees", "login");
        let merged = merge_set(base.assignees.as_deref().unwrap_or(&[]), local, &remote_logins);
        if !same_set(&merged, &remote_logins) {
            send.assignees = Some(merged);
        }
    }
    (send, conflicts)
}

/// 設定ファイルの一部を書き換える。GitHub 側でも変えられていたら、リマインダーは両方の足し引きをまとめ、ほかは知らせる
async fn send_config(client: &GitHubClient, owner: &str, repo: &str, key: &str, json: &str, base: Option<&str>) -> Outcome {
    let kind = match config::kind(key) {
        Ok(kind) => kind,
        Err(e) => return Outcome::Failed(e),
    };
    let (content, sha) = match client.get_contents(owner, repo, kind.path).await {
        Ok((content, sha)) => (Some(content), Some(sha)),
        Err(e) if status_of(&e) == 404 => (None, None),
        Err(e) => return classify(e),
    };
    let remote_part = match config::read_part(kind, content.as_deref()) {
        Ok(part) => part,
        Err(e) => return Outcome::Failed(e),
    };
    let read_key = format!("config:{}", key);
    let mut json = json.to_string();
    if let Some(base) = base.filter(|base| !config::same_json(&remote_part, base)) {
        if key == "reminders" {
            match config::merge_lists(base, &json, &remote_part) {
                Some(merged) => json = merged,
                None => return Outcome::Failed("リマインダーの一覧を読めませんでした".into()),
            }
        } else if !config::same_json(&remote_part, &json) {
            let conflict = Conflict {
                id: 0,
                number: 0,
                title: kind.label.to_string(),
                field: "config".into(),
                local: json.clone(),
                remote: remote_part.clone(),
                base: base.to_string(),
                message: String::new(),
                kind: key.to_string(),
                retry: Some(Op::SaveConfig { kind: key.to_string(), json: json.clone(), base: None, at: store::now() }),
            };
            return Outcome::Done(Done { conflicts: vec![conflict], reads: vec![(read_key, remote_part)], ..Default::default() });
        }
    }
    let yaml = match config::write_part(kind, content.as_deref(), &json) {
        Ok(yaml) => yaml,
        Err(e) => return Outcome::Failed(e),
    };
    // 書いたあとの内容（画面とやりとりする形）
    let written = config::read_part(kind, Some(&yaml)).unwrap_or(json);
    if config::same_json(&written, &remote_part) {
        return Outcome::Done(Done { reads: vec![(read_key, remote_part)], ..Default::default() });
    }
    match client.put_contents(owner, repo, kind.path, &yaml, kind.commit, sha).await {
        Ok(_) => Outcome::Done(Done { reads: vec![(read_key, written)], ..Default::default() }),
        Err(e) => classify(e),
    }
}

/// 日誌のノートを書き換える。GitHub 側でもノートが変えられていたら、行ごとにまとめ、まとめられなければ知らせる
async fn send_journal_notes(client: &GitHubClient, owner: &str, repo: &str, date: &str, notes: &str, base: Option<&str>) -> Outcome {
    let remote_md = match client.get_contents(owner, repo, &format!("journal/{}.md", date)).await {
        Ok((content, _)) => content,
        Err(e) if status_of(&e) == 404 => return Outcome::Failed(format!("{}の日誌が GitHub にありません", date)),
        Err(e) => return classify(e),
    };
    let read_key = format!("journal:{}", date);
    let remote_notes = generator::notes_of(&remote_md);
    let mut notes = notes.trim().to_string();
    if notes == remote_notes {
        return Outcome::Done(Done { reads: vec![(read_key, remote_md)], ..Default::default() });
    }
    if let Some(base) = base.filter(|base| base.trim() != remote_notes) {
        match merge_text(base.trim(), &notes, &remote_notes) {
            Some(merged) => notes = merged,
            None => {
                let conflict = Conflict {
                    id: 0,
                    number: 0,
                    title: format!("{} の日誌", date),
                    field: "journal".into(),
                    local: notes.clone(),
                    remote: remote_notes,
                    base: base.trim().to_string(),
                    message: String::new(),
                    kind: date.to_string(),
                    retry: Some(Op::SaveJournalNotes { date: date.to_string(), notes, base: None, at: store::now() }),
                };
                return Outcome::Done(Done { conflicts: vec![conflict], reads: vec![(read_key, remote_md)], ..Default::default() });
            }
        }
    }
    match generator::save_journal_notes(client, owner, repo, date, &notes).await {
        Ok(md) => Outcome::Done(Done { reads: vec![(read_key, md)], ..Default::default() }),
        Err(e) => classify(e),
    }
}

async fn send(client: &GitHubClient, owner: &str, repo: &str, op: &Op) -> Outcome {
    match op {
        Op::CreateIssue { temp, title, body, labels, milestone, assignees, .. } => {
            match client.create_issue(owner, repo, title, body, labels.clone(), *milestone, assignees.clone()).await {
                Ok(json) => {
                    let issue = parse(&json);
                    let real = issue["number"].as_i64().unwrap_or(0);
                    Outcome::Done(Done { created: Some((*temp, real)), issue: Some(issue), notify: Some(real), ..Default::default() })
                }
                Err(e) => classify(e),
            }
        }
        Op::UpdateIssue { number, changes, base, .. } => {
            if *number < 0 {
                return Outcome::Failed("GitHub に作れなかった Issue への変更です".into());
            }
            let n = *number as u32;
            let remote = match client.get_issue(owner, repo, n).await {
                Ok(json) => parse(&json),
                Err(e) => return classify(e),
            };
            let (to_send, conflicts) = decide(*number, &remote, changes, base.as_ref());
            if to_send.is_empty() {
                return Outcome::Done(Done { issue: Some(remote), conflicts, ..Default::default() });
            }
            let Changes { title, body, state, labels, milestone, assignees, state_reason, duplicate_issue_id } = to_send;
            match client.update_issue(owner, repo, n, title, body, state, labels, milestone, assignees, state_reason, duplicate_issue_id).await {
                Ok(json) => Outcome::Done(Done { issue: Some(parse(&json)), conflicts, notify: Some(*number), ..Default::default() }),
                Err(e) => classify(e),
            }
        }
        Op::CreateComment { number, body, .. } => {
            if *number < 0 {
                return Outcome::Failed("GitHub に作れなかった Issue へのコメントです".into());
            }
            match client.create_comment(owner, repo, *number as u32, body).await {
                Ok(json) => Outcome::Done(Done { comment: Some((*number, parse(&json))), notify: Some(*number), ..Default::default() }),
                Err(e) => classify(e),
            }
        }
        Op::SaveConfig { kind, json, base, .. } => send_config(client, owner, repo, kind, json, base.as_deref()).await,
        Op::SaveJournalNotes { date, notes, base, .. } => {
            send_journal_notes(client, owner, repo, date, notes, base.as_deref()).await
        }
        Op::GenerateJournal { date, .. } => match generator::generate_journal(client, owner, repo, date).await {
            Ok(md) => Outcome::Done(Done { reads: vec![(format!("journal:{}", date), md)], ..Default::default() }),
            Err(e) => classify(e),
        },
    }
}

fn describe(op: &Op) -> (String, String) {
    match op {
        Op::CreateIssue { title, .. } => (title.clone(), "Issue の作成".into()),
        Op::UpdateIssue { .. } => (String::new(), "Issue の変更".into()),
        Op::CreateComment { body, .. } => (String::new(), format!("コメント「{}」", body.chars().take(30).collect::<String>())),
        Op::SaveConfig { kind, .. } => {
            let label = config::kind(kind).map(|k| k.label).unwrap_or("設定");
            (label.to_string(), format!("{}の保存", label))
        }
        Op::SaveJournalNotes { date, .. } => (format!("{} の日誌", date), "日誌のノートの保存".into()),
        Op::GenerateJournal { date, .. } => (format!("{} の日誌", date), "日誌の作成".into()),
    }
}

fn failure(number: i64, title: String, message: String) -> Conflict {
    Conflict {
        id: 0,
        number,
        title,
        field: "error".into(),
        local: String::new(),
        remote: String::new(),
        base: String::new(),
        message,
        kind: String::new(),
        retry: None,
    }
}

/// 裏で送る（ほかの送信の途中なら、それが終わってから）
pub fn spawn_flush(app: AppHandle, client: GitHubClient, owner: String, repo: String) {
    tauri::async_runtime::spawn(async move {
        let _ = flush(&app, &client, &owner, &repo).await;
    });
}

/// 送信待ちを前から順に送る。つながらない・GitHub が受け付けないときは、そこで止めて残りは待たせる
pub async fn flush(app: &AppHandle, client: &GitHubClient, owner: &str, repo: &str) -> Result<SyncResult, String> {
    let _guard = SYNC_LOCK.lock().await;
    let mut result = SyncResult::default();
    loop {
        let Some(op) = store::read_store(app, owner, repo).outbox.first().cloned() else { break };
        let outcome = send(client, owner, repo, &op).await;
        super::set_offline(app, matches!(outcome, Outcome::Offline));
        match outcome {
            Outcome::Offline => {
                result.offline = true;
                break;
            }
            Outcome::Stop(message) => {
                result.stopped = Some(message);
                break;
            }
            Outcome::Done(Done { created, issue, comment, conflicts, reads, notify }) => {
                store::with_store(app, owner, repo, |s| {
                    // 送った 1 件を外す（ファイルが壊れて空になっていても止まらないように）
                    if !s.outbox.is_empty() {
                        s.outbox.remove(0);
                    }
                    if let Some((temp, real)) = created {
                        store::remap(s, temp, real);
                        result.mapping.insert(temp.to_string(), real);
                    }
                    if let Some(issue) = &issue {
                        store::note_issue(s, issue);
                    }
                    if let Some((number, comment)) = &comment {
                        store::note_comment(s, *number, comment);
                    }
                    for (key, value) in reads {
                        s.reads.insert(key, value);
                    }
                    for c in conflicts {
                        store::push_conflict(s, c);
                    }
                })?;
                result.sent += 1;
                if let Some((temp, real)) = created {
                    store::notify_created(app, owner, repo, temp, real);
                }
                // GitHub を書き換えられたら、お知らせを出す（送れたあとの番号で）
                if let (Some(number), Some(notice)) = (notify, op.notice()) {
                    super::deliver_notice(app, owner, repo, notice, number).await;
                }
            }
            Outcome::Failed(message) => {
                store::with_store(app, owner, repo, |s| {
                    if s.outbox.is_empty() {
                        return;
                    }
                    let failed = s.outbox.remove(0);
                    let (title, what) = describe(&failed);
                    store::push_conflict(s, failure(failed.number(), title, format!("{}を送れませんでした: {}", what, message)));
                    // 作れなかった Issue への変更・コメントも送れないので、一緒に外して知らせる
                    if let Op::CreateIssue { temp, .. } = failed {
                        let orphans: Vec<Op> = s.outbox.iter().filter(|o| o.number() == temp).cloned().collect();
                        s.outbox.retain(|o| o.number() != temp);
                        for orphan in orphans {
                            let (title, what) = describe(&orphan);
                            store::push_conflict(s, failure(temp, title, format!("{}を送れませんでした（Issue を作れなかったため）", what)));
                        }
                    }
                })?;
            }
        }
        store::notify_changed(app, owner, repo);
    }
    result.pending = store::read_store(app, owner, repo).outbox.len();
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn unchanged_fields_on_github_are_overwritten_and_changed_ones_are_kept_for_the_user() {
        let remote = json!({
            "title": "牛乳を買う（ほかの人が直した）",
            "state": "open",
            "body": "- [ ] 牛乳",
            "labels": [{ "name": "状態:未整理" }, { "name": "優先:高" }],
            "assignees": [],
            "milestone": null,
        });
        let base = Changes {
            title: Some("牛乳を買う".into()),
            state: Some("open".into()),
            labels: Some(vec!["状態:未整理".into()]),
            ..Default::default()
        };
        let changes = Changes {
            title: Some("牛乳を 2 本買う".into()),
            state: Some("closed".into()),
            labels: Some(vec!["状態:進行中".into()]),
            ..Default::default()
        };
        let (send, conflicts) = decide(5, &remote, &changes, Some(&base));
        assert_eq!(send.state.as_deref(), Some("closed"));
        assert!(same_set(send.labels.as_deref().unwrap(), &["優先:高".to_string(), "状態:進行中".to_string()]));
        assert_eq!(send.title, None);
        assert_eq!(conflicts.len(), 1);
        assert_eq!((conflicts[0].field.as_str(), conflicts[0].base.as_str()), ("title", "牛乳を買う"));
        // 「自分の変更で上書き」を選んだら、手元のタイトルを比べずに送る
        match &conflicts[0].retry {
            Some(Op::UpdateIssue { number: 5, changes, base: None, .. }) => assert_eq!(changes.title.as_deref(), Some("牛乳を 2 本買う")),
            other => panic!("{:?}", other),
        }
    }

    #[test]
    fn bodies_edited_in_different_places_are_merged_before_sending() {
        let remote = json!({ "title": "t", "state": "open", "body": "目的\r\nメモ: 金曜まで", "labels": [], "assignees": [] });
        let base = Changes { body: Some("目的\r\nメモ".into()), ..Default::default() };
        let changes = Changes { body: Some("目的: 発表\nメモ".into()), ..Default::default() };
        let (send, conflicts) = decide(5, &remote, &changes, Some(&base));
        assert!(conflicts.is_empty());
        assert_eq!(send.body.as_deref(), Some("目的: 発表\nメモ: 金曜まで"));
    }

    #[test]
    fn the_close_reason_is_sent_with_the_state() {
        let issue = |state: &str| json!({ "title": "t", "state": state, "body": "", "labels": [], "assignees": [] });
        let base = Changes { state: Some("open".into()), ..Default::default() };
        let changes = Changes {
            state: Some("closed".into()),
            state_reason: Some("duplicate".into()),
            duplicate_issue_id: Some(99),
            ..Default::default()
        };
        let (send, _) = decide(5, &issue("open"), &changes, Some(&base));
        assert_eq!((send.state.as_deref(), send.state_reason.as_deref(), send.duplicate_issue_id), (Some("closed"), Some("duplicate"), Some(99)));
        // GitHub の側がもう閉じていれば、理由だけを送ることはしない
        let (send, _) = decide(5, &issue("closed"), &changes, Some(&base));
        assert!(send.is_empty());
    }

    #[test]
    fn only_network_errors_wait_and_auth_errors_stop() {
        assert!(matches!(classify("通信できませんでした: error sending request".into()), Outcome::Offline));
        assert!(matches!(classify("HTTP 401 Unauthorized: {}".into()), Outcome::Stop(_)));
        assert!(matches!(classify("HTTP 409 Conflict: {}".into()), Outcome::Stop(_)));
        assert!(matches!(classify("HTTP 404 Not Found: {}".into()), Outcome::Failed(_)));
    }
}
