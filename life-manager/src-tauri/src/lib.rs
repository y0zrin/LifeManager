mod credential;
mod git;
mod github;
mod journal;
mod notify;
mod offline;
mod scheduler;
mod tokens;

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

    // プロジェクト専用のトークン（入れたときだけ）
    if let Some(t) = token.filter(|t| !t.trim().is_empty()) {
        tokens::set_project(&owner, &repo, &tokens::clean(&t)?)?;
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
    tokens::clear_project(&owner, &repo);

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
    // プロジェクト専用のトークン → なければいつものトークン
    let client = client_for(&owner, &repo)
        .ok_or_else(|| String::from("トークンがありません。GitHub にログインするか、設定 → 接続 でトークンを入れてください。"))?;

    // GitHubClientを更新
    let mut guard = state.lock().await;
    *guard = Some(client);

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
    tokens::set_project(&owner, &repo, &tokens::clean(&token)?)?;
    // 今開いているプロジェクトなら、使うトークンもすぐ差し替える
    reload_active_client(&state).await;
    return Ok("プロジェクトのトークンを保存しました".to_string());
}

#[tauri::command]
fn has_project_token(owner: String, repo: String) -> Result<bool, String> {
    Ok(tokens::project_token(&owner, &repo).is_some())
}

/// プロジェクト専用のトークンを外す（いつものトークンを使うようになる）
#[tauri::command]
async fn clear_project_token(
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
) -> Result<String, String> {
    tokens::clear_project(&owner, &repo);
    reload_active_client(&state).await;
    Ok("いつものトークンを使うようにしました".to_string())
}

/// いつものトークンを入れる（貼ったトークンの前後の空白は外す）
#[tauri::command]
async fn set_token(
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    token: String,
) -> Result<String, String> {
    tokens::set_default(&tokens::clean(&token)?)?;
    // 今のプロジェクトに専用のトークンがあれば、そちらを使い続ける
    reload_active_client(&state).await;
    return Ok(String::from("トークンを設定しました"));
}

#[tauri::command]
async fn load_token(
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
) -> Result<String, String> {
    // 前のセットアップが、いつものトークンを最初のプロジェクト専用にも入れていたのを外す
    tokens::drop_duplicate_project_tokens(&project_list());
    // ログインの鍵は、期限が近ければここで新しくする（この PC で使う期限が過ぎていたら消えて、ログインし直しになる）
    let _ = tokens::fresh_default().await;
    let client = active_client().ok_or_else(|| String::from("トークンがありません"))?;
    let mut guard = state.lock().await;
    *guard = Some(client);
    return Ok(String::from("トークンをロードしました"));
}

/// 登録しているプロジェクト（持ち主・名前）
fn project_list() -> Vec<(String, String)> {
    let json = Entry::new("life-manager", "projects").ok().and_then(|e| e.get_password().ok()).unwrap_or_default();
    serde_json::from_str::<Vec<serde_json::Value>>(&json)
        .unwrap_or_default()
        .iter()
        .filter_map(|p| Some((p["owner"].as_str()?.to_string(), p["repo"].as_str()?.to_string())))
        .collect()
}

/// プロジェクトで使うクライアント（専用のトークン → いつもの）。いつものは、ログインの鍵が新しくなっても使い続けられる形で作る
fn client_for(owner: &str, repo: &str) -> Option<GitHubClient> {
    if let Some(token) = tokens::project_token(owner, repo) {
        return Some(GitHubClient::new(token));
    }
    tokens::default_token().map(GitHubClient::following_default)
}

/// 今開いているプロジェクトで使うクライアント
fn active_client() -> Option<GitHubClient> {
    match tokens::active_project() {
        Some((owner, repo)) => client_for(&owner, &repo),
        None => tokens::default_token().map(GitHubClient::following_default),
    }
}

/// 今開いているプロジェクトで使うトークンで、クライアントを作り直す（トークンがなければ外す）
async fn reload_active_client(state: &tauri::State<'_, Mutex<Option<GitHubClient>>>) {
    let mut guard = state.lock().await;
    *guard = active_client();
}

// --- GitHub でログイン（デバイスフロー）・トークンの確認 ---

