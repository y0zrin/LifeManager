mod credential;
mod git;
mod github;
mod journal;
mod notify;
mod offline;
mod scheduler;

use credential::CredentialEntry as Entry;
use github::client::GitHubClient;
use tauri_plugin_notification::NotificationExt;
use tokio::sync::Mutex;

// --- 認証 ---

#[tauri::command]
fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

// --- リポジトリ設定 ---

#[tauri::command]
fn set_repo_config(owner: String, repo: String) -> Result<String, String> {
    let owner_entry =
        Entry::new("life-manager", "github-owner").map_err(|e| e.to_string())?;
    owner_entry
        .set_password(&owner)
        .map_err(|e| e.to_string())?;

    let repo_entry =
        Entry::new("life-manager", "github-repo").map_err(|e| e.to_string())?;
    repo_entry
        .set_password(&repo)
        .map_err(|e| e.to_string())?;

    return Ok(String::from("リポジトリ設定を保存しました"));
}

#[tauri::command]
fn load_repo_config() -> Result<String, String> {
    let owner_entry =
        Entry::new("life-manager", "github-owner").map_err(|e| e.to_string())?;
    let owner = owner_entry.get_password().unwrap_or_default();

    let repo_entry =
        Entry::new("life-manager", "github-repo").map_err(|e| e.to_string())?;
    let repo = repo_entry.get_password().unwrap_or_default();

    let json = format!(r#"{{"owner":"{}","repo":"{}"}}"#, owner, repo);
    return Ok(json);
}

// --- プロジェクト管理 ---

#[tauri::command]
fn list_projects() -> Result<String, String> {
    let entry = Entry::new("life-manager", "projects").map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(json) => Ok(json),
        Err(_) => Ok("[]".to_string()),
    }
}

#[tauri::command]
fn add_project(owner: String, repo: String, name: String, token: Option<String>) -> Result<String, String> {
    let entry = Entry::new("life-manager", "projects").map_err(|e| e.to_string())?;
    let mut projects: Vec<serde_json::Value> = match entry.get_password() {
        Ok(json) => serde_json::from_str(&json).unwrap_or_default(),
        Err(_) => Vec::new(),
    };

    // 重複チェック
    let exists = projects.iter().any(|p| {
        p.get("owner").and_then(|v| v.as_str()) == Some(&owner)
            && p.get("repo").and_then(|v| v.as_str()) == Some(&repo)
    });

    if !exists {
        projects.push(serde_json::json!({
            "owner": owner,
            "repo": repo,
            "name": name
        }));
        let json = serde_json::to_string(&projects).map_err(|e| e.to_string())?;
        entry.set_password(&json).map_err(|e| e.to_string())?;
    }

    // プロジェクト固有のトークンを保存
    if let Some(t) = token {
        let token_key = format!("project-token-{}/{}", owner, repo);
        let token_entry = Entry::new("life-manager", &token_key).map_err(|e| e.to_string())?;
        token_entry.set_password(&t).map_err(|e| e.to_string())?;
    }

    let result = serde_json::to_string(&projects).map_err(|e| e.to_string())?;
    Ok(result)
}

#[tauri::command]
fn remove_project(owner: String, repo: String) -> Result<String, String> {
    let entry = Entry::new("life-manager", "projects").map_err(|e| e.to_string())?;
    let mut projects: Vec<serde_json::Value> = match entry.get_password() {
        Ok(json) => serde_json::from_str(&json).unwrap_or_default(),
        Err(_) => Vec::new(),
    };

    projects.retain(|p| {
        !(p.get("owner").and_then(|v| v.as_str()) == Some(&owner)
            && p.get("repo").and_then(|v| v.as_str()) == Some(&repo))
    });

    let json = serde_json::to_string(&projects).map_err(|e| e.to_string())?;
    entry.set_password(&json).map_err(|e| e.to_string())?;

    // プロジェクトのトークンも削除
    let token_key = format!("project-token-{}/{}", owner, repo);
    if let Ok(token_entry) = Entry::new("life-manager", &token_key) {
        let _ = token_entry.delete_credential();
    }

    Ok(json)
}

