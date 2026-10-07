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

/// 送信待ちの変更で書き換える項目（None は変えない）。milestone の 0 は「外す」、負の数は仮の番号のマイルストーン（#272）
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
    pub milestone: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assignees: Option<Vec<String>>,
    /// 閉じるときの理由（completed / not_planned / duplicate）。state を変えるときだけ使われる
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state_reason: Option<String>,
    /// 重複として閉じるときの、元の Issue の id（番号ではない）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duplicate_issue_id: Option<u64>,
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
        milestone: Option<i64>,
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
    /// マイルストーンを作る。仮の番号（-1, -2, …）は Issue の仮の番号とは別に数える（#272）
    CreateMilestone {
        temp: i64,
        title: String,
        description: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        due_on: Option<String>,
        at: String,
    },
    /// マイルストーンを変える・閉じる・開き直す（None は変えない。due_on の "" は期限を外す）
    UpdateMilestone {
        number: i64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        due_on: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        state: Option<String>,
        at: String,
    },
    /// 子にする（#273）。親も子も Issue の番号（まだ GitHub にない Issue は仮の番号）。子の GitHub の id は送るときに引く。
    /// replace_parent なら、ほかの親から付け替える
    AddSubIssue { parent: i64, child: i64, replace_parent: bool, at: String },
    /// 子から外す（#273）
    RemoveSubIssue { parent: i64, child: i64, at: String },
}

impl Op {
    /// どの Issue への操作か（Issue の操作でなければ 0。親子の操作は子）
    pub fn number(&self) -> i64 {
        match self {
            Op::CreateIssue { temp, .. } => *temp,
            Op::UpdateIssue { number, .. } | Op::CreateComment { number, .. } => *number,
            Op::AddSubIssue { child, .. } | Op::RemoveSubIssue { child, .. } => *child,
            _ => 0,
        }
    }

