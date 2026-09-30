//! ヒストリーの「チームの仕事」: これまでの合計（減らない数）。コミット（既定のブランチ）・終えたタスク（閉じた Issue）・
//! マージしたプルリク・コメント（Issue とプルリクの会話）・リリースを、GitHub に 5 回問い合わせて数える。読めなかったものは null
use super::client::GitHubClient;
use serde_json::{json, Value};
use tokio::sync::Mutex;

type ClientState<'a> = tauri::State<'a, Mutex<Option<GitHubClient>>>;

async fn client_of(state: &ClientState<'_>) -> Result<GitHubClient, String> {
    let guard = state.lock().await;
    return Ok(guard.as_ref().ok_or("トークンが未設定です")?.clone());
}

#[tauri::command]
pub async fn team_totals(state: ClientState<'_>, owner: String, repo: String) -> Result<Value, String> {
    let client = client_of(&state).await?;
    let done_query = format!("repo:{}/{} is:issue is:closed", owner, repo);
    let merged_query = format!("repo:{}/{} is:pr is:merged", owner, repo);
    let (commits, done, merged, comments, releases) = tokio::join!(
        client.count_repo_list(&owner, &repo, "commits"),
        client.search_issue_count(&done_query),
        client.search_issue_count(&merged_query),
        client.count_repo_list(&owner, &repo, "issues/comments"),
        client.count_repo_list(&owner, &repo, "releases"),
    );
    // どれも読めなければ、わけを返す（つながらない・許可がない）
    if commits.is_err() && done.is_err() && merged.is_err() && comments.is_err() && releases.is_err() {
        return Err(commits.err().unwrap_or_default());
    }
    Ok(json!({
        "commits": commits.ok(),
        "done": done.ok(),
        "merged": merged.ok(),
        "comments": comments.ok(),
        "releases": releases.ok(),
    }))
}
