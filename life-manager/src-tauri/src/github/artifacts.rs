//! Issue の成果物: その Issue につながるコミット（メッセージで #11 に触れた・Issue にリンクされた・その Issue に触れたプルリクのコミット）で
//! 変わったファイルの一覧。この PC にクローンしてあれば、この PC の git からも探す（まだプッシュしていないコミットも）。
//! ファイルの中身（メディアビューワー）を GitHub から読むのも、ここ
use super::client::GitHubClient;
use crate::git::media::{commits_mentioning, is_sha, lfs_oid, local_commit, ChangedFile, LocalCommit, MAX_BYTES};
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;
use tauri::ipc::Response;
use tokio::sync::Mutex;

type ClientState<'a> = tauri::State<'a, Mutex<Option<GitHubClient>>>;

async fn client_of(state: &ClientState<'_>) -> Result<GitHubClient, String> {
    let guard = state.lock().await;
    return Ok(guard.as_ref().ok_or("トークンが未設定です")?.clone());
}

fn parse(text: &str) -> Result<Value, String> {
    serde_json::from_str(text).map_err(|e| format!("JSONパースエラー: {}", e))
}

/// 1 回に探すコミットの数（Issue ひとつで、これより多いことはまれ）
const MAX_COMMITS: usize = 40;

/// GitHub から読んだコミット（owner/repo@sha → 変わったファイル）。コミットはあとから変わらないので、アプリを開いているあいだ覚えておき、
/// 成果物のタブを開くたびに GitHub に聞かない（前は開くたびに、コミットの数だけ〔40 まで〕聞いていた）
static GITHUB_COMMITS: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String, LocalCommit>>> = std::sync::LazyLock::new(Default::default);
/// 覚えておくコミットの数（超えたら、いったん忘れる）
const KEEP_COMMITS: usize = 2000;

/// GitHub のコミット（覚えていれば、聞かない）
async fn github_commit(client: &GitHubClient, owner: &str, repo: &str, sha: &str) -> Option<LocalCommit> {
    let key = format!("{}/{}@{}", owner, repo, sha).to_lowercase();
    if let Some(c) = GITHUB_COMMITS.lock().ok().and_then(|m| m.get(&key).cloned()) {
        return Some(c);
    }
    let commit = client.get_commit(owner, repo, sha).await.ok().and_then(|t| parse(&t).ok()).and_then(|v| from_github_commit(&v))?;
    if let Ok(mut m) = GITHUB_COMMITS.lock() {
        if m.len() >= KEEP_COMMITS {
            m.clear();
        }
        m.insert(key, commit.clone());
    }
    Some(commit)
}

/// 成果物のコミット
#[derive(Debug, Clone, Serialize)]
pub struct ArtifactCommit {
    pub sha: String,
    pub message: String,
    pub author: String,
    pub date: String,
    /// そのコミットが入っているプルリク（あれば）
    pub pull: Option<u64>,
    /// この PC の git にある（中身をこの PC から読める）
    pub local: bool,
}