    /// この Issue を使う操作か（親子の操作は、親も子も）
    pub fn refers_to(&self, n: i64) -> bool {
        match self {
            Op::AddSubIssue { parent, child, .. } | Op::RemoveSubIssue { parent, child, .. } => *parent == n || *child == n,
            _ => self.number() == n,
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
    /// 最後に使ったマイルストーンの仮の番号（#272）
    #[serde(default)]
    pub next_temp_milestone: i64,
    /// GitHub に作れたマイルストーンの、仮の番号 → 本当の番号
    #[serde(default)]
    pub created_milestones: HashMap<i64, i64>,
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

fn milestone_value(number: i64, known: &[Value]) -> Value {
    if number == 0 {
        return Value::Null;
    }
    known
        .iter()
        .find(|m| m["number"].as_i64() == Some(number))
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
            // 閉じた日時（タスク画面の分析で、閉じた数を週ごとに数える）
            if was_open && !is_open {
                issue["closed_at"] = json!(at);
            } else if !was_open && is_open {
                issue["closed_at"] = Value::Null;
            }
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
        Op::AddSubIssue { parent, child, .. } => link_in_view(open, closed, *parent, *child, true),
        Op::RemoveSubIssue { parent, child, .. } => link_in_view(open, closed, *parent, *child, false),
        _ => {}
    }
}

/// 一覧の Issue の API の頭（`https://api.github.com/repos/o/r`）。どれかの Issue の repository_url から
fn repository_url(open: &[Value], closed: &[Value]) -> Option<String> {
    open.iter().chain(closed.iter()).find_map(|x| x["repository_url"].as_str().map(String::from))
}

/// 親の Issue の番号（parent_issue_url の最後。このリポジトリの Issue のときだけ。仮の番号の親は -1 など）
fn parent_number(issue: &Value, repo_url: Option<&str>) -> Option<i64> {
    let url = issue["parent_issue_url"].as_str()?;
    let (head, n) = url.rsplit_once("/issues/")?;
    if repo_url.is_some_and(|r| r != head) {
        return None;
    }
    n.parse().ok()
}

/// 送信待ちの「子にする」「子から外す」を一覧に重ねる（親の子の数と、子の親。#273）。子は番号で探す
fn link_in_view(open: &mut [Value], closed: &mut [Value], parent: i64, child: i64, linked: bool) {
    let repo_url = repository_url(open, closed);
    let Some(found) = open.iter().chain(closed.iter()).find(|x| number_of(x) == Some(child)) else { return };
    let done = (found["state"].as_str() == Some("closed")) as i64;
    let old = parent_number(found, repo_url.as_deref());
    let mut edit = |n: i64, f: &dyn Fn(&mut Value)| {
        for x in open.iter_mut().chain(closed.iter_mut()).filter(|x| number_of(x) == Some(n)) {
            f(x);
        }
    };
    if !linked {
        // この親の子のときだけ外す
        if old == Some(parent) {
            edit(parent, &|x| adjust_summary(x, -1, -done));
            edit(child, &|x| {
                x["parent_issue_url"] = Value::Null;
                x["_pending"] = json!(true);
            });
        }
        return;
    }
    if old == Some(parent) {
        return;
    }
    if let Some(o) = old {
        // ほかの親から付け替えた
        edit(o, &|x| adjust_summary(x, -1, -done));
    }
    edit(parent, &|x| adjust_summary(x, 1, done));
    let url = repo_url.map(|r| format!("{}/issues/{}", r, parent));
    edit(child, &|x| {
        x["parent_issue_url"] = url.clone().map_or(Value::Null, Value::String);
        x["_pending"] = json!(true);
    });
}

/// サブイシューの一覧（前に読んだもの base）に、送信待ちの付ける・外すを重ねる（#273）。
/// 子の中身も、送信待ちの変更を重ねたものにする（つながらないあいだに閉じた子は、閉じたと出る）
pub fn sub_issues_view(store: &RepoStore, parent: i64, base: Vec<Value>) -> Vec<Value> {
    let (open, closed) = issues_view(store);
    let issue = |n: i64| open.iter().chain(closed.iter()).find(|x| number_of(x) == Some(n)).cloned();
    let mut list: Vec<Value> = base.into_iter().map(|c| number_of(&c).and_then(issue).unwrap_or(c)).collect();
    for op in &store.outbox {
        match op {
            Op::AddSubIssue { parent: p, child, .. } if *p == parent => {
                if !list.iter().any(|x| number_of(x) == Some(*child)) {
                    if let Some(mut c) = issue(*child) {
                        c["_pending"] = json!(true);
                        list.push(c);
                    }
                }
            }
            // ほかの親へ付け替えた・この親から外した
            Op::AddSubIssue { child, .. } => list.retain(|x| number_of(x) != Some(*child)),
            Op::RemoveSubIssue { parent: p, child, .. } if *p == parent => list.retain(|x| number_of(x) != Some(*child)),
            _ => {}
        }
    }
    list
}

/// 一覧の中で、親がこの Issue のもの（サブイシューの一覧を前に読んでいないとき、つながらないあいだに使う。#273）
pub fn children_in_view(store: &RepoStore, parent: i64) -> Vec<Value> {
    let (open, closed) = issues_view(store);
    let repo_url = repository_url(&open, &closed);
    open.into_iter().chain(closed).filter(|x| parent_number(x, repo_url.as_deref()) == Some(parent)).collect()
}

/// Issue の GitHub の id（写しから。子にする・外すを送るとき。#273）
pub fn issue_id(store: &RepoStore, number: i64) -> Option<u64> {
    ["issues:open", "issues:closed"]
        .iter()
        .flat_map(|key| parse_list(store, key))
        .find(|x| number_of(x) == Some(number))
        .and_then(|x| x["id"].as_u64())
}

/// 最後に読んだ Issue に、送信待ちの変更を重ねたもの（開いている・閉じた）
pub fn issues_view(store: &RepoStore) -> (Vec<Value>, Vec<Value>) {
    let mut open = parse_list(store, "issues:open");
    let mut closed = parse_list(store, "issues:closed");
    let known = Known {
        labels: parse_list(store, "labels"),
        // 送信待ちで作ったマイルストーンも、名前を引けるように
        milestones: milestones_view(store),
        people: parse_list(store, "collaborators"),
    };
    for op in &store.outbox {
        apply_op(&mut open, &mut closed, op, &known);
    }
    (open, closed)
}

/// 最後に読んだ（開いている）マイルストーンに、送信待ちの作る・変える・閉じるを重ねたもの（#272）。
/// 閉じたものは一覧から外す（GitHub から読む一覧も、開いているものだけのため）
pub fn milestones_view(store: &RepoStore) -> Vec<Value> {
    let mut list = parse_list(store, "milestones");
    for op in &store.outbox {
        match op {
            Op::CreateMilestone { temp, title, description, due_on, at } => list.push(json!({
                "number": temp,
                "title": title,
                "description": description,
                "due_on": due_on.clone().filter(|d| !d.is_empty()),
                "state": "open",
                "open_issues": 0,
                "closed_issues": 0,
                "created_at": at,
                "updated_at": at,
                "closed_at": null,
                "_pending": true,
            })),
            Op::UpdateMilestone { number, title, description, due_on, state, at } => {
                let Some(i) = list.iter().position(|m| m["number"].as_i64() == Some(*number)) else { continue };
                if state.as_deref() == Some("closed") {
                    list.remove(i);
                    continue;
                }
                let m = &mut list[i];
                if let Some(t) = title {
                    m["title"] = json!(t);
                }
                if let Some(d) = description {
                    m["description"] = json!(d);
                }
                if let Some(d) = due_on {
                    m["due_on"] = if d.is_empty() { Value::Null } else { json!(d) };
                }
                m["updated_at"] = json!(at);
                m["_pending"] = json!(true);
            }
            _ => {}
        }
    }
    list
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

/// 送信待ちの日誌の日（つながったら作る日誌・まだ送っていないノート）
pub fn pending_journal_dates(store: &RepoStore) -> Vec<String> {
    store
        .outbox
        .iter()
        .filter_map(|op| match op {
            Op::GenerateJournal { date, .. } | Op::SaveJournalNotes { date, .. } => Some(date.clone()),
            _ => None,
        })
        .collect()
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
            Op::CreateMilestone { title, at, .. } => item("milestone", 0, title.clone(), "作る", at),
            Op::UpdateMilestone { number, title, state, at, .. } => {
                let name = title.clone().unwrap_or_else(|| milestone_title(store, *number));
                let action = match state.as_deref() {
                    Some("closed") => "閉じる",
                    Some(_) => "開き直す",
                    None => "変える",
                };
                item("milestone", 0, name, action, at)
            }
            Op::AddSubIssue { parent, child, at, .. } => {
                item("issue", *child, title_of(*child), &format!("{} の子にする", super::issue_ref(*parent)), at)
            }
            Op::RemoveSubIssue { parent, child, at } => {
                item("issue", *child, title_of(*child), &format!("{} の子から外す", super::issue_ref(*parent)), at)
            }
        })
        .collect()
}

/// マイルストーンの名前（写しと、送信待ちの作る・名前を変えるのうち、いちばん新しいもの。閉じたものも引ける。わからなければ番号）
fn milestone_title(store: &RepoStore, number: i64) -> String {
    let mut name = parse_list(store, "milestones")
        .iter()
        .find(|m| m["number"].as_i64() == Some(number))
        .and_then(|m| m["title"].as_str().map(String::from));
    for op in &store.outbox {
        match op {
            Op::CreateMilestone { temp, title, .. } if *temp == number => name = Some(title.clone()),
            Op::UpdateMilestone { number: n, title: Some(title), .. } if *n == number => name = Some(title.clone()),
            _ => {}
        }
    }
    name.unwrap_or_else(|| format!("#{}", number))
}

/// 仮の番号のマイルストーンがもう GitHub に作られていれば、本当の番号にする（#272）
pub fn real_milestone(store: &RepoStore, number: i64) -> i64 {
    if number < 0 {
        store.created_milestones.get(&number).copied().unwrap_or(number)
    } else {
        number
    }
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
        milestone: changes.milestone.map(|_| issue["milestone"]["number"].as_i64().unwrap_or(0)),
        assignees: changes.assignees.as_ref().map(|_| names("assignees", "login")),
        ..Default::default()
    }
}

