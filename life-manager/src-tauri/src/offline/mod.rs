//! オフラインのあいだも Issue・設定・日誌を見たり変えたりできるようにする。
//! GitHub から読めた内容は手元に写しておき、つながらないときはそれを見せる。
//! 変更は、つながらないとき（または前の変更がまだ送信待ちのとき）は送信待ちに並べ、つながったら順に送る
pub mod config;
pub mod merge;
pub mod store;
pub mod sync;

use crate::github::client::{is_network_error, GitHubClient};
use crate::github::recent;
use crate::journal::generator;
use serde::Serialize;
use serde_json::Value;
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use store::{Changes, Conflict, Notice, Op, PendingItem};
use tauri::{AppHandle, Emitter};

/// 送信待ちに並べたときに、画面に出す言葉に添える
pub const PENDING_NOTE: &str = "（未送信。つながったら GitHub に送ります）";

/// 最後の通信ができなかったか（画面の「オフライン」の表示と、すぐに送りはじめるかの判断に使う）
static OFFLINE: AtomicBool = AtomicBool::new(false);

pub fn is_offline() -> bool {
    OFFLINE.load(Ordering::Relaxed)
}

/// つながった・つながらなかったを覚える。変わったら画面に知らせる
pub fn set_offline(app: &AppHandle, offline: bool) {
    if OFFLINE.swap(offline, Ordering::Relaxed) != offline {
        let _ = app.emit("network-changed", serde_json::json!({ "offline": offline }));
    }
}

/// 通信の結果から、つながっているかを覚える（GitHub が断ったときも、つながってはいる）
pub fn note_result<T>(app: &AppHandle, result: &Result<T, String>) {
    set_offline(app, matches!(result, Err(e) if is_network_error(e)));
}

/// Issue の番号の書き方（まだ GitHub に作っていない Issue は「仮1」）
pub fn issue_ref(number: i64) -> String {
    if number < 0 {
        format!("仮{}", -number)
    } else {
        format!("#{}", number)
    }
}

/// お知らせの文。「{issue}」を番号にし、GitHub に作られた Issue ならリンクを付ける
pub fn notice_text(notice: &Notice, owner: &str, repo: &str, number: i64) -> String {
    let text = notice.message.replace("{issue}", &issue_ref(number));
    if notice.message.contains("{issue}") && number > 0 {
        format!("{}\nhttps://github.com/{}/{}/issues/{}", text, owner, repo, number)
    } else {
        text
    }
}

/// お知らせを出す（Discord・OS）
pub async fn deliver_notice(app: &AppHandle, owner: &str, repo: &str, notice: &Notice, number: i64) {
    let text = notice_text(notice, owner, repo, number);
    if notice.channels.iter().any(|c| c == "os") {
        crate::scheduler::routine::send_os_notification_public(app, "Life Manager", &text);
    }
    if notice.channels.iter().any(|c| c == "discord") {
        crate::scheduler::routine::send_discord_if_configured_public(owner, repo, &text).await;
    }
}

/// 直接送れたときのお知らせ（画面への返事を待たせないよう、裏で出す）
fn spawn_notice(app: &AppHandle, owner: &str, repo: &str, notice: Option<Notice>, number: i64) {
    let Some(notice) = notice else { return };
    let (app, owner, repo) = (app.clone(), owner.to_string(), repo.to_string());
    tauri::async_runtime::spawn(async move {
        deliver_notice(&app, &owner, &repo, &notice, number).await;
    });
}

/// GitHub から読む。読めたら手元に写し、つながらないときは最後に読んだ内容を返す
pub async fn read_through(
    app: &AppHandle,
    owner: &str,
    repo: &str,
    key: &str,
    fetch: impl Future<Output = Result<String, String>>,
) -> Result<String, String> {
    let result = fetch.await;
    note_result(app, &result);
    match result {
        Ok(json) => {
            store::remember(app, owner, repo, key, &json);
            Ok(json)
        }
        Err(e) if is_network_error(&e) => store::read_store(app, owner, repo).reads.remove(key).ok_or(e),
        Err(e) => Err(e),
    }
}

/// 送信待ちに並べたあと: 画面に知らせ、つながっていそうならすぐ送りはじめる
fn queued(app: &AppHandle, client: &GitHubClient, owner: &str, repo: &str) {
    store::notify_changed(app, owner, repo);
    if !is_offline() {
        sync::spawn_flush(app.clone(), client.clone(), owner.to_string(), repo.to_string());
    }
}

