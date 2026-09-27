//! 手元の写し（最後に GitHub から読んだ内容）と、送信待ちの列。リポジトリごとに、アプリのデータフォルダの JSON に保存する。
//! 画面に返す Issue は「最後に読んだ内容」に「送信待ちの変更」を重ねたもの（まだ送っていない変更には "_pending": true を付ける）
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

/// ファイルの読み書きを 1 つずつにする
static STORE_LOCK: Mutex<()> = Mutex::new(());

/// 送信待ちの変更で書き換える項目（None は変えない）。milestone の 0 は「外す」
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Changes {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub labels: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub milestone: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assignees: Option<Vec<String>>,
}

impl Changes {
    pub fn is_empty(&self) -> bool {
        *self == Changes::default()
    }
}

/// 送信待ちの 1 件。Issue の番号は、まだ GitHub に作っていない Issue なら仮の番号（-1, -2, …）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Op {
    CreateIssue {
        temp: i64,
        title: String,
        body: String,
        labels: Vec<String>,
        milestone: Option<u32>,
        assignees: Option<Vec<String>>,
        at: String,
    },
    UpdateIssue {
        number: i64,
        changes: Changes,
        /// 変更する前の値。None なら GitHub の今の値と比べずに送る（「自分の変更で上書き」）
        base: Option<Changes>,
        at: String,
    },
    CreateComment {
        number: i64,
        body: String,
        at: String,
    },
}

impl Op {
    /// どの Issue への操作か
    pub fn number(&self) -> i64 {
        match self {
            Op::CreateIssue { temp, .. } => *temp,
            Op::UpdateIssue { number, .. } | Op::CreateComment { number, .. } => *number,
        }
    }
}

/// 送るときに GitHub 側の変更とぶつかった・送れなかったもの。使う人に見せて決めてもらう
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Conflict {
    pub id: u64,
    pub number: i64,
    pub title: String,
    /// "title" / "body" / "state" / "milestone" / "error"
    pub field: String,
    pub local: String,
    pub remote: String,
    pub message: String,
    /// 「自分の変更で上書き」を選んだときに送る変更
    pub force: Option<Changes>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct RepoStore {
    /// 最後に GitHub から読んだ内容（キー → JSON の文字列）
    #[serde(default)]
    pub reads: HashMap<String, String>,
    #[serde(default)]
    pub outbox: Vec<Op>,
    /// 最後に使った仮の番号（1, 2, … 実際の番号は -1, -2, …）
    #[serde(default)]
    pub next_temp: i64,
    #[serde(default)]
    pub conflicts: Vec<Conflict>,
    #[serde(default)]
    pub next_conflict: u64,
    /// GitHub に作れた Issue の、仮の番号 → 本当の番号（あとから仮の番号で届いた変更を直すため）
    #[serde(default)]
    pub created: HashMap<i64, i64>,
}

pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn offline_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("offline");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn store_path(app: &AppHandle, owner: &str, repo: &str) -> Result<PathBuf, String> {
    let safe = |s: &str| -> String {
        s.chars().map(|c| if c.is_ascii_alphanumeric() || "-_.".contains(c) { c } else { '_' }).collect()
    };
    Ok(offline_dir(app)?.join(format!("{}__{}.json", safe(owner), safe(repo))))
}

/// リポジトリによらない写し（ログインしている人）
fn global_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(offline_dir(app)?.join("_global.json"))
}