/// Issue を作る（仮の番号を付ける）。画面に返す Issue を返す
pub fn enqueue_create(
    store: &mut RepoStore,
    title: String,
    body: String,
    labels: Vec<String>,
    milestone: Option<i64>,
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

/// マイルストーンを作る（仮の番号を付ける。#272）。画面に返すマイルストーンを返す
pub fn enqueue_create_milestone(store: &mut RepoStore, title: String, description: String, due_on: Option<String>) -> Value {
    store.next_temp_milestone += 1;
    let temp = -store.next_temp_milestone;
    store.outbox.push(Op::CreateMilestone { temp, title, description, due_on, at: now() });
    milestones_view(store).into_iter().find(|m| m["number"].as_i64() == Some(temp)).unwrap_or(Value::Null)
}

/// マイルストーンを変える・閉じる・開き直す（#272）。画面に返すマイルストーン（閉じたなら閉じた形）を返す
pub fn enqueue_update_milestone(
    store: &mut RepoStore,
    number: i64,
    title: Option<String>,
    description: Option<String>,
    due_on: Option<String>,
    state: Option<String>,
) -> Value {
    let number = real_milestone(store, number);
    let before = milestones_view(store).into_iter().find(|m| m["number"].as_i64() == Some(number));
    let closing = state.as_deref() == Some("closed");
    store.outbox.push(Op::UpdateMilestone { number, title, description, due_on, state: state.clone(), at: now() });
    let after = milestones_view(store).into_iter().find(|m| m["number"].as_i64() == Some(number));
    match (after, before) {
        (Some(m), _) => m,
        (None, Some(mut m)) if closing => {
            m["state"] = json!("closed");
            m["closed_at"] = json!(now());
            m["_pending"] = json!(true);
            m
        }
        _ => json!({ "number": number, "state": state.unwrap_or_else(|| "open".into()), "_pending": true }),
    }
}

/// つながったら日誌を作る
/// 子にする・子から外すを送信待ちに並べる（#273）。重ねたあとの子を返す（画面は _pending で「未送信」を出す）
pub fn enqueue_sub_issue(store: &mut RepoStore, parent: i64, child: i64, linked: bool, replace_parent: bool) -> Value {
    let at = now();
    store.outbox.push(if linked {
        Op::AddSubIssue { parent, child, replace_parent, at }
    } else {
        Op::RemoveSubIssue { parent, child, at }
    });
    let mut view = find_issue(store, child).unwrap_or_else(|| json!({ "number": child }));
    view["_pending"] = json!(true);
    view
}

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

/// 読み直しで使う since: 写しの Issue（開いている・閉じた）のいちばん新しい updated_at（GitHub の時刻なので、この PC の時計のずれに左右されない）。
/// どちらかの一覧をまだ読んでいなければ None（全部読む。#269）
pub fn latest_updated(store: &RepoStore) -> Option<String> {
    if !store.reads.contains_key("issues:open") || !store.reads.contains_key("issues:closed") {
        return None;
    }
    ["issues:open", "issues:closed"]
        .iter()
        .flat_map(|key| parse_list(store, key))
        .filter_map(|issue| issue["updated_at"].as_str().map(String::from))
        .max()
}

/// 読み直した Issue（since より後に変わったもの）を、写しに入れる（開いている・閉じたの入れ替えも。#269）
pub fn note_refreshed(store: &mut RepoStore, issues: &[Value]) {
    for issue in issues {
        note_issue(store, issue);
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
            Op::AddSubIssue { parent, child, .. } | Op::RemoveSubIssue { parent, child, .. } => {
                if *parent == temp {
                    *parent = real;
                }
                if *child == temp {
                    *child = real;
                }
            }
            _ => {}
        }
    }
}