/// 直接送ってよいか（前の変更がまだ送信待ちなら、追い越さないよう後ろに並べる）
fn can_send_directly(app: &AppHandle, owner: &str, repo: &str) -> bool {
    store::read_store(app, owner, repo).outbox.is_empty()
}

fn remember_issue(app: &AppHandle, owner: &str, repo: &str, json: &str) {
    if let Ok(issue) = serde_json::from_str::<Value>(json) {
        let _ = store::with_store(app, owner, repo, |s| store::note_issue(s, &issue));
    }
}

// --- Issue ---

/// Issue の一覧（open / closed）。cached なら GitHub に聞かず、手元の写しに送信待ちを重ねたものを返す
pub async fn list_issues(
    app: &AppHandle,
    client: &GitHubClient,
    owner: &str,
    repo: &str,
    state: &str,
    cached: bool,
) -> Result<String, String> {
    if state != "open" && state != "closed" {
        return client.list_issues(owner, repo, state).await;
    }
    let key = format!("issues:{}", state);
    let has_copy = store::read_store(app, owner, repo).reads.contains_key(&key);
    if !(cached && has_copy) {
        read_through(app, owner, repo, &key, client.list_issues(owner, repo, state)).await?;
    }
    let (open, closed) = store::issues_view(&store::read_store(app, owner, repo));
    Ok(Value::Array(if state == "closed" { closed } else { open }).to_string())
}

pub async fn create_issue(
    app: &AppHandle,
    client: &GitHubClient,
    owner: &str,
    repo: &str,
    title: String,
    body: String,
    labels: Vec<String>,
    milestone: Option<u32>,
    assignees: Option<Vec<String>>,
    notice: Option<Notice>,
) -> Result<String, String> {
    if can_send_directly(app, owner, repo) {
        let result = client.create_issue(owner, repo, &title, &body, labels.clone(), milestone, assignees.clone()).await;
        note_result(app, &result);
        match result {
            Ok(json) => {
                remember_issue(app, owner, repo, &json);
                let number = serde_json::from_str::<Value>(&json).ok().and_then(|v| v["number"].as_i64()).unwrap_or(0);
                spawn_notice(app, owner, repo, notice, number);
                return Ok(json);
            }
            Err(e) if !is_network_error(&e) => return Err(e),
            Err(_) => {}
        }
    }
    let issue = store::with_store(app, owner, repo, |s| store::enqueue_create(s, title, body, labels, milestone, assignees, notice))?;
    queued(app, client, owner, repo);
    Ok(issue.to_string())
}

pub async fn update_issue(
    app: &AppHandle,
    client: &GitHubClient,
    owner: &str,
    repo: &str,
    number: i64,
    changes: Changes,
    notice: Option<Notice>,
) -> Result<String, String> {
    let number = store::real_number(&store::read_store(app, owner, repo), number);
    if number > 0 && can_send_directly(app, owner, repo) {
        let c = changes.clone();
        let result = client
            .update_issue(owner, repo, number as u32, c.title, c.body, c.state, c.labels, c.milestone, c.assignees)
            .await;
        note_result(app, &result);
        match result {
            Ok(json) => {
                remember_issue(app, owner, repo, &json);
                spawn_notice(app, owner, repo, notice, number);
                return Ok(json);
            }
            Err(e) if !is_network_error(&e) => return Err(e),
            Err(_) => {}
        }
    }
    let issue = store::with_store(app, owner, repo, |s| store::enqueue_update(s, number, changes, notice))?;
    queued(app, client, owner, repo);
    Ok(issue.to_string())
}

// --- コメント ---

pub async fn list_comments(app: &AppHandle, client: &GitHubClient, owner: &str, repo: &str, number: i64) -> Result<String, String> {
    let number = store::real_number(&store::read_store(app, owner, repo), number);
    if number > 0 {
        let key = format!("comments:{}", number);
        match read_through(app, owner, repo, &key, client.list_comments(owner, repo, number as u32)).await {
            // つながらず、まだ一度も読んでいないときは、送信待ちのコメントだけを見せる
            Err(e) if !is_network_error(&e) => return Err(e),
            _ => {}
        }
    }
    let user = current_user(app, Some(owner), Some(repo));
    Ok(Value::Array(store::comments_view(&store::read_store(app, owner, repo), number, &user)).to_string())
}

