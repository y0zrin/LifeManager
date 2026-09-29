//! GitHub のトークン（いつものトークンと、プロジェクト専用のトークン）をしまう・取り出す。
//! プロジェクトで使うトークンは「専用 → いつもの」の順に探す（画面・スケジューラで同じ決まりを使う）。
//! 「GitHub でログイン」の鍵は 8 時間で切れるので、期限と更新の鍵も別にしまい、期限が近づいたら新しくする
use crate::credential::CredentialEntry as Entry;
use crate::github::auth;
use serde::{Deserialize, Serialize};

const SERVICE: &str = "life-manager";
const DEFAULT_KEY: &str = "github-token";
/// 「GitHub でログイン」でもらった鍵の期限と、更新の鍵（鍵そのものは DEFAULT_KEY）
const LOGIN_KEY: &str = "github-login";
/// この PC で使う期限が来て、鍵を消した（次の最初の画面で知らせる）
const EXPIRED_NOTICE_KEY: &str = "login-expired";

fn project_key(owner: &str, repo: &str) -> String {
    format!("project-token-{}/{}", owner, repo)
}

fn read(key: &str) -> Option<String> {
    Entry::new(SERVICE, key).ok()?.get_password().ok().filter(|t| !t.is_empty())
}

fn write(key: &str, value: &str) -> Result<(), String> {
    Entry::new(SERVICE, key)?.set_password(value)
}

fn delete(key: &str) {
    if let Ok(entry) = Entry::new(SERVICE, key) {
        let _ = entry.delete_credential();
    }
}

/// いつものトークン
pub fn default_token() -> Option<String> {
    read(DEFAULT_KEY)
}

/// プロジェクト専用のトークン
pub fn project_token(owner: &str, repo: &str) -> Option<String> {
    read(&project_key(owner, repo))
}

/// プロジェクトで使うトークン（専用 → いつもの）
pub fn token_for(owner: &str, repo: &str) -> Option<String> {
    if !owner.is_empty() && !repo.is_empty() {
        if let Some(t) = project_token(owner, repo) {
            return Some(t);
        }
    }
    default_token()
}

/// いつものトークンを、貼ったトークンにする（ログインの期限の記録は消す）
pub fn set_default(token: &str) -> Result<(), String> {
    write(DEFAULT_KEY, token)?;
    delete(LOGIN_KEY);
    Ok(())
}

/// いつものトークン（ログインなら、期限と更新の鍵も）を消す
pub fn clear_default() {
    delete(DEFAULT_KEY);
    delete(LOGIN_KEY);
}

pub fn set_project(owner: &str, repo: &str, token: &str) -> Result<(), String> {
    write(&project_key(owner, repo), token)
}

pub fn clear_project(owner: &str, repo: &str) {
    delete(&project_key(owner, repo));
}

/// 今開いているプロジェクト（まだ決めていなければ None）
pub fn active_project() -> Option<(String, String)> {
    let owner = read("github-owner")?;
    let repo = read("github-repo")?;
    Some((owner, repo))
}

/// 今開いているプロジェクトで使うトークン
pub fn active_token() -> Option<String> {
    match active_project() {
        Some((owner, repo)) => token_for(&owner, &repo),
        None => default_token(),
    }
}

// --- 「GitHub でログイン」の鍵の期限 ---

/// ログインでもらった鍵の期限と、更新の鍵
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LoginRecord {
    /// 鍵が切れる時（UNIX 秒）。切れない鍵なら None
    pub expires_at: Option<i64>,
    /// 鍵を新しくするための鍵
    pub refresh_token: Option<String>,
    /// 更新の鍵が切れる時（UNIX 秒）
    pub refresh_expires_at: Option<i64>,
    /// この PC で使う期限（UNIX 秒）。過ぎたら鍵を消して、ログインし直してもらう
    pub valid_until: Option<i64>,
}

/// 今の鍵をどうするか
#[derive(Debug, Clone, PartialEq)]
pub enum Freshness {
    /// そのまま使える
    Use,
    /// 期限が近いので、新しくする
    Refresh,
    /// この PC の期限が過ぎたか、新しくできない（ログインし直し）
    Expired,
}

