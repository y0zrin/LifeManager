//! リリース（一覧・作る・直す・ファイルを添える・ノートを作る）と、アクティビティ（リポジトリで起きたこと）。
//! GitHub の大きな JSON を、画面で使う小さな形にする
use super::client::GitHubClient;
use super::errors::{self, Permission};
use serde_json::{json, Value};
use tokio::sync::Mutex;

type ClientState<'a> = tauri::State<'a, Mutex<Option<GitHubClient>>>;

async fn client_of(state: &ClientState<'_>) -> Result<GitHubClient, String> {
    let guard = state.lock().await;
    return Ok(guard.as_ref().ok_or("トークンが未設定です")?.clone());
}

fn parse(text: &str) -> Result<Value, String> {
    serde_json::from_str(text).map_err(|e| format!("JSONパースエラー: {}", e))
}

const CONTENTS: Permission = Permission { name: "Contents", access: "Read and write" };

const KNOWN: &[(&str, &str)] = &[
    ("already_exists", "同じタグのリリースが、もうあります（一覧から開いて直せます）"),
    ("tag_name is not a valid tag", "タグの名前に使えない文字があります（空白や ~ ^ : ? * [ \\ など）"),
    ("target_commitish is invalid", "元にするブランチが見つかりません"),
    ("Published releases must have a valid tag", "公開するリリースにはタグが要ります"),
    ("Bad Content-Length", "ファイルを送れませんでした（大きすぎるか、読めません）"),
    ("name already exists", "同じ名前のファイルがもう添えてあります。GitHub の画面で消してから、もう一度添えてください"),
];

fn explain(err: &str, what: &str) -> String {
    errors::explain(err, what, &CONTENTS, KNOWN)
}

fn person(v: &Value) -> Value {
    if v.is_null() {
        return Value::Null;
    }
    json!({ "login": v["login"], "avatar_url": v["avatar_url"] })
}

fn compact_asset(a: &Value) -> Value {
    json!({
        "id": a["id"],
        "name": a["name"],
        "size": a["size"],
        "download_count": a["download_count"],
        "browser_download_url": a["browser_download_url"],
        "content_type": a["content_type"],
        "created_at": a["created_at"],
    })
}

fn compact_release(r: &Value, latest_id: Option<u64>) -> Value {
    json!({
        "id": r["id"],
        "tag_name": r["tag_name"],
        "name": r["name"],
        "body": r["body"].as_str().unwrap_or(""),
        "draft": r["draft"].as_bool().unwrap_or(false),
        "prerelease": r["prerelease"].as_bool().unwrap_or(false),
        "latest": latest_id.is_some() && r["id"].as_u64() == latest_id,
        "created_at": r["created_at"],
        "published_at": r["published_at"],
        "author": person(&r["author"]),
        "html_url": r["html_url"],
        "target_commitish": r["target_commitish"],
        "assets": r["assets"].as_array().map(|a| a.iter().map(compact_asset).collect::<Vec<_>>()).unwrap_or_default(),
    })
}

/// ファイルの種類（ダウンロードしたときに、ブラウザやパソコンが正しく扱えるように）
fn content_type_of(name: &str) -> &'static str {
    let lower = name.to_lowercase();
    let ext = lower.rsplit('.').next().unwrap_or("");
    match ext {
        "exe" => "application/vnd.microsoft.portable-executable",
        "msi" => "application/x-msi",
        "json" => "application/json",
        "zip" => "application/zip",
        "gz" | "tgz" => "application/gzip",
        "apk" => "application/vnd.android.package-archive",
        "dmg" => "application/x-apple-diskimage",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "pdf" => "application/pdf",
        "txt" | "sig" | "md" => "text/plain",
        _ => "application/octet-stream",
    }
}

/// リリースの一覧（新しい順。「最新」の印つき）
#[tauri::command]
pub async fn list_releases(state: ClientState<'_>, owner: String, repo: String) -> Result<Vec<Value>, String> {
    let client = client_of(&state).await?;
    let (list, latest) = tokio::join!(client.list_releases(&owner, &repo), client.latest_release(&owner, &repo));
    let list = parse(&list.map_err(|e| explain(&e, "リリースを読むこと"))?)?;
    let latest_id = latest.ok().and_then(|t| parse(&t).ok()).and_then(|v| v["id"].as_u64());
    Ok(list.as_array().map(|a| a.iter().map(|r| compact_release(r, latest_id)).collect()).unwrap_or_default())
}

