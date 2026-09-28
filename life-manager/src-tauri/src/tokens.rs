//! GitHub のトークン（いつものトークンと、プロジェクト専用のトークン）をしまう・取り出す。
//! プロジェクトで使うトークンは「専用 → いつもの」の順に探す（画面・スケジューラで同じ決まりを使う）
use crate::credential::CredentialEntry as Entry;

const SERVICE: &str = "life-manager";
const DEFAULT_KEY: &str = "github-token";

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

pub fn set_default(token: &str) -> Result<(), String> {
    write(DEFAULT_KEY, token)
}

pub fn clear_default() {
    delete(DEFAULT_KEY);
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
        assert_eq!(kind_of("xyz"), "unknown");
    }
}