/// 鍵の期限の、これだけ前には新しくする（秒）
const REFRESH_MARGIN: i64 = 600;

pub fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

/// 期限を見て、今の鍵をどうするかを決める
pub fn freshness(record: &LoginRecord, now: i64) -> Freshness {
    if record.valid_until.is_some_and(|v| now >= v) {
        return Freshness::Expired;
    }
    match record.expires_at {
        Some(at) if now + REFRESH_MARGIN >= at => {
            let refreshable = record.refresh_token.is_some() && record.refresh_expires_at.is_none_or(|r| now < r);
            if refreshable {
                Freshness::Refresh
            } else if now < at {
                // 新しくはできないが、まだ切れていない
                Freshness::Use
            } else {
                Freshness::Expired
            }
        }
        _ => Freshness::Use,
    }
}

/// ログインの記録（ログインしていない・トークンを貼ったときは None）
pub fn login_record() -> Option<LoginRecord> {
    serde_json::from_str(&read(LOGIN_KEY)?).ok()
}

/// この PC で使う期限（UNIX 秒）
pub fn login_valid_until() -> Option<i64> {
    login_record()?.valid_until
}

fn record_of(tokens: &auth::Tokens, now: i64, valid_until: Option<i64>) -> LoginRecord {
    LoginRecord {
        expires_at: tokens.expires_in.map(|s| now + s as i64),
        refresh_token: tokens.refresh_token.clone(),
        refresh_expires_at: tokens.refresh_token_expires_in.map(|s| now + s as i64),
        valid_until,
    }
}

fn save_record(tokens: &auth::Tokens, record: &LoginRecord) -> Result<(), String> {
    write(DEFAULT_KEY, &tokens.access_token)?;
    write(LOGIN_KEY, &serde_json::to_string(record).map_err(|e| e.to_string())?)
}

/// ログインでもらった鍵を、いつものトークンとしてしまう。days は、この PC で使う日数（None なら決めない）
pub fn save_login(tokens: &auth::Tokens, days: Option<u32>) -> Result<(), String> {
    let now = now();
    delete(EXPIRED_NOTICE_KEY);
    save_record(tokens, &record_of(tokens, now, days.map(|d| now + d as i64 * 86400)))
}

/// 期限が来て鍵を消したことを、1 回だけ知らせる
pub fn take_expired_notice() -> bool {
    let had = read(EXPIRED_NOTICE_KEY).is_some();
    delete(EXPIRED_NOTICE_KEY);
    had
}

fn expire_login() {
    clear_default();
    let _ = write(EXPIRED_NOTICE_KEY, "1");
}

/// 新しくするのは 1 つずつ（画面とスケジューラが同時に新しくして、更新の鍵を無駄にしないように）
static REFRESHING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// いつものトークン。ログインの鍵なら、期限が近ければ新しくしてから返す（この PC の期限が過ぎていたら消して None）
pub async fn fresh_default() -> Option<String> {
    let Some(record) = login_record() else { return default_token() };
    if freshness(&record, now()) == Freshness::Use {
        return default_token();
    }
    let _guard = REFRESHING.lock().await;
    // 待っているあいだに、ほかで新しくした・消したかもしれない
    let record = login_record()?;
    match freshness(&record, now()) {
        Freshness::Use => default_token(),
        Freshness::Expired => {
            expire_login();
            None
        }
        Freshness::Refresh => {
            let refresh_token = record.refresh_token.clone()?;
            match auth::refresh(&refresh_token).await {
                Ok(tokens) => {
                    let _ = save_record(&tokens, &record_of(&tokens, now(), record.valid_until));
                    Some(tokens.access_token)
                }
                Err(auth::RefreshError::Rejected(_)) => {
                    expire_login();
                    None
                }
                // 通信できないときは今の鍵のまま（まだ切れていなければ使える。オフラインなら送信待ちになる）
                Err(auth::RefreshError::Network(_)) => default_token(),
            }
        }
    }
}