// --- ローカルのフォルダ（PC で git を操作する場所） ---
// PC ごとに違う値なので、その PC のキーチェーンに {"owner/repo": "フォルダ"} の形で持つ。
// プロジェクト一覧に登録していないリポジトリでも設定できるように、一覧とは別に保存する

#[tauri::command]
fn load_local_folders() -> Result<String, String> {
    let entry = Entry::new("life-manager", "local-folders").map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(json) => Ok(json),
        Err(_) => Ok("{}".to_string()),
    }
}

/// フォルダを保存する。None や空文字なら設定を外す。保存後の一覧を返す
#[tauri::command]
fn set_local_folder(owner: String, repo: String, path: Option<String>) -> Result<String, String> {
    let entry = Entry::new("life-manager", "local-folders").map_err(|e| e.to_string())?;
    let mut folders: serde_json::Map<String, serde_json::Value> = match entry.get_password() {
        Ok(json) => serde_json::from_str(&json).unwrap_or_default(),
        Err(_) => serde_json::Map::new(),
    };

    let key = format!("{}/{}", owner, repo);
    match path.filter(|p| !p.trim().is_empty()) {
        Some(p) => {
            folders.insert(key, serde_json::Value::String(p));
        }
        None => {
            folders.remove(&key);
        }
    }

    let json = serde_json::to_string(&folders).map_err(|e| e.to_string())?;
    entry.set_password(&json).map_err(|e| e.to_string())?;
    Ok(json)
}

/// GitHub にあるブランチ・タグ・コミットから履歴を作る（スマホ版や、作業フォルダのない PC のブランチ画面・全体図）
#[tauri::command]
async fn github_history(
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
) -> Result<git::history::History, String> {
    // API を何度も呼ぶので、ほかの操作を待たせないよう、クライアントを複製してすぐにロックを離す
    let client = {
        let guard = state.lock().await;
        guard.as_ref().ok_or("トークンが未設定です")?.clone()
    };
    return github::history::read_history(&client, &owner, &repo).await;
}

/// GitHub にある 1 つのコミットの内容（作業フォルダのないときの「変更内容を見る」。形は git_show と同じ）
#[tauri::command]
async fn github_commit_detail(
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
    hash: String,
) -> Result<github::history::CommitDetail, String> {
    let client = {
        let guard = state.lock().await;
        guard.as_ref().ok_or("トークンが未設定です")?.clone()
    };
    return github::history::commit_detail(&client, &owner, &repo, &hash).await;
}

#[tauri::command]
async fn switch_project(
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
) -> Result<String, String> {
    // プロジェクト固有のトークンを試す → なければグローバルトークンにフォールバック
    let token_key = format!("project-token-{}/{}", owner, repo);
    let token = match Entry::new("life-manager", &token_key) {
        Ok(entry) => match entry.get_password() {
            Ok(t) => t,
            Err(_) => {
                // フォールバック: グローバルトークン
                let global_entry = Entry::new("life-manager", "github-token").map_err(|e| e.to_string())?;
                global_entry.get_password().map_err(|_| String::from("トークンが未設定です。設定画面でプロジェクトのトークンを設定してください。"))?
            }
        },
        Err(_) => {
            let global_entry = Entry::new("life-manager", "github-token").map_err(|e| e.to_string())?;
            global_entry.get_password().map_err(|_| String::from("トークンが未設定です。設定画面でプロジェクトのトークンを設定してください。"))?
        }
    };

    // GitHubClientを更新
    let mut guard = state.lock().await;
    *guard = Some(GitHubClient::new(token));

    // アクティブプロジェクトとして保存
    let owner_entry = Entry::new("life-manager", "github-owner").map_err(|e| e.to_string())?;
    owner_entry.set_password(&owner).map_err(|e| e.to_string())?;
    let repo_entry = Entry::new("life-manager", "github-repo").map_err(|e| e.to_string())?;
    repo_entry.set_password(&repo).map_err(|e| e.to_string())?;

    return Ok(format!("プロジェクトを切り替えました: {}/{}", owner, repo));
}