pub async fn create_comment(
    app: &AppHandle,
    client: &GitHubClient,
    owner: &str,
    repo: &str,
    number: i64,
    body: String,
    notice: Option<Notice>,
) -> Result<String, String> {
    let number = store::real_number(&store::read_store(app, owner, repo), number);
    if number > 0 && can_send_directly(app, owner, repo) {
        let result = client.create_comment(owner, repo, number as u32, &body).await;
        note_result(app, &result);
        match result {
            Ok(json) => {
                if let Ok(comment) = serde_json::from_str::<Value>(&json) {
                    let _ = store::with_store(app, owner, repo, |s| store::note_comment(s, number, &comment));
                }
                spawn_notice(app, owner, repo, notice, number);
                return Ok(json);
            }
            Err(e) if !is_network_error(&e) => return Err(e),
            Err(_) => {}
        }
    }
    let user = current_user(app, Some(owner), Some(repo));
    let comment = store::with_store(app, owner, repo, |s| store::enqueue_comment(s, number, body, &user, notice))?;
    queued(app, client, owner, repo);
    Ok(comment.to_string())
}

// --- 設定（config/*.yaml） ---

/// 設定を読む（つながらないときは最後に読んだ内容。ファイルがないときは空。送信待ちの書き換えがあれば、それを見せる）
pub async fn read_config(app: &AppHandle, client: &GitHubClient, owner: &str, repo: &str, key: &str) -> Result<String, String> {
    let kind = config::kind(key)?;
    let read_key = format!("config:{}", key);
    let fetched = client.get_contents(owner, repo, kind.path).await;
    note_result(app, &fetched);
    let read = match fetched {
        Ok((content, _sha)) => config::read_part(kind, Some(&content)).map(|json| {
            store::remember(app, owner, repo, &read_key, &json);
            json
        }),
        Err(e) if is_network_error(&e) => {
            Ok(store::read_store(app, owner, repo).reads.remove(&read_key).unwrap_or_else(|| kind.empty.to_string()))
        }
        Err(_) => Ok(kind.empty.to_string()),
    };
    match store::pending_config(&store::read_store(app, owner, repo), key) {
        Some(json) => Ok(json),
        None => read,
    }
}

/// GitHub の設定ファイルの一部を書き換える（ほかの部分は今のファイルのものを残す）。書いたあとの内容を返す
async fn write_config(client: &GitHubClient, owner: &str, repo: &str, kind: &config::Kind, json: &str) -> Result<String, String> {
    let (content, sha) = match client.get_contents(owner, repo, kind.path).await {
        Ok((content, sha)) => (Some(content), Some(sha)),
        Err(e) if e.starts_with("HTTP 404") => (None, None),
        Err(e) => return Err(e),
    };
    let yaml = config::write_part(kind, content.as_deref(), json)?;
    client.put_contents(owner, repo, kind.path, &yaml, kind.commit, sha).await?;
    config::read_part(kind, Some(&yaml))
}

/// 読んでから書くまでのあいだに GitHub の版がずれて断られたら（書いた直後は古い版が返ることがある）、少し待って一度だけやり直す（#64）
async fn retry_if_stale<T, F, Fut>(mut attempt: F) -> Result<T, String>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, String>>,
{
    match attempt().await {
        Err(e) if recent::is_stale_write(&e) => {
            tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
            attempt().await
        }
        result => result,
    }
}
/// 設定を書き換える。つながらないとき・同じ設定の書き換えが送信待ちのときは、送信待ちに並べる。返すのは画面に出す言葉
pub async fn save_config(app: &AppHandle, client: &GitHubClient, owner: &str, repo: &str, key: &str, json: String) -> Result<String, String> {
    let kind = config::kind(key)?;
    // 形を確かめておく（壊れた内容を並べないように）
    config::write_part(kind, None, &json)?;
    let waiting = store::pending_config(&store::read_store(app, owner, repo), key).is_some();
    // まだ GitHub に作っていない Issue のリマインダーは、その Issue を送ったあとに書く
    let temporary = key == "reminders" && config::has_temporary_reminders(&json);
    if !waiting && !temporary {
        let result = retry_if_stale(|| write_config(client, owner, repo, kind, &json)).await;
        note_result(app, &result);
        match result {
            Ok(written) => {
                store::remember(app, owner, repo, &format!("config:{}", key), &written);
                return Ok(format!("{}を保存しました", kind.label));
            }
            Err(e) if !is_network_error(&e) => return Err(e),
            Err(_) => {}
        }
    }
    store::with_store(app, owner, repo, |s| store::enqueue_config(s, key, json))?;
    queued(app, client, owner, repo);
    Ok(format!("{}を保存しました{}", kind.label, PENDING_NOTE))
}

// --- 日誌 ---

