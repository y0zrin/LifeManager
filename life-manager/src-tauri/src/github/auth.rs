//! 「GitHub でログイン」（GitHub App のデバイスフロー。GitHub CLI と同じやり方）。
//! 画面に出したコードを、利用者がブラウザの github.com/login/device で入れて許可すると、鍵（トークン）がもらえる。
//! GitHub App なので、アプリが触れるのは、持ち主が Life Manager を入れて選んだリポジトリだけ。
//! 鍵は 8 時間で切れ、いっしょにもらう「更新の鍵」（半年で切れる）で新しくする。
//! デバイスフローでもらった鍵は client secret なしで新しくできる（GitHub の決まり）ので、アプリに秘密を入れなくてよい
use serde::{Deserialize, Serialize};

/// GitHub に登録した GitHub App「Life Manager App」の Client ID（秘密ではない）。空なら「GitHub でログイン」は使えない
pub const CLIENT_ID: &str = "Iv23lilmumXASbk6CNV2";

/// GitHub App の URL の名前（https://github.com/apps/<これ>）。使うリポジトリを選ぶ画面を開くのに使う
pub const APP_SLUG: &str = "life-manager-app";

/// ログインに使えるか（Client ID が入っているか）
pub fn available() -> bool {
    !CLIENT_ID.is_empty()
}