#[tauri::command]
async fn set_project_token(
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
    token: String,
) -> Result<String, String> {
    let token_key = format!("project-token-{}/{}", owner, repo);
    let entry = Entry::new("life-manager", &token_key).map_err(|e| e.to_string())?;
    entry.set_password(&token).map_err(|e| e.to_string())?;

    // 保存対象が現在アクティブなプロジェクトなら、メモリ上の GitHubClient も即座に差し替える
    // （これを行わないと、アプリ再起動まで古いトークンで API を叩き続けてしまう）
    let active_owner = Entry::new("life-manager", "github-owner")
        .ok()
        .and_then(|e| e.get_password().ok())
        .unwrap_or_default();
    let active_repo = Entry::new("life-manager", "github-repo")
        .ok()
        .and_then(|e| e.get_password().ok())
        .unwrap_or_default();
    if active_owner == owner && active_repo == repo {
        let mut guard = state.lock().await;
        *guard = Some(GitHubClient::new(token));
    }

    return Ok("プロジェクトのトークンを保存しました".to_string());
}

#[tauri::command]
fn has_project_token(owner: String, repo: String) -> Result<bool, String> {
    let token_key = format!("project-token-{}/{}", owner, repo);
    match Entry::new("life-manager", &token_key) {
        Ok(entry) => return Ok(entry.get_password().is_ok()),
        Err(_) => return Ok(false),
    }
}

#[tauri::command]
async fn set_token(
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    token: String,
) -> Result<String, String> {
    let entry = Entry::new("life-manager", "github-token").map_err(|e| e.to_string())?;
    entry.set_password(&token).map_err(|e| e.to_string())?;
    let mut guard = state.lock().await;
    *guard = Some(GitHubClient::new(token));
    return Ok(String::from("トークンを設定しました"));
}

#[tauri::command]
async fn load_token(
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
) -> Result<String, String> {
    // アクティブプロジェクトのトークンを優先的に解決する
    let token = resolve_active_token()?;
    let mut guard = state.lock().await;
    *guard = Some(GitHubClient::new(token));
    return Ok(String::from("トークンをロードしました"));
}

/// アクティブプロジェクトのトークンを解決する
/// 優先順位: プロジェクト固有トークン → グローバルトークン
fn resolve_active_token() -> Result<String, String> {
    // 保存済みの owner/repo を取得
    let owner = Entry::new("life-manager", "github-owner")
        .ok()
        .and_then(|e| e.get_password().ok())
        .unwrap_or_default();
    let repo = Entry::new("life-manager", "github-repo")
        .ok()
        .and_then(|e| e.get_password().ok())
        .unwrap_or_default();

    // プロジェクト固有トークンを試す
    if !owner.is_empty() && !repo.is_empty() {
        let token_key = format!("project-token-{}/{}", owner, repo);
        if let Ok(entry) = Entry::new("life-manager", &token_key) {
            if let Ok(token) = entry.get_password() {
                if !token.is_empty() {
                    return Ok(token);
                }
            }
        }
    }

    // フォールバック: グローバルトークン
    let global_entry = Entry::new("life-manager", "github-token")
        .map_err(|e| e.to_string())?;
    return global_entry
        .get_password()
        .map_err(|_| String::from("トークンがありません"));
}

/// 今のトークンの GitHub クライアント。通信のあいだほかの操作を待たせないよう、複製してすぐにロックを離す
async fn current_client(state: &tauri::State<'_, Mutex<Option<GitHubClient>>>) -> Result<GitHubClient, String> {
    let guard = state.lock().await;
    return Ok(guard.as_ref().ok_or("トークンが未設定です")?.clone());
}

// --- Issue ---
// つながらないときは、最後に読んだ内容を返し、変更は送信待ちに並べる（offline モジュール）

