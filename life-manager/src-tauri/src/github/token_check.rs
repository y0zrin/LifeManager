//! トークンを確かめる（だれのトークンか・種類・期限・リポジトリが見えるか・Issue を読めるか）。
//! 足りないときは、何をすれば直るかを、トークンの種類に合わせて返す
use super::client::GitHubClient;
use crate::tokens;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepoRef {
    pub owner: String,
    pub repo: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RepoCheck {
    pub owner: String,
    pub repo: String,
    /// 見えて、Issue を読める
    pub ok: bool,
    /// 書き込める（リポジトリでの役割）
    pub can_push: bool,
    pub private: bool,
    /// 足りないもの（not_found / not_installed / no_issues / org_restricted / sso / error）
    pub problem: Option<String>,
    /// 画面に出す、直し方の文
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TokenReport {
    pub login: String,
    /// GitHub のアカウントの番号（Life Manager App を入れる画面を、このアカウントを選んだ状態で開くのに使う）
    pub id: u64,
    pub name: Option<String>,
    pub avatar_url: String,
    /// oauth（GitHub でログイン）/ fine-grained / classic / app / unknown
    pub kind: String,
    /// 期限（"2026-12-27 00:00:00 +0900" の形。期限のないトークンは None）。
    /// 「GitHub でログイン」の鍵は 8 時間ごとに新しくなるので、この PC で使う期限を入れる
    pub expires_at: Option<String>,
    /// OAuth・Classic のトークンの権限（repo など）
    pub scopes: Option<Vec<String>>,
    pub repos: Vec<RepoCheck>,
}

/// トークンが使えないとき（401）の文
pub const INVALID: &str = "このトークンは使えません。期限が切れたか、取り消されたか、コピーが途中で切れています";

pub async fn check(token: &str, repos: &[RepoRef]) -> Result<TokenReport, String> {
    let client = GitHubClient::new(token.to_string());
    let (status, headers, body) = client.get_raw("/user").await?;
    if status == 401 {
        return Err(INVALID.into());
    }
    if status >= 400 {
        return Err(format!("HTTP {}: {}", status, body));
    }
    let user: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let header = |name: &str| headers.get(name).and_then(|v| v.to_str().ok()).map(|s| s.to_string());
    let kind = tokens::kind_of(token).to_string();
    let scopes = header("x-oauth-scopes").map(|s| s.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect());
    // ログインの鍵なら、Life Manager App を入れたリポジトリか（入れていない公開リポジトリは、見えても書けない）
    let installed: Option<std::collections::HashSet<String>> = if kind == "app" && !repos.is_empty() {
        client
            .list_installed_repos()
            .await
            .ok()
            .map(|list| list.iter().filter_map(|r| r["full_name"].as_str().map(|s| s.to_lowercase())).collect())
    } else {
        None
    };
    let mut checks = Vec::new();
    for r in repos {
        checks.push(check_repo(&client, &kind, r, installed.as_ref()).await);
    }
    let expires_at = if kind == "app" {
        tokens::login_valid_until().and_then(format_time)
    } else {
        header("github-authentication-token-expiration")
    };
    Ok(TokenReport {
        login: user["login"].as_str().unwrap_or("").to_string(),
        id: user["id"].as_u64().unwrap_or(0),
        name: user["name"].as_str().map(String::from),
        avatar_url: user["avatar_url"].as_str().unwrap_or("").to_string(),
        kind,
        expires_at,
        scopes,
        repos: checks,
    })
}

/// UNIX 秒を、GitHub の期限の見出しと同じ形（"2026-12-27 00:00:00 +0900"）にする
fn format_time(secs: i64) -> Option<String> {
    use chrono::TimeZone;
    chrono::Local.timestamp_opt(secs, 0).single().map(|t| t.format("%Y-%m-%d %H:%M:%S %z").to_string())
}

async fn check_repo(client: &GitHubClient, kind: &str, r: &RepoRef, installed: Option<&std::collections::HashSet<String>>) -> RepoCheck {
    let full = format!("{}/{}", r.owner, r.repo);
    let mut out = RepoCheck { owner: r.owner.clone(), repo: r.repo.clone(), ok: false, can_push: false, private: false, problem: None, message: None };
    let fail = |mut out: RepoCheck, problem: &str, message: String| {
        out.problem = Some(problem.into());
        out.message = Some(message);
        out
    };
    let (status, _, body) = match client.get_raw(&format!("/repos/{}", full)).await {
        Ok(x) => x,
        Err(e) => return fail(out, "error", e),
    };
    if status == 403 && body.contains("OAuth App access restrictions") {
        return fail(out, "org_restricted", format!("組織 {} で、まだ Life Manager が許可されていません。組織の管理者（チームリーダーなど）に一度だけ許可してもらってください", r.owner));
    }
    if status == 403 && (body.contains("SAML") || body.contains("SSO")) {
        return fail(out, "sso", format!("組織 {} のシングルサインオン（SSO）で、このトークンを許可する必要があります", r.owner));
    }
    if status == 404 && kind == "app" {
        return fail(
            out,
            "not_installed",
            format!(
                "{} には、まだ Life Manager が入っていません。自分のリポジトリなら「使用するリポジトリを選ぶ」（入れてあれば「リポジトリを追加する」）で選びます。チームのリポジトリなら、持ち主（リーダー）に Life Manager を入れてもらってください。名前の打ち間違いや、まだ招待を受けていないときも、こう見えます",
                full
            ),
        );
    }
    if status == 404 {
        let message = if kind == "fine-grained" {
            format!("このトークンの対象に {} が入っていません。GitHub のトークンの画面で「Repository access」に足してください", full)
        } else {
            format!("{} が見つかりません。名前の打ち間違い、まだ招待されていない、組織の許可がまだ、のどれかです", full)
        };
        return fail(out, "not_found", message);
    }
    if status >= 400 {
        return fail(out, "error", format!("HTTP {}: {}", status, body));
    }
    if installed.is_some_and(|set| !set.contains(&full.to_lowercase())) {
        return fail(
            out,
            "not_installed",
            format!(
                "{} には、まだ Life Manager が入っていません。見ることはできても、書き込めません。自分のリポジトリなら「使用するリポジトリを選ぶ」（入れてあれば「リポジトリを追加する」）で選びます。チームのリポジトリなら、持ち主（リーダー）に Life Manager を入れてもらってください",
                full
            ),
        );
    }
    let repo: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
    out.private = repo["private"].as_bool().unwrap_or(false);
    out.can_push = repo["permissions"]["push"].as_bool().unwrap_or(false);
    // Issue を読めるか（Fine-grained で Issues の権限がないと 403）
    match client.get_raw(&format!("/repos/{}/issues?per_page=1", full)).await {
        Ok((200, _, _)) => {}
        Ok((403, _, _)) => {
            return fail(out, "no_issues", "Issue を読む権限がありません。トークンの権限に「Issues（Read and write）」を足してください".into());
        }
        Ok((s, _, b)) => return fail(out, "error", format!("HTTP {}: {}", s, b)),
        Err(e) => return fail(out, "error", e),
    }
    out.ok = true;
    if !out.can_push {
        out.message = Some(format!("{} は見るだけです（書き込みの役割がありません）。リポジトリの持ち主に、書き込みできるように招待してもらってください", full));
    }
    out
}