/// リリースのもとにするマイルストーン（閉じたものも。期日の新しい順）
#[tauri::command]
pub async fn release_milestones(state: ClientState<'_>, owner: String, repo: String) -> Result<Vec<Value>, String> {
    let client = client_of(&state).await?;
    let list = parse(&client.list_all_milestones(&owner, &repo).await.map_err(|e| explain(&e, "マイルストーンを読むこと"))?)?;
    Ok(list
        .as_array()
        .map(|a| {
            a.iter()
                .map(|m| {
                    json!({
                        "number": m["number"],
                        "title": m["title"],
                        "state": m["state"],
                        "open_issues": m["open_issues"],
                        "closed_issues": m["closed_issues"],
                        "due_on": m["due_on"],
                        "closed_at": m["closed_at"],
                    })
                })
                .collect()
        })
        .unwrap_or_default())
}

/// マイルストーンの閉じた Issue（リリースノートのもと。プルリクは除く）
#[tauri::command]
pub async fn milestone_closed_issues(state: ClientState<'_>, owner: String, repo: String, number: u32) -> Result<Vec<Value>, String> {
    let client = client_of(&state).await?;
    let list = parse(&client.list_milestone_closed_issues(&owner, &repo, number).await.map_err(|e| explain(&e, "Issue を読むこと"))?)?;
    Ok(list
        .as_array()
        .map(|a| {
            a.iter()
                .filter(|i| i["pull_request"].is_null())
                .map(|i| {
                    json!({
                        "number": i["number"],
                        "title": i["title"],
                        "labels": i["labels"].as_array().map(|l| l.iter().filter_map(|x| x["name"].as_str()).collect::<Vec<_>>()).unwrap_or_default(),
                        // completed / not_planned / duplicate など
                        "state_reason": i["state_reason"],
                        "assignees": i["assignees"].as_array().map(|l| l.iter().filter_map(|x| x["login"].as_str()).collect::<Vec<_>>()).unwrap_or_default(),
                        "user": i["user"]["login"],
                        "closed_at": i["closed_at"],
                    })
                })
                .collect()
        })
        .unwrap_or_default())
}

/// GitHub が作るリリースノート（前のタグから入ったプルリクと、手伝った人）
#[tauri::command]
pub async fn generate_release_notes(
    state: ClientState<'_>,
    owner: String,
    repo: String,
    tag: String,
    target: String,
    previous: Option<String>,
) -> Result<Value, String> {
    let client = client_of(&state).await?;
    let mut payload = json!({ "tag_name": tag, "target_commitish": target });
    if let Some(p) = previous.filter(|p| !p.is_empty()) {
        payload["previous_tag_name"] = json!(p);
    }
    let notes = parse(&client.generate_release_notes(&owner, &repo, &payload).await.map_err(|e| explain(&e, "リリースノートを作ること"))?)?;
    Ok(json!({ "name": notes["name"], "body": notes["body"] }))
}

/// リリースを作る。latest は「最新にする」（下書き・試用版のときは GitHub の決まりで最新にならない）
#[tauri::command]
pub async fn create_release(
    state: ClientState<'_>,
    owner: String,
    repo: String,
    tag: String,
    target: String,
    name: String,
    body: String,
    draft: bool,
    prerelease: bool,
    latest: bool,
) -> Result<Value, String> {
    let tag = tag.trim().to_string();
    if tag.is_empty() {
        return Err("タグの名前を入れてください".into());
    }
    let client = client_of(&state).await?;
    let payload = json!({
        "tag_name": tag,
        "target_commitish": target,
        "name": name.trim(),
        "body": body,
        "draft": draft,
        "prerelease": prerelease,
        "make_latest": if latest && !draft && !prerelease { "true" } else { "false" },
    });
    let created = parse(&client.create_release(&owner, &repo, &payload).await.map_err(|e| explain(&e, "リリースを作ること"))?)?;
    Ok(compact_release(&created, if latest && !draft && !prerelease { created["id"].as_u64() } else { None }))
}