/// プロジェクトで使うトークン（専用 → いつもの。いつものがログインなら、期限が近ければ新しくする）
pub async fn fresh_token_for(owner: &str, repo: &str) -> Option<String> {
    if !owner.is_empty() && !repo.is_empty() {
        if let Some(t) = project_token(owner, repo) {
            return Some(t);
        }
    }
    fresh_default().await
}

/// 貼り付けたトークンを整える（前後の空白・改行を外す）。GitHub のトークンに使わない文字があれば、理由を返す
pub fn clean(token: &str) -> Result<String, String> {
    let t: String = token.trim().chars().filter(|c| !c.is_whitespace()).collect();
    if t.is_empty() {
        return Err("トークンを貼ってください".into());
    }
    if let Some(c) = t.chars().find(|c| !(c.is_ascii_alphanumeric() || *c == '_')) {
        return Err(format!(
            "トークンに使えない文字（{}）が入っています。GitHub の画面でコピーし直して、そのまま貼ってください",
            c
        ));
    }
    Ok(t)
}

/// トークンの種類（先頭の文字で分かる）
pub fn kind_of(token: &str) -> &'static str {
    if token.starts_with("gho_") {
        "oauth"
    } else if token.starts_with("github_pat_") {
        "fine-grained"
    } else if token.starts_with("ghp_") {
        "classic"
    } else if token.starts_with("ghu_") {
        "app"
    } else {
        "unknown"
    }
}

// --- アカウントの切り替え ---
// 今のアカウントは、今までどおりの場所（いつものトークン・ログインの記録・使うリポジトリの一覧・開いているリポジトリ）に置く。
// ほかのアカウントは、アカウントごとに「鍵」と「使うリポジトリ」に分けてしまっておき、切り替えるときに入れ替える
// （Windows の資格情報は 1 つにしまえる大きさに限りがあるので、まとめて 1 つにはしない）。
// 鍵は、今のアカウントの場所かしまってある場所の、どちらか 1 か所にだけ置く（更新の鍵は使うたびに変わるので、写しを残さない）

/// しまってあるアカウント（切り替えの一覧に出す。鍵そのものは入れない）
const ACCOUNTS_KEY: &str = "accounts";
const PROJECTS_KEY: &str = "projects";
const OWNER_KEY: &str = "github-owner";
const REPO_KEY: &str = "github-repo";

/// GitHub の名前は大文字・小文字を区別しないので、しまう場所の名前は小文字にそろえる
fn account_token_key(login: &str) -> String {
    format!("account-token-{}", login.to_lowercase())
}

fn account_projects_key(login: &str) -> String {
    format!("account-projects-{}", login.to_lowercase())
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SavedAccount {
    pub login: String,
    pub avatar_url: Option<String>,
}

/// しまってある鍵（いつものトークンと、ログインの記録そのまま）
#[derive(Serialize, Deserialize)]
struct SavedKeys {
    token: String,
    login: Option<String>,
}

/// しまってある、使うリポジトリの一覧と、開いていたリポジトリ（ログアウトしても残す。もう一度ログインすれば続きから）
#[derive(Serialize, Deserialize, Default)]
struct SavedProjects {
    projects: Option<serde_json::Value>,
    owner: Option<String>,
    repo: Option<String>,
}

/// 切り替えの一覧（しまってあるアカウント）
pub fn saved_accounts() -> Vec<SavedAccount> {
    read(ACCOUNTS_KEY).and_then(|json| serde_json::from_str(&json).ok()).unwrap_or_default()
}

fn save_accounts(list: &[SavedAccount]) -> Result<(), String> {
    if list.is_empty() {
        delete(ACCOUNTS_KEY);
        return Ok(());
    }
    write(ACCOUNTS_KEY, &serde_json::to_string(list).map_err(|e| e.to_string())?)
}

fn drop_from_accounts(login: &str) -> Result<(), String> {
    let list: Vec<SavedAccount> = saved_accounts().into_iter().filter(|a| !a.login.eq_ignore_ascii_case(login)).collect();
    save_accounts(&list)
}

/// しまってあるアカウントの、使うリポジトリ（名前だけ。一覧の見出しに出す）
pub fn saved_projects_of(login: &str) -> Vec<(String, String)> {
    let saved: SavedProjects = read(&account_projects_key(login)).and_then(|json| serde_json::from_str(&json).ok()).unwrap_or_default();
    saved
        .projects
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|p| Some((p["owner"].as_str()?.to_string(), p["repo"].as_str()?.to_string())))
        .collect()
}