/// 「GitHub でログイン」に使う GitHub App の Client ID（秘密ではない）。空なら、ログインは使えない（トークンで入る）
#[tauri::command]
fn auth_client_id() -> String {
    github::auth::CLIENT_ID.to_string()
}

/// Life Manager App を入れる画面（初回の「使用するリポジトリを選ぶ」・2 つ目からの「リポジトリを追加する」）
#[tauri::command]
fn auth_install_url() -> String {
    github::auth::install_url()
}

/// この PC で使う期限が来て、ログインの鍵を消したか（1 回だけ true を返す。最初の画面で知らせる）
#[tauri::command]
fn take_login_notice() -> bool {
    tokens::take_expired_notice()
}

/// ログインを始める（画面に出すコードをもらう）
#[tauri::command]
async fn auth_start() -> Result<github::auth::DeviceCode, String> {
    github::auth::start().await
}

/// 許可されたかを確かめる。許可されたら、いつものトークンとしてしまい、今のプロジェクトで使う。
/// days は、この PC で使う日数（過ぎたらログインし直し）
#[tauri::command]
async fn auth_poll(
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    device_code: String,
    days: Option<u32>,
) -> Result<github::auth::Poll, String> {
    let (poll, tokens) = github::auth::poll(&device_code).await?;
    if let Some(tokens) = tokens {
        tokens::save_login(&tokens, days)?;
        reload_active_client(&state).await;
    }
    Ok(poll)
}

/// ログアウト（学校の PC などで使い終わったとき）。この PC から、いつものトークンもプロジェクト専用のトークンも消す
/// （どれも、だれかの合鍵なので）。使うリポジトリの一覧は、login のアカウントの分としてしまうので、
/// 次に同じアカウントでログインすれば続きから使え、別の人には前の人の一覧が出ない
#[tauri::command]
async fn sign_out(state: tauri::State<'_, Mutex<Option<GitHubClient>>>, login: Option<String>) -> Result<String, String> {
    if let Some(login) = login.as_deref() {
        tokens::put_away_projects(login)?;
    }
    tokens::clear_default();
    for (owner, repo) in project_list() {
        tokens::clear_project(&owner, &repo);
    }
    let mut guard = state.lock().await;
    *guard = None;
    Ok("ログアウトしました".to_string())
}

// --- アカウントの切り替え（この PC でログインしたアカウントをしまっておき、入れ替える） ---

/// 切り替えの一覧に出す、しまってあるアカウント
#[derive(serde::Serialize)]
struct AccountSummary {
    login: String,
    avatar_url: Option<String>,
    /// 使うリポジトリ（owner/repo。見出しに出す）
    projects: Vec<String>,
}

#[tauri::command]
fn list_accounts() -> Vec<AccountSummary> {
    tokens::saved_accounts()
        .into_iter()
        .map(|a| AccountSummary {
            projects: tokens::saved_projects_of(&a.login).into_iter().map(|(o, r)| format!("{}/{}", o, r)).collect(),
            login: a.login,
            avatar_url: a.avatar_url,
        })
        .collect()
}

/// 今のアカウントをしまう（別のアカウントを足すとき。そのあとログインの画面になる）
#[tauri::command]
async fn stash_account(
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    login: String,
    avatar_url: Option<String>,
) -> Result<(), String> {
    tokens::stash_active(&login, avatar_url)?;
    reload_active_client(&state).await;
    Ok(())
}

/// しまってあるアカウントに切り替える（今のアカウントはしまう）
#[tauri::command]
async fn switch_account(
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    current: String,
    current_avatar: Option<String>,
    target: String,
) -> Result<(), String> {
    if !tokens::has_saved_keys(&target) {
        return Err(format!("{} の鍵が、この PC にありません。「別のアカウントを追加」からログインしてください", target));
    }
    tokens::stash_active(&current, current_avatar)?;
    if let Err(e) = tokens::restore(&target) {
        // 切り替えられなければ、元のアカウントに戻す
        let _ = tokens::restore(&current);
        reload_active_client(&state).await;
        return Err(e);
    }
    reload_active_client(&state).await;
    Ok(())
}

