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
    ("Published releases must have a valid tag", "公開するリリースには、タグが要ります"),
    ("Bad Content-Length", "ファイルを送れませんでした（大きすぎるか、読めません）"),
    ("name already exists", "同じ名前のファイルが、もう添えてあります（GitHub の画面で消してから、もう一度）"),
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
        }
        "PullRequestEvent" | "PullRequestReviewEvent" | "PullRequestReviewCommentEvent" => {
            let pr = &p["pull_request"];
            out["number"] = pr["number"].clone();
            out["title"] = pr["title"].clone();
            out["merged"] = json!(pr["merged"].as_bool().unwrap_or(false) || !pr["merged_at"].is_null());
            out["review_state"] = p["review"]["state"].clone();
            out["body"] = first_chars(&p["comment"]["body"], 120);
        }
        "IssuesEvent" | "IssueCommentEvent" => {
            let i = &p["issue"];
            out["number"] = i["number"].clone();
            out["title"] = i["title"].clone();
            out["pull"] = json!(!i["pull_request"].is_null());
            out["state_reason"] = i["state_reason"].clone();
            out["assignee"] = p["assignee"]["login"].clone();
            out["label"] = p["label"]["name"].clone();
            out["body"] = first_chars(&p["comment"]["body"], 200);
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

/// アクティビティ: リポジトリで起きたこと（100 件）と、開いているプルリク（「あなたがすること」のもと）
#[tauri::command]
pub async fn activity_feed(state: ClientState<'_>, owner: String, repo: String) -> Result<Value, String> {
    let client = client_of(&state).await?;
    let (events, pulls) = tokio::join!(client.list_repo_events(&owner, &repo), client.list_open_pulls(&owner, &repo));
    let events = parse(&events.map_err(|e| explain(&e, "リポジトリで起きたことを読むこと"))?)?;
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
    Ok(json!({
        "events": events.as_array().map(|a| a.iter().map(compact_event).collect::<Vec<_>>()).unwrap_or_default(),
        "pulls": pulls,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

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

        let comment = json!({ "id": "3", "type": "IssueCommentEvent", "actor": { "login": "y0zrin2" }, "created_at": "t",
            "payload": { "action": "created", "issue": { "number": 45, "title": "t", "pull_request": null }, "comment": { "body": "@y0zrin 見てください" } } });
        let c = compact_event(&comment);
        assert_eq!(c["pull"], false);
        assert_eq!(c["body"], "@y0zrin 見てください");
    }
}