/// cached が true なら GitHub に聞かず、手元の写しに送信待ちの変更を重ねたものを返す（送信待ちが変わったときの表示の更新用）
#[tauri::command]
async fn list_issues(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
    issue_state: Option<String>,
    cached: Option<bool>,
) -> Result<String, String> {
    let client = current_client(&state).await?;
    let s = issue_state.unwrap_or_else(|| "open".to_string());
    return offline::list_issues(&app, &client, &owner, &repo, &s, cached.unwrap_or(false)).await;
}

#[tauri::command]
async fn create_issue(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
    title: String,
    body: String,
    labels: Vec<String>,
    milestone: Option<u32>,
    assignees: Option<Vec<String>>,
    notice: Option<offline::store::Notice>,
) -> Result<String, String> {
    let client = current_client(&state).await?;
    return offline::create_issue(&app, &client, &owner, &repo, title, body, labels, milestone, assignees, notice).await;
}

/// issue_number が負の数なら、まだ GitHub に送っていない Issue（仮の番号）。
/// notice は GitHub に送れたときに出すお知らせ（「{issue}」は番号に置き換わる）
#[tauri::command]
async fn update_issue(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
    issue_number: i64,
    title: Option<String>,
    body: Option<String>,
    issue_state: Option<String>,
    labels: Option<Vec<String>>,
    milestone: Option<u32>,
    assignees: Option<Vec<String>>,
    notice: Option<offline::store::Notice>,
) -> Result<String, String> {
    let client = current_client(&state).await?;
    let changes = offline::store::Changes { title, body, state: issue_state, labels, milestone, assignees };
    return offline::update_issue(&app, &client, &owner, &repo, issue_number, changes, notice).await;
}

// --- User ---

/// owner / repo が分かるときは、そのリポジトリの写しにも覚える（リポジトリごとにトークンが違うことがあるため）
#[tauri::command]
async fn get_current_user(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: Option<String>,
    repo: Option<String>,
) -> Result<String, String> {
    let client = current_client(&state).await?;
    return offline::get_current_user(&app, &client, owner.as_deref(), repo.as_deref()).await;
}

// --- Collaborators ---

#[tauri::command]
async fn list_collaborators(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
) -> Result<String, String> {
    let client = current_client(&state).await?;
    return offline::read_through(&app, &owner, &repo, "collaborators", client.list_collaborators(&owner, &repo)).await;
}

// --- Labels ---

#[tauri::command]
async fn list_labels(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
) -> Result<String, String> {
    let client = current_client(&state).await?;
    return offline::read_through(&app, &owner, &repo, "labels", client.list_labels(&owner, &repo)).await;
}

#[tauri::command]
async fn create_label(
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
    name: String,
    color: String,
    description: String,
) -> Result<String, String> {
    let guard = state.lock().await;
    let client = guard.as_ref().ok_or("トークンが未設定です")?;
    return client.create_label(&owner, &repo, &name, &color, &description).await;
}

#[tauri::command]
async fn update_label(
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
    current_name: String,
    new_name: String,
    color: String,
    description: String,
) -> Result<String, String> {
    let guard = state.lock().await;
    let client = guard.as_ref().ok_or("トークンが未設定です")?;
    return client
        .update_label(&owner, &repo, &current_name, &new_name, &color, &description)
        .await;
}

#[tauri::command]
async fn delete_label(
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
    name: String,
) -> Result<String, String> {
    let guard = state.lock().await;
    let client = guard.as_ref().ok_or("トークンが未設定です")?;
    return client.delete_label(&owner, &repo, &name).await;
}

