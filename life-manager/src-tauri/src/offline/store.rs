//! 手元の写し（最後に GitHub から読んだ内容）と、送信待ちの列。リポジトリごとに、アプリのデータフォルダの JSON に保存する。
//! 画面に返す Issue は「最後に読んだ内容」に「送信待ちの変更」を重ねたもの（まだ送っていない変更には "_pending": true を付ける）
use super::config;
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

/// 送れたあとに出すお知らせ（Discord・OS）。message の「{issue}」は、送ったあとの Issue の番号（#12）にして、Issue へのリンクを付ける
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Notice {
    pub message: String,
    pub channels: Vec<String>,
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        notice: Option<Notice>,
    },
    UpdateIssue {
        number: i64,
        changes: Changes,
        /// 変更する前の値。None なら GitHub の今の値と比べずに送る（「自分の変更で上書き」）
        base: Option<Changes>,
        at: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        notice: Option<Notice>,
    },
    CreateComment {
        number: i64,
        body: String,
        at: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        notice: Option<Notice>,
    },
    /// 設定ファイル（config/*.yaml）の一部を書き換える。kind は config::KINDS のどれか
    SaveConfig {
        #[serde(rename = "config")]
        kind: String,
        /// 新しい内容（画面とやりとりする JSON）
        json: String,
        /// 変える前の内容（最初に変えたときに見ていたもの）。None なら比べずに書く
        base: Option<String>,
        at: String,
    },
    /// 日誌（journal/日付.md）のノートを書き換える
    SaveJournalNotes {
        date: String,
        notes: String,
        base: Option<String>,
        at: String,
    },
    /// 日誌を作る（つながらなかった日の分を、つながってから作る）
    GenerateJournal { date: String, at: String },
}

impl Op {
    /// どの Issue への操作か（Issue の操作でなければ 0）
    pub fn number(&self) -> i64 {
        match self {
            Op::CreateIssue { temp, .. } => *temp,
            Op::UpdateIssue { number, .. } | Op::CreateComment { number, .. } => *number,
            _ => 0,
        }
    }

    pub fn notice(&self) -> Option<&Notice> {
        match self {
            Op::CreateIssue { notice, .. } | Op::UpdateIssue { notice, .. } | Op::CreateComment { notice, .. } => {
                notice.as_ref()
            }
            _ => None,
        }
    }
}

