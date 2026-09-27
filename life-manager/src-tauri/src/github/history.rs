// GitHub API からコミットの履歴を作る（スマホ版や、作業フォルダのない PC のブランチ画面・全体図）。
// 形はこの PC の git から読む履歴（git::history）と同じにする
use crate::git::history::{date_order, guess_default_branch, CommitInfo, History, RefTip, MAX_COMMITS};
use crate::github::client::GitHubClient;
use serde::Serialize;
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

/// 「変更内容を見る」の中身。画面は git show と同じ形で読むので、この PC の git（GitRun）と同じ形で返す
#[derive(Debug, Serialize)]
pub struct CommitDetail {
    pub command: String,
    pub output: String,
}

/// GitHub から 1 つのコミットを読んで、git show --stat --patch と同じ形にする（作業フォルダのないときの「変更内容を見る」）
pub async fn commit_detail(client: &GitHubClient, owner: &str, repo: &str, hash: &str) -> Result<CommitDetail, String> {
    let json: Value = serde_json::from_str(&client.get_commit(owner, repo, hash).await?)
        .map_err(|e| format!("JSONパースエラー: {}", e))?;
    let short = &hash[..hash.len().min(7)];
    Ok(CommitDetail {
        command: format!("GitHub から読み込み（手元なら git show {}）", short),
        output: format_show(&json),
    })
}

fn plural(n: u64, one: &str, many: &str) -> String {
    format!("{} {}", n, if n == 1 { one } else { many })
}

/// GitHub の「1 つのコミット」の JSON を、git show --stat --patch --format=%H%n%an <%ae>%n%aI%n%n%B の出力の形にする
fn format_show(c: &Value) -> String {
    let mut out = String::new();
    let author = &c["commit"]["author"];
    out.push_str(c["sha"].as_str().unwrap_or(""));
    out.push('\n');
    out.push_str(&format!("{} <{}>\n", author["name"].as_str().unwrap_or(""), author["email"].as_str().unwrap_or("")));
    out.push_str(author["date"].as_str().unwrap_or(""));
    out.push_str("\n\n");
    out.push_str(c["commit"]["message"].as_str().unwrap_or("").trim_end());
    out.push_str("\n\n");

    let files = c["files"].as_array().cloned().unwrap_or_default();
    if files.is_empty() {
        return out;
    }
    // --stat の一覧（+ と - の棒は、いちばん多いファイルを 40 文字にそろえる）
    let width = files.iter().map(|f| f["filename"].as_str().unwrap_or("").chars().count()).max().unwrap_or(0);
    let most = files.iter().map(|f| f["changes"].as_u64().unwrap_or(0)).max().unwrap_or(0).max(1);
    let (mut added, mut deleted) = (0u64, 0u64);
    for f in &files {
        let name = f["filename"].as_str().unwrap_or("");
        let (a, d) = (f["additions"].as_u64().unwrap_or(0), f["deletions"].as_u64().unwrap_or(0));
        added += a;
        deleted += d;
        let scale = |n: u64| if most > 40 { ((n * 40 + most - 1) / most) as usize } else { n as usize };
        let pad = " ".repeat(width.saturating_sub(name.chars().count()));
        out.push_str(&format!(" {}{} | {} {}{}\n", name, pad, a + d, "+".repeat(scale(a)), "-".repeat(scale(d))));
    }
    let mut summary = vec![plural(files.len() as u64, "file changed", "files changed")];
    if added > 0 {
        summary.push(plural(added, "insertion(+)", "insertions(+)"));
    }
    if deleted > 0 {
        summary.push(plural(deleted, "deletion(-)", "deletions(-)"));
    }
    out.push_str(&format!(" {}\n", summary.join(", ")));

    // ファイルごとの差分（GitHub は見出しを付けないので、git と同じ見出しを付ける）
    for f in &files {
        let name = f["filename"].as_str().unwrap_or("");
        let old = f["previous_filename"].as_str().unwrap_or(name);
        let status = f["status"].as_str().unwrap_or("");
        out.push_str(&format!("\ndiff --git a/{} b/{}\n", old, name));
        match f["patch"].as_str() {
            Some(patch) => {
                out.push_str(&format!("--- {}\n", if status == "added" { "/dev/null".to_string() } else { format!("a/{}", old) }));
                out.push_str(&format!("+++ {}\n", if status == "removed" { "/dev/null".to_string() } else { format!("b/{}", name) }));
                out.push_str(patch.trim_end_matches('\n'));
                out.push('\n');
            }
            // 画像などのバイナリ、または GitHub が差分を省いたほど大きいもの
            None if status == "renamed" && f["changes"].as_u64() == Some(0) => out.push_str("（名前だけの変更です）\n"),
            None => out.push_str("（GitHub が差分を表示しないファイルです。画像などのバイナリか、大きすぎる変更です）\n"),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_a_commit_like_git_show() {
        let c: Value = serde_json::json!({
            "sha": "7c8d9e0aaaabbbbccccddddeeeeffff000011112",
            "commit": {
                "author": { "name": "Baba Yui", "email": "yui@example.com", "date": "2026-10-02T16:40:12Z" },
                "message": "ボスの移動範囲を、画面の中に制限する (#18)\n\n画面の外に出ると戻ってこなかったため"
            },
            "files": [
                { "filename": "src/Boss.cpp", "status": "modified", "additions": 2, "deletions": 1, "changes": 3,
                  "patch": "@@ -10,3 +10,4 @@ void Boss::Update()\n-    Move();\n+    Move();\n+    ClampToScreen();" },
                { "filename": "assets/boss.png", "status": "added", "additions": 0, "deletions": 0, "changes": 0 },
                { "filename": "src/Util.cpp", "previous_filename": "src/Old.cpp", "status": "renamed", "additions": 0, "deletions": 0, "changes": 0 }
            ]
        });
        let out = format_show(&c);
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines[0], "7c8d9e0aaaabbbbccccddddeeeeffff000011112");
        assert_eq!(lines[1], "Baba Yui <yui@example.com>");
        assert_eq!(lines[3], "");
        assert_eq!(lines[4], "ボスの移動範囲を、画面の中に制限する (#18)");
        assert!(out.contains(" src/Boss.cpp    | 3 ++-\n"), "{}", out);
        assert!(out.contains(" 3 files changed, 2 insertions(+), 1 deletion(-)\n"), "{}", out);
        assert!(out.contains("\ndiff --git a/src/Boss.cpp b/src/Boss.cpp\n--- a/src/Boss.cpp\n+++ b/src/Boss.cpp\n@@ -10,3"));
        assert!(out.contains("\ndiff --git a/assets/boss.png b/assets/boss.png\n（GitHub が差分を表示しないファイル"));
        assert!(out.contains("\ndiff --git a/src/Old.cpp b/src/Util.cpp\n（名前だけの変更です）"));
    }
}