/// リリースを直す（題名・ノート・下書き→公開・試用版・最新）
#[tauri::command]
pub async fn update_release(
    state: ClientState<'_>,
    owner: String,
    repo: String,
    id: u64,
    name: Option<String>,
    body: Option<String>,
    draft: Option<bool>,
    prerelease: Option<bool>,
    latest: Option<bool>,
) -> Result<Value, String> {
    let client = client_of(&state).await?;
    let mut payload = serde_json::Map::new();
    if let Some(n) = name {
        payload.insert("name".into(), json!(n.trim()));
    }
    if let Some(b) = body {
        payload.insert("body".into(), json!(b));
    }
    if let Some(d) = draft {
        payload.insert("draft".into(), json!(d));
    }
    if let Some(p) = prerelease {
        payload.insert("prerelease".into(), json!(p));
    }
    if let Some(l) = latest {
        payload.insert("make_latest".into(), json!(if l { "true" } else { "false" }));
    }
    let what = if draft == Some(false) { "リリースを公開すること" } else { "リリースを直すこと" };
    let updated = parse(&client.update_release(&owner, &repo, id, &Value::Object(payload)).await.map_err(|e| explain(&e, what))?)?;
    Ok(compact_release(&updated, None))
}

/// リリースにファイルを添える（この PC のファイル。名前はファイルの名前）
#[tauri::command]
pub async fn upload_release_asset(state: ClientState<'_>, owner: String, repo: String, release_id: u64, path: String) -> Result<Value, String> {
    let file = std::path::Path::new(&path);
    let name = file
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| format!("{} はファイルではありません", path))?
        .to_string();
    let meta = std::fs::metadata(file).map_err(|e| format!("{} を読めませんでした: {}", name, e))?;
    if !meta.is_file() {
        return Err(format!("{} はファイルではありません", name));
    }
    // GitHub の決まり: 1 つ 2 GiB まで
    if meta.len() >= 2 * 1024 * 1024 * 1024 {
        return Err(format!("{} は大きすぎます（GitHub のリリースには 2 GB まで）", name));
    }
    let bytes = std::fs::read(file).map_err(|e| format!("{} を読めませんでした: {}", name, e))?;
    let client = client_of(&state).await?;
    let asset = parse(
        &client
            .upload_release_asset(&owner, &repo, release_id, &name, content_type_of(&name), bytes)
            .await
            .map_err(|e| explain(&e, &format!("{} を添えること", name)))?,
    )?;
    Ok(compact_asset(&asset))
}

/// マイルストーンを閉じる（リリースしたあとの片づけ）
#[tauri::command]
pub async fn close_milestone(state: ClientState<'_>, owner: String, repo: String, number: u32) -> Result<(), String> {
    let client = client_of(&state).await?;
    client
        .update_milestone(&owner, &repo, number, None, None, None, Some("closed".into()))
        .await
        .map_err(|e| explain(&e, "マイルストーンを閉じること"))?;
    Ok(())
}

// --- アクティビティ ---

fn first_chars(v: &Value, n: usize) -> Value {
    json!(v.as_str().unwrap_or("").chars().take(n).collect::<String>())
}

/// 🆘 のコメント（「助けを求める」とその解決）の印。これがあれば本文を切らずに渡す（1.0 からは 2 行目、前は本文の終わり）
const HELP_MARKS: [&str; 2] = ["<!-- lm:help -->", "<!-- lm:help-done -->"];
/// 🆘 のコメントを渡すときの上限（困っていること・今のようす・git のメッセージ 20 行が入る長さ）
const HELP_BODY_CHARS: usize = 6000;

/// コメントの本文（ふつうは頭の n 文字。🆘 のコメントは、印とようすが読めるよう、ほぼまるごと）
fn comment_body(v: &Value, n: usize) -> Value {
    let text = v.as_str().unwrap_or("");
    if HELP_MARKS.iter().any(|m| text.contains(m)) {
        return first_chars(v, HELP_BODY_CHARS);
    }
    return first_chars(v, n);
}

/// 本文で「@名前」と呼ばれた人（小文字）。ふつうのコメントは頭の数文字しか渡さないので、呼んだかは本文まるごとから数えておく。
/// メールアドレス（bob@alice.com）や、チームの呼び方（@org/team）は、人を呼んだとしない
fn mentions_of(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let name_char = |c: char| c.is_ascii_alphanumeric() || c == '-' || c == '_';
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] != '@' {
            i += 1;
            continue;
        }
        let mut j = i + 1;
        while j < chars.len() && name_char(chars[j]) {
            j += 1;
        }
        let before_ok = i == 0 || !(name_char(chars[i - 1]) || matches!(chars[i - 1], '.' | '@' | '/'));
        let after_ok = j >= chars.len() || chars[j] != '/';
        if before_ok && after_ok && j > i + 1 {
            let name = chars[i + 1..j].iter().collect::<String>().to_lowercase();
            if !out.contains(&name) {
                out.push(name);
            }
        }
        i = j.max(i + 1);
    }
    return out;
}