/// しまってあるアカウントを、今のアカウントにする（今のアカウントがないとき: 足すのをやめた・ログアウトした）
#[tauri::command]
async fn restore_account(state: tauri::State<'_, Mutex<Option<GitHubClient>>>, login: String) -> Result<(), String> {
    tokens::restore(&login)?;
    reload_active_client(&state).await;
    Ok(())
}

/// ログインしたばかりのアカウントが前にこの PC で使っていたものなら、使うリポジトリの一覧を戻す（戻して、開くリポジトリもあれば true）
#[tauri::command]
fn adopt_login(login: String) -> Result<bool, String> {
    tokens::adopt(&login)
}

/// しまってあるアカウントを、この PC から外す（そのアカウントの鍵を消す）
#[tauri::command]
fn forget_account(login: String) -> Result<(), String> {
    tokens::forget(&login)
}

/// トークンを確かめる。token を渡せばそれを、渡さなければ owner/repo のプロジェクトで使うトークン（なければいつもの）を確かめる
#[tauri::command]
async fn check_token(
    token: Option<String>,
    owner: Option<String>,
    repo: Option<String>,
    repos: Vec<github::token_check::RepoRef>,
) -> Result<github::token_check::TokenReport, String> {
    let token = match token {
        Some(t) => tokens::clean(&t)?,
        // ログインの鍵なら、期限が近ければ新しくしてから確かめる
        None => match (owner.as_deref(), repo.as_deref()) {
            (Some(o), Some(r)) => tokens::fresh_token_for(o, r).await,
            _ => tokens::fresh_default().await,
        }
        .ok_or("トークンがありません（ログインの期限が来たときは、もう一度ログインしてください）")?,
    };
    github::token_check::check(&token, &repos).await
}

#[derive(serde::Serialize)]
struct ProjectTokenUse {
    owner: String,
    repo: String,
    /// project（専用）/ default（いつもの）/ none（どちらもない）
    source: &'static str,
}

#[derive(serde::Serialize)]
struct TokenOverview {
    /// いつものトークンがあるか・その種類（トークンそのものは渡さない）
    has_default: bool,
    default_kind: Option<&'static str>,
    projects: Vec<ProjectTokenUse>,
}

/// どのプロジェクトがどのトークンを使っているか（トークンそのものは渡さない）
#[tauri::command]
fn token_overview() -> TokenOverview {
    let default = tokens::default_token();
    TokenOverview {
        has_default: default.is_some(),
        default_kind: default.as_deref().map(tokens::kind_of),
        projects: project_list()
            .into_iter()
            .map(|(owner, repo)| {
                let source = if tokens::project_token(&owner, &repo).is_some() {
                    "project"
                } else if default.is_some() {
                    "default"
                } else {
                    "none"
                };
                ProjectTokenUse { owner, repo, source }
            })
            .collect(),
    }
}

/// ログインした人が使えるリポジトリ（最初のセットアップで選ぶため）。
/// 「GitHub でログイン」なら、Life Manager App を入れたリポジトリだけ（更新の新しい順）
#[tauri::command]
async fn list_user_repos(state: tauri::State<'_, Mutex<Option<GitHubClient>>>) -> Result<String, String> {
    let client = current_client(&state).await?;
    if tokens::default_token().is_some_and(|t| tokens::kind_of(&t) == "app") {
        let mut repos = client.list_installed_repos().await?;
        repos.sort_by(|a, b| b["updated_at"].as_str().unwrap_or("").cmp(a["updated_at"].as_str().unwrap_or("")));
        return Ok(serde_json::Value::Array(repos).to_string());
    }
    client.list_user_repos().await
}

/// Life Manager App を入れてある先（初回の「使用するリポジトリを選ぶ」と、2 つ目からの「リポジトリを追加する」を分けるため）。
/// [{ id, account: { login, type, id }, repository_selection: "all" | "selected", html_url }]
#[tauri::command]
async fn list_installations(state: tauri::State<'_, Mutex<Option<GitHubClient>>>) -> Result<String, String> {
    let client = current_client(&state).await?;
    let list: Vec<serde_json::Value> = client
        .list_installations()
        .await?
        .iter()
        .map(|i| {
            serde_json::json!({
                "id": i["id"],
                "account": { "login": i["account"]["login"], "type": i["account"]["type"], "id": i["account"]["id"] },
                "repository_selection": i["repository_selection"],
                "html_url": i["html_url"],
            })
        })
        .collect();
    Ok(serde_json::Value::Array(list).to_string())
}