/// 今の場所の、使うリポジトリの一覧と開いているリポジトリを、login の分としてしまい、今の場所は空にする
fn put_away_projects_of(login: &str) -> Result<(), String> {
    let projects = read(PROJECTS_KEY).and_then(|json| serde_json::from_str::<serde_json::Value>(&json).ok());
    let saved = SavedProjects { projects, owner: read(OWNER_KEY), repo: read(REPO_KEY) };
    write(&account_projects_key(login), &serde_json::to_string(&saved).map_err(|e| e.to_string())?)?;
    delete(PROJECTS_KEY);
    delete(OWNER_KEY);
    delete(REPO_KEY);
    Ok(())
}

/// login の分としてしまってある一覧を、今の場所に戻す（なければ空にする）
fn bring_back_projects_of(login: &str) -> Result<(), String> {
    let key = account_projects_key(login);
    let saved: SavedProjects = read(&key).and_then(|json| serde_json::from_str(&json).ok()).unwrap_or_default();
    match saved.projects {
        Some(p) => write(PROJECTS_KEY, &p.to_string())?,
        None => delete(PROJECTS_KEY),
    }
    match saved.owner {
        Some(o) => write(OWNER_KEY, &o)?,
        None => delete(OWNER_KEY),
    }
    match saved.repo {
        Some(r) => write(REPO_KEY, &r)?,
        None => delete(REPO_KEY),
    }
    delete(&key);
    Ok(())
}

/// 今のアカウントをしまう（鍵・使うリポジトリの一覧・開いていたリポジトリ）。今の場所は空になる
pub fn stash_active(login: &str, avatar_url: Option<String>) -> Result<(), String> {
    let login = login.trim();
    if login.is_empty() {
        return Err("今のアカウントの名前が分かりません。少し待ってから、もう一度試してください".into());
    }
    if let Some(token) = default_token() {
        let keys = SavedKeys { token, login: read(LOGIN_KEY) };
        write(&account_token_key(login), &serde_json::to_string(&keys).map_err(|e| e.to_string())?)?;
        let mut list: Vec<SavedAccount> = saved_accounts().into_iter().filter(|a| !a.login.eq_ignore_ascii_case(login)).collect();
        list.insert(0, SavedAccount { login: login.to_string(), avatar_url });
        save_accounts(&list)?;
    }
    put_away_projects_of(login)?;
    delete(DEFAULT_KEY);
    delete(LOGIN_KEY);
    Ok(())
}

/// しまってあるアカウントか（鍵がある）
pub fn has_saved_keys(login: &str) -> bool {
    read(&account_token_key(login)).is_some()
}

/// しまってあるアカウントを、今のアカウントにする
pub fn restore(login: &str) -> Result<(), String> {
    let key = account_token_key(login);
    let keys: SavedKeys = read(&key)
        .and_then(|json| serde_json::from_str(&json).ok())
        .ok_or_else(|| format!("{} の鍵が、この PC にありません。もう一度ログインしてください", login))?;
    write(DEFAULT_KEY, &keys.token)?;
    match keys.login {
        Some(record) => write(LOGIN_KEY, &record)?,
        None => delete(LOGIN_KEY),
    }
    delete(&key);
    bring_back_projects_of(login)?;
    drop_from_accounts(login)
}

