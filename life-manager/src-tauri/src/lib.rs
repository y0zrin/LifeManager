mod credential;
mod github;
mod journal;
mod notify;
mod scheduler;

use credential::CredentialEntry as Entry;
use github::client::GitHubClient;
use tauri_plugin_notification::NotificationExt;
use tokio::sync::Mutex;

// --- 認証 ---

#[tauri::command]
fn get_app_version() -> String {
    return String::from("Life Manager v0.1.0");
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
fn set_project_token(owner: String, repo: String, token: String) -> Result<String, String> {
    let token_key = format!("project-token-{}/{}", owner, repo);
    let entry = Entry::new("life-manager", &token_key).map_err(|e| e.to_string())?;
    entry.set_password(&token).map_err(|e| e.to_string())?;
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
    let entry = Entry::new("life-manager", "github-token").map_err(|e| e.to_string())?;
    let token = entry
        .get_password()
        .map_err(|_| String::from("トークンがありません"))?;
    let mut guard = state.lock().await;
    *guard = Some(GitHubClient::new(token));
    return Ok(String::from("トークンをロードしました"));
}

// --- Issue ---

#[tauri::command]
async fn list_issues(
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
    issue_state: Option<String>,
) -> Result<String, String> {
    let guard = state.lock().await;
    let client = guard.as_ref().ok_or("トークンが未設定です")?;
    let s = issue_state.unwrap_or_else(|| "open".to_string());
    return client.list_issues(&owner, &repo, &s).await;
}

#[tauri::command]
async fn create_issue(
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
    title: String,
    body: String,
    labels: Vec<String>,
    milestone: Option<u32>,
    assignees: Option<Vec<String>>,
) -> Result<String, String> {
    let guard = state.lock().await;
    let client = guard.as_ref().ok_or("トークンが未設定です")?;
    return client
        .create_issue(&owner, &repo, &title, &body, labels, milestone, assignees)
        .await;
}

#[tauri::command]
async fn update_issue(
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
    issue_number: u32,
    title: Option<String>,
    body: Option<String>,
    issue_state: Option<String>,
    labels: Option<Vec<String>>,
    milestone: Option<u32>,
    assignees: Option<Vec<String>>,
) -> Result<String, String> {
    let guard = state.lock().await;
    let client = guard.as_ref().ok_or("トークンが未設定です")?;
    return client
        .update_issue(
            &owner,
            &repo,
            issue_number,
            title,
            body,
            issue_state,
            labels,
            milestone,
            assignees,
        )
        .await;
}

// --- User ---

#[tauri::command]
async fn get_current_user(
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
) -> Result<String, String> {
    let guard = state.lock().await;
    let client = guard.as_ref().ok_or("トークンが未設定です")?;
    client.get_authenticated_user().await
}

// --- Collaborators ---

#[tauri::command]
async fn list_collaborators(
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
) -> Result<String, String> {
    let guard = state.lock().await;
    let client = guard.as_ref().ok_or("トークンが未設定です")?;
    return client.list_collaborators(&owner, &repo).await;
}

// --- Labels ---

#[tauri::command]
async fn list_labels(
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
) -> Result<String, String> {
    let guard = state.lock().await;
    let client = guard.as_ref().ok_or("トークンが未設定です")?;
    return client.list_labels(&owner, &repo).await;
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
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
) -> Result<String, String> {
    let guard = state.lock().await;
    let client = guard.as_ref().ok_or("トークンが未設定です")?;
    return client.list_milestones(&owner, &repo).await;
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
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
    issue_number: u32,
) -> Result<String, String> {
    let guard = state.lock().await;
    let client = guard.as_ref().ok_or("トークンが未設定です")?;
    return client.list_comments(&owner, &repo, issue_number).await;
}

#[tauri::command]
async fn create_comment(
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
    issue_number: u32,
    body: String,
) -> Result<String, String> {
    let guard = state.lock().await;
    let client = guard.as_ref().ok_or("トークンが未設定です")?;
    return client.create_comment(&owner, &repo, issue_number, &body).await;
}

// --- Routines ---

#[tauri::command]
async fn get_routines(
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
) -> Result<String, String> {
    let client = {
        let guard = state.lock().await;
        guard.as_ref().ok_or("トークンが未設定です")?.clone()
    };
    match client
        .get_contents(&owner, &repo, "config/routines.yaml")
        .await
    {
        Ok((content, _sha)) => {
            let config: scheduler::routine::RoutineConfig =
                serde_yaml::from_str(&content).map_err(|e| format!("YAMLパースエラー: {}", e))?;
            let json = serde_json::to_string(&config.routines).map_err(|e| e.to_string())?;
            return Ok(json);
        }
        Err(_) => return Ok("[]".to_string()),
    }
}

#[tauri::command]
async fn save_routines(
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
    routines: String,
) -> Result<String, String> {
    let client = {
        let guard = state.lock().await;
        guard.as_ref().ok_or("トークンが未設定です")?.clone()
    };

    let routines_vec: Vec<scheduler::routine::Routine> =
        serde_json::from_str(&routines).map_err(|e| format!("JSONパースエラー: {}", e))?;
    let config = scheduler::routine::RoutineConfig {
        routines: routines_vec,
    };
    let yaml =
        serde_yaml::to_string(&config).map_err(|e| format!("YAMLシリアライズエラー: {}", e))?;

    let sha = match client
        .get_contents(&owner, &repo, "config/routines.yaml")
        .await
    {
        Ok((_, sha)) => Some(sha),
        Err(_) => None,
    };

    client
        .put_contents(
            &owner,
            &repo,
            "config/routines.yaml",
            &yaml,
            "ルーチン設定を更新",
            sha,
        )
        .await?;

    return Ok("ルーチン設定を保存しました".to_string());
}

// --- ジャーナル ---

#[tauri::command]
async fn generate_journal(
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
    date: String,
) -> Result<String, String> {
    let client = {
        let guard = state.lock().await;
        guard.as_ref().ok_or("トークンが未設定です")?.clone()
    };
    return journal::generator::generate_journal(&client, &owner, &repo, &date).await;
}

#[tauri::command]
async fn get_journal(
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
    date: String,
) -> Result<String, String> {
    let client = {
        let guard = state.lock().await;
        guard.as_ref().ok_or("トークンが未設定です")?.clone()
    };
    return journal::generator::get_journal(&client, &owner, &repo, &date).await;
}

#[tauri::command]
async fn save_journal_notes(
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
    date: String,
    notes: String,
) -> Result<String, String> {
    let client = {
        let guard = state.lock().await;
        guard.as_ref().ok_or("トークンが未設定です")?.clone()
    };
    return journal::generator::save_journal_notes(&client, &owner, &repo, &date, &notes).await;
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
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
) -> Result<String, String> {
    let client = {
        let guard = state.lock().await;
        guard.as_ref().ok_or("トークンが未設定です")?.clone()
    };
    match client
        .get_contents(&owner, &repo, "config/notifications.yaml")
        .await
    {
        Ok((content, _sha)) => {
            let config: scheduler::routine::NotificationConfig =
                serde_yaml::from_str(&content).map_err(|e| format!("YAMLパースエラー: {}", e))?;
            let json =
                serde_json::to_string(&config.notifications).map_err(|e| e.to_string())?;
            return Ok(json);
        }
        Err(_) => return Ok("[]".to_string()),
    }
}

#[tauri::command]
async fn save_notification_schedules(
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
    schedules: String,
) -> Result<String, String> {
    let client = {
        let guard = state.lock().await;
        guard.as_ref().ok_or("トークンが未設定です")?.clone()
    };

    let notif_vec: Vec<scheduler::routine::NotificationSchedule> =
        serde_json::from_str(&schedules).map_err(|e| format!("JSONパースエラー: {}", e))?;

    // 既存のevent_notificationsを保持するため、現在のファイルを読み込む
    let existing_event_notif = match client
        .get_contents(&owner, &repo, "config/notifications.yaml")
        .await
    {
        Ok((content, _)) => {
            serde_yaml::from_str::<scheduler::routine::NotificationConfig>(&content)
                .ok()
                .and_then(|c| c.event_notifications)
        }
        Err(_) => None,
    };

    let config = scheduler::routine::NotificationConfig {
        notifications: notif_vec,
        event_notifications: existing_event_notif,
    };
    let yaml =
        serde_yaml::to_string(&config).map_err(|e| format!("YAMLシリアライズエラー: {}", e))?;

    let sha = match client
        .get_contents(&owner, &repo, "config/notifications.yaml")
        .await
    {
        Ok((_, sha)) => Some(sha),
        Err(_) => None,
    };

    client
        .put_contents(
            &owner,
            &repo,
            "config/notifications.yaml",
            &yaml,
            "通知スケジュール設定を更新",
            sha,
        )
        .await?;

    return Ok("通知スケジュールを保存しました".to_string());
}

// --- イベント通知設定 ---

#[tauri::command]
async fn get_event_notification_config(
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
) -> Result<String, String> {
    let client = {
        let guard = state.lock().await;
        guard.as_ref().ok_or("トークンが未設定です")?.clone()
    };
    match client
        .get_contents(&owner, &repo, "config/notifications.yaml")
        .await
    {
        Ok((content, _sha)) => {
            let config: scheduler::routine::NotificationConfig =
                serde_yaml::from_str(&content).map_err(|e| format!("YAMLパースエラー: {}", e))?;
            match config.event_notifications {
                Some(event_config) => {
                    let json =
                        serde_json::to_string(&event_config).map_err(|e| e.to_string())?;
                    return Ok(json);
                }
                None => return Ok("null".to_string()),
            }
        }
        Err(_) => return Ok("null".to_string()),
    }
}

#[tauri::command]
async fn save_event_notification_config(
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
    config_json: String,
) -> Result<String, String> {
    let client = {
        let guard = state.lock().await;
        guard.as_ref().ok_or("トークンが未設定です")?.clone()
    };

    let event_config: scheduler::routine::EventNotificationConfig =
        serde_json::from_str(&config_json).map_err(|e| format!("JSONパースエラー: {}", e))?;

    // 既存のスケジュール通知を保持するため、現在のファイルを読み込む
    let existing_schedules = match client
        .get_contents(&owner, &repo, "config/notifications.yaml")
        .await
    {
        Ok((content, _)) => {
            serde_yaml::from_str::<scheduler::routine::NotificationConfig>(&content)
                .ok()
                .map(|c| c.notifications)
                .unwrap_or_default()
        }
        Err(_) => vec![],
    };

    let config = scheduler::routine::NotificationConfig {
        notifications: existing_schedules,
        event_notifications: Some(event_config),
    };
    let yaml =
        serde_yaml::to_string(&config).map_err(|e| format!("YAMLシリアライズエラー: {}", e))?;

    let sha = match client
        .get_contents(&owner, &repo, "config/notifications.yaml")
        .await
    {
        Ok((_, sha)) => Some(sha),
        Err(_) => None,
    };

    client
        .put_contents(
            &owner,
            &repo,
            "config/notifications.yaml",
            &yaml,
            "イベント通知設定を更新",
            sha,
        )
        .await?;

    return Ok("イベント通知設定を保存しました".to_string());
}

#[tauri::command]
async fn send_event_notification(
    app: tauri::AppHandle,
    owner: String,
    repo: String,
    message: String,
    channels: Vec<String>,
) -> Result<String, String> {
    if channels.contains(&"os".to_string()) {
        scheduler::routine::send_os_notification_public(&app, "Life Manager", &message);
    }
    if channels.contains(&"discord".to_string()) {
        scheduler::routine::send_discord_if_configured_public(&owner, &repo, &message).await;
    }
    return Ok("OK".to_string());
}

// --- リマインダー ---

#[tauri::command]
async fn get_reminders(
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
) -> Result<String, String> {
    let client = {
        let guard = state.lock().await;
        guard.as_ref().ok_or("トークンが未設定です")?.clone()
    };
    match client
        .get_contents(&owner, &repo, "config/reminders.yaml")
        .await
    {
        Ok((content, _sha)) => {
            let config: scheduler::routine::ReminderConfig =
                serde_yaml::from_str(&content).map_err(|e| format!("YAMLパースエラー: {}", e))?;
            let json = serde_json::to_string(&config.reminders).map_err(|e| e.to_string())?;
            return Ok(json);
        }
        Err(_) => return Ok("[]".to_string()),
    }
}

#[tauri::command]
async fn save_reminders(
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
    reminders: String,
) -> Result<String, String> {
    let client = {
        let guard = state.lock().await;
        guard.as_ref().ok_or("トークンが未設定です")?.clone()
    };

    let reminders_vec: Vec<scheduler::routine::Reminder> =
        serde_json::from_str(&reminders).map_err(|e| format!("JSONパースエラー: {}", e))?;
    let config = scheduler::routine::ReminderConfig {
        reminders: reminders_vec,
    };
    let yaml =
        serde_yaml::to_string(&config).map_err(|e| format!("YAMLシリアライズエラー: {}", e))?;

    let sha = match client
        .get_contents(&owner, &repo, "config/reminders.yaml")
        .await
    {
        Ok((_, sha)) => Some(sha),
        Err(_) => None,
    };

    client
        .put_contents(
            &owner,
            &repo,
            "config/reminders.yaml",
            &yaml,
            "リマインダーを更新",
            sha,
        )
        .await?;

    return Ok("リマインダーを保存しました".to_string());
}

#[tauri::command]
fn refresh_scheduler() {
    scheduler::routine::request_refresh();
}

// --- ボード設定 ---

#[tauri::command]
async fn get_board_config(
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
) -> Result<String, String> {
    let client = {
        let guard = state.lock().await;
        guard.as_ref().ok_or("トークンが未設定です")?.clone()
    };
    match client
        .get_contents(&owner, &repo, "config/board.yaml")
        .await
    {
        Ok((content, _sha)) => {
            let config: serde_json::Value =
                serde_yaml::from_str(&content).map_err(|e| format!("YAMLパースエラー: {}", e))?;
            let json = serde_json::to_string(&config).map_err(|e| e.to_string())?;
            return Ok(json);
        }
        Err(_) => return Ok("null".to_string()),
    }
}

#[tauri::command]
async fn save_board_config(
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
    config: String,
) -> Result<String, String> {
    let client = {
        let guard = state.lock().await;
        guard.as_ref().ok_or("トークンが未設定です")?.clone()
    };

    let config_value: serde_json::Value =
        serde_json::from_str(&config).map_err(|e| format!("JSONパースエラー: {}", e))?;
    let yaml = serde_yaml::to_string(&config_value)
        .map_err(|e| format!("YAMLシリアライズエラー: {}", e))?;

    let sha = match client
        .get_contents(&owner, &repo, "config/board.yaml")
        .await
    {
        Ok((_, sha)) => Some(sha),
        Err(_) => None,
    };

    client
        .put_contents(
            &owner,
            &repo,
            "config/board.yaml",
            &yaml,
            "ボード設定を更新",
            sha,
        )
        .await?;

    return Ok("ボード設定を保存しました".to_string());
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
            send_event_notification,
            get_reminders,
            save_reminders,
            refresh_scheduler,
            get_board_config,
            save_board_config,
            set_discord_webhook,
            load_discord_webhook,
            test_discord_webhook,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