// --- チーム（招待・メンバー）。最初のセットアップの「チームに入る」と、設定 → チーム ---

fn parse_json(text: &str) -> Result<serde_json::Value, String> {
    serde_json::from_str(text).map_err(|e| e.to_string())
}

/// 自分で作ったトークン（Fine-grained token）に権限がないときの GitHub の言葉を、直し方つきの言葉にする。what は「招待すること」など
fn token_permission_message(err: &str, what: &str) -> String {
    if err.contains("not accessible by personal access token") {
        format!(
            "今のトークン（自分で作ったトークン）では、{}ができません。「GitHub でログイン」で入り直すか、GitHub のトークンの画面でこのトークンに「Administration」の権限（Read and write）を足してください",
            what
        )
    } else if err.contains("not accessible by integration") {
        // GitHub でログインしたとき: そのリポジトリ（アカウント）に Life Manager が入っていない
        format!(
            "{}ができません。このリポジトリに Life Manager が入っていないか、入れたときに選んでいません。持ち主（リーダー）が GitHub で Life Manager を入れて、このリポジトリを選ぶと使えます",
            what
        )
    } else {
        err.to_string()
    }
}

/// 自分宛ての招待。{"repos": [リポジトリへの招待], "orgs": [組織への招待]}
#[tauri::command]
async fn list_my_invitations(state: tauri::State<'_, Mutex<Option<GitHubClient>>>) -> Result<String, String> {
    let client = current_client(&state).await?;
    let repos = parse_json(&client.list_my_repo_invitations().await?)?;
    // 組織の招待を読むには read:org が要る。トークンで入った人は読めないことがあるので、そのときは無しとする
    let orgs = match client.list_my_org_invitations().await {
        Ok(text) => parse_json(&text).unwrap_or_else(|_| serde_json::json!([])),
        Err(_) => serde_json::json!([]),
    };
    Ok(serde_json::json!({ "repos": repos, "orgs": orgs }).to_string())
}

/// リポジトリへの招待を受ける（accept = true）・断る
#[tauri::command]
async fn answer_invitation(state: tauri::State<'_, Mutex<Option<GitHubClient>>>, id: u64, accept: bool) -> Result<(), String> {
    let client = current_client(&state).await?;
    client.answer_repo_invitation(id, accept).await.map_err(|e| {
        let what = if accept { "招待を受けること" } else { "招待を断ること" };
        let message = token_permission_message(&e, what);
        if message != e { format!("{}（メールの「View invitation」からも受けられます）", message) } else { e }
    })
}

/// 自分用のリポジトリを作る（作ったリポジトリを返す）
#[tauri::command]
async fn create_my_repo(state: tauri::State<'_, Mutex<Option<GitHubClient>>>, name: String, private: bool) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("リポジトリの名前を入れてください".into());
    }
    let client = current_client(&state).await?;
    client.create_user_repo(name, private).await.map_err(|e| {
        if e.contains("already exists") {
            format!("「{}」というリポジトリはもうあります。別の名前にするか、一覧から選んでください", name)
        } else if e.contains("not accessible by integration") {
            // GitHub でログインしたとき: 自分のアカウントに Life Manager が入っていない（入れたリポジトリにしか触れない）
            "Life Manager が、あなたのアカウントにまだ入っていないため、ここでは作れません。先に「使用するリポジトリを選ぶ」で Life Manager を入れてください（入れたあとは、ここで作れます）".to_string()
        } else if e.contains("not accessible by personal access token") {
            format!("{}（GitHub の画面 github.com/new で作ってから、一覧から選んでも同じです）", token_permission_message(&e, "リポジトリを作ること"))
        } else {
            e
        }
    })
}

