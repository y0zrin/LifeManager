// Discord通知ヘルパー（Webhook専用、メッセージキュー付き）

use reqwest::Client;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};

/// 送信キューのエントリ
struct QueueEntry {
    url: String,
    payload: serde_json::Value,
}

/// グローバル送信キュー
static SEND_QUEUE: OnceLock<Mutex<Vec<QueueEntry>>> = OnceLock::new();
/// フラッシュタスクが実行中かどうか
static FLUSHING: AtomicBool = AtomicBool::new(false);

fn queue() -> &'static Mutex<Vec<QueueEntry>> {
    SEND_QUEUE.get_or_init(|| Mutex::new(Vec::new()))
}

/// キューにメッセージを追加し、キュー処理を起動する（既に実行中なら起動しない）
fn enqueue_and_flush(url: String, payload: serde_json::Value) {
    {
        let mut q = queue().lock().unwrap();
        q.push(QueueEntry { url, payload });
    }
    // フラッシュタスクが未実行なら起動
    if FLUSHING.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_ok() {
        tokio::spawn(async {
            flush_queue().await;
            FLUSHING.store(false, Ordering::SeqCst);
        });
    }
}

/// キュー内のメッセージを順次送信（レートリミット時は待機してリトライ、全件送信保証）
async fn flush_queue() {
    let client = Client::new();

    loop {
        // キューから1件取り出す
        let entry = {
            let mut q = queue().lock().unwrap();
            if q.is_empty() {
                return;
            }
            q.remove(0)
        };

        // 無限リトライ（成功するまで）
        let mut attempt: u32 = 0;
        loop {
            attempt += 1;
            let req = client
                .post(&entry.url)
                .header("Content-Type", "application/json")
                .json(&entry.payload);

            match req.send().await {
                Ok(response) => {
                    let status = response.status();
                    if status.as_u16() == 429 {
                        // レートリミット: Retry-Afterの秒数だけ待機してリトライ
                        let retry_after = response
                            .headers()
                            .get("Retry-After")
                            .and_then(|v| v.to_str().ok())
                            .and_then(|s| s.parse::<f64>().ok())
                            .unwrap_or(5.0);
                        eprintln!(
                            "Discordレートリミット: {:.1}秒待機 (試行{}回目)",
                            retry_after, attempt
                        );
                        tokio::time::sleep(std::time::Duration::from_secs_f64(retry_after + 0.5)).await;
                        continue;
                    }
                    if !status.is_success() {
                        let body = response.text().await.unwrap_or_default();
                        eprintln!("Discord送信エラー HTTP {}: {}", status, body);
                    }
                    break; // 成功 or 非レートリミットエラー → 次のメッセージへ
                }
                Err(e) => {
                    // ネットワークエラー: 少し待ってリトライ（最大10回）
                    eprintln!("Discord通信エラー (試行{}回目): {}", attempt, e);
                    if attempt >= 10 {
                        eprintln!("Discord通信エラー: リトライ上限に達しました。メッセージを破棄します。");
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                    continue;
                }
            }
        }

        // 連続送信間に間隔を空けてレートリミットを予防（5件/5秒の制限に対し余裕を持たせる）
        tokio::time::sleep(std::time::Duration::from_millis(2500)).await;
    }
}

/// Discord Webhook URLにメッセージをPOSTする
pub async fn send_discord(webhook_url: &str, text: &str) -> Result<String, String> {
    let content = format!("{}\n@everyone", text);
    let payload = serde_json::json!({
        "content": content
    });
    enqueue_and_flush(webhook_url.to_string(), payload);
    return Ok("Discord通知をキューに追加しました".to_string());
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

/// プロジェクトに設定されたDiscord Webhook通知を送信する
pub async fn send_discord_for_project(owner: &str, repo: &str, text: &str) -> Result<(), String> {
    if let Some(webhook_url) = load_webhook_url_for_project(owner, repo) {
        return send_discord(&webhook_url, text).await.map(|_| ());
    }
    return Ok(());
}