#[tauri::command]
async fn setup_labels(
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
) -> Result<String, String> {
    let guard = state.lock().await;
    let client = guard.as_ref().ok_or("トークンが未設定です")?;

    let labels = vec![
        ("種別:イシュー",   "0E8A16", "具体的な成果単位"),
        ("種別:メモ",       "FBCA04", "思いつき・タスク未満の断片"),
        ("種別:ルーチン",   "1D76DB", "繰り返しタスク"),
        ("分野:仕事",       "B60205", "仕事関連"),
        ("分野:私用",       "D93F0B", "プライベート"),
        ("分野:やりたい",   "F9D0C4", "やりたいことリスト"),
        ("分野:健康",       "0E8A16", "健康・運動"),
        ("分野:学習",       "5319E7", "学習・スキルアップ"),
        ("状態:未整理",     "C2E0C6", "投入直後・未分類"),
        ("状態:進行中",     "0075CA", "着手済み"),
        ("状態:ブロック",   "E4E669", "外部要因で停止中"),
        ("状態:いつか",     "D4C5F9", "いつかやる"),
        ("優先:高",         "B60205", "高優先度"),
        ("優先:中",         "FBCA04", "中優先度"),
        ("優先:低",         "0E8A16", "低優先度"),
    ];

    let mut created = 0;
    let mut skipped = 0;
    let mut errors: Vec<String> = Vec::new();

    for (name, color, description) in labels {
        match client
            .create_label(&owner, &repo, name, color, description)
            .await
        {
            Ok(_) => created += 1,
            Err(e) if e.contains("422") => skipped += 1,
            Err(e) => errors.push(format!("{}: {}", name, e)),
        }
    }

    let mut msg = format!("作成: {}個, スキップ(既存): {}個", created, skipped);
    if !errors.is_empty() {
        msg.push_str(&format!(", エラー: {:?}", errors));
    }
    return Ok(msg);
}

// --- Milestones ---

#[tauri::command]
async fn list_milestones(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
) -> Result<String, String> {
    let client = current_client(&state).await?;
    return offline::read_through(&app, &owner, &repo, "milestones", client.list_milestones(&owner, &repo)).await;
}

#[tauri::command]
async fn create_milestone(
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
    title: String,
    description: String,
    due_on: Option<String>,
) -> Result<String, String> {
    let guard = state.lock().await;
    let client = guard.as_ref().ok_or("トークンが未設定です")?;
    return client
        .create_milestone(&owner, &repo, &title, &description, due_on)
        .await;
}

#[tauri::command]
async fn update_milestone(
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
    milestone_number: u32,
    title: Option<String>,
    description: Option<String>,
    due_on: Option<String>,
    milestone_state: Option<String>,
) -> Result<String, String> {
    let guard = state.lock().await;
    let client = guard.as_ref().ok_or("トークンが未設定です")?;
    return client
        .update_milestone(&owner, &repo, milestone_number, title, description, due_on, milestone_state)
        .await;
}

// --- Comments ---

#[tauri::command]
async fn list_comments(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
    issue_number: i64,
) -> Result<String, String> {
    let client = current_client(&state).await?;
    return offline::list_comments(&app, &client, &owner, &repo, issue_number).await;
}

#[tauri::command]
async fn create_comment(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
    issue_number: i64,
    body: String,
    notice: Option<offline::store::Notice>,
) -> Result<String, String> {
    let client = current_client(&state).await?;
    return offline::create_comment(&app, &client, &owner, &repo, issue_number, body, notice).await;
}

// --- オフライン（送信待ち） ---

/// 送信待ちの一覧・ぶつかったもの・最後の通信ができなかったか
#[tauri::command]
fn offline_status(app: tauri::AppHandle, owner: String, repo: String) -> offline::OfflineStatus {
    return offline::status(&app, &owner, &repo);
}

/// 送信待ちを今すぐ送る
#[tauri::command]
async fn sync_outbox(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
) -> Result<offline::sync::SyncResult, String> {
    let client = current_client(&state).await?;
    return offline::sync_now(&app, &client, &owner, &repo).await;
}

/// ぶつかったものを片付ける。choice: "remote"（GitHub の内容を残す）/ "local"（自分の変更で上書き）/ "custom"（直した value を送る）
#[tauri::command]
async fn resolve_conflict(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
    id: u64,
    choice: String,
    value: Option<String>,
) -> Result<(), String> {
    let client = current_client(&state).await.ok();
    return offline::resolve_conflict(&app, client.as_ref(), &owner, &repo, id, &choice, value);
}