/// 仮の番号のマイルストーンが GitHub に作られたら、残りの送信待ちの番号を本当の番号にする（#272）
pub fn remap_milestone(store: &mut RepoStore, temp: i64, real: i64) {
    store.created_milestones.insert(temp, real);
    let fix = |m: &mut Option<i64>| {
        if *m == Some(temp) {
            *m = Some(real);
        }
    };
    for op in store.outbox.iter_mut() {
        match op {
            Op::CreateIssue { milestone, .. } => fix(milestone),
            Op::UpdateIssue { changes, base, .. } => {
                fix(&mut changes.milestone);
                if let Some(b) = base.as_mut() {
                    fix(&mut b.milestone);
                }
            }
            Op::UpdateMilestone { number, .. } if *number == temp => *number = real,
            _ => {}
        }
    }
}

/// 作った・変えたマイルストーンを、手元の写し（開いているものの一覧）に入れる。閉じたものは外す（#272）
pub fn note_milestone(store: &mut RepoStore, milestone: &Value) {
    let Some(number) = milestone["number"].as_i64() else { return };
    let Some(raw) = store.reads.get("milestones") else { return };
    let mut list: Vec<Value> = serde_json::from_str(raw).unwrap_or_default();
    let at = list.iter().position(|m| m["number"].as_i64() == Some(number));
    let open = milestone["state"].as_str() != Some("closed");
    match (at, open) {
        (Some(i), true) => list[i] = milestone.clone(),
        (Some(i), false) => {
            list.remove(i);
        }
        (None, true) => list.push(milestone.clone()),
        (None, false) => {}
    }
    store.reads.insert("milestones".to_string(), serde_json::to_string(&list).unwrap_or_default());
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
        assert!(closed[0]["closed_at"].is_string());
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
    fn refreshing_uses_the_newest_github_time_and_moves_issues_between_lists() {
        // UT-31・UT-32（#269）
        let mut store = store_with(json!([
            { "number": 1, "title": "牛乳", "state": "open", "labels": [], "updated_at": "2026-10-07T01:00:00Z" },
            { "number": 2, "title": "パン", "state": "open", "labels": [], "updated_at": "2026-10-07T03:00:00Z" },
        ]));
        assert_eq!(latest_updated(&store).as_deref(), Some("2026-10-07T03:00:00Z"));
        // まだ読んでいない一覧があれば、全部読む
        assert_eq!(latest_updated(&RepoStore::default()), None);

        // 自分の送信待ち（#2 のタイトル）
        enqueue_update(&mut store, 2, Changes { title: Some("食パン".into()), ..Default::default() }, None);
        // 仲間が #1 を閉じ、#3 を作った
        note_refreshed(
            &mut store,
            &[
                json!({ "number": 1, "title": "牛乳", "state": "closed", "labels": [{ "name": "状態:完了" }], "updated_at": "2026-10-07T04:00:00Z" }),
                json!({ "number": 3, "title": "卵", "state": "open", "labels": [], "updated_at": "2026-10-07T04:01:00Z" }),
            ],
        );
        let (open, closed) = issues_view(&store);
        let numbers = |list: &Vec<Value>| list.iter().map(|i| i["number"].as_i64().unwrap()).collect::<Vec<_>>();
        assert_eq!(numbers(&open), vec![3, 2]);
        assert_eq!(numbers(&closed), vec![1]);
        assert_eq!(closed[0]["labels"][0]["name"], json!("状態:完了"));
        // 送信待ちの変更は、読み直したあとも上に重なっている
        assert_eq!(open[1]["title"], json!("食パン"));
        assert_eq!(open[1]["_pending"], json!(true));
        assert_eq!(latest_updated(&store).as_deref(), Some("2026-10-07T04:01:00Z"));
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

    #[test]
    fn milestones_made_offline_are_shown_and_follow_the_real_number() {
        // UT-33・UT-34・UT-40（#272）
        let mut store = store_with(json!([{ "number": 5, "title": "牛乳", "state": "open", "labels": [], "milestone": null }]));
        store.reads.insert("milestones".into(), json!([{ "number": 3, "title": "スプリント3", "state": "open" }]).to_string());
        // 作る: Issue の仮の番号とは別に数える
        enqueue_create(&mut store, "パン".into(), "".into(), vec![], None, None, None);
        let made = enqueue_create_milestone(&mut store, "スプリント4".into(), "敵".into(), Some("2026-10-20T00:00:00Z".into()));
        assert_eq!(made["number"], json!(-1));
        assert_eq!(made["_pending"], json!(true));
        // 仮の番号のマイルストーンに Issue を入れると、名前が引ける
        enqueue_update(&mut store, 5, Changes { milestone: Some(-1), ..Default::default() }, None);
        let (open, _) = issues_view(&store);
        let milk = open.iter().find(|i| i["number"] == json!(5)).unwrap();
        assert_eq!(milk["milestone"]["title"], json!("スプリント4"));
        // 変える・閉じる
        enqueue_update_milestone(&mut store, 3, Some("スプリント3（延長）".into()), None, Some("".into()), None);
        let view = milestones_view(&store);
        assert_eq!(view.iter().map(|m| m["number"].as_i64().unwrap()).collect::<Vec<_>>(), vec![3, -1]);
        assert_eq!(view[0]["title"], json!("スプリント3（延長）"));
        assert_eq!(view[0]["due_on"], Value::Null);
        let closed = enqueue_update_milestone(&mut store, 3, None, None, None, Some("closed".into()));
        assert_eq!(closed["state"], json!("closed"));
        assert_eq!(milestones_view(&store).len(), 1);
        // 送信待ちの一覧の文
        let items = pending_items(&store);
        let ms: Vec<(&str, &str)> = items.iter().filter(|i| i.kind == "milestone").map(|i| (i.title.as_str(), i.action.as_str())).collect();
        assert_eq!(ms, vec![("スプリント4", "作る"), ("スプリント3（延長）", "変える"), ("スプリント3（延長）", "閉じる")]);
        // 作れたら、あとの送信待ちの番号が本当の番号になる
        remap_milestone(&mut store, -1, 4);
        match &store.outbox[2] {
            Op::UpdateIssue { changes, .. } => assert_eq!(changes.milestone, Some(4)),
            other => panic!("{:?}", other),
        }
        assert_eq!(real_milestone(&store, -1), 4);
        assert_eq!(real_milestone(&store, 3), 3);
    }

    #[test]
    fn outboxes_saved_before_milestones_became_i64_still_load() {
        // UT-35（#272）: 前の版で保存した送信待ち（milestone が u32）も読める
        let old = r#"{"outbox":[{"kind":"update_issue","number":5,"changes":{"milestone":3},"base":{"milestone":0},"at":"2026-10-01T00:00:00Z"},{"kind":"create_issue","temp":-1,"title":"パン","body":"","labels":[],"milestone":2,"assignees":null,"at":"2026-10-01T00:00:00Z"}],"next_temp":1}"#;
        let store: RepoStore = serde_json::from_str(old).unwrap();
        match &store.outbox[0] {
            Op::UpdateIssue { changes, base: Some(base), .. } => assert_eq!((changes.milestone, base.milestone), (Some(3), Some(0))),
            other => panic!("{:?}", other),
        }
        assert!(matches!(&store.outbox[1], Op::CreateIssue { milestone: Some(2), .. }));
        assert_eq!(store.next_temp_milestone, 0);
    }

    fn issue(number: i64, id: i64, state: &str, parent: Option<i64>) -> Value {
        let repo = "https://api.github.com/repos/o/r";
        json!({
            "number": number, "id": id, "title": format!("課題{}", number), "state": state,
            "url": format!("{}/issues/{}", repo, number), "repository_url": repo,
            "parent_issue_url": parent.map(|p| format!("{}/issues/{}", repo, p)),
            "labels": [], "assignees": [],
        })
    }

    fn summary(store: &RepoStore, n: i64) -> (i64, i64) {
        let (open, closed) = issues_view(store);
        let v = open.into_iter().chain(closed).find(|i| number_of(i) == Some(n)).unwrap();
        (v["sub_issues_summary"]["total"].as_i64().unwrap_or(0), v["sub_issues_summary"]["completed"].as_i64().unwrap_or(0))
    }

    fn parent_of(store: &RepoStore, n: i64) -> Option<String> {
        let (open, closed) = issues_view(store);
        open.into_iter().chain(closed).find(|i| number_of(i) == Some(n)).and_then(|i| i["parent_issue_url"].as_str().map(String::from))
    }

    // UT-36: 付ける・外すが issues_view の親の数と子の親に重なる。仮の番号の子は、作られたら本当の番号になる
    #[test]
    fn pending_sub_issue_links_show_in_the_view() {
        let mut store = RepoStore::default();
        store.reads.insert("issues:open".into(), json!([issue(10, 100, "open", None), issue(11, 110, "open", None), issue(20, 200, "open", None)]).to_string());
        store.reads.insert("issues:closed".into(), json!([issue(12, 120, "closed", None)]).to_string());

        let child = enqueue_sub_issue(&mut store, 10, 12, true, false);
        assert_eq!(child["_pending"], json!(true));
        assert_eq!(child["parent_issue_url"], json!("https://api.github.com/repos/o/r/issues/10"));
        enqueue_sub_issue(&mut store, 10, 11, true, false);
        assert_eq!(summary(&store, 10), (2, 1));

        // 付け替える（20 へ）・外す
        enqueue_sub_issue(&mut store, 20, 11, true, true);
        assert_eq!((summary(&store, 10), summary(&store, 20)), ((1, 1), (1, 0)));
        enqueue_sub_issue(&mut store, 10, 12, false, false);
        assert_eq!(summary(&store, 10), (0, 0));
        assert_eq!(parent_of(&store, 12), None);
        // この親の子でないものは外さない
        enqueue_sub_issue(&mut store, 10, 20, false, false);
        assert_eq!(summary(&store, 10), (0, 0));

        // 仮の番号の子（まだ作っていない Issue）も付けられ、作られたら本当の番号になる
        let temp = enqueue_create(&mut store, "子".into(), String::new(), vec![], None, None, None)["number"].as_i64().unwrap();
        enqueue_sub_issue(&mut store, 20, temp, true, false);
        assert_eq!(summary(&store, 20), (2, 0));
        assert_eq!(parent_of(&store, temp).as_deref(), Some("https://api.github.com/repos/o/r/issues/20"));
        // 送るときは、作れた Issue を送信待ちから外してから番号を直す
        store.outbox.retain(|op| !matches!(op, Op::CreateIssue { .. }));
        remap(&mut store, temp, 31);
        assert!(store.outbox.iter().any(|op| matches!(op, Op::AddSubIssue { parent: 20, child: 31, .. })));
        assert!(store.outbox.iter().any(|op| op.refers_to(31)) && !store.outbox.iter().any(|op| op.refers_to(temp)));
    }

    #[test]
    fn sub_issue_list_overlays_pending_links() {
        let mut store = RepoStore::default();
        store.reads.insert("issues:open".into(), json!([issue(10, 100, "open", None), issue(11, 110, "open", Some(10)), issue(13, 130, "open", None)]).to_string());
        let base = vec![issue(11, 110, "open", Some(10))];
        enqueue_sub_issue(&mut store, 10, 13, true, false);
        enqueue_update(&mut store, 11, Changes { state: Some("closed".into()), ..Default::default() }, None);
        let list = sub_issues_view(&store, 10, base.clone());
        let shown: Vec<(i64, String)> = list.iter().map(|c| (c["number"].as_i64().unwrap(), c["state"].as_str().unwrap().to_string())).collect();
        assert_eq!(shown, vec![(11, "closed".to_string()), (13, "open".to_string())]);
        assert_eq!(list[1]["_pending"], json!(true));

        enqueue_sub_issue(&mut store, 10, 11, false, false);
        assert_eq!(sub_issues_view(&store, 10, base).iter().map(|c| c["number"].as_i64().unwrap()).collect::<Vec<_>>(), vec![13]);
        // 前に読んでいなければ、一覧の中で親がこの Issue のもの
        assert_eq!(children_in_view(&store, 10).iter().map(|c| c["number"].as_i64().unwrap()).collect::<Vec<_>>(), vec![13]);
    }

    // UT-37 の一部: 子の id は写しから引く
    #[test]
    fn issue_id_comes_from_the_copy() {
        let mut store = RepoStore::default();
        store.reads.insert("issues:closed".into(), json!([issue(12, 120, "closed", None)]).to_string());
        assert_eq!(issue_id(&store, 12), Some(120));
        assert_eq!(issue_id(&store, 13), None);
    }

    #[test]
    fn pending_items_describe_sub_issue_links() {
        let mut store = RepoStore::default();
        store.reads.insert("issues:open".into(), json!([issue(10, 100, "open", None), issue(11, 110, "open", None)]).to_string());
        enqueue_sub_issue(&mut store, 10, 11, true, false);
        enqueue_sub_issue(&mut store, -2, 11, false, false);
        let items = pending_items(&store);
        assert_eq!((items[0].number, items[0].title.as_str(), items[0].action.as_str()), (11, "課題11", "#10 の子にする"));
        assert_eq!(items[1].action, "仮2 の子から外す");
    }
}