/// ログインしたばかりのアカウントが、前にこの PC で使っていたものなら、使うリポジトリの一覧を戻す（しまってあった古い鍵は捨てる）。
/// 戻したら true
pub fn adopt(login: &str) -> Result<bool, String> {
    delete(&account_token_key(login));
    drop_from_accounts(login)?;
    if read(&account_projects_key(login)).is_none() {
        return Ok(false);
    }
    // 今の場所に一覧があれば（前の版で使っていた PC）、そちらを使う（しまってある一覧は消さずに残す）
    let active_empty = read(PROJECTS_KEY).is_none_or(|json| serde_json::from_str::<Vec<serde_json::Value>>(&json).map(|v| v.is_empty()).unwrap_or(true));
    if !active_empty {
        return Ok(false);
    }
    bring_back_projects_of(login)?;
    Ok(read(OWNER_KEY).is_some() && read(REPO_KEY).is_some())
}

/// しまってあるアカウントを、この PC から外す（鍵を消す。使うリポジトリの一覧は残すので、もう一度ログインすれば続きから）
pub fn forget(login: &str) -> Result<(), String> {
    delete(&account_token_key(login));
    drop_from_accounts(login)
}

/// ログアウトのとき: 使うリポジトリの一覧を、そのアカウントの分としてしまう（次にログインした別の人に、前の人の一覧を出さない）
pub fn put_away_projects(login: &str) -> Result<(), String> {
    if login.trim().is_empty() {
        return Ok(());
    }
    put_away_projects_of(login.trim())
}

/// 前のセットアップは、いつものトークンを最初のプロジェクト専用にも入れていた。
/// そのままだと、いつものトークンを入れ替えても専用（古いほう）が使われ続けるので、同じものは専用から外す
pub fn drop_duplicate_project_tokens(projects: &[(String, String)]) {
    let Some(default) = default_token() else { return };
    for (owner, repo) in projects {
        if project_token(owner, repo).as_deref() == Some(default.as_str()) {
            clear_project(owner, repo);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleans_pasted_tokens() {
        assert_eq!(clean("  ghp_abc123\n").unwrap(), "ghp_abc123");
        assert_eq!(clean("github_pat_11AB CD").unwrap(), "github_pat_11ABCD");
        assert!(clean("").is_err());
        assert!(clean("ghp_ａｂｃ").unwrap_err().contains("使えない文字"));
        assert!(clean("ghp_abc-def").is_err());
    }

    #[test]
    fn knows_the_kind_of_token() {
        assert_eq!(kind_of("gho_x"), "oauth");
        assert_eq!(kind_of("github_pat_x"), "fine-grained");
        assert_eq!(kind_of("ghp_x"), "classic");
        assert_eq!(kind_of("ghu_x"), "app");
        assert_eq!(kind_of("xyz"), "unknown");
    }

    #[test]
    fn decides_when_to_refresh_the_login() {
        let t0 = 1_000_000;
        let tokens = auth::Tokens {
            access_token: "ghu_a".into(),
            expires_in: Some(28800),
            refresh_token: Some("ghr_b".into()),
            refresh_token_expires_in: Some(15_897_600),
        };
        let record = record_of(&tokens, t0, Some(t0 + 90 * 86400));
        // もらったばかり・8 時間の 10 分前まではそのまま
        assert_eq!(freshness(&record, t0), Freshness::Use);
        assert_eq!(freshness(&record, t0 + 28800 - 601), Freshness::Use);
        // 10 分前からは新しくする（切れたあとも、更新の鍵が生きていれば新しくできる）
        assert_eq!(freshness(&record, t0 + 28800 - 600), Freshness::Refresh);
        assert_eq!(freshness(&record, t0 + 86400), Freshness::Refresh);
        // この PC の期限（90 日）が過ぎたら、ログインし直し
        assert_eq!(freshness(&record, t0 + 90 * 86400), Freshness::Expired);
        // 更新の鍵も切れたら、ログインし直し
        let no_limit = LoginRecord { valid_until: None, ..record.clone() };
        assert_eq!(freshness(&no_limit, t0 + 15_897_600 + 1), Freshness::Expired);
        // 期限のない鍵は、この PC の期限だけを見る
        let forever = LoginRecord { expires_at: None, refresh_token: None, refresh_expires_at: None, valid_until: Some(t0 + 30 * 86400) };
        assert_eq!(freshness(&forever, t0 + 29 * 86400), Freshness::Use);
        assert_eq!(freshness(&forever, t0 + 30 * 86400), Freshness::Expired);
    }
}