fn load(path: &PathBuf) -> RepoStore {
    std::fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

fn save(path: &PathBuf, store: &RepoStore) -> Result<(), String> {
    let json = serde_json::to_string(store).map_err(|e| e.to_string())?;
    // 書いている途中で止まっても壊れないよう、別の名前で書いてから置き換える
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// 読むだけ
pub fn read_store(app: &AppHandle, owner: &str, repo: &str) -> RepoStore {
    let _lock = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    store_path(app, owner, repo).map(|p| load(&p)).unwrap_or_default()
}

/// 読んで、書き換えて、保存する
pub fn with_store<R>(app: &AppHandle, owner: &str, repo: &str, f: impl FnOnce(&mut RepoStore) -> R) -> Result<R, String> {
    let _lock = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = store_path(app, owner, repo)?;
    let mut store = load(&path);
    let result = f(&mut store);
    save(&path, &store)?;
    Ok(result)
}

pub fn read_global(app: &AppHandle, key: &str) -> Option<String> {
    let _lock = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    load(&global_path(app).ok()?).reads.remove(key)
}

pub fn write_global(app: &AppHandle, key: &str, value: &str) -> Result<(), String> {
    let _lock = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = global_path(app)?;
    let mut store = load(&path);
    store.reads.insert(key.to_string(), value.to_string());
    save(&path, &store)
}

/// 画面に「送信待ちが変わった」と知らせる
pub fn notify_changed(app: &AppHandle, owner: &str, repo: &str) {
    let _ = app.emit("offline-changed", json!({ "owner": owner, "repo": repo }));
}

/// 仮の番号の Issue が GitHub に作られたと知らせる（開いている詳細の番号を直すため）
pub fn notify_created(app: &AppHandle, owner: &str, repo: &str, temp: i64, real: i64) {
    let _ = app.emit("offline-changed", json!({ "owner": owner, "repo": repo, "created": { "temp": temp, "real": real } }));
}

// --- 手元の写しに重ねる ---

fn parse_list(store: &RepoStore, key: &str) -> Vec<Value> {
    store.reads.get(key).and_then(|s| serde_json::from_str(s).ok()).unwrap_or_default()
}

fn number_of(issue: &Value) -> Option<i64> {
    issue["number"].as_i64()
}

fn label_values(names: &[String], known: &[Value], current: &Value) -> Value {
    Value::Array(
        names
            .iter()
            .map(|name| {
                current
                    .as_array()
                    .and_then(|ls| ls.iter().find(|l| l["name"].as_str() == Some(name)).cloned())
                    .or_else(|| known.iter().find(|l| l["name"].as_str() == Some(name)).cloned())
                    .unwrap_or_else(|| json!({ "name": name, "color": "cccccc" }))
            })
            .collect(),
    )
}

fn milestone_value(number: u32, known: &[Value]) -> Value {
    if number == 0 {
        return Value::Null;
    }
    known
        .iter()
        .find(|m| m["number"].as_u64() == Some(number as u64))
        .cloned()
        .unwrap_or_else(|| json!({ "number": number, "title": format!("#{}", number), "state": "open" }))
}

fn assignee_values(logins: &[String], current: &Value) -> Value {
    Value::Array(
        logins
            .iter()
            .map(|login| {
                current
                    .as_array()
                    .and_then(|as_| as_.iter().find(|a| a["login"].as_str() == Some(login)).cloned())
                    .unwrap_or_else(|| json!({ "login": login, "avatar_url": "" }))
            })
            .collect(),
    )
}

fn apply_changes(issue: &mut Value, changes: &Changes, labels: &[Value], milestones: &[Value]) {
    if let Some(t) = &changes.title {
        issue["title"] = json!(t);
    }
    if let Some(b) = &changes.body {
        issue["body"] = json!(b);
    }
    if let Some(s) = &changes.state {
        issue["state"] = json!(s);
    }
    if let Some(ls) = &changes.labels {
        issue["labels"] = label_values(ls, labels, &issue["labels"]);
    }
    if let Some(m) = changes.milestone {
        issue["milestone"] = milestone_value(m, milestones);
    }
    if let Some(a) = &changes.assignees {
        issue["assignees"] = assignee_values(a, &issue["assignees"]);
    }
}

fn apply_op(open: &mut Vec<Value>, closed: &mut Vec<Value>, op: &Op, labels: &[Value], milestones: &[Value]) {
    match op {
        Op::CreateIssue { temp, title, body, labels: names, milestone, assignees, at } => {
            let issue = json!({
                "number": temp,
                "title": title,
                "body": body,
                "state": "open",
                "labels": label_values(names, labels, &Value::Null),
                "milestone": milestone_value(milestone.unwrap_or(0), milestones),
                "assignees": assignee_values(assignees.as_deref().unwrap_or(&[]), &Value::Null),
                "comments": 0,
                "created_at": at,
                "updated_at": at,
                "_pending": true,
            });
            open.insert(0, issue);
        }
        Op::UpdateIssue { number, changes, at, .. } => {
            let (mut issue, was_open, index) = if let Some(i) = open.iter().position(|x| number_of(x) == Some(*number)) {
                (open.remove(i), true, i)
            } else if let Some(i) = closed.iter().position(|x| number_of(x) == Some(*number)) {
                (closed.remove(i), false, i)
            } else {
                return;
            };
            apply_changes(&mut issue, changes, labels, milestones);
            issue["updated_at"] = json!(at);
            issue["_pending"] = json!(true);
            let is_open = issue["state"].as_str() != Some("closed");
            match (was_open, is_open) {
                (true, true) => open.insert(index.min(open.len()), issue),
                (false, false) => closed.insert(index.min(closed.len()), issue),
                (_, true) => open.insert(0, issue),
                (_, false) => closed.insert(0, issue),
            }
        }
        Op::CreateComment { number, .. } => {
            if let Some(issue) = open.iter_mut().chain(closed.iter_mut()).find(|x| number_of(x) == Some(*number)) {
                issue["comments"] = json!(issue["comments"].as_u64().unwrap_or(0) + 1);
                issue["_pending"] = json!(true);
            }
        }
    }
}

/// 最後に読んだ Issue に、送信待ちの変更を重ねたもの（開いている・閉じた）
pub fn issues_view(store: &RepoStore) -> (Vec<Value>, Vec<Value>) {
    let mut open = parse_list(store, "issues:open");
    let mut closed = parse_list(store, "issues:closed");
    let labels = parse_list(store, "labels");
    let milestones = parse_list(store, "milestones");
    for op in &store.outbox {
        apply_op(&mut open, &mut closed, op, &labels, &milestones);
    }
    (open, closed)
}

/// Issue のコメントに、送信待ちのコメントを重ねたもの
pub fn comments_view(store: &RepoStore, number: i64, user: &Value) -> Vec<Value> {
    let mut comments = parse_list(store, &format!("comments:{}", number));
    let login = user["login"].as_str().unwrap_or("");
    let avatar = user["avatar_url"].as_str().unwrap_or("");
    for (i, op) in store.outbox.iter().enumerate() {
        if let Op::CreateComment { number: n, body, at } = op {
            if *n == number {
                comments.push(json!({
                    "id": -(i as i64) - 1,
                    "body": body,
                    "user": { "login": login, "avatar_url": avatar },
                    "created_at": at,
                    "updated_at": at,
                    "_pending": true,
                }));
            }
        }
    }
    comments
}

fn find_issue(store: &RepoStore, number: i64) -> Option<Value> {
    let (open, closed) = issues_view(store);
    open.into_iter().chain(closed).find(|i| number_of(i) == Some(number))
}

/// 送信待ちの 1 件を、画面に並べる形にしたもの
#[derive(Debug, Serialize)]
pub struct PendingItem {
    pub number: i64,
    pub title: String,
    /// 何をするか（「作る」「閉じる」「ラベル・本文を変える」「コメントする」など）
    pub action: String,
    pub at: String,
}

fn describe_changes(changes: &Changes) -> String {
    let mut fields = Vec::new();
    for (changed, name) in [
        (changes.title.is_some(), "タイトル"),
        (changes.body.is_some(), "本文"),
        (changes.labels.is_some(), "ラベル"),
        (changes.milestone.is_some(), "マイルストーン"),
        (changes.assignees.is_some(), "担当者"),
    ] {
        if changed {
            fields.push(name);
        }
    }
    let mut actions = Vec::new();
    if !fields.is_empty() {
        actions.push(format!("{}を変える", fields.join("・")));
    }
    match changes.state.as_deref() {
        Some("closed") => actions.push("閉じる".to_string()),
        Some(_) => actions.push("開き直す".to_string()),
        None => {}
    }
    actions.join("、")
}

pub fn pending_items(store: &RepoStore) -> Vec<PendingItem> {
    let (open, closed) = issues_view(store);
    let title_of = |n: i64| -> String {
        open.iter()
            .chain(closed.iter())
            .find(|i| number_of(i) == Some(n))
            .and_then(|i| i["title"].as_str())
            .unwrap_or("")
            .to_string()
    };
    store
        .outbox
        .iter()
        .map(|op| match op {
            Op::CreateIssue { temp, title, at, .. } => {
                PendingItem { number: *temp, title: title.clone(), action: "作る".into(), at: at.clone() }
            }
            Op::UpdateIssue { number, changes, at, .. } => {
                PendingItem { number: *number, title: title_of(*number), action: describe_changes(changes), at: at.clone() }
            }
            Op::CreateComment { number, at, .. } => {
                PendingItem { number: *number, title: title_of(*number), action: "コメントする".into(), at: at.clone() }
            }
        })
        .collect()
}

/// 仮の番号の Issue がもう GitHub に作られていれば、本当の番号にする
pub fn real_number(store: &RepoStore, number: i64) -> i64 {
    if number < 0 {
        store.created.get(&number).copied().unwrap_or(number)
    } else {
        number
    }
}

// --- 送信待ちに並べる ---

/// 変えようとしている項目の、今の値（あとで GitHub の値と比べるため）
fn base_of(issue: &Value, changes: &Changes) -> Changes {
    let names = |key: &str, field: &str| -> Vec<String> {
        issue[key]
            .as_array()
            .map(|xs| xs.iter().filter_map(|x| x[field].as_str().map(|s| s.to_string())).collect())
            .unwrap_or_default()
    };
    Changes {
        title: changes.title.as_ref().map(|_| issue["title"].as_str().unwrap_or("").to_string()),
        body: changes.body.as_ref().map(|_| issue["body"].as_str().unwrap_or("").to_string()),
        state: changes.state.as_ref().map(|_| issue["state"].as_str().unwrap_or("open").to_string()),
        labels: changes.labels.as_ref().map(|_| names("labels", "name")),
        milestone: changes.milestone.map(|_| issue["milestone"]["number"].as_u64().unwrap_or(0) as u32),
        assignees: changes.assignees.as_ref().map(|_| names("assignees", "login")),
    }
}

/// Issue を作る（仮の番号を付ける）。画面に返す Issue を返す
pub fn enqueue_create(
    store: &mut RepoStore,
    title: String,
    body: String,
    labels: Vec<String>,
    milestone: Option<u32>,
    assignees: Option<Vec<String>>,
) -> Value {
    store.next_temp += 1;
    let temp = -store.next_temp;
    store.outbox.push(Op::CreateIssue { temp, title, body, labels, milestone, assignees, at: now() });
    find_issue(store, temp).unwrap_or(Value::Null)
}

/// Issue を変える。画面に返す Issue（変えたあと）を返す
pub fn enqueue_update(store: &mut RepoStore, number: i64, changes: Changes) -> Value {
    let base = find_issue(store, number).map(|issue| base_of(&issue, &changes));
    store.outbox.push(Op::UpdateIssue { number, changes, base, at: now() });
    find_issue(store, number).unwrap_or_else(|| json!({ "number": number, "_pending": true }))
}

/// コメントする。画面に返すコメントを返す
pub fn enqueue_comment(store: &mut RepoStore, number: i64, body: String, user: &Value) -> Value {
    store.outbox.push(Op::CreateComment { number, body, at: now() });
    comments_view(store, number, user).pop().unwrap_or(Value::Null)
}

// --- GitHub に送れたとき、手元の写しも新しくする ---

/// 作った・変えた Issue を、手元の写しに入れる（開いている・閉じたの入れ替えも）
pub fn note_issue(store: &mut RepoStore, issue: &Value) {
    let Some(number) = number_of(issue) else { return };
    let is_open = issue["state"].as_str() != Some("closed");
    for (key, keep) in [("issues:open", is_open), ("issues:closed", !is_open)] {
        // まだ一度も読んでいない一覧は作らない（読んだときに正しい内容が入る）
        let Some(raw) = store.reads.get(key) else { continue };
        let mut list: Vec<Value> = serde_json::from_str(raw).unwrap_or_default();
        let at = list.iter().position(|x| number_of(x) == Some(number));
        match (at, keep) {
            (Some(i), true) => list[i] = issue.clone(),
            (Some(i), false) => {
                list.remove(i);
            }
            (None, true) => list.insert(0, issue.clone()),
            (None, false) => {}
        }
        store.reads.insert(key.to_string(), serde_json::to_string(&list).unwrap_or_default());
    }
}

/// 送れたコメントを、手元の写しに入れる
pub fn note_comment(store: &mut RepoStore, number: i64, comment: &Value) {
    let key = format!("comments:{}", number);
    if let Some(raw) = store.reads.get(&key) {
        let mut list: Vec<Value> = serde_json::from_str(raw).unwrap_or_default();
        list.push(comment.clone());
        store.reads.insert(key, serde_json::to_string(&list).unwrap_or_default());
    }
    for key in ["issues:open", "issues:closed"] {
        let Some(raw) = store.reads.get(key) else { continue };
        let mut list: Vec<Value> = serde_json::from_str(raw).unwrap_or_default();
        if let Some(issue) = list.iter_mut().find(|x| number_of(x) == Some(number)) {
            issue["comments"] = json!(issue["comments"].as_u64().unwrap_or(0) + 1);
            store.reads.insert(key.to_string(), serde_json::to_string(&list).unwrap_or_default());
        }
    }
}

/// 仮の番号の Issue が GitHub に作られたら、残りの送信待ちの番号を本当の番号にする
pub fn remap(store: &mut RepoStore, temp: i64, real: i64) {
    store.created.insert(temp, real);
    for op in store.outbox.iter_mut() {
        match op {
            Op::UpdateIssue { number, .. } | Op::CreateComment { number, .. } if *number == temp => *number = real,
            _ => {}
        }
    }
}

pub fn push_conflict(store: &mut RepoStore, mut conflict: Conflict) {
    store.next_conflict += 1;
    conflict.id = store.next_conflict;
    store.conflicts.push(conflict);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_with(open: Value) -> RepoStore {
        let mut store = RepoStore::default();
        store.reads.insert("issues:open".into(), open.to_string());
        store.reads.insert("issues:closed".into(), "[]".into());
        store.reads.insert("labels".into(), json!([{ "name": "状態:進行中", "color": "0075ca" }]).to_string());
        store
    }

    #[test]
    fn pending_changes_are_shown_on_top_of_the_last_read() {
        let mut store = store_with(json!([{ "number": 5, "title": "牛乳", "state": "open", "labels": [], "comments": 0 }]));
        let created = enqueue_create(&mut store, "パン".into(), "".into(), vec!["状態:進行中".into()], None, None);
        assert_eq!(created["number"], json!(-1));
        assert_eq!(created["labels"][0]["color"], json!("0075ca"));
        enqueue_update(&mut store, 5, Changes { state: Some("closed".into()), ..Default::default() });
        let (open, closed) = issues_view(&store);
        assert_eq!(open.iter().map(|i| i["number"].as_i64().unwrap()).collect::<Vec<_>>(), vec![-1]);
        assert_eq!(closed[0]["number"], json!(5));
        assert_eq!(closed[0]["_pending"], json!(true));
        // 変える前の状態を覚えておく（送るときに GitHub の状態と比べる）
        match &store.outbox[1] {
            Op::UpdateIssue { base: Some(base), .. } => assert_eq!(base.state.as_deref(), Some("open")),
            other => panic!("{:?}", other),
        }
    }

    #[test]
    fn temporary_numbers_are_replaced_after_creation() {
        let mut store = store_with(json!([]));
        enqueue_create(&mut store, "パン".into(), "".into(), vec![], None, None);
        enqueue_comment(&mut store, -1, "買った".into(), &json!({ "login": "y0zrin" }));
        store.outbox.remove(0);
        remap(&mut store, -1, 66);
        assert_eq!(store.outbox[0].number(), 66);
        // 作られたあとに仮の番号で届いた変更も、本当の番号に直せる（保存して読み直しても）
        let saved: RepoStore = serde_json::from_str(&serde_json::to_string(&store).unwrap()).unwrap();
        assert_eq!(real_number(&saved, -1), 66);
    }

    #[test]
    fn pending_items_say_what_will_be_sent() {
        let mut store = store_with(json!([{ "number": 5, "title": "牛乳", "state": "open", "labels": [], "comments": 0 }]));
        enqueue_update(&mut store, 5, Changes { body: Some("- [x] 牛乳".into()), state: Some("closed".into()), ..Default::default() });
        enqueue_comment(&mut store, 5, "買った".into(), &json!({ "login": "y0zrin" }));
        let items = pending_items(&store);
        assert_eq!(items[0].action, "本文を変える、閉じる");
        assert_eq!(items[1].title, "牛乳");
    }
}