/// リポジトリで起きたこと 1 つを、画面で文にしやすい形にする
fn compact_event(e: &Value) -> Value {
    let p = &e["payload"];
    let kind = e["type"].as_str().unwrap_or("");
    let mut out = json!({ "id": e["id"], "type": kind, "actor": e["actor"]["login"], "at": e["created_at"], "action": p["action"] });
    match kind {
        "PushEvent" => {
            out["ref"] = json!(p["ref"].as_str().unwrap_or("").trim_start_matches("refs/heads/"));
            out["size"] = p["size"].clone();
            out["commits"] = json!(p["commits"]
                .as_array()
                .map(|a| a.iter().rev().take(3).map(|c| json!({ "sha": c["sha"], "message": c["message"].as_str().unwrap_or("").lines().next().unwrap_or("") })).collect::<Vec<_>>())
                .unwrap_or_default());
            // 今の GitHub は、プッシュにコミットを入れない（before と head だけ）。あとで比べて足す
            out["before"] = p["before"].clone();
            out["head"] = p["head"].clone();
        }
        "PullRequestEvent" | "PullRequestReviewEvent" | "PullRequestReviewCommentEvent" => {
            let pr = &p["pull_request"];
            out["number"] = if pr["number"].is_null() { p["number"].clone() } else { pr["number"].clone() };
            // 今の GitHub は、題名を入れない（あとで番号から足す）
            out["title"] = pr["title"].clone();
            // マージは、前は action: closed と merged、今は action: merged で来る
            out["merged"] = json!(pr["merged"].as_bool().unwrap_or(false) || !pr["merged_at"].is_null() || p["action"] == "merged");
            out["review_state"] = p["review"]["state"].clone();
            out["body"] = comment_body(&p["comment"]["body"], 120);
            out["mentions"] = json!(mentions_of(p["comment"]["body"].as_str().unwrap_or("")));
        }
        "IssuesEvent" | "IssueCommentEvent" => {
            let i = &p["issue"];
            out["number"] = i["number"].clone();
            out["title"] = i["title"].clone();
            out["pull"] = json!(!i["pull_request"].is_null());
            out["state_reason"] = i["state_reason"].clone();
            out["assignee"] = p["assignee"]["login"].clone();
            out["label"] = p["label"]["name"].clone();
            out["body"] = comment_body(&p["comment"]["body"], 200);
            out["mentions"] = json!(mentions_of(p["comment"]["body"].as_str().unwrap_or("")));
            // コメントは、コメントの番号で呼ぶ（最近のコメントの一覧から拾ったものと同じ id にして、知らせを二重にしない）
            if kind == "IssueCommentEvent" && !p["comment"]["id"].is_null() {
                out["comment_id"] = p["comment"]["id"].clone();
                out["id"] = json!(format!("c{}", p["comment"]["id"]));
            }
        }
        "CreateEvent" | "DeleteEvent" => {
            out["ref_type"] = p["ref_type"].clone();
            out["ref"] = p["ref"].clone();
        }
        "ReleaseEvent" => {
            let r = &p["release"];
            out["title"] = if r["name"].as_str().map(|s| !s.is_empty()).unwrap_or(false) { r["name"].clone() } else { r["tag_name"].clone() };
            out["ref"] = r["tag_name"].clone();
            out["prerelease"] = r["prerelease"].clone();
        }
        "MemberEvent" => out["member"] = p["member"]["login"].clone(),
        "ForkEvent" => out["ref"] = p["forkee"]["full_name"].clone(),
        _ => {}
    }
    out
}