// --- 設定ファイル（config/*.yaml） ---
// つながらないときは最後に読んだ内容を返し、書き換えは送信待ちに並べる（offline モジュール）

async fn read_config(
    app: &tauri::AppHandle,
    state: &tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: &str,
    repo: &str,
    key: &str,
) -> Result<String, String> {
    let client = current_client(state).await?;
    return offline::read_config(app, &client, owner, repo, key).await;
}

async fn save_config(
    app: &tauri::AppHandle,
    state: &tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: &str,
    repo: &str,
    key: &str,
    json: String,
) -> Result<String, String> {
    let client = current_client(state).await?;
    return offline::save_config(app, &client, owner, repo, key, json).await;
}

// --- Routines ---

#[tauri::command]
async fn get_routines(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
) -> Result<String, String> {
    return read_config(&app, &state, &owner, &repo, "routines").await;
}

#[tauri::command]
async fn save_routines(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
    routines: String,
) -> Result<String, String> {
    return save_config(&app, &state, &owner, &repo, "routines", routines).await;
}

// --- ジャーナル ---

/// つながらないときは、つながってから作る（pending: true）
#[tauri::command]
async fn generate_journal(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
    date: String,
) -> Result<offline::JournalResult, String> {
    let client = current_client(&state).await?;
    return offline::generate_journal(&app, &client, &owner, &repo, &date).await;
}

#[tauri::command]
async fn get_journal(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
    date: String,
) -> Result<String, String> {
    let client = current_client(&state).await?;
    return offline::get_journal(&app, &client, &owner, &repo, &date).await;
}

/// つながらないときは送信待ちに並べる（pending: true）
#[tauri::command]
async fn save_journal_notes(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
    date: String,
    notes: String,
) -> Result<offline::JournalResult, String> {
    let client = current_client(&state).await?;
    return offline::save_journal_notes(&app, &client, &owner, &repo, &date, notes).await;
}

// --- 通知 ---

#[tauri::command]
async fn send_notification(
    app: tauri::AppHandle,
    title: String,
    body: String,
) -> Result<String, String> {
    app.notification()
        .builder()
        .title(&title)
        .body(&body)
        .show()
        .map_err(|e| format!("通知送信エラー: {}", e))?;
    return Ok("通知を送信しました".to_string());
}

// --- 通知スケジュール ---

#[tauri::command]
async fn get_notification_schedules(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
) -> Result<String, String> {
    return read_config(&app, &state, &owner, &repo, "notifications").await;
}

#[tauri::command]
async fn save_notification_schedules(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
    schedules: String,
) -> Result<String, String> {
    return save_config(&app, &state, &owner, &repo, "notifications", schedules).await;
}

// --- イベント通知設定 ---

#[tauri::command]
async fn get_event_notification_config(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
) -> Result<String, String> {
    return read_config(&app, &state, &owner, &repo, "event_notifications").await;
}

#[tauri::command]
async fn save_event_notification_config(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
    config_json: String,
) -> Result<String, String> {
    return save_config(&app, &state, &owner, &repo, "event_notifications", config_json).await;
}

// --- リマインダー ---

#[tauri::command]
async fn get_reminders(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
) -> Result<String, String> {
    return read_config(&app, &state, &owner, &repo, "reminders").await;
}

/// まだ GitHub に作っていない Issue（仮の番号）のリマインダーは、その Issue を送ったあとで GitHub に書く
#[tauri::command]
async fn save_reminders(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
    reminders: String,
) -> Result<String, String> {
    return save_config(&app, &state, &owner, &repo, "reminders", reminders).await;
}

#[tauri::command]
fn refresh_scheduler() {
    scheduler::routine::request_refresh();
}

// --- ボード設定 ---

#[tauri::command]
async fn get_board_config(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
) -> Result<String, String> {
    return read_config(&app, &state, &owner, &repo, "board").await;
}

#[tauri::command]
async fn save_board_config(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
    config: String,
) -> Result<String, String> {
    return save_config(&app, &state, &owner, &repo, "board", config).await;
}

// --- Discord Webhook（プロジェクト別対応） ---

