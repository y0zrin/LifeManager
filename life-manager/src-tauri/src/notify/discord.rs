// Discord Webhook通知ヘルパー

use reqwest::Client;

/// Discord Webhook URLにメッセージをPOSTする
pub async fn send_discord(webhook_url: &str, text: &str) -> Result<String, String> {
    let client = Client::new();
    let payload = serde_json::json!({
        "content": text
    });

    let response = client
        .post(webhook_url)
        .header("Content-Type", "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Discord送信エラー: {}", e))?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.map_err(|e| e.to_string())?;
        return Err(format!("Discord HTTP {}: {}", status, body));
    }

    return Ok("Discord通知を送信しました".to_string());
}

/// プロジェクト固有のWebhook URLを読み込む
pub fn load_webhook_url_for_project(owner: &str, repo: &str) -> Option<String> {
    let key = format!("project-discord-{}/{}", owner, repo);
    if let Ok(entry) = crate::credential::CredentialEntry::new("life-manager", &key) {
        if let Ok(url) = entry.get_password() {
            if !url.is_empty() {
                return Some(url);
            }
        }
    }
    return None;
}