/// 送るときに GitHub 側の変更とぶつかった・送れなかったもの。使う人に見せて決めてもらう
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Conflict {
    pub id: u64,
    pub number: i64,
    pub title: String,
    /// "title" / "body" / "state" / "milestone" / "config" / "journal" / "error"
    pub field: String,
    pub local: String,
    pub remote: String,
    /// 変える前の値（3 つを見比べられるように）
    #[serde(default)]
    pub base: String,
    pub message: String,
    /// config のときは設定の種類（routines など）、journal のときは日付
    #[serde(default)]
    pub kind: String,
    /// 「自分の変更で上書き」を選んだときに送り直す操作
    #[serde(default)]
    pub retry: Option<Op>,
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
    let Ok(text) = std::fs::read_to_string(path) else { return RepoStore::default() };
    match serde_json::from_str(&text) {
        Ok(store) => store,
        Err(e) => {
            // 読めないファイルは消さずに残しておく（送信待ちがなくならないように）
            eprintln!("オフラインの写しを読めませんでした（{}）: {}", path.display(), e);
            let _ = std::fs::copy(path, path.with_extension(format!("broken-{}.json", chrono::Utc::now().timestamp())));
            RepoStore::default()
        }
    }
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

/// 読めた内容を写す（前と同じなら書かない。大きな一覧を何度も書かないように）
pub fn remember(app: &AppHandle, owner: &str, repo: &str, key: &str, value: &str) {
    if read_store(app, owner, repo).reads.get(key).map(|v| v.as_str()) == Some(value) {
        return;
    }
    let _ = with_store(app, owner, repo, |s| {
        s.reads.insert(key.to_string(), value.to_string());
    });
}

pub fn read_global(app: &AppHandle, key: &str) -> Option<String> {
    let _lock = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    load(&global_path(app).ok()?).reads.remove(key)
}

pub fn write_global(app: &AppHandle, key: &str, value: &str) -> Result<(), String> {
    let _lock = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = global_path(app)?;
    let mut store = load(&path);
    if store.reads.get(key).map(|v| v.as_str()) == Some(value) {
        return Ok(());
    }
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

fn assignee_values(logins: &[String], current: &Value, people: &[Value]) -> Value {
    Value::Array(
        logins
            .iter()
            .map(|login| {
                current
                    .as_array()
                    .and_then(|as_| as_.iter().find(|a| a["login"].as_str() == Some(login)).cloned())
                    .or_else(|| people.iter().find(|p| p["login"].as_str() == Some(login)).cloned())
                    .unwrap_or_else(|| json!({ "login": login, "avatar_url": "" }))
            })
            .collect(),
    )
}

/// 重ねるときに使う、名前から中身を引くための一覧
struct Known {
    labels: Vec<Value>,
    milestones: Vec<Value>,
    people: Vec<Value>,
}

fn apply_changes(issue: &mut Value, changes: &Changes, known: &Known) {
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
        issue["labels"] = label_values(ls, &known.labels, &issue["labels"]);
    }
    if let Some(m) = changes.milestone {
        issue["milestone"] = milestone_value(m, &known.milestones);
    }
    if let Some(a) = &changes.assignees {
        issue["assignees"] = assignee_values(a, &issue["assignees"], &known.people);
    }
}

fn apply_op(open: &mut Vec<Value>, closed: &mut Vec<Value>, op: &Op, known: &Known) {
    match op {
        Op::CreateIssue { temp, title, body, labels: names, milestone, assignees, at, .. } => {
            let issue = json!({
                "number": temp,
                "title": title,
                "body": body,
                "state": "open",
                "labels": label_values(names, &known.labels, &Value::Null),
                "milestone": milestone_value(milestone.unwrap_or(0), &known.milestones),
                "assignees": assignee_values(assignees.as_deref().unwrap_or(&[]), &Value::Null, &known.people),
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
            apply_changes(&mut issue, changes, known);
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
        _ => {}
    }
}

/// 最後に読んだ Issue に、送信待ちの変更を重ねたもの（開いている・閉じた）
pub fn issues_view(store: &RepoStore) -> (Vec<Value>, Vec<Value>) {
    let mut open = parse_list(store, "issues:open");
    let mut closed = parse_list(store, "issues:closed");
    let known = Known {
        labels: parse_list(store, "labels"),
        milestones: parse_list(store, "milestones"),
        people: parse_list(store, "collaborators"),
    };
    for op in &store.outbox {
        apply_op(&mut open, &mut closed, op, &known);
    }
    (open, closed)
}

/// Issue のコメントに、送信待ちのコメントを重ねたもの
pub fn comments_view(store: &RepoStore, number: i64, user: &Value) -> Vec<Value> {
    let mut comments = parse_list(store, &format!("comments:{}", number));
    let login = user["login"].as_str().unwrap_or("");
    let avatar = user["avatar_url"].as_str().unwrap_or("");
    for (i, op) in store.outbox.iter().enumerate() {
        if let Op::CreateComment { number: n, body, at, .. } = op {
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

/// 送信待ちの設定の書き換え（あれば、画面にはこれを見せる）
pub fn pending_config(store: &RepoStore, key: &str) -> Option<String> {
    store.outbox.iter().rev().find_map(|op| match op {
        Op::SaveConfig { kind, json, .. } if kind == key => Some(json.clone()),
        _ => None,
    })
}

/// 送信待ちの日誌のノート
pub fn pending_journal_notes(store: &RepoStore, date: &str) -> Option<String> {
    store.outbox.iter().rev().find_map(|op| match op {
        Op::SaveJournalNotes { date: d, notes, .. } if d == date => Some(notes.clone()),
        _ => None,
    })
}

/// つながったら作る日誌か
pub fn pending_journal_generation(store: &RepoStore, date: &str) -> bool {
    store.outbox.iter().any(|op| matches!(op, Op::GenerateJournal { date: d, .. } if d == date))
}

fn find_issue(store: &RepoStore, number: i64) -> Option<Value> {
    let (open, closed) = issues_view(store);
    open.into_iter().chain(closed).find(|i| number_of(i) == Some(number))
}

/// 送信待ちの 1 件を、画面に並べる形にしたもの
#[derive(Debug, Serialize)]
pub struct PendingItem {
    /// "issue" / "config" / "journal"
    pub kind: &'static str,
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
    let item = |kind, number, title: String, action: &str, at: &String| PendingItem {
        kind,
        number,
        title,
        action: action.to_string(),
        at: at.clone(),
    };
    store
        .outbox
        .iter()
        .map(|op| match op {
            Op::CreateIssue { temp, title, at, .. } => item("issue", *temp, title.clone(), "作る", at),
            Op::UpdateIssue { number, changes, at, .. } => {
                item("issue", *number, title_of(*number), &describe_changes(changes), at)
            }
            Op::CreateComment { number, at, .. } => item("issue", *number, title_of(*number), "コメントする", at),
            Op::SaveConfig { kind, at, .. } => {
                let label = config::kind(kind).map(|k| k.label).unwrap_or("設定");
                item("config", 0, label.to_string(), "保存する", at)
            }
            Op::SaveJournalNotes { date, at, .. } => item("journal", 0, format!("{} の日誌", date), "ノートを保存する", at),
            Op::GenerateJournal { date, at } => item("journal", 0, format!("{} の日誌", date), "作る", at),
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
    notice: Option<Notice>,
) -> Value {
    store.next_temp += 1;
    let temp = -store.next_temp;
    store.outbox.push(Op::CreateIssue { temp, title, body, labels, milestone, assignees, at: now(), notice });
    find_issue(store, temp).unwrap_or(Value::Null)
}

/// Issue を変える。画面に返す Issue（変えたあと）を返す
pub fn enqueue_update(store: &mut RepoStore, number: i64, changes: Changes, notice: Option<Notice>) -> Value {
    let base = find_issue(store, number).map(|issue| base_of(&issue, &changes));
    store.outbox.push(Op::UpdateIssue { number, changes, base, at: now(), notice });
    find_issue(store, number).unwrap_or_else(|| json!({ "number": number, "_pending": true }))
}

/// コメントする。画面に返すコメントを返す
pub fn enqueue_comment(store: &mut RepoStore, number: i64, body: String, user: &Value, notice: Option<Notice>) -> Value {
    store.outbox.push(Op::CreateComment { number, body, at: now(), notice });
    comments_view(store, number, user).pop().unwrap_or(Value::Null)
}

/// 設定の書き換えを並べる。同じ設定の前の書き換えは外し（最後のものだけを送る）、変える前の内容は最初のものを使う。
/// 前のものを外して後ろに並べるのは、リマインダーが、先に並んでいる Issue の作成より後に送られるようにするため
pub fn enqueue_config(store: &mut RepoStore, key: &str, json: String) {
    let mut base = store.reads.get(&format!("config:{}", key)).cloned();
    store.outbox.retain(|op| match op {
        Op::SaveConfig { kind, base: earlier, .. } if kind == key => {
            base = earlier.clone();
            false
        }
        _ => true,
    });
    store.outbox.push(Op::SaveConfig { kind: key.to_string(), json, base, at: now() });
}

/// 日誌のノートの書き換えを並べる（同じ日の前の書き換えは外す）。base_now は今見えているノート
pub fn enqueue_journal_notes(store: &mut RepoStore, date: &str, notes: String, base_now: Option<String>) {
    let mut base = base_now;
    store.outbox.retain(|op| match op {
        Op::SaveJournalNotes { date: d, base: earlier, .. } if d == date => {
            base = earlier.clone();
            false
        }
        _ => true,
    });
    store.outbox.push(Op::SaveJournalNotes { date: date.to_string(), notes, base, at: now() });
}

/// つながったら日誌を作る
pub fn enqueue_generate_journal(store: &mut RepoStore, date: &str) {
    if !pending_journal_generation(store, date) {
        store.outbox.push(Op::GenerateJournal { date: date.to_string(), at: now() });
    }
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

// --- サブイシュー（親子） ---

/// 手元の写しの Issue（開いている・閉じた）のうち、pred に合うものを書き換える
fn edit_issues(store: &mut RepoStore, pred: impl Fn(&Value) -> bool, mut f: impl FnMut(&mut Value)) {
    for key in ["issues:open", "issues:closed"] {
        let Some(raw) = store.reads.get(key) else { continue };
        let mut list: Vec<Value> = serde_json::from_str(raw).unwrap_or_default();
        let mut changed = false;
        for issue in list.iter_mut().filter(|x| pred(x)) {
            f(issue);
            changed = true;
        }
        if changed {
            store.reads.insert(key.to_string(), serde_json::to_string(&list).unwrap_or_default());
        }
    }
}

fn find_issue_where(store: &RepoStore, pred: impl Fn(&Value) -> bool) -> Option<Value> {
    ["issues:open", "issues:closed"].iter().flat_map(|key| parse_list(store, key)).find(|x| pred(x))
}

/// 子の数（total）と、そのうち閉じた数（completed）を増やす・減らす
fn adjust_summary(issue: &mut Value, total: i64, completed: i64) {
    let s = &issue["sub_issues_summary"];
    let t = (s["total"].as_i64().unwrap_or(0) + total).max(0);
    let c = (s["completed"].as_i64().unwrap_or(0) + completed).clamp(0, t);
    let percent = if t > 0 { (c * 100 + t / 2) / t } else { 0 };
    issue["sub_issues_summary"] = json!({ "total": t, "completed": c, "percent_completed": percent });
}

/// サブイシューをつないだ（linked）・外したことを、手元の写しに入れる（親の「子の数」と、子の「親」）。
/// 子は id で探す（GitHub の API が id で指すため）。次に GitHub から読めば、GitHub の内容に置き換わる
pub fn note_sub_issue(store: &mut RepoStore, parent: i64, child_id: i64, linked: bool) {
    let child = find_issue_where(store, |x| x["id"].as_i64() == Some(child_id));
    let done = child.as_ref().map_or(0, |c| (c["state"].as_str() == Some("closed")) as i64);
    let old_parent = child.as_ref().and_then(|c| c["parent_issue_url"].as_str().map(String::from));
    let is_child = |x: &Value| x["id"].as_i64() == Some(child_id);
    let is_parent = |x: &Value| number_of(x) == Some(parent);
    if !linked {
        edit_issues(store, is_parent, |x| adjust_summary(x, -1, -done));
        edit_issues(store, is_child, |x| x["parent_issue_url"] = Value::Null);
        return;
    }
    // 親の API の URL（子の parent_issue_url と同じ形）
    let parent_url = find_issue_where(store, is_parent)
        .and_then(|p| p["url"].as_str().map(String::from))
        .or_else(|| child.as_ref().and_then(|c| c["repository_url"].as_str()).map(|r| format!("{}/issues/{}", r, parent)));
    if old_parent.is_some() && old_parent == parent_url {
        return;
    }
    if let Some(old) = &old_parent {
        // ほかの親から付け替えた
        edit_issues(store, |x| x["url"].as_str() == Some(old.as_str()), |x| adjust_summary(x, -1, -done));
    }
    edit_issues(store, is_parent, |x| adjust_summary(x, 1, done));
    edit_issues(store, is_child, |x| x["parent_issue_url"] = parent_url.clone().map_or(Value::Null, Value::String));
}

/// 文章の中の、仮の番号への参照（#-1）を本当の番号（#66）に直す（#-10 のような別の番号は直さない）
pub fn rewrite_refs(text: &str, temp: i64, real: i64) -> String {
    let pattern = format!("#{}", temp);
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find(&pattern) {
        let after = &rest[i + pattern.len()..];
        out.push_str(&rest[..i]);
        if after.starts_with(|c: char| c.is_ascii_digit()) {
            out.push_str(&pattern);
        } else {
            out.push_str(&format!("#{}", real));
        }
        rest = after;
    }
    out.push_str(rest);
    out
}

/// リマインダーの一覧（JSON）の、仮の番号を本当の番号に直す
fn rewrite_reminders(json: &str, temp: i64, real: i64) -> String {
    let Ok(mut list) = serde_json::from_str::<Vec<Value>>(json) else { return json.to_string() };
    for reminder in list.iter_mut() {
        if reminder["issue_number"].as_i64() == Some(temp) {
            reminder["issue_number"] = json!(real);
        }
    }
    serde_json::to_string(&list).unwrap_or_else(|_| json.to_string())
}

/// 仮の番号の Issue が GitHub に作られたら、残りの送信待ちの番号と、本文・コメント・リマインダーの中の参照を本当の番号にする
pub fn remap(store: &mut RepoStore, temp: i64, real: i64) {
    store.created.insert(temp, real);
    for op in store.outbox.iter_mut() {
        match op {
            Op::CreateIssue { body, .. } => *body = rewrite_refs(body, temp, real),
            Op::UpdateIssue { number, changes, base, .. } => {
                if *number == temp {
                    *number = real;
                }
                if let Some(body) = changes.body.as_mut() {
                    *body = rewrite_refs(body, temp, real);
                }
                if let Some(body) = base.as_mut().and_then(|b| b.body.as_mut()) {
                    *body = rewrite_refs(body, temp, real);
                }
            }
            Op::CreateComment { number, body, .. } => {
                if *number == temp {
                    *number = real;
                }
                *body = rewrite_refs(body, temp, real);
            }
            Op::SaveConfig { kind, json, .. } if kind == "reminders" => *json = rewrite_reminders(json, temp, real),
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
        let created = enqueue_create(&mut store, "パン".into(), "".into(), vec!["状態:進行中".into()], None, None, None);
        assert_eq!(created["number"], json!(-1));
        assert_eq!(created["labels"][0]["color"], json!("0075ca"));
        enqueue_update(&mut store, 5, Changes { state: Some("closed".into()), ..Default::default() }, None);
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
    fn linking_sub_issues_updates_the_counts_and_the_parent() {
        let url = |n: i64| format!("https://api.github.com/repos/o/r/issues/{}", n);
        let issue = |n: i64, id: i64| json!({ "number": n, "id": id, "url": url(n), "state": "open", "labels": [], "parent_issue_url": null });
        let mut store = store_with(json!([issue(45, 450), issue(46, 460), issue(47, 470)]));
        store.reads.insert(
            "issues:closed".into(),
            json!([{ "number": 48, "id": 480, "url": url(48), "state": "closed", "labels": [], "parent_issue_url": null }]).to_string(),
        );
        let get = |s: &RepoStore, n: i64| find_issue_where(s, |x| number_of(x) == Some(n)).unwrap();
        let summary = |s: &RepoStore, n: i64| {
            let v = get(s, n);
            (v["sub_issues_summary"]["total"].as_i64().unwrap_or(0), v["sub_issues_summary"]["completed"].as_i64().unwrap_or(0))
        };

        // 開いている子と、閉じた子をつなぐ
        note_sub_issue(&mut store, 45, 460, true);
        note_sub_issue(&mut store, 45, 480, true);
        assert_eq!(summary(&store, 45), (2, 1));
        assert_eq!(get(&store, 46)["parent_issue_url"], json!(url(45)));
        assert_eq!(get(&store, 48)["parent_issue_url"], json!(url(45)));
        // 同じ親に二度つないでも、数は増えない
        note_sub_issue(&mut store, 45, 460, true);
        assert_eq!(summary(&store, 45), (2, 1));
        // ほかの親（#47）に付け替えると、前の親の数が減る
        note_sub_issue(&mut store, 47, 480, true);
        assert_eq!((summary(&store, 45), summary(&store, 47)), ((1, 0), (1, 1)));
        assert_eq!(get(&store, 48)["parent_issue_url"], json!(url(47)));
        // 外すと、親の数が減り、子の親がなくなる
        note_sub_issue(&mut store, 45, 460, false);
        assert_eq!(summary(&store, 45), (0, 0));
        assert_eq!(get(&store, 46)["parent_issue_url"], Value::Null);
    }

    #[test]
    fn temporary_numbers_are_replaced_after_creation() {
        let mut store = store_with(json!([]));
        enqueue_create(&mut store, "パン".into(), "".into(), vec![], None, None, None);
        enqueue_comment(&mut store, -1, "買った".into(), &json!({ "login": "y0zrin" }), None);
        store.outbox.remove(0);
        remap(&mut store, -1, 66);
        assert_eq!(store.outbox[0].number(), 66);
        // 作られたあとに仮の番号で届いた変更も、本当の番号に直せる（保存して読み直しても）
        let saved: RepoStore = serde_json::from_str(&serde_json::to_string(&store).unwrap()).unwrap();
        assert_eq!(real_number(&saved, -1), 66);
    }

    #[test]
    fn references_in_bodies_and_reminders_follow_the_real_number() {
        let mut store = store_with(json!([]));
        enqueue_create(&mut store, "設計".into(), "".into(), vec![], None, None, None);
        enqueue_create(&mut store, "実装".into(), "#-1 のあと\n<!-- depends:#-1,#-10 -->".into(), vec![], None, None, None);
        enqueue_config(&mut store, "reminders", r#"[{"issue_number":-1,"title":"設計","datetime":"2026-10-01T09:00","channels":["os"]}]"#.into());
        store.outbox.remove(0);
        remap(&mut store, -1, 66);
        match &store.outbox[0] {
            Op::CreateIssue { body, .. } => assert_eq!(body, "#66 のあと\n<!-- depends:#66,#-10 -->"),
            other => panic!("{:?}", other),
        }
        assert!(pending_config(&store, "reminders").unwrap().contains(r#""issue_number":66"#));
    }

    #[test]
    fn only_the_latest_setting_is_sent_and_it_goes_to_the_end() {
        let mut store = store_with(json!([]));
        store.reads.insert("config:routines".into(), "[]".into());
        enqueue_config(&mut store, "routines", r#"[{"name":"A"}]"#.into());
        enqueue_create(&mut store, "パン".into(), "".into(), vec![], None, None, None);
        enqueue_config(&mut store, "routines", r#"[{"name":"B"}]"#.into());
        assert_eq!(store.outbox.len(), 2);
        match &store.outbox[1] {
            // 変える前の内容は、最初に変えたときのもの
            Op::SaveConfig { json, base, .. } => {
                assert_eq!(json, r#"[{"name":"B"}]"#);
                assert_eq!(base.as_deref(), Some("[]"));
            }
            other => panic!("{:?}", other),
        }
    }

    #[test]
    fn pending_items_say_what_will_be_sent() {
        let mut store = store_with(json!([{ "number": 5, "title": "牛乳", "state": "open", "labels": [], "comments": 0 }]));
        enqueue_update(&mut store, 5, Changes { body: Some("- [x] 牛乳".into()), state: Some("closed".into()), ..Default::default() }, None);
        enqueue_comment(&mut store, 5, "買った".into(), &json!({ "login": "y0zrin" }), None);
        enqueue_generate_journal(&mut store, "2026-09-27");
        let items = pending_items(&store);
        assert_eq!(items[0].action, "本文を変える、閉じる");
        assert_eq!(items[1].title, "牛乳");
        assert_eq!((items[2].kind, items[2].title.as_str()), ("journal", "2026-09-27 の日誌"));
    }
}