#[tauri::command]
fn set_discord_webhook(owner: String, repo: String, webhook_url: String) -> Result<String, String> {
    let key = format!("project-discord-{}/{}", owner, repo);
    let entry = Entry::new("life-manager", &key).map_err(|e| e.to_string())?;
    if webhook_url.trim().is_empty() {
        // 空文字で保存 → Webhook解除
        let _ = entry.delete_credential();
        return Ok("Discord Webhook URLを解除しました".to_string());
    }
    entry.set_password(&webhook_url).map_err(|e| e.to_string())?;
    return Ok("Discord Webhook URLを保存しました".to_string());
}

#[tauri::command]
fn load_discord_webhook(owner: String, repo: String) -> Result<String, String> {
    let key = format!("project-discord-{}/{}", owner, repo);
    if let Ok(entry) = Entry::new("life-manager", &key) {
        if let Ok(url) = entry.get_password() {
            if !url.is_empty() {
                return Ok(url);
            }
        }
    }
    return Ok(String::new());
}

#[tauri::command]
async fn test_discord_webhook(webhook_url: String) -> Result<String, String> {
    return notify::discord::send_discord(
        &webhook_url,
        "Life Manager: テスト通知です。Webhook接続に成功しました。",
    )
    .await;
}

// --- アプリ起動 ---

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Mutex::new(None::<GitHubClient>))
        .setup(|app| {
            let app_handle = app.handle().clone();
            credential::init_android_data_dir(&app_handle);
            tauri::async_runtime::spawn(async move {
                scheduler::routine::start_scheduler(app_handle).await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_app_version,
            set_token,
            load_token,
            set_repo_config,
            load_repo_config,
            list_projects,
            add_project,
            remove_project,
            switch_project,
            set_project_token,
            has_project_token,
            load_local_folders,
            set_local_folder,
            github_history,
            github_commit_detail,
            list_issues,
            create_issue,
            update_issue,
            get_current_user,
            list_collaborators,
            list_labels,
            create_label,
            update_label,
            delete_label,
            setup_labels,
            list_milestones,
            create_milestone,
            update_milestone,
            list_comments,
            create_comment,
            offline_status,
            sync_outbox,
            resolve_conflict,
            get_routines,
            save_routines,
            generate_journal,
            get_journal,
            save_journal_notes,
            send_notification,
            get_notification_schedules,
            save_notification_schedules,
            get_event_notification_config,
            save_event_notification_config,
            get_reminders,
            save_reminders,
            refresh_scheduler,
            get_board_config,
            save_board_config,
            set_discord_webhook,
            load_discord_webhook,
            test_discord_webhook,
            git::commands::git_version,
            git::commands::git_setup_status,
            git::commands::git_install,
            git::commands::git_set_identity,
            git::commands::git_check_folder,
            git::commands::git_clone,
            git::commands::git_clone_url,
            git::commands::git_folder_state,
            git::commands::git_publish_prepare,
            git::commands::git_remote_exists,
            git::commands::git_publish_push,
            git::commands::git_status,
            git::commands::git_branches,
            git::commands::git_stashes,
            git::commands::git_diff,
            git::commands::git_stage,
            git::commands::git_unstage,
            git::commands::git_commit,
            git::commands::git_push,
            git::commands::git_pull,
            git::commands::git_fetch,
            git::commands::git_switch,
            git::commands::git_stash_push,
            git::commands::git_stash_pop,
            git::commands::git_stash_drop,
            git::commands::git_tag,
            git::commands::git_discard_all,
            git::commands::git_open_terminal,
            git::commands::git_history,
            git::commands::git_detach,
            git::commands::git_show,
            git::commands::git_cherry_pick,
            git::commands::git_revert,
            git::commands::git_reset,
            git::commands::git_merge,
            git::commands::git_rebase,
            git::commands::git_push_branch,
            git::commands::git_set_upstream,
            git::commands::git_rename_branch,
            git::commands::git_delete_branch,
            git::commands::git_abort,
            git::commands::git_continue,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