#[derive(Debug, Serialize)]
pub struct JournalResult {
    /// 日誌の Markdown（まだ送っていないノートは重ねてある）
    pub content: String,
    /// 送信待ちに並べた
    pub pending: bool,
}

/// 日誌を読む（つながらないときは最後に読んだもの。送信待ちのノートがあれば重ねる）
pub async fn get_journal(app: &AppHandle, client: &GitHubClient, owner: &str, repo: &str, date: &str) -> Result<String, String> {
    let key = format!("journal:{}", date);
    let fetched = client.get_contents(owner, repo, &format!("journal/{}.md", date)).await;
    note_result(app, &fetched);
    let content = match fetched {
        Ok((content, _)) => {
            store::remember(app, owner, repo, &key, &content);
            Some(content)
        }
        Err(e) if is_network_error(&e) => store::read_store(app, owner, repo).reads.remove(&key),
        Err(_) => None,
    };
    let store = store::read_store(app, owner, repo);
    match (content, store::pending_journal_notes(&store, date)) {
        (Some(md), Some(notes)) => Ok(generator::replace_notes(&md, &notes)),
        (Some(md), None) => Ok(md),
        (None, _) if store::pending_journal_generation(&store, date) => Err(format!("{}の日誌は、つながったら作ります", date)),
        (None, _) => Err(format!("{}のジャーナルが見つかりません", date)),
    }
}

/// 日誌のノートを保存する。つながらないときは送信待ちに並べる（この端末に日誌の写しがあるときだけ）
pub async fn save_journal_notes(
    app: &AppHandle,
    client: &GitHubClient,
    owner: &str,
    repo: &str,
    date: &str,
    notes: String,
) -> Result<JournalResult, String> {
    let key = format!("journal:{}", date);
    let waiting = store::pending_journal_notes(&store::read_store(app, owner, repo), date).is_some();
    if !waiting {
        let result = retry_if_stale(|| generator::save_journal_notes(client, owner, repo, date, &notes)).await;
        note_result(app, &result);
        match result {
            Ok(md) => {
                store::remember(app, owner, repo, &key, &md);
                return Ok(JournalResult { content: md, pending: false });
            }
            Err(e) if !is_network_error(&e) => return Err(e),
            Err(_) => {}
        }
    }
    let Some(md) = store::read_store(app, owner, repo).reads.remove(&key) else {
        return Err(format!("{}の日誌がこの端末にないため、つながるまでノートを保存できません", date));
    };
    let base = generator::notes_of(&md);
    store::with_store(app, owner, repo, |s| store::enqueue_journal_notes(s, date, notes.clone(), Some(base)))?;
    queued(app, client, owner, repo);
    Ok(JournalResult { content: generator::replace_notes(&md, &notes), pending: true })
}

/// 日誌を作る。つながらないときは、つながってから作る
pub async fn generate_journal(app: &AppHandle, client: &GitHubClient, owner: &str, repo: &str, date: &str) -> Result<JournalResult, String> {
    let key = format!("journal:{}", date);
    let result = retry_if_stale(|| generator::generate_journal(client, owner, repo, date)).await;
    note_result(app, &result);
    match result {
        Ok(md) => {
            store::remember(app, owner, repo, &key, &md);
            Ok(JournalResult { content: md, pending: false })
        }
        Err(e) if is_network_error(&e) => {
            store::with_store(app, owner, repo, |s| store::enqueue_generate_journal(s, date))?;
            queued(app, client, owner, repo);
            let content = store::read_store(app, owner, repo).reads.remove(&key).unwrap_or_default();
            Ok(JournalResult { content, pending: true })
        }
        Err(e) => Err(e),
    }
}

// --- ログインしている人 ---

fn current_user(app: &AppHandle, owner: Option<&str>, repo: Option<&str>) -> Value {
    let from_repo = match (owner, repo) {
        (Some(o), Some(r)) => store::read_store(app, o, r).reads.remove("user"),
        _ => None,
    };
    from_repo
        .or_else(|| store::read_global(app, "user"))
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or(Value::Null)
}

fn remember_user(app: &AppHandle, owner: Option<&str>, repo: Option<&str>, json: &str) {
    let _ = store::write_global(app, "user", json);
    if let (Some(o), Some(r)) = (owner, repo) {
        store::remember(app, o, r, "user", json);
    }
}