/// 設定 → チーム に出すもの。自分の権限（管理者・書き込み）、組織のリポジトリか、メンバー、送った招待（管理者だけ）
#[tauri::command]
async fn team_overview(state: tauri::State<'_, Mutex<Option<GitHubClient>>>, owner: String, repo: String) -> Result<String, String> {
    let client = current_client(&state).await?;
    let info = parse_json(&client.get_repo(&owner, &repo).await?)?;
    let admin = info["permissions"]["admin"].as_bool().unwrap_or(false);
    let push = info["permissions"]["push"].as_bool().unwrap_or(false);
    let organization = info["owner"]["type"].as_str() == Some("Organization");
    // 読めないものがあっても、読めたものは出す（トークンの権限が足りないときなど）
    let (members, members_error) = if push {
        match client.list_collaborators(&owner, &repo).await {
            Ok(text) => (parse_json(&text)?, None),
            Err(e) => (serde_json::json!([]), Some(token_permission_message(&e, "メンバーを読むこと"))),
        }
    } else {
        (serde_json::json!([]), None)
    };
    let (invitations, invitations_error) = if admin {
        match client.list_repo_invitations(&owner, &repo).await {
            Ok(text) => (parse_json(&text)?, None),
            Err(e) => (serde_json::Value::Null, Some(token_permission_message(&e, "招待すること・送った招待を読むこと"))),
        }
    } else {
        (serde_json::Value::Null, None)
    };
    Ok(serde_json::json!({
        "admin": admin,
        "push": push,
        "organization": organization,
        "members": members,
        "members_error": members_error,
        "invitations": invitations,
        "invitations_error": invitations_error,
    })
    .to_string())
}

/// 招待の結果（画面で 1 人ずつ出す）
#[derive(Debug, serde::Serialize, PartialEq)]
struct InviteOutcome {
    /// invited = 招待した、already = もう使える人、no_user = その名前の人がいない、forbidden = 招待できない、invalid = GitHub が受け付けない、failed = そのほか
    status: &'static str,
    message: Option<String>,
}

/// GitHub の返事（状態と本文）を、招待の結果に直す。user_exists は 404 のときに確かめた結果
fn invite_outcome(status: u16, body: &str, user_exists: Option<bool>) -> InviteOutcome {
    let json: serde_json::Value = serde_json::from_str(body).unwrap_or(serde_json::Value::Null);
    let github_message = json["errors"][0]["message"]
        .as_str()
        .or_else(|| json["message"].as_str())
        .map(|s| s.to_string());
    let outcome = |status: &'static str, message: Option<String>| InviteOutcome { status, message };
    match status {
        201 => outcome("invited", None),
        204 => outcome("already", None),
        404 if user_exists == Some(false) => outcome("no_user", None),
        404 => outcome("forbidden", Some("このリポジトリの管理者だけが招待できます（リポジトリが見つからないか、管理者の権限がありません）".into())),
        403 => {
            let raw = github_message.unwrap_or_default();
            let message = if raw.contains("not accessible by personal access token") {
                token_permission_message(&raw, "招待すること")
            } else if raw.to_lowercase().contains("limit") {
                "招待の数が上限に達しました。時間をおいてから送ってください".to_string()
            } else if raw.to_lowercase().contains("admin") {
                "このリポジトリの管理者だけが招待できます".to_string()
            } else {
                format!("招待できませんでした（{}）", raw)
            };
            outcome("forbidden", Some(message))
        }
        422 => outcome("invalid", Some(format!("GitHub が受け付けませんでした（{}）", github_message.unwrap_or_default()))),
        _ => outcome("failed", Some(format!("HTTP {}: {}", status, github_message.unwrap_or_default()))),
    }
}

/// 名前で招待する（1 人ずつ呼ぶ）。permission は組織のリポジトリのときだけ（pull / triage / push / maintain / admin）
#[tauri::command]
async fn invite_member(
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
    username: String,
    permission: Option<String>,
) -> Result<InviteOutcome, String> {
    let client = current_client(&state).await?;
    let username = username.trim().trim_start_matches('@');
    let (status, body) = client.invite_collaborator(&owner, &repo, username, permission.as_deref()).await?;
    let exists = if status == 404 { Some(client.user_exists(username).await?) } else { None };
    Ok(invite_outcome(status, &body, exists))
}

