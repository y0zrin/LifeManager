//! 送信待ちの変更を、つながったときに順に GitHub へ送る。
//! 変更は、今の GitHub の内容と比べてから送る（オフラインのあいだに GitHub 側でも変わっていたら、上書きしないで知らせる）
use super::merge::{merge_set, merge_text, merge_value, same_set, Merge};
use super::store::{self, Changes, Conflict, Op};
use crate::github::client::{is_network_error, GitHubClient};
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

enum Outcome {
    Done {
        created: Option<(i64, i64)>,
        issue: Option<Value>,
        comment: Option<(i64, Value)>,
        conflicts: Vec<Conflict>,
    },
    /// つながらない（送信待ちはそのまま）
    Offline,
    /// GitHub が受け付けない状態（トークンが無効・GitHub の不調など）。送信待ちはそのまま残して止める
    Stop(String),
    /// この変更は送れない（Issue が消されたなど）。送信待ちから外し、使う人に知らせる
    Failed(String),
}

fn classify(error: String) -> Outcome {
    if is_network_error(&error) {
        return Outcome::Offline;
    }
    let status: u16 = error.strip_prefix("HTTP ").and_then(|s| s.get(..3)).and_then(|s| s.parse().ok()).unwrap_or(0);
    if status == 401 || status == 403 || status == 429 || status >= 500 {
        Outcome::Stop(error)
    } else {
        Outcome::Failed(error)
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

fn conflict(number: i64, remote: &Value, field: &str, local: String, remote_value: String, force: Changes) -> Conflict {
    Conflict {
        id: 0,
        number,
        title: remote["title"].as_str().unwrap_or("").to_string(),
        field: field.to_string(),
        local,
        remote: remote_value,
        message: String::new(),
        force: Some(force),
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
                    Changes { state: Some(local.clone()), ..Default::default() }
                };
                conflicts.push(conflict(number, remote, field, local.clone(), remote_value, force));
            }
        }
    }

    if let Some(local) = &changes.body {
        let remote_body = text("body");
        match merge_text(base.body.as_deref().unwrap_or(""), local, &remote_body) {
            Some(merged) if merged != remote_body => send.body = Some(merged),
            Some(_) => {}
            None => conflicts.push(conflict(
                number,
                remote,
                "body",
                local.clone(),
                remote_body,
                Changes { body: Some(local.clone()), ..Default::default() },
            )),
        }
    }

    if let Some(local) = changes.milestone {
        let remote_value = remote["milestone"]["number"].as_u64().unwrap_or(0) as u32;
        match merge_value(&base.milestone.unwrap_or(0), &local, &remote_value) {
            Merge::Keep => {}
            Merge::Send(v) => send.milestone = Some(v),
            Merge::Conflict => conflicts.push(conflict(
                number,
                remote,
                "milestone",
                local.to_string(),
                remote_value.to_string(),
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

async fn send(client: &GitHubClient, owner: &str, repo: &str, op: &Op) -> Outcome {
    match op {
        Op::CreateIssue { temp, title, body, labels, milestone, assignees, .. } => {
            match client.create_issue(owner, repo, title, body, labels.clone(), *milestone, assignees.clone()).await {
                Ok(json) => {
                    let issue = parse(&json);
                    let real = issue["number"].as_i64().unwrap_or(0);
                    Outcome::Done { created: Some((*temp, real)), issue: Some(issue), comment: None, conflicts: Vec::new() }
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
                return Outcome::Done { created: None, issue: Some(remote), comment: None, conflicts };
            }
            let Changes { title, body, state, labels, milestone, assignees } = to_send;
            match client.update_issue(owner, repo, n, title, body, state, labels, milestone, assignees).await {
                Ok(json) => Outcome::Done { created: None, issue: Some(parse(&json)), comment: None, conflicts },
                Err(e) => classify(e),
            }
        }
        Op::CreateComment { number, body, .. } => {
            if *number < 0 {
                return Outcome::Failed("GitHub に作れなかった Issue へのコメントです".into());
            }
            match client.create_comment(owner, repo, *number as u32, body).await {
                Ok(json) => Outcome::Done { created: None, issue: None, comment: Some((*number, parse(&json))), conflicts: Vec::new() },
                Err(e) => classify(e),
            }
        }
    }
}

fn describe(op: &Op) -> (String, String) {
    match op {
        Op::CreateIssue { title, .. } => (title.clone(), "Issue の作成".into()),
        Op::UpdateIssue { .. } => (String::new(), "Issue の変更".into()),
        Op::CreateComment { body, .. } => (String::new(), format!("コメント「{}」", body.chars().take(30).collect::<String>())),
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
            Outcome::Done { created, issue, comment, conflicts } => {
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
                    for c in conflicts {
                        store::push_conflict(s, c);
                    }
                })?;
                result.sent += 1;
                if let Some((temp, real)) = created {
                    store::notify_created(app, owner, repo, temp, real);
                }
            }
            Outcome::Failed(message) => {
                store::with_store(app, owner, repo, |s| {
                    if s.outbox.is_empty() {
                        return;
                    }
                    let failed = s.outbox.remove(0);
                    let (title, what) = describe(&failed);
                    let number = failed.number();
                    store::push_conflict(
                        s,
                        Conflict {
                            id: 0,
                            number,
                            title,
                            field: "error".into(),
                            local: String::new(),
                            remote: String::new(),
                            message: format!("{}を送れませんでした: {}", what, message),
                            force: None,
                        },
                    );
                    // 作れなかった Issue への変更・コメントも送れないので、一緒に外して知らせる
                    if let Op::CreateIssue { temp, .. } = failed {
                        let orphans: Vec<Op> = s.outbox.iter().filter(|o| o.number() == temp).cloned().collect();
                        s.outbox.retain(|o| o.number() != temp);
                        for orphan in orphans {
                            let (title, what) = describe(&orphan);
                            store::push_conflict(
                                s,
                                Conflict {
                                    id: 0,
                                    number: temp,
                                    title,
                                    field: "error".into(),
                                    local: String::new(),
                                    remote: String::new(),
                                    message: format!("{}を送れませんでした（Issue を作れなかったため）", what),
                                    force: None,
                                },
                            );
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
        assert_eq!(conflicts[0].field, "title");
        assert_eq!(conflicts[0].force.as_ref().and_then(|f| f.title.as_deref()), Some("牛乳を 2 本買う"));
    }

    #[test]
    fn only_network_errors_wait_and_auth_errors_stop() {
        assert!(matches!(classify("通信できませんでした: error sending request".into()), Outcome::Offline));
        assert!(matches!(classify("HTTP 401 Unauthorized: {}".into()), Outcome::Stop(_)));
        assert!(matches!(classify("HTTP 404 Not Found: {}".into()), Outcome::Failed(_)));
    }
}