/// リポジトリごとにトークンが違うことがあるので、リポジトリが分かるときはリポジトリごとにも覚える
pub async fn get_current_user(app: &AppHandle, client: &GitHubClient, owner: Option<&str>, repo: Option<&str>) -> Result<String, String> {
    let result = client.get_authenticated_user().await;
    note_result(app, &result);
    match result {
        Ok(json) => {
            remember_user(app, owner, repo, &json);
            Ok(json)
        }
        Err(e) if is_network_error(&e) => match current_user(app, owner, repo) {
            Value::Null => Err(e),
            user => Ok(user.to_string()),
        },
        Err(e) => Err(e),
    }
}

// --- 送信待ちの様子・送る・ぶつかったものを決める ---

/// ぶつかったもの（本文・日誌のノートは、行ごとのまとめも付ける）
#[derive(Debug, Serialize)]
pub struct ConflictView {
    #[serde(flatten)]
    pub conflict: Conflict,
    pub hunks: Option<Vec<merge::Hunk>>,
}

#[derive(Debug, Serialize)]
pub struct OfflineStatus {
    /// 最後の通信ができなかった
    pub offline: bool,
    pub pending: Vec<PendingItem>,
    pub conflicts: Vec<ConflictView>,
}

pub fn status(app: &AppHandle, owner: &str, repo: &str) -> OfflineStatus {
    let store = store::read_store(app, owner, repo);
    let conflicts = store
        .conflicts
        .iter()
        .map(|c| {
            let hunks = if c.field == "body" || c.field == "journal" {
                let n = merge::normalize_newlines;
                merge::merge_lines(&n(&c.base), &n(&c.local), &n(&c.remote))
            } else {
                None
            };
            ConflictView { conflict: c.clone(), hunks }
        })
        .collect();
    OfflineStatus { offline: is_offline(), pending: store::pending_items(&store), conflicts }
}

/// 今すぐ送る。送るものがなく、前につながらなかったときは、つながったか確かめる
pub async fn sync_now(app: &AppHandle, client: &GitHubClient, owner: &str, repo: &str) -> Result<sync::SyncResult, String> {
    if store::read_store(app, owner, repo).outbox.is_empty() {
        if is_offline() {
            let result = client.get_authenticated_user().await;
            note_result(app, &result);
            if let Ok(json) = &result {
                remember_user(app, Some(owner), Some(repo), json);
            }
        }
        return Ok(sync::SyncResult { offline: is_offline(), ..Default::default() });
    }
    sync::flush(app, client, owner, repo).await
}

/// 「直して送る」で送る操作（タイトル・本文・日誌のノートだけ）
fn custom_op(conflict: &Conflict, value: String) -> Option<Op> {
    let at = store::now();
    match conflict.field.as_str() {
        "title" | "body" => {
            let mut changes = Changes::default();
            if conflict.field == "title" {
                changes.title = Some(value);
            } else {
                changes.body = Some(value);
            }
            Some(Op::UpdateIssue { number: conflict.number, changes, base: None, at, notice: None })
        }
        "journal" => Some(Op::SaveJournalNotes { date: conflict.kind.clone(), notes: value, base: None, at }),
        _ => None,
    }
}

/// ぶつかったものを片付ける。choice: "remote"（GitHub の内容を残す）/ "local"（自分の変更で上書き）/ "custom"（直した value を送る）
pub fn resolve_conflict(
    app: &AppHandle,
    client: Option<&GitHubClient>,
    owner: &str,
    repo: &str,
    id: u64,
    choice: &str,
    value: Option<String>,
) -> Result<(), String> {
    let requeued = store::with_store(app, owner, repo, |s| {
        let Some(index) = s.conflicts.iter().position(|c| c.id == id) else { return false };
        let conflict = s.conflicts.remove(index);
        let op = match (choice, value) {
            ("local", _) => conflict.retry.clone(),
            ("custom", Some(value)) => custom_op(&conflict, value),
            _ => None,
        };
        match op {
            Some(op) => {
                s.outbox.push(op);
                true
            }
            None => false,
        }
    })?;
    match (requeued, client) {
        (true, Some(client)) => queued(app, client, owner, repo),
        _ => store::notify_changed(app, owner, repo),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notices_use_the_number_given_by_github() {
        let notice = Notice { message: "✅ {issue} 牛乳 を完了".into(), channels: vec!["discord".into()] };
        assert_eq!(notice_text(&notice, "o", "r", 66), "✅ #66 牛乳 を完了\nhttps://github.com/o/r/issues/66");
        assert_eq!(notice_text(&notice, "o", "r", -1), "✅ 仮1 牛乳 を完了");
        let plain = Notice { message: "📋 ルーチンIssue作成: 日報".into(), channels: vec![] };
        assert_eq!(notice_text(&plain, "o", "r", 66), "📋 ルーチンIssue作成: 日報");
    }
}