/// 最近のコメントの一覧の 1 つを、リポジトリで起きたこと（IssueCommentEvent）と同じ形に（題名は来ないので、画面で番号から足す）
fn compact_comment(c: &Value) -> Value {
    let number = c["issue_url"].as_str().and_then(|u| u.rsplit('/').next()).and_then(|n| n.parse::<u64>().ok());
    let body = c["body"].as_str().unwrap_or("");
    return json!({
        "id": format!("c{}", c["id"]),
        "comment_id": c["id"],
        "type": "IssueCommentEvent",
        "actor": c["user"]["login"],
        "at": c["created_at"],
        "action": "created",
        "number": number,
        "title": null,
        "pull": c["html_url"].as_str().is_some_and(|u| u.contains("/pull/")),
        "body": comment_body(&c["body"], 200),
        "mentions": mentions_of(body),
    });
}

/// 最近のコメントのうち、リポジトリで起きたことにまだ来ていないものを足して、新しい順に並べ直す
fn merge_recent_comments(events: &mut Vec<Value>, comments: &Value) {
    let Some(list) = comments.as_array() else { return };
    let known: std::collections::HashSet<String> = events.iter().filter_map(|e| e["comment_id"].as_u64().map(|n| n.to_string())).collect();
    let mut added = false;
    for c in list {
        let Some(id) = c["id"].as_u64() else { continue };
        if known.contains(&id.to_string()) {
            continue;
        }
        events.push(compact_comment(c));
        added = true;
    }
    if added {
        // 時刻はどちらも GitHub の「…Z」なので、文字のままくらべてよい
        events.sort_by(|a, b| b["at"].as_str().unwrap_or("").cmp(a["at"].as_str().unwrap_or("")));
    }
}

