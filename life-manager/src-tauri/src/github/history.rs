// GitHub API からコミットの履歴を作る（スマホ版や、作業フォルダのない PC のブランチ画面・全体図）。
// 形はこの PC の git から読む履歴（git::history）と同じにする
use crate::git::history::{date_order, guess_default_branch, CommitInfo, History, RefTip, MAX_COMMITS};
use crate::github::client::GitHubClient;
use serde_json::Value;
use std::collections::{HashMap, HashSet};

/// 読み込むブランチの数の上限（ブランチごとに API を 1 回呼ぶため）
const MAX_BRANCHES: usize = 30;
/// ブランチごとに読み込むコミットの数
const COMMITS_PER_BRANCH: u32 = 100;

fn parse_array(json: &str) -> Result<Vec<Value>, String> {
    return serde_json::from_str(json).map_err(|e| format!("JSONパースエラー: {}", e));
}

pub async fn read_history(client: &GitHubClient, owner: &str, repo: &str) -> Result<History, String> {
    let info: Value = serde_json::from_str(&client.get_repository(owner, repo).await?)
        .map_err(|e| format!("JSONパースエラー: {}", e))?;
    let branches = parse_array(&client.list_branches(owner, repo).await?)?;
    let tags = parse_array(&client.list_tags(owner, repo).await?)?;

    let mut refs: Vec<RefTip> = Vec::new();
    for b in &branches {
        if let (Some(name), Some(sha)) = (b["name"].as_str(), b["commit"]["sha"].as_str()) {
            refs.push(RefTip { kind: "branch".into(), name: name.into(), hash: sha.into() });
        }
    }
    for t in &tags {
        if let (Some(name), Some(sha)) = (t["name"].as_str(), t["commit"]["sha"].as_str()) {
            refs.push(RefTip { kind: "tag".into(), name: name.into(), hash: sha.into() });
        }
    }
    let default_branch = info["default_branch"].as_str().map(|s| s.to_string()).or_else(|| guess_default_branch(&refs));

    // 既定のブランチを先に読む。多すぎるときは上限まで
    let mut names: Vec<&str> = refs.iter().filter(|r| r.kind == "branch").map(|r| r.name.as_str()).collect();
    if let Some(d) = default_branch.as_deref() {
        names.sort_by_key(|n| *n != d);
    }
    let truncated_branches = names.len() > MAX_BRANCHES;
    names.truncate(MAX_BRANCHES);

    let mut seen: HashSet<String> = HashSet::new();
    let mut commits: Vec<CommitInfo> = Vec::new();
    // 並べるときは「コミットした日時」を使う（作った日時はリベースなどで前後することがある）
    let mut committed_at: HashMap<String, String> = HashMap::new();
    let mut truncated = truncated_branches;
    for name in names {
        let list = parse_array(&client.list_commits(owner, repo, name, COMMITS_PER_BRANCH).await?)?;
        if list.len() as u32 >= COMMITS_PER_BRANCH {
            truncated = true;
        }
        for c in list {
            let Some(sha) = c["sha"].as_str() else { continue };
            if !seen.insert(sha.to_string()) {
                continue;
            }
            let message = c["commit"]["message"].as_str().unwrap_or("");
            let parents = c["parents"]
                .as_array()
                .map(|ps| ps.iter().filter_map(|p| p["sha"].as_str().map(|s| s.to_string())).collect())
                .unwrap_or_default();
            if let Some(at) = c["commit"]["committer"]["date"].as_str() {
                committed_at.insert(sha.to_string(), at.to_string());
            }
            commits.push(CommitInfo {
                hash: sha.to_string(),
                parents,
                author: c["commit"]["author"]["name"].as_str().unwrap_or("").to_string(),
                date: c["commit"]["author"]["date"].as_str().unwrap_or("").to_string(),
                subject: message.lines().next().unwrap_or("").to_string(),
            });
        }
    }

    let mut commits = date_order(commits, &committed_at);
    if commits.len() > MAX_COMMITS {
        commits.truncate(MAX_COMMITS);
        truncated = true;
    }

    return Ok(History {
        commits,
        refs,
        head_branch: None,
        head: None,
        default_branch,
        truncated,
        source: "github".into(),
    });
}
