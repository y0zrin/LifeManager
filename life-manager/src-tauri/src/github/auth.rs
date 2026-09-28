//! 「GitHub でログイン」（OAuth アプリのデバイスフロー。GitHub Desktop と同じやり方）。
//! 画面に出したコードを、利用者がブラウザの github.com/login/device で入れて許可すると、トークンがもらえる。
//! デバイスフローは client secret を使わないので、デスクトップアプリに入れてよい
use serde::{Deserialize, Serialize};

/// GitHub に登録した OAuth アプリ「Life Manager」の Client ID（秘密ではない）。空なら「GitHub でログイン」は使えない
pub const CLIENT_ID: &str = "Ov23liu0oRzKR4l5kDMZ";

/// もらう権限: repo（非公開も含めて、入っているリポジトリの Issue・ファイルを読み書き）、read:org（入っている組織を知る）
pub const SCOPES: &str = "repo read:org";

/// ログインに使えるか（Client ID が入っているか）
pub fn available() -> bool {
    !CLIENT_ID.is_empty()
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
    /// 許可された（トークンはアプリの中でしまい、画面には渡さない）
    Done,
    /// コードの期限が切れた
    Expired,
    /// 利用者が断った
    Denied,
    Failed { message: String },
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

/// ログインを始める（画面に出すコードをもらう）
pub async fn start() -> Result<DeviceCode, String> {
    if !available() {
        return Err("「GitHub でログイン」の準備（アプリの登録）がまだです。「トークンで入る」を使ってください".into());
    }
    let json = post_form("https://github.com/login/device/code", form(&[("client_id", CLIENT_ID), ("scope", SCOPES)])).await?;
    if let Some(error) = json["error"].as_str() {
        return Err(describe_error(error, json["error_description"].as_str()));
    }
    serde_json::from_value(json).map_err(|e| format!("GitHub の返事を読めませんでした: {}", e))
}

/// 許可されたかを確かめる。許可されたらトークンを返す
pub async fn poll(device_code: &str) -> Result<(Poll, Option<String>), String> {
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

/// GitHub の返事を、確かめた結果にする
fn read_poll(json: &serde_json::Value) -> (Poll, Option<String>) {
    if let Some(token) = json["access_token"].as_str() {
        return (Poll::Done, Some(token.to_string()));
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

fn describe_error(code: &str, description: Option<&str>) -> String {
    match code {
        "device_flow_disabled" => "GitHub のアプリの設定で「Enable Device Flow」がまだ有効になっていません".into(),
        "incorrect_client_credentials" => "GitHub のアプリの Client ID が違います".into(),
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
        let (done, token) = read_poll(&json!({ "access_token": "gho_abc", "token_type": "bearer", "scope": "repo,read:org" }));
        assert_eq!((done, token.as_deref()), (Poll::Done, Some("gho_abc")));
        match read_poll(&json!({ "error": "device_flow_disabled" })).0 {
            Poll::Failed { message } => assert!(message.contains("Enable Device Flow")),
            other => panic!("{:?}", other),
        }
    }
}
