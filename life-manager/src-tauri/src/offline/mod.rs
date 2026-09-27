//! オフラインのあいだも Issue を見たり変えたりできるようにする。
//! GitHub から読めた内容は手元に写しておき、つながらないときはそれを見せる。
//! 変更は、つながらないとき（または前の変更がまだ送信待ちのとき）は送信待ちに並べ、つながったら順に送る
pub mod merge;
pub mod store;
pub mod sync;

use crate::github::client::{is_network_error, GitHubClient};
use serde::Serialize;
use serde_json::Value;
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use store::{Changes, Conflict, Op, PendingItem};
use tauri::{AppHandle, Emitter};

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
            let _ = store::with_store(app, owner, repo, |s| {
                s.reads.insert(key.to_string(), json.clone());
            });
            Ok(json)
        }
        Err(e) if is_network_error(&e) => store::read_store(app, owner, repo).reads.remove(key).ok_or(e),
        Err(e) => Err(e),
    }
}

/// 設定ファイル（config/*.yaml）を読んだ結果。読めたら手元に写し、つながらないときは最後に読んだ内容、
/// ファイルがないときは default を返す
pub fn config_result(
    app: &AppHandle,
    owner: &str,
    repo: &str,
    key: &str,
    default: &str,
    fetched: Result<(String, String), String>,
    parse: impl FnOnce(&str) -> Result<String, String>,
) -> Result<String, String> {
    note_result(app, &fetched);
    match fetched {
        Ok((content, _sha)) => {
            let json = parse(&content)?;
            let _ = store::with_store(app, owner, repo, |s| {
                s.reads.insert(key.to_string(), json.clone());
            });
            Ok(json)
        }
        Err(e) if is_network_error(&e) => {
            Ok(store::read_store(app, owner, repo).reads.remove(key).unwrap_or_else(|| default.to_string()))
        }
        Err(_) => Ok(default.to_string()),
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
) -> Result<String, String> {
    if can_send_directly(app, owner, repo) {
        let result = client.create_issue(owner, repo, &title, &body, labels.clone(), milestone, assignees.clone()).await;
        note_result(app, &result);
        match result {
            Ok(json) => {
                remember_issue(app, owner, repo, &json);
                return Ok(json);
            }
            Err(e) if !is_network_error(&e) => return Err(e),
            Err(_) => {}
        }
    }
    let issue = store::with_store(app, owner, repo, |s| store::enqueue_create(s, title, body, labels, milestone, assignees))?;
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
                return Ok(json);
            }
            Err(e) if !is_network_error(&e) => return Err(e),
            Err(_) => {}
        }
    }
    let issue = store::with_store(app, owner, repo, |s| store::enqueue_update(s, number, changes))?;
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

pub async fn create_comment(app: &AppHandle, client: &GitHubClient, owner: &str, repo: &str, number: i64, body: String) -> Result<String, String> {
    let number = store::real_number(&store::read_store(app, owner, repo), number);
    if number > 0 && can_send_directly(app, owner, repo) {
        let result = client.create_comment(owner, repo, number as u32, &body).await;
        note_result(app, &result);
        match result {
            Ok(json) => {
                if let Ok(comment) = serde_json::from_str::<Value>(&json) {
                    let _ = store::with_store(app, owner, repo, |s| store::note_comment(s, number, &comment));
                }
                return Ok(json);
            }
            Err(e) if !is_network_error(&e) => return Err(e),
            Err(_) => {}
        }
    }
    let user = current_user(app, Some(owner), Some(repo));
    let comment = store::with_store(app, owner, repo, |s| store::enqueue_comment(s, number, body, &user))?;
    queued(app, client, owner, repo);
    Ok(comment.to_string())
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
        let _ = store::with_store(app, o, r, |s| {
            s.reads.insert("user".to_string(), json.to_string());
        });
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

#[derive(Debug, Serialize)]
pub struct OfflineStatus {
    /// 最後の通信ができなかった
    pub offline: bool,
    pub pending: Vec<PendingItem>,
    pub conflicts: Vec<Conflict>,
}

pub fn status(app: &AppHandle, owner: &str, repo: &str) -> OfflineStatus {
    let store = store::read_store(app, owner, repo);
    OfflineStatus { offline: is_offline(), pending: store::pending_items(&store), conflicts: store.conflicts.clone() }
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

/// ぶつかったものを片付ける。keep_local なら自分の変更を、GitHub の今の値と比べずに送り直す
pub fn resolve_conflict(
    app: &AppHandle,
    client: Option<&GitHubClient>,
    owner: &str,
    repo: &str,
    id: u64,
    keep_local: bool,
) -> Result<(), String> {
    let requeued = store::with_store(app, owner, repo, |s| {
        let Some(index) = s.conflicts.iter().position(|c| c.id == id) else { return false };
        let conflict = s.conflicts.remove(index);
        match (keep_local, conflict.force) {
            (true, Some(force)) => {
                s.outbox.push(Op::UpdateIssue { number: conflict.number, changes: force, base: None, at: store::now() });
                true
            }
            _ => false,
        }
    })?;
    match (requeued, client) {
        (true, Some(client)) => queued(app, client, owner, repo),
        _ => store::notify_changed(app, owner, repo),
    }
    Ok(())
}