/// 送った招待を取り消す
#[tauri::command]
async fn cancel_invitation(state: tauri::State<'_, Mutex<Option<GitHubClient>>>, owner: String, repo: String, id: u64) -> Result<(), String> {
    let client = current_client(&state).await?;
    client.cancel_repo_invitation(&owner, &repo, id).await.map_err(|e| token_permission_message(&e, "招待を取り消すこと"))
}

/// メンバーを外す（管理者だけ。組織のリポジトリでは、組織のメンバーとしての権限は残る）
#[tauri::command]
async fn remove_member(state: tauri::State<'_, Mutex<Option<GitHubClient>>>, owner: String, repo: String, username: String) -> Result<(), String> {
    let client = current_client(&state).await?;
    let username = username.trim().trim_start_matches('@');
    client.remove_collaborator(&owner, &repo, username).await.map_err(|e| {
        if e.starts_with("HTTP 403") && !e.contains("not accessible by") {
            "メンバーを外せるのは、このリポジトリの管理者だけです".to_string()
        } else {
            token_permission_message(&e, "メンバーを外すこと")
        }
    })
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
    state_reason: Option<String>,
    duplicate_issue_id: Option<u64>,
    notice: Option<offline::store::Notice>,
) -> Result<String, String> {
    let client = current_client(&state).await?;
    let changes = offline::store::Changes { title, body, state: issue_state, labels, milestone, assignees, state_reason, duplicate_issue_id };
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
        // 見積もり（見積:3pt など）は、単位がリポジトリの設定で変わるので、付けるときに画面が作る
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

/// Issue テンプレート（リポジトリの .github/ISSUE_TEMPLATE/*.md）。つながらないときは最後に読んだもの
#[tauri::command]
async fn list_issue_templates(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
) -> Result<Vec<github::templates::IssueTemplate>, String> {
    let client = current_client(&state).await?;
    return offline::list_issue_templates(&app, &client, &owner, &repo).await;
}

/// Issue テンプレートをリポジトリに置く（1 つのコミット）。置いたあとの一覧を返す
#[tauri::command]
async fn add_issue_templates(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
    templates: Vec<github::templates::IssueTemplate>,
    message: String,
) -> Result<Vec<github::templates::IssueTemplate>, String> {
    let client = current_client(&state).await?;
    return offline::add_issue_templates(&app, &client, &owner, &repo, templates, &message).await;
}

/// Issue の変更の履歴（タイムライン）。つながっているときだけ
#[tauri::command]
async fn list_issue_timeline(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
    issue_number: u32,
) -> Result<String, String> {
    let client = current_client(&state).await?;
    return offline::list_timeline(&app, &client, &owner, &repo, issue_number).await;
}

// --- サブイシュー（親子）。つながっているときだけ使える（送信待ちには並べない） ---

#[tauri::command]
async fn list_sub_issues(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
    issue_number: u32,
) -> Result<String, String> {
    let client = current_client(&state).await?;
    return offline::list_sub_issues(&app, &client, &owner, &repo, issue_number).await;
}

/// sub_issue_id は子にする Issue の id（番号ではない）。replace_parent なら、ほかの親から付け替える
#[tauri::command]
async fn add_sub_issue(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
    issue_number: u32,
    sub_issue_id: u64,
    replace_parent: Option<bool>,
) -> Result<String, String> {
    let client = current_client(&state).await?;
    return offline::add_sub_issue(&app, &client, &owner, &repo, issue_number, sub_issue_id, replace_parent.unwrap_or(false)).await;
}

#[tauri::command]
async fn remove_sub_issue(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
    issue_number: u32,
    sub_issue_id: u64,
) -> Result<String, String> {
    let client = current_client(&state).await?;
    return offline::remove_sub_issue(&app, &client, &owner, &repo, issue_number, sub_issue_id).await;
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

// --- 見積もりの単位 ---

#[tauri::command]
async fn get_estimate_config(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
) -> Result<String, String> {
    return read_config(&app, &state, &owner, &repo, "estimate").await;
}

#[tauri::command]
async fn save_estimate_config(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
    config: String,
) -> Result<String, String> {
    return save_config(&app, &state, &owner, &repo, "estimate", config).await;
}

// --- 保存した見方（タスク一覧） ---

#[tauri::command]
async fn get_saved_views(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
) -> Result<String, String> {
    return read_config(&app, &state, &owner, &repo, "views").await;
}

#[tauri::command]
async fn save_saved_views(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: String,
    repo: String,
    views: String,
) -> Result<String, String> {
    return save_config(&app, &state, &owner, &repo, "views", views).await;
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
            auth_client_id,
            auth_install_url,
            list_installations,
            take_login_notice,
            auth_start,
            auth_poll,
            sign_out,
            list_accounts,
            stash_account,
            switch_account,
            restore_account,
            adopt_login,
            forget_account,
            check_token,
            token_overview,
            clear_project_token,
            list_user_repos,
            list_my_invitations,
            answer_invitation,
            create_my_repo,
            team_overview,
            invite_member,
            cancel_invitation,
            remove_member,
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
            list_issue_timeline,
            list_issue_templates,
            add_issue_templates,
            list_sub_issues,
            add_sub_issue,
            remove_sub_issue,
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
            get_saved_views,
            save_saved_views,
            get_estimate_config,
            save_estimate_config,
            set_discord_webhook,
            load_discord_webhook,
            test_discord_webhook,
            github::actions::actions_overview,
            github::actions::actions_workflows,
            github::actions::run_jobs,
            github::actions::job_log,
            github::actions::rerun_run,
            github::actions::cancel_run,
            github::actions::dispatch_workflow,
            github::actions::commit_checks,
            github::actions::commits_checks,
            github::pulls::list_pulls,
            github::pulls::pull_verdicts,
            github::pulls::pull_detail,
            github::pulls::pull_files,
            github::pulls::pull_commits,
            github::pulls::pull_repo_info,
            github::pulls::compare_branches,
            github::pulls::create_pull,
            github::pulls::update_pull,
            github::pulls::merge_pull,
            github::pulls::review_pull,
            github::pulls::comment_pull,
            github::pulls::comment_pull_line,
            github::pulls::set_pull_reviewers,
            github::pulls::update_pull_branch,
            github::pulls::set_pull_draft,
            github::pulls::delete_pull_branch,
            github::pulls::restore_pull_branch,
            github::pulls::branch_pull,
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
            git::commands::git_ignore_tracked,
            git::commands::git_ignore_add,
            git::commands::git_gitignore_read,
            git::commands::git_gitignore_write,
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
            git::commands::git_conflict_file,
            git::commands::git_resolve_conflict,
            git::commands::git_take_side,
            git::commands::git_open_file,
            git::commands::git_continue,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod team_tests {
    use super::*;

    #[test]
    fn invite_results_are_told_apart() {
        assert_eq!(invite_outcome(201, "{}", None).status, "invited");
        assert_eq!(invite_outcome(204, "", None).status, "already");
        // 404 は、その名前の人がいないのか、リポジトリを管理できないのかを確かめてから分ける
        assert_eq!(invite_outcome(404, r#"{"message":"Not Found"}"#, Some(false)).status, "no_user");
        assert_eq!(invite_outcome(404, r#"{"message":"Not Found"}"#, Some(true)).status, "forbidden");
        let limit = invite_outcome(403, r#"{"message":"You have exceeded the invitation rate limit"}"#, None);
        assert_eq!(limit.status, "forbidden");
        assert!(limit.message.unwrap().contains("上限"));
        let invalid = invite_outcome(422, r#"{"message":"Validation Failed","errors":[{"message":"Repository owner cannot be a collaborator"}]}"#, None);
        assert_eq!(invalid.status, "invalid");
        assert!(invalid.message.unwrap().contains("Repository owner cannot be a collaborator"));
        assert_eq!(invite_outcome(500, "oops", None).status, "failed");
        // 自分で作ったトークンに Administration の権限がないとき
        let pat = invite_outcome(403, r#"{"message":"Resource not accessible by personal access token"}"#, None);
        assert_eq!(pat.status, "forbidden");
        assert!(pat.message.unwrap().contains("Administration"));
    }
}