/// 成果物のファイル（いちばん新しく変えたコミットのもの）
#[derive(Debug, Clone, Serialize)]
pub struct ArtifactFile {
    pub path: String,
    pub status: String,
    pub previous: Option<String>,
    pub additions: Option<u64>,
    pub deletions: Option<u64>,
    /// いちばん新しく変えたコミット
    pub sha: String,
    /// 変えたコミットの数
    pub commits: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct Artifacts {
    pub commits: Vec<ArtifactCommit>,
    pub files: Vec<ArtifactFile>,
}

/// タイムラインから、Issue につながるコミットとプルリク
pub fn linked_from_timeline(timeline: &Value, owner: &str, repo: &str) -> (Vec<String>, Vec<u64>) {
    let mut shas = Vec::new();
    let mut pulls = Vec::new();
    let full = format!("{}/{}", owner, repo).to_lowercase();
    for ev in timeline.as_array().into_iter().flatten() {
        match ev["event"].as_str().unwrap_or("") {
            // コミットのメッセージで触れた・コミットで閉じた
            "referenced" | "closed" => {
                if let Some(sha) = ev["commit_id"].as_str() {
                    shas.push(sha.to_string());
                }
            }
            // プルリクから触れた（同じリポジトリのプルリクだけ）
            "cross-referenced" => {
                let issue = &ev["source"]["issue"];
                let same = issue["repository"]["full_name"].as_str().map(|n| n.to_lowercase() == full).unwrap_or(true);
                if same && !issue["pull_request"].is_null() {
                    if let Some(n) = issue["number"].as_u64() {
                        pulls.push(n);
                    }
                }
            }
            _ => {}
        }
    }
    (shas, pulls)
}

/// GitHub のコミット（/commits/{sha}）を、この PC のコミットと同じ形に
fn from_github_commit(v: &Value) -> Option<LocalCommit> {
    let sha = v["sha"].as_str()?.to_string();
    let files = v["files"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|f| {
                    Some(ChangedFile {
                        path: f["filename"].as_str()?.to_string(),
                        status: f["status"].as_str().unwrap_or("modified").to_string(),
                        previous: f["previous_filename"].as_str().map(|s| s.to_string()),
                        additions: f["additions"].as_u64(),
                        deletions: f["deletions"].as_u64(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Some(LocalCommit {
        sha,
        message: v["commit"]["message"].as_str().unwrap_or("").lines().next().unwrap_or("").to_string(),
        author: v["commit"]["author"]["name"].as_str().or(v["author"]["login"].as_str()).unwrap_or("").to_string(),
        date: v["commit"]["author"]["date"].as_str().unwrap_or("").to_string(),
        files,
    })
}

/// コミットの時刻を、くらべられる数に（この PC の git は「…+09:00」、GitHub は「…Z」で来るので、文字のままではくらべない。読めなければ 0）
fn instant(date: &str) -> i64 {
    return chrono::DateTime::parse_from_rfc3339(date).map(|d| d.timestamp()).unwrap_or(0);
}

/// コミットごとの変わったファイルを、ファイルごとにまとめる（いちばん新しく変えたコミットのものを残す）
pub fn merge_files(commits: &[(LocalCommit, Option<u64>)]) -> Vec<ArtifactFile> {
    let mut sorted: Vec<&(LocalCommit, Option<u64>)> = commits.iter().collect();
    sorted.sort_by_key(|a| instant(&a.0.date));
    let mut map: BTreeMap<String, ArtifactFile> = BTreeMap::new();
    for (c, _) in sorted {
        for f in &c.files {
            let count = map.get(&f.path).map(|e| e.commits).unwrap_or(0) + 1;
            // 名前を変えたときは、前の名前の分をまとめる
            let count = match f.previous.as_ref().and_then(|p| map.remove(p)) {
                Some(prev) => prev.commits + count,
                None => count,
            };
            map.insert(
                f.path.clone(),
                ArtifactFile {
                    path: f.path.clone(),
                    status: f.status.clone(),
                    previous: f.previous.clone(),
                    additions: f.additions,
                    deletions: f.deletions,
                    sha: c.sha.clone(),
                    commits: count,
                },
            );
        }
    }
    map.into_values().collect()
}

/// Issue の成果物（つながるコミットで変わったファイル）
#[tauri::command]
pub async fn issue_artifacts(state: ClientState<'_>, owner: String, repo: String, number: u32, folder: Option<String>) -> Result<Artifacts, String> {
    let client = client_of(&state).await?;
    let timeline = parse(&client.list_timeline(&owner, &repo, number).await?)?;
    let (mut shas, pulls) = linked_from_timeline(&timeline, &owner, &repo);

    // プルリクのコミット
    let mut pull_of: BTreeMap<String, u64> = BTreeMap::new();
    for n in pulls.iter().take(10) {
        if let Ok(text) = client.list_pull_commits(&owner, &repo, *n).await {
            for c in parse(&text)?.as_array().into_iter().flatten() {
                if let Some(sha) = c["sha"].as_str() {
                    pull_of.insert(sha.to_string(), *n);
                    shas.push(sha.to_string());
                }
            }
        }
    }

    // この PC の git で、メッセージが #11 に触れたコミット（まだプッシュしていないものも）
    let folder_path = folder.filter(|f| !f.trim().is_empty()).map(PathBuf::from);
    if let Some(dir) = folder_path.clone() {
        let found = tauri::async_runtime::spawn_blocking(move || commits_mentioning(&dir, number)).await.unwrap_or_default();
        shas.extend(found);
    }

    // 同じコミットは 1 回だけ（短い番号と長い番号も同じとみる）
    let mut seen: HashSet<String> = HashSet::new();
    let mut unique = Vec::new();
    for sha in shas {
        if !is_sha(&sha) {
            continue;
        }
        let key = sha[..7].to_lowercase();
        if seen.insert(key) {
            unique.push(sha);
        }
    }
    unique.truncate(MAX_COMMITS);

    let mut commits: Vec<(LocalCommit, Option<u64>)> = Vec::new();
    let mut listed: Vec<ArtifactCommit> = Vec::new();
    for sha in unique {
        // この PC にあれば、この PC の git から（速い・API を使わない）
        let local = match folder_path.clone() {
            Some(dir) => {
                let s = sha.clone();
                tauri::async_runtime::spawn_blocking(move || local_commit(&dir, &s)).await.unwrap_or(None)
            }
            None => None,
        };
        let (commit, is_local) = match local {
            Some(c) => (c, true),
            None => match github_commit(&client, &owner, &repo, &sha).await {
                Some(c) => (c, false),
                None => continue,
            },
        };
        let pull = pull_of.get(&commit.sha).copied().or_else(|| pull_of.get(&sha).copied());
        listed.push(ArtifactCommit { sha: commit.sha.clone(), message: commit.message.clone(), author: commit.author.clone(), date: commit.date.clone(), pull, local: is_local });
        commits.push((commit, pull));
    }
    listed.sort_by_key(|c| std::cmp::Reverse(instant(&c.date)));
    let files = merge_files(&commits);
    Ok(Artifacts { commits: listed, files })
}

/// GitHub のファイルの中身（コミットの時点。100MB まで。Git LFS のファイルは読めない）
#[tauri::command]
pub async fn media_read_github(state: ClientState<'_>, owner: String, repo: String, sha: String, file: String) -> Result<Response, String> {
    if !is_sha(&sha) {
        return Err(format!("コミットの番号が正しくありません: {}", sha));
    }
    let client = client_of(&state).await?;
    let bytes = client.get_file_bytes(&owner, &repo, &sha, file.trim().trim_start_matches('/'), MAX_BYTES.min(100 * 1024 * 1024)).await?;
    if lfs_oid(&bytes).is_some() {
        return Err("Git LFS のファイルです。GitHub からは中身を読めません。この PC にクローンして、git lfs pull をすると見られます".into());
    }
    Ok(Response::new(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn finds_commits_and_pulls_in_the_timeline() {
        let timeline = json!([
            { "event": "referenced", "commit_id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
            { "event": "closed", "commit_id": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
            { "event": "closed", "commit_id": null },
            { "event": "cross-referenced", "source": { "issue": { "number": 26, "pull_request": {}, "repository": { "full_name": "sato/Game" } } } },
            { "event": "cross-referenced", "source": { "issue": { "number": 5, "repository": { "full_name": "sato/Game" } } } },
            { "event": "cross-referenced", "source": { "issue": { "number": 9, "pull_request": {}, "repository": { "full_name": "other/Repo" } } } },
            { "event": "labeled" },
        ]);
        let (shas, pulls) = linked_from_timeline(&timeline, "sato", "game");
        assert_eq!(shas.len(), 2);
        assert_eq!(pulls, vec![26]);
    }

    #[test]
    fn keeps_the_newest_change_of_each_file() {
        let file = |path: &str, status: &str, previous: Option<&str>| ChangedFile {
            path: path.into(),
            status: status.into(),
            previous: previous.map(|p| p.to_string()),
            additions: Some(1),
            deletions: Some(0),
        };
        let commit = |sha: &str, date: &str, files: Vec<ChangedFile>| LocalCommit { sha: sha.into(), message: "m".into(), author: "a".into(), date: date.into(), files };
        let commits = vec![
            (commit("b", "2026-09-29T10:00:00Z", vec![file("a.png", "modified", None), file("new.cpp", "renamed", Some("old.cpp"))]), None),
            (commit("a", "2026-09-28T10:00:00Z", vec![file("a.png", "added", None), file("old.cpp", "added", None)]), None),
        ];
        let files = merge_files(&commits);
        assert_eq!(files.len(), 2);
        let png = files.iter().find(|f| f.path == "a.png").unwrap();
        assert_eq!(png.sha, "b");
        assert_eq!(png.commits, 2);
        let cpp = files.iter().find(|f| f.path == "new.cpp").unwrap();
        assert_eq!(cpp.commits, 2);
        assert!(files.iter().all(|f| f.path != "old.cpp"));
    }

    #[test]
    fn compares_times_across_time_zones() {
        let file = ChangedFile { path: "a.png".into(), status: "modified".into(), previous: None, additions: None, deletions: None };
        let commit = |sha: &str, date: &str| LocalCommit { sha: sha.into(), message: "m".into(), author: "a".into(), date: date.into(), files: vec![file.clone()] };
        // 仲間の 14:00（日本）= 05:00Z は、自分の 13:00+09:00 より新しい
        let commits = vec![(commit("mine", "2026-09-30T13:00:00+09:00"), None), (commit("theirs", "2026-09-30T05:00:00Z"), None)];
        assert_eq!(merge_files(&commits)[0].sha, "theirs");
    }
}
