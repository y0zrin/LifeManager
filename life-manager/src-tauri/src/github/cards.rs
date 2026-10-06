//! リポジトリを選ぶ画面のカード（開いている Issue・プルリク・レビュー待ち・最後の更新・人数）。
//! 選ぶ画面を開いたときに、見ているカードの分だけ読む（1 つのリポジトリで 3 回まで）
use super::client::GitHubClient;
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

/// 開いているプルリクの数と、そのうちレビューをお願いされているもの（まだ誰かの返事を待っている）
fn pull_counts(pulls: &Value) -> (usize, usize) {
    let list = pulls.as_array().cloned().unwrap_or_default();
    let open = list.iter().filter(|p| p["draft"].as_bool() != Some(true)).count();
    let waiting = list
        .iter()
        .filter(|p| p["draft"].as_bool() != Some(true))
        .filter(|p| p["requested_reviewers"].as_array().map(|a| !a.is_empty()).unwrap_or(false))
        .count();
    return (open, waiting);
}

/// リポジトリのカード。読めなかったところは null（人数は、書き込めない人には読めないことがある）
#[tauri::command]
pub async fn repo_card(state: ClientState<'_>, owner: String, repo: String) -> Result<Value, String> {
    let client = client_of(&state).await?;
    let r = parse(&client.get_repo(&owner, &repo).await?)?;
    if r["full_name"].is_null() {
        return Err(r["message"].as_str().unwrap_or("リポジトリを読めませんでした").to_string());
    }
    let pulls = match client.list_open_pulls(&owner, &repo).await {
        Ok(text) => parse(&text).ok(),
        Err(_) => None,
    };
    let (open_pulls, waiting) = pulls.as_ref().map(pull_counts).unwrap_or((0, 0));
    // GitHub の open_issues_count は、開いているプルリク（下書きも）を含む
    let all_open_pulls = pulls.as_ref().and_then(|p| p.as_array().map(|a| a.len())).unwrap_or(0) as i64;
    let open_issues = r["open_issues_count"].as_i64().map(|n| (n - all_open_pulls).max(0));
    let members = match client.list_collaborators(&owner, &repo).await {
        Ok(text) => parse(&text).ok().and_then(|v| v.as_array().cloned()),
        Err(_) => None,
    };
    // カードの右上に並べる顔（5 人まで）
    let faces = members.as_ref().map(|list| {
        list.iter()
            .take(5)
            .map(|p| json!({ "login": p["login"], "avatar_url": p["avatar_url"] }))
            .collect::<Vec<_>>()
    });
    Ok(json!({
        "private": r["private"],
        "description": r["description"],
        "pushed_at": r["pushed_at"],
        "default_branch": r["default_branch"],
        "owner_type": r["owner"]["type"],
        "open_issues": open_issues,
        "open_pulls": if pulls.is_some() { json!(open_pulls) } else { Value::Null },
        "review_waiting": if pulls.is_some() { json!(waiting) } else { Value::Null },
        "members": members.as_ref().map(|list| list.len()),
        "faces": faces,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_open_and_waiting_pulls_without_drafts() {
        let pulls = json!([
            { "draft": false, "requested_reviewers": [{ "login": "a" }] },
            { "draft": false, "requested_reviewers": [] },
            { "draft": true, "requested_reviewers": [{ "login": "b" }] },
        ]);
        assert_eq!(pull_counts(&pulls), (2, 1));
        assert_eq!(pull_counts(&json!([])), (0, 0));
    }
}