/// 使うリポジトリを選ぶ・足す画面（Life Manager を入れる。もう入れてあるアカウントでは、選び直す画面に進める）
pub fn install_url() -> String {
    format!("https://github.com/apps/{}/installations/new", APP_SLUG)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceCode {
    pub device_code: String,
    /// 利用者がブラウザで入れるコード（WDJB-MJHT など）
    pub user_code: String,
    pub verification_uri: String,
    /// コードの有効期間（秒）
    pub expires_in: u64,
    /// 確かめに行く間隔（秒）
    pub interval: u64,
}

/// 確かめた結果
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Poll {
    /// まだ許可されていない
    Pending,
    /// 確かめる間隔を空けてほしい
    SlowDown { interval: u64 },
    /// 許可された（鍵はアプリの中でしまい、画面には渡さない）
    Done,
    /// コードの期限が切れた
    Expired,
    /// 利用者が断った
    Denied,
    Failed { message: String },
}

/// もらった鍵
#[derive(Debug, Clone, PartialEq)]
pub struct Tokens {
    pub access_token: String,
    /// 鍵が切れるまでの秒（切れない鍵なら None）
    pub expires_in: Option<u64>,
    /// 鍵を新しくするための鍵
    pub refresh_token: Option<String>,
    /// 更新の鍵が切れるまでの秒
    pub refresh_token_expires_in: Option<u64>,
}

/// 鍵を新しくできなかった理由
#[derive(Debug, Clone, PartialEq)]
pub enum RefreshError {
    /// 更新の鍵が切れた・取り消された（ログインし直してもらう）
    Rejected(String),
    /// 通信できなかった（あとでもう一度）
    Network(String),
}

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

fn form(pairs: &[(&str, &str)]) -> String {
    pairs.iter().map(|(k, v)| format!("{}={}", k, urlencoding::encode(v))).collect::<Vec<_>>().join("&")
}

async fn post_form(url: &str, body: String) -> Result<serde_json::Value, String> {
    let response = http()
        .post(url)
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .header(reqwest::header::USER_AGENT, "life-manager")
        .body(body)
        .send()
        .await
        .map_err(|e| format!("{}{}", super::client::NETWORK_ERROR, e))?;
    let status = response.status();
    let text = response.text().await.map_err(|e| format!("{}{}", super::client::NETWORK_ERROR, e))?;
    let json: serde_json::Value = serde_json::from_str(&text).map_err(|_| format!("HTTP {}: {}", status, text))?;
    Ok(json)
}

/// ログインを始める（画面に出すコードをもらう）。GitHub App では、できることは入れたときの権限で決まるので、scope は送らない
pub async fn start() -> Result<DeviceCode, String> {
    if !available() {
        return Err("「GitHub でログイン」の準備（アプリの登録）がまだです。「トークンで入る」を使ってください".into());
    }
    let json = post_form("https://github.com/login/device/code", form(&[("client_id", CLIENT_ID)])).await?;
    if let Some(error) = json["error"].as_str() {
        return Err(describe_error(error, json["error_description"].as_str()));
    }
    serde_json::from_value(json).map_err(|e| format!("GitHub の返事を読めませんでした: {}", e))
}

/// 許可されたかを確かめる。許可されたら鍵を返す
pub async fn poll(device_code: &str) -> Result<(Poll, Option<Tokens>), String> {
    let json = post_form(
        "https://github.com/login/oauth/access_token",
        form(&[
            ("client_id", CLIENT_ID),
            ("device_code", device_code),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ]),
    )
    .await?;
    Ok(read_poll(&json))
}

/// 更新の鍵で、新しい鍵をもらう（更新の鍵も新しくなる）
pub async fn refresh(refresh_token: &str) -> Result<Tokens, RefreshError> {
    let json = post_form(
        "https://github.com/login/oauth/access_token",
        form(&[("client_id", CLIENT_ID), ("grant_type", "refresh_token"), ("refresh_token", refresh_token)]),
    )
    .await
    .map_err(RefreshError::Network)?;
    read_refresh(&json)
}

/// GitHub の返事から、鍵を取り出す
fn read_tokens(json: &serde_json::Value) -> Option<Tokens> {
    let access_token = json["access_token"].as_str().filter(|t| !t.is_empty())?.to_string();
    Some(Tokens {
        access_token,
        expires_in: json["expires_in"].as_u64(),
        refresh_token: json["refresh_token"].as_str().filter(|t| !t.is_empty()).map(String::from),
        refresh_token_expires_in: json["refresh_token_expires_in"].as_u64(),
    })
}

/// GitHub の返事を、確かめた結果にする
fn read_poll(json: &serde_json::Value) -> (Poll, Option<Tokens>) {
    if let Some(tokens) = read_tokens(json) {
        return (Poll::Done, Some(tokens));
    }
    match json["error"].as_str() {
        Some("authorization_pending") => (Poll::Pending, None),
        Some("slow_down") => (Poll::SlowDown { interval: json["interval"].as_u64().unwrap_or(10) }, None),
        Some("expired_token") => (Poll::Expired, None),
        Some("access_denied") => (Poll::Denied, None),
        Some(other) => (Poll::Failed { message: describe_error(other, json["error_description"].as_str()) }, None),
        None => (Poll::Failed { message: "GitHub の返事を読めませんでした".into() }, None),
    }
}

/// 新しくしたときの GitHub の返事を読む
fn read_refresh(json: &serde_json::Value) -> Result<Tokens, RefreshError> {
    if let Some(tokens) = read_tokens(json) {
        return Ok(tokens);
    }
    let code = json["error"].as_str().unwrap_or("unknown");
    Err(RefreshError::Rejected(describe_error(code, json["error_description"].as_str())))
}

fn describe_error(code: &str, description: Option<&str>) -> String {
    match code {
        "device_flow_disabled" => "GitHub のアプリの設定で「Enable Device Flow」がまだ有効になっていません".into(),
        "incorrect_client_credentials" => "GitHub のアプリの Client ID が違います".into(),
        "bad_refresh_token" => "ログインの期限が切れたか、GitHub で取り消されました。もう一度ログインしてください".into(),
        _ => format!("GitHub でログインできませんでした（{}{}）", code, description.map(|d| format!(": {}", d)).unwrap_or_default()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_what_github_answers_while_waiting() {
        assert_eq!(read_poll(&json!({ "error": "authorization_pending" })).0, Poll::Pending);
        assert_eq!(read_poll(&json!({ "error": "slow_down", "interval": 10 })).0, Poll::SlowDown { interval: 10 });
        assert_eq!(read_poll(&json!({ "error": "expired_token" })).0, Poll::Expired);
        assert_eq!(read_poll(&json!({ "error": "access_denied" })).0, Poll::Denied);
        match read_poll(&json!({ "error": "device_flow_disabled" })).0 {
            Poll::Failed { message } => assert!(message.contains("Enable Device Flow")),
            other => panic!("{:?}", other),
        }
    }

    #[test]
    fn reads_expiring_tokens_of_a_github_app() {
        let (done, tokens) = read_poll(&json!({
            "access_token": "ghu_abc", "expires_in": 28800, "refresh_token": "ghr_def",
            "refresh_token_expires_in": 15897600, "token_type": "bearer", "scope": ""
        }));
        assert_eq!(done, Poll::Done);
        assert_eq!(
            tokens,
            Some(Tokens { access_token: "ghu_abc".into(), expires_in: Some(28800), refresh_token: Some("ghr_def".into()), refresh_token_expires_in: Some(15897600) })
        );
        // 期限のない鍵（OAuth アプリや、期限を切った GitHub App）
        let (_, tokens) = read_poll(&json!({ "access_token": "gho_abc", "token_type": "bearer", "scope": "repo" }));
        assert_eq!(tokens.map(|t| (t.expires_in, t.refresh_token)), Some((None, None)));
    }

    #[test]
    fn reads_the_answer_to_a_refresh() {
        let ok = read_refresh(&json!({ "access_token": "ghu_new", "expires_in": 28800, "refresh_token": "ghr_new", "refresh_token_expires_in": 15897600 }));
        assert_eq!(ok.map(|t| t.refresh_token), Ok(Some("ghr_new".into())));
        match read_refresh(&json!({ "error": "bad_refresh_token", "error_description": "The refresh token passed is incorrect or expired." })) {
            Err(RefreshError::Rejected(message)) => assert!(message.contains("もう一度ログイン")),
            other => panic!("{:?}", other),
        }
    }
}