/// アクティビティ: リポジトリで起きたこと（100 件）と、開いているプルリク（「あなたがすること」のもと）。
/// 名前を呼ばれた・🆘 が遅れないよう、最近 14 日のコメント（50 件）も読んで足す
#[tauri::command]
pub async fn activity_feed(state: ClientState<'_>, owner: String, repo: String) -> Result<Value, String> {
    let client = client_of(&state).await?;
    let since = (chrono::Utc::now() - chrono::Duration::days(14)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let (events, pulls, comments) = tokio::join!(
        client.list_repo_events(&owner, &repo),
        client.list_open_pulls(&owner, &repo),
        client.list_recent_issue_comments(&owner, &repo, &since)
    );
    let events = parse(&events.map_err(|e| explain(&e, "リポジトリで起きたことを読むこと"))?)?;
    // コメントを読めなかったとき（権限など）は、リポジトリで起きたことだけで
    let comments = comments.ok().and_then(|t| parse(&t).ok()).unwrap_or(Value::Null);
    // プルリクの権限がなければ null（そのときは、プルリクの「あなたがすること」は出さない）
    let pulls = pulls.ok().and_then(|t| parse(&t).ok()).map(|v| {
        v.as_array()
            .map(|a| {
                a.iter()
                    .map(|p| {
                        json!({
                            "number": p["number"],
                            "title": p["title"],
                            "user": p["user"]["login"],
                            "draft": p["draft"],
                            "head_sha": p["head"]["sha"],
                            "updated_at": p["updated_at"],
                            "requested_reviewers": p["requested_reviewers"].as_array().map(|r| r.iter().filter_map(|x| x["login"].as_str()).collect::<Vec<_>>()).unwrap_or_default(),
                        })
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    });
    let mut events: Vec<Value> = events.as_array().map(|a| a.iter().map(compact_event).collect()).unwrap_or_default();
    merge_recent_comments(&mut events, &comments);
    let open = pulls.as_deref().unwrap_or(&[]);
    let untitled = untitled_pulls(&owner, &repo, &events, open);
    tokio::join!(fill_push_commits(&client, &owner, &repo, &mut events), fetch_pull_titles(&client, &owner, &repo, untitled));
    apply_pull_titles(&owner, &repo, &mut events, open);
    Ok(json!({
        "events": events,
        "pulls": pulls,
    }))
}

/// 比べたプッシュのコミット（owner/repo@before...head → { size, commits }）と、プルリクの題名（owner/repo#番号）。
/// どちらもあとから変わらない（題名はまれに変わる）ので、アプリを開いているあいだ覚えておき、読み直すたびに GitHub に聞かない
static PUSH_COMMITS: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String, Value>>> = std::sync::LazyLock::new(Default::default);
static PULL_TITLES: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String, Value>>> = std::sync::LazyLock::new(Default::default);
/// いちどに GitHub に聞くのは、これだけまで（残りは、次に読み直したとき）
const FILL_LIMIT: usize = 10;

/// 比べる前と後（コミットの入っていないプッシュだけ。新しいブランチの最初のプッシュは、前が 0 だけなので比べられない）
fn push_range(e: &Value) -> Option<(String, String)> {
    if e["type"] != "PushEvent" || e["commits"].as_array().is_some_and(|c| !c.is_empty()) {
        return None;
    }
    let before = e["before"].as_str().filter(|s| !s.is_empty() && !s.chars().all(|c| c == '0'))?;
    let head = e["head"].as_str().filter(|s| !s.is_empty())?;
    Some((before.to_string(), head.to_string()))
}

/// 比べた結果を、プッシュの形（コミットの数と、新しい順に 3 つまで）にする
fn pushed_commits(compare: &Value) -> Value {
    let commits = compare["commits"]
        .as_array()
        .map(|a| a.iter().rev().take(3).map(|c| json!({ "sha": c["sha"], "message": c["commit"]["message"].as_str().unwrap_or("").lines().next().unwrap_or("") })).collect::<Vec<_>>())
        .unwrap_or_default();
    json!({ "size": compare["total_commits"], "commits": commits })
}

/// プッシュのコミットを足す（覚えていないものは、新しいプッシュから FILL_LIMIT 件まで GitHub に聞く）
async fn fill_push_commits(client: &GitHubClient, owner: &str, repo: &str, events: &mut [Value]) {
    let key_of = |before: &str, head: &str| format!("{}/{}@{}...{}", owner, repo, before, head);
    let mut asked = tokio::task::JoinSet::new();
    for e in events.iter() {
        let Some((before, head)) = push_range(e) else { continue };
        let key = key_of(&before, &head);
        if asked.len() >= FILL_LIMIT || PUSH_COMMITS.lock().map(|m| m.contains_key(&key)).unwrap_or(true) {
            continue;
        }
        let (client, owner, repo) = (client.clone(), owner.to_string(), repo.to_string());
        asked.spawn(async move { (key, client.compare(&owner, &repo, &before, &head).await) });
    }
    while let Some(Ok((key, result))) = asked.join_next().await {
        if let (Some(v), Ok(mut m)) = (result.ok().and_then(|t| parse(&t).ok()), PUSH_COMMITS.lock()) {
            m.insert(key, pushed_commits(&v));
        }
    }
    for e in events.iter_mut() {
        let Some((before, head)) = push_range(e) else { continue };
        if let Some(hit) = PUSH_COMMITS.lock().ok().and_then(|m| m.get(&key_of(&before, &head)).cloned()) {
            e["size"] = hit["size"].clone();
            e["commits"] = hit["commits"].clone();
        }
    }
}

/// 題名のないプルリクの番号（開いているプルリク・覚えている題名にないもの）
fn untitled_pulls(owner: &str, repo: &str, events: &[Value], open: &[Value]) -> Vec<u64> {
    let mut numbers = Vec::new();
    for e in events {
        if !e["type"].as_str().unwrap_or("").starts_with("PullRequest") || !e["title"].is_null() {
            continue;
        }
        let Some(n) = e["number"].as_u64() else { continue };
        let known = open.iter().any(|p| p["number"].as_u64() == Some(n))
            || PULL_TITLES.lock().map(|m| m.contains_key(&format!("{}/{}#{}", owner, repo, n))).unwrap_or(true);
        if !known && !numbers.contains(&n) {
            numbers.push(n);
        }
    }
    numbers
}

/// プルリクの題名を GitHub に聞いて覚える（FILL_LIMIT 件まで）
async fn fetch_pull_titles(client: &GitHubClient, owner: &str, repo: &str, numbers: Vec<u64>) {
    let mut asked = tokio::task::JoinSet::new();
    for n in numbers.into_iter().take(FILL_LIMIT) {
        let (client, owner, repo) = (client.clone(), owner.to_string(), repo.to_string());
        asked.spawn(async move { (n, client.get_pull(&owner, &repo, n).await) });
    }
    while let Some(Ok((n, result))) = asked.join_next().await {
        if let (Some(v), Ok(mut m)) = (result.ok().and_then(|t| parse(&t).ok()), PULL_TITLES.lock()) {
            m.insert(format!("{}/{}#{}", owner, repo, n), v["title"].clone());
        }
    }
}

/// 題名を足す（開いているプルリク → 覚えている題名）
fn apply_pull_titles(owner: &str, repo: &str, events: &mut [Value], open: &[Value]) {
    for e in events.iter_mut() {
        if !e["type"].as_str().unwrap_or("").starts_with("PullRequest") || !e["title"].is_null() {
            continue;
        }
        let Some(n) = e["number"].as_u64() else { continue };
        if let Some(p) = open.iter().find(|p| p["number"].as_u64() == Some(n)) {
            e["title"] = p["title"].clone();
        } else if let Some(t) = PULL_TITLES.lock().ok().and_then(|m| m.get(&format!("{}/{}#{}", owner, repo, n)).cloned()) {
            e["title"] = t;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_whole_help_comment_body() {
        let long = format!("🆘 **助けてください** @b

{}

<!-- lm:help -->", "あ".repeat(400));
        let e = json!({ "id": "1", "type": "IssueCommentEvent", "actor": { "login": "a" }, "created_at": "2026-10-01T00:00:00Z",
            "payload": { "action": "created", "issue": { "number": 3, "title": "t" }, "comment": { "body": long } } });
        let out = compact_event(&e);
        assert!(out["body"].as_str().unwrap().ends_with("<!-- lm:help -->"));
        let plain = json!({ "id": "2", "type": "IssueCommentEvent", "actor": { "login": "a" }, "created_at": "2026-10-01T00:00:00Z",
            "payload": { "action": "created", "issue": { "number": 3, "title": "t" }, "comment": { "body": "い".repeat(400) } } });
        assert_eq!(compact_event(&plain)["body"].as_str().unwrap().chars().count(), 200);
    }

    #[test]
    fn adds_recent_comments_not_yet_in_events() {
        // リポジトリで起きたことに来ているコメント（番号 11）と、まだ来ていないコメント（番号 12・プルリクの会話）
        let e = json!({ "id": "900", "type": "IssueCommentEvent", "actor": { "login": "a" }, "created_at": "2026-10-01T01:00:00Z",
            "payload": { "action": "created", "issue": { "number": 3, "title": "t" }, "comment": { "id": 11, "body": "@b 見て" } } });
        let mut events = vec![compact_event(&e)];
        assert_eq!(events[0]["id"], json!("c11"));
        let comments = json!([
            { "id": 12, "user": { "login": "c" }, "created_at": "2026-10-01T02:00:00Z", "body": "@B お願いします",
              "issue_url": "https://api.github.com/repos/o/r/issues/7", "html_url": "https://github.com/o/r/pull/7#issuecomment-12" },
            { "id": 11, "user": { "login": "a" }, "created_at": "2026-10-01T01:00:00Z", "body": "@b 見て",
              "issue_url": "https://api.github.com/repos/o/r/issues/3", "html_url": "https://github.com/o/r/issues/3#issuecomment-11" }
        ]);
        merge_recent_comments(&mut events, &comments);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["id"], json!("c12"));
        assert_eq!(events[0]["number"], json!(7));
        assert_eq!(events[0]["pull"], json!(true));
        assert_eq!(events[0]["mentions"], json!(["b"]));
        assert_eq!(events[1]["id"], json!("c11"));
    }

    #[test]
    fn counts_mentions_from_the_whole_comment() {
        let body = format!("{}\n最後に @Alice さん、見てください。bob@carol.com・git@dave.github.io・@org/team・@eve_x、@frank-2", "い".repeat(400));
        let e = json!({ "id": "3", "type": "IssueCommentEvent", "actor": { "login": "a" }, "created_at": "2026-10-01T00:00:00Z",
            "payload": { "action": "created", "issue": { "number": 3, "title": "t" }, "comment": { "body": body } } });
        let out = compact_event(&e);
        assert_eq!(out["mentions"], json!(["alice", "eve_x", "frank-2"]));
        assert_eq!(out["body"].as_str().unwrap().chars().count(), 200);
    }

    #[test]
    fn marks_the_latest_release_and_compacts_assets() {
        let r = json!({
            "id": 7, "tag_name": "0.9.0", "name": "Life Manager 0.9.0", "body": null, "draft": false, "prerelease": false,
            "author": { "login": "y0zrin", "avatar_url": "a", "id": 1 },
            "assets": [{ "id": 3, "name": "setup.exe", "size": 5000000, "download_count": 12, "browser_download_url": "u", "uploader": {} }]
        });
        let c = compact_release(&r, Some(7));
        assert_eq!(c["latest"], true);
        assert_eq!(c["body"], "");
        assert_eq!(c["assets"][0]["name"], "setup.exe");
        assert!(c["assets"][0].get("uploader").is_none());
        assert_eq!(compact_release(&r, Some(8))["latest"], false);
    }

    #[test]
    fn picks_content_types_by_extension() {
        assert_eq!(content_type_of("Life Manager_0.9.0_x64-setup.exe"), "application/vnd.microsoft.portable-executable");
        assert_eq!(content_type_of("latest.json"), "application/json");
        assert_eq!(content_type_of("setup.exe.sig"), "text/plain");
        assert_eq!(content_type_of("game.unitypackage"), "application/octet-stream");
    }

    #[test]
    fn compacts_events() {
        let push = json!({ "id": "1", "type": "PushEvent", "actor": { "login": "y0zrin2" }, "created_at": "t",
            "payload": { "ref": "refs/heads/main", "size": 3, "commits": [
                { "sha": "a", "message": "一つめ" }, { "sha": "b", "message": "二つめ\n\n本文" }, { "sha": "c", "message": "三つめ" }, { "sha": "d", "message": "四つめ" }
            ] } });
        let c = compact_event(&push);
        assert_eq!(c["ref"], "main");
        assert_eq!(c["size"], 3);
        assert_eq!(c["commits"].as_array().unwrap().len(), 3);
        assert_eq!(c["commits"][0]["message"], "四つめ");
        assert_eq!(c["commits"][2]["message"], "二つめ");

        let merged = json!({ "id": "2", "type": "PullRequestEvent", "actor": { "login": "y0zrin" }, "created_at": "t",
            "payload": { "action": "closed", "pull_request": { "number": 70, "title": "サブイシュー", "merged": true } } });
        let m = compact_event(&merged);
        assert_eq!(m["action"], "closed");
        assert_eq!(m["merged"], true);
        assert_eq!(m["number"], 70);

        // 今の GitHub の形: マージは action: merged、題名なし（番号は payload にも）。プッシュは before と head だけ
        let merged_now = json!({ "id": "4", "type": "PullRequestEvent", "actor": { "login": "y0zrin" }, "created_at": "t",
            "payload": { "action": "merged", "number": 2, "pull_request": { "id": 1, "number": 2, "url": "u", "base": {}, "head": {} } } });
        let m = compact_event(&merged_now);
        assert_eq!(m["merged"], true);
        assert_eq!(m["number"], 2);
        assert!(m["title"].is_null());
        let push_now = json!({ "id": "5", "type": "PushEvent", "actor": { "login": "y0zrin" }, "created_at": "t",
            "payload": { "ref": "refs/heads/main", "before": "b93239c", "head": "83b7a60", "push_id": 1, "repository_id": 1 } });
        let p = compact_event(&push_now);
        assert!(p["size"].is_null());
        assert_eq!(push_range(&p), Some(("b93239c".to_string(), "83b7a60".to_string())));
        // 新しいブランチの最初のプッシュは比べない
        let first = json!({ "type": "PushEvent", "commits": [], "before": "0000000000000000000000000000000000000000", "head": "83b7a60" });
        assert_eq!(push_range(&first), None);
        let compared = json!({ "total_commits": 4, "commits": [
            { "sha": "a", "commit": { "message": "一" } }, { "sha": "b", "commit": { "message": "二" } },
            { "sha": "c", "commit": { "message": "三\n\n本文" } }, { "sha": "d", "commit": { "message": "四" } }
        ] });
        let pc = pushed_commits(&compared);
        assert_eq!(pc["size"], 4);
        assert_eq!(pc["commits"][0]["message"], "四");
        assert_eq!(pc["commits"][1]["message"], "三");

        let comment = json!({ "id": "3", "type": "IssueCommentEvent", "actor": { "login": "y0zrin2" }, "created_at": "t",
            "payload": { "action": "created", "issue": { "number": 45, "title": "t", "pull_request": null }, "comment": { "body": "@y0zrin 見てください" } } });
        let c = compact_event(&comment);
        assert_eq!(c["pull"], false);
        assert_eq!(c["body"], "@y0zrin 見てください");
    }
}
