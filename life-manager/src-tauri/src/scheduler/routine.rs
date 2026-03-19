use chrono::{Datelike, Local, Timelike, Weekday};
use crate::credential::CredentialEntry as Entry;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri_plugin_notification::NotificationExt;
use tokio::sync::Notify;
use tokio::time;

use crate::github::client::GitHubClient;
use crate::journal::generator;
use crate::notify::discord;

/// 外部から設定リフレッシュを要求するためのハンドル
static REFRESH_NOTIFY: std::sync::OnceLock<Arc<Notify>> = std::sync::OnceLock::new();

/// スケジューラに即時リフレッシュを要求する
pub fn request_refresh() {
    if let Some(notify) = REFRESH_NOTIFY.get() {
        notify.notify_one();
    }
}

/// アクティブプロジェクトのowner/repoをキーチェーンから読み込む
fn load_active_project() -> (String, String) {
    let owner = Entry::new("life-manager", "github-owner")
        .ok()
        .and_then(|e| e.get_password().ok())
        .unwrap_or_else(|| "y0zrin".to_string());
    let repo = Entry::new("life-manager", "github-repo")
        .ok()
        .and_then(|e| e.get_password().ok())
        .unwrap_or_else(|| "life".to_string());
    (owner, repo)
}

// --- データ構造 ---

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct RoutineConfig {
    pub routines: Vec<Routine>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct NotificationConfig {
    #[serde(default)]
    pub notifications: Vec<NotificationSchedule>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event_notifications: Option<EventNotificationConfig>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct EventNotificationConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub os_for_own_actions: bool,
    #[serde(default)]
    pub events: HashMap<String, EventEntry>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct EventEntry {
    pub enabled: bool,
    pub channels: Vec<String>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct NotificationSchedule {
    pub name: String,
    pub schedule: Schedule,
    #[serde(rename = "type")]
    pub notify_type: String, // "today_tasks" | "overdue" | "summary" | "custom"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub channels: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct Routine {
    pub name: String,
    pub schedule: Schedule,
    pub issue: IssueTemplate,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_close: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct Schedule {
    pub frequency: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub days: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub day: Option<serde_json::Value>,
    pub time: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_date: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct IssueTemplate {
    pub title: String,
    pub labels: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct ReminderConfig {
    pub reminders: Vec<Reminder>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct Reminder {
    pub issue_number: u32,
    pub title: String,
    pub datetime: String, // "YYYY-MM-DDTHH:mm"
    pub channels: Vec<String>,
}

// --- スケジュール評価 ---

fn weekday_str(wd: Weekday) -> &'static str {
    match wd {
        Weekday::Mon => "mon",
        Weekday::Tue => "tue",
        Weekday::Wed => "wed",
        Weekday::Thu => "thu",
        Weekday::Fri => "fri",
        Weekday::Sat => "sat",
        Weekday::Sun => "sun",
    }
}

fn should_run(routine: &Routine, hour: u32, minute: u32, weekday: Weekday, month_day: u32) -> bool {
    // 期間チェック
    let today = Local::now().format("%Y-%m-%d").to_string();
    if let Some(start) = &routine.schedule.start_date {
        if today < *start {
            return false;
        }
    }
    if let Some(end) = &routine.schedule.end_date {
        if today > *end {
            return false;
        }
    }

    // 時刻チェック
    let time_parts: Vec<&str> = routine.schedule.time.split(':').collect();
    let target_hour: u32 = time_parts
        .first()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let target_min: u32 = time_parts
        .get(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);

    if hour != target_hour || minute != target_min {
        return false;
    }

    match routine.schedule.frequency.as_str() {
        "daily" => {
            if let Some(days) = &routine.schedule.days {
                if days.is_empty() {
                    return true;
                }
                let wd = weekday_str(weekday);
                return days.iter().any(|d| d == wd);
            }
            return true;
        }
        "weekly" => {
            if let Some(day_val) = &routine.schedule.day {
                let current = weekday_str(weekday);
                if let Some(target) = day_val.as_str() {
                    return current == target;
                }
            }
            return false;
        }
        "monthly" => {
            if let Some(day_val) = &routine.schedule.day {
                if let Some(target) = day_val.as_u64() {
                    return month_day == target as u32;
                }
            }
            return false;
        }
        _ => return false,
    }
}

// --- テンプレート展開 ---

fn expand_template(template: &str, now: &chrono::DateTime<Local>) -> String {
    let date_str = now.format("%Y-%m-%d").to_string();
    let week_str = format!("{}年第{}週", now.year(), now.iso_week().week());
    let month_str = now.format("%Y-%m").to_string();

    return template
        .replace("{{date}}", &date_str)
        .replace("{{week}}", &week_str)
        .replace("{{month}}", &month_str);
}

// --- OS通知送信ヘルパー ---

fn send_os_notification(app: &tauri::AppHandle, title: &str, body: &str) {
    if let Err(e) = app
        .notification()
        .builder()
        .title(title)
        .body(body)
        .show()
    {
        eprintln!("OS通知送信エラー: {}", e);
    }
}

// --- 外部公開用ヘルパー ---

pub fn send_os_notification_public(app: &tauri::AppHandle, title: &str, body: &str) {
    send_os_notification(app, title, body);
}

pub async fn send_discord_if_configured_public(owner: &str, repo: &str, text: &str) {
    send_discord_if_configured(owner, repo, text).await;
}

// --- Discord通知送信ヘルパー（Bot優先、Webhookフォールバック） ---

async fn send_discord_if_configured(owner: &str, repo: &str, text: &str) {
    if let Err(e) = discord::send_discord_for_project(owner, repo, text).await {
        eprintln!("Discord通知エラー: {}", e);
    }
}

// --- バックグラウンドスケジューラ ---

pub async fn start_scheduler(app: tauri::AppHandle) {
    // リフレッシュ通知チャネルを登録
    let notify = Arc::new(Notify::new());
    let _ = REFRESH_NOTIFY.set(notify.clone());

    // トークンが利用可能になるまで待機（プロジェクト固有トークン優先、グローバルにフォールバック）
    let client = loop {
        time::sleep(Duration::from_secs(3)).await;

        let (owner, repo) = load_active_project();

        // プロジェクト固有トークンを試行
        let project_key = format!("project-token-{}/{}", owner, repo);
        if let Ok(entry) = Entry::new("life-manager", &project_key) {
            if let Ok(token) = entry.get_password() {
                if !token.is_empty() {
                    break GitHubClient::new(token);
                }
            }
        }

        // グローバルトークンにフォールバック
        let entry = match Entry::new("life-manager", "github-token") {
            Ok(e) => e,
            Err(_) => continue,
        };

        match entry.get_password() {
            Ok(token) => break GitHubClient::new(token),
            Err(_) => continue,
        }
    };

    run_scheduler_loop(client, app, notify).await;
}

// 日次ジャーナル自動生成の時刻（23:59）
const JOURNAL_HOUR: u32 = 23;
const JOURNAL_MINUTE: u32 = 59;

async fn run_scheduler_loop(client: GitHubClient, app: tauri::AppHandle, refresh: Arc<Notify>) {
    let mut interval = time::interval(Duration::from_secs(60));
    let mut cached_config: Option<RoutineConfig> = None;
    let mut cached_notif_config: Option<NotificationConfig> = None;
    let mut cached_reminder_config: Option<ReminderConfig> = None;
    let mut last_config_fetch = Instant::now() - Duration::from_secs(600);
    let mut last_check_minute: Option<(u32, u32)> = None;
    let mut force_refresh = false;

    loop {
        // 60秒タイマー or 外部からの即時リフレッシュ要求を待つ
        tokio::select! {
            _ = interval.tick() => {}
            _ = refresh.notified() => {
                force_refresh = true;
            }
        }
        let now = Local::now();

        // 同じ分は再チェックしない（ただし強制リフレッシュ時は通過）
        let current_minute = (now.hour(), now.minute());
        if !force_refresh && last_check_minute == Some(current_minute) {
            continue;
        }
        last_check_minute = Some(current_minute);

        // アクティブプロジェクトを取得
        let (owner, repo) = load_active_project();

        // 設定リフレッシュ（毎分 or 強制リフレッシュ時）
        if force_refresh || last_config_fetch.elapsed() > Duration::from_secs(60) {
            force_refresh = false;
            match client
                .get_contents(&owner, &repo, "config/routines.yaml")
                .await
            {
                Ok((content, _sha)) => match serde_yaml::from_str::<RoutineConfig>(&content) {
                    Ok(config) => cached_config = Some(config),
                    Err(e) => eprintln!("routines.yaml パースエラー: {}", e),
                },
                Err(_) => {} // ファイル未作成
            }

            // リマインダー設定を取得
            match client
                .get_contents(&owner, &repo, "config/reminders.yaml")
                .await
            {
                Ok((content, _sha)) => {
                    match serde_yaml::from_str::<ReminderConfig>(&content) {
                        Ok(config) => cached_reminder_config = Some(config),
                        Err(e) => eprintln!("reminders.yaml パースエラー: {}", e),
                    }
                }
                Err(_) => {} // ファイル未作成
            }

            // 通知スケジュール設定を取得
            match client
                .get_contents(&owner, &repo, "config/notifications.yaml")
                .await
            {
                Ok((content, _sha)) => {
                    match serde_yaml::from_str::<NotificationConfig>(&content) {
                        Ok(config) => cached_notif_config = Some(config),
                        Err(e) => eprintln!("notifications.yaml パースエラー: {}", e),
                    }
                }
                Err(_) => {} // ファイル未作成
            }

            last_config_fetch = Instant::now();
        }

        // 通知スケジュール評価
        if let Some(notif_config) = &cached_notif_config {
            for notif in &notif_config.notifications {
                // Schedule構造体を再利用してshould_runで評価するためのダミーRoutineは使わず直接評価
                let time_parts: Vec<&str> = notif.schedule.time.split(':').collect();
                let target_hour: u32 = time_parts.first().and_then(|s| s.parse().ok()).unwrap_or(99);
                let target_min: u32 = time_parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(99);

                if now.hour() != target_hour || now.minute() != target_min {
                    continue;
                }

                // 曜日・日付チェック（Schedule評価を再利用）
                let dummy_routine = Routine {
                    name: notif.name.clone(),
                    schedule: notif.schedule.clone(),
                    issue: IssueTemplate {
                        title: String::new(),
                        labels: vec![],
                        body: None,
                    },
                    auto_close: None,
                };
                if !should_run(&dummy_routine, now.hour(), now.minute(), now.weekday(), now.day()) {
                    continue;
                }

                // 通知内容を生成
                let message = build_notification_message(&client, &owner, &repo, &notif.notify_type, notif.message.as_deref(), &now).await;
                if message.is_empty() {
                    continue;
                }

                // チャンネルに応じて送信
                if notif.channels.contains(&"os".to_string()) {
                    send_os_notification(&app, &notif.name, &message);
                }
                if notif.channels.contains(&"discord".to_string()) {
                    send_discord_if_configured(&owner, &repo, &format!("**{}**\n{}", notif.name, message)).await;
                }
            }
        }

        // リマインダー評価（時刻が来たら通知し、発火済みを削除）
        if let Some(ref mut reminder_config) = cached_reminder_config {
            let now_str = now.format("%Y-%m-%dT%H:%M").to_string();
            let mut fired = false;

            for reminder in &reminder_config.reminders {
                if reminder.datetime <= now_str {
                    // 通知を送信
                    let message = format!("#{} {}", reminder.issue_number, reminder.title);
                    if reminder.channels.contains(&"os".to_string()) {
                        send_os_notification(&app, "リマインダー", &message);
                    }
                    if reminder.channels.contains(&"discord".to_string()) {
                        send_discord_if_configured(&owner, &repo, &format!("🔔 **リマインダー**\n{}", message)).await;
                    }
                    fired = true;
                }
            }

            if fired {
                // 発火済みリマインダーを除去して保存
                let remaining: Vec<Reminder> = reminder_config
                    .reminders
                    .iter()
                    .filter(|r| r.datetime > now_str)
                    .cloned()
                    .collect();
                reminder_config.reminders = remaining.clone();

                let updated_config = ReminderConfig {
                    reminders: remaining,
                };
                if let Ok(yaml) = serde_yaml::to_string(&updated_config) {
                    let sha = client
                        .get_contents(&owner, &repo, "config/reminders.yaml")
                        .await
                        .ok()
                        .map(|(_, s)| s);
                    let _ = client
                        .put_contents(
                            &owner,
                            &repo,
                            "config/reminders.yaml",
                            &yaml,
                            "発火済みリマインダーを削除",
                            sha,
                        )
                        .await;
                }
            }
        }

        // ルーチン評価
        let config = match &cached_config {
            Some(c) => c,
            None => continue,
        };

        for routine in &config.routines {
            // スケジュール一致チェック
            if should_run(
                routine,
                now.hour(),
                now.minute(),
                now.weekday(),
                now.day(),
            ) {
                let title = expand_template(&routine.issue.title, &now);

                // 重複チェック（同タイトルのIssueが既にあればスキップ）
                if let Ok(existing) = client.list_issues(&owner, &repo, "open").await {
                    if let Ok(issues) =
                        serde_json::from_str::<Vec<serde_json::Value>>(&existing)
                    {
                        if issues
                            .iter()
                            .any(|i| i["title"].as_str() == Some(&title))
                        {
                            continue;
                        }
                    }
                }

                let body = routine
                    .issue
                    .body
                    .as_ref()
                    .map(|b| expand_template(b, &now))
                    .unwrap_or_default();

                match client
                    .create_issue(&owner, &repo, &title, &body, routine.issue.labels.clone(), None, None)
                    .await
                {
                    Ok(_) => {
                        // ルーチンIssue作成成功 → 常にOS通知 + イベント設定に従いDiscord
                        let message = format!("📋 ルーチンIssue作成: {}", title);
                        send_os_notification(&app, "ルーチン", &message);

                        // Discord はイベント設定に従う
                        let send_discord = if let Some(nc) = &cached_notif_config {
                            if let Some(ec) = &nc.event_notifications {
                                if ec.enabled {
                                    if let Some(entry) = ec.events.get("routine_created") {
                                        entry.enabled && entry.channels.contains(&"discord".to_string())
                                    } else {
                                        true // routine_created 未設定ならデフォルト送信
                                    }
                                } else {
                                    false // イベント通知が無効
                                }
                            } else {
                                true // event_notifications 未設定ならデフォルト
                            }
                        } else {
                            true // config未読み込みならデフォルト
                        };
                        if send_discord {
                            send_discord_if_configured(&owner, &repo, &message).await;
                        }
                    }
                    Err(e) => {
                        eprintln!("ルーチンIssue作成エラー: {}", e);
                    }
                }
            }

            // 自動クローズチェック
            if let Some(close_time) = &routine.auto_close {
                let time_parts: Vec<&str> = close_time.split(':').collect();
                let close_hour: u32 = time_parts
                    .first()
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(99);
                let close_min: u32 = time_parts
                    .get(1)
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(99);

                if now.hour() == close_hour && now.minute() == close_min {
                    let today_str = now.format("%Y-%m-%d").to_string();

                    if let Ok(existing) = client.list_issues(&owner, &repo, "open").await {
                        if let Ok(issues) =
                            serde_json::from_str::<Vec<serde_json::Value>>(&existing)
                        {
                            for issue in &issues {
                                let issue_title = issue["title"].as_str().unwrap_or("");
                                let has_routine_label = issue["labels"]
                                    .as_array()
                                    .map(|ls| {
                                        ls.iter()
                                            .any(|l| l["name"].as_str() == Some("種別:ルーチン"))
                                    })
                                    .unwrap_or(false);

                                if has_routine_label && issue_title.contains(&today_str) {
                                    if let Some(num) = issue["number"].as_u64() {
                                        let _ = client
                                            .update_issue(
                                                &owner,
                                                &repo,
                                                num as u32,
                                                None,
                                                None,
                                                Some("closed".to_string()),
                                                None,
                                                None,
                                                None,
                                            )
                                            .await;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // 日次ジャーナル自動生成（23:59に実行）
        if now.hour() == JOURNAL_HOUR && now.minute() == JOURNAL_MINUTE {
            let date_str = now.format("%Y-%m-%d").to_string();
            match generator::generate_journal(&client, &owner, &repo, &date_str).await {
                Ok(_) => eprintln!("日次ジャーナルを生成しました: {}", date_str),
                Err(e) => eprintln!("日次ジャーナル生成エラー: {}", e),
            }
        }
    }
}

// --- 通知メッセージ生成 ---

async fn build_notification_message(
    client: &GitHubClient,
    owner: &str,
    repo: &str,
    notify_type: &str,
    custom_message: Option<&str>,
    now: &chrono::DateTime<Local>,
) -> String {
    match notify_type {
        "today_tasks" => {
            // 今日の未完了タスク一覧
            let issues_json = match client.list_issues(&owner, &repo, "open").await {
                Ok(json) => json,
                Err(_) => return String::new(),
            };
            let issues: Vec<serde_json::Value> = match serde_json::from_str(&issues_json) {
                Ok(v) => v,
                Err(_) => return String::new(),
            };

            // 進行中のタスクを抽出
            let active: Vec<String> = issues
                .iter()
                .filter(|i| {
                    i["labels"]
                        .as_array()
                        .map(|ls| {
                            ls.iter()
                                .any(|l| l["name"].as_str() == Some("状態:進行中"))
                        })
                        .unwrap_or(false)
                })
                .map(|i| {
                    format!(
                        "#{} {}",
                        i["number"],
                        i["title"].as_str().unwrap_or("(無題)")
                    )
                })
                .collect();

            if active.is_empty() {
                return "進行中のタスクはありません".to_string();
            }
            return format!("進行中: {}件\n{}", active.len(), active.join("\n"));
        }
        "overdue" => {
            // 期限超過のタスク
            let today_str = now.format("%Y-%m-%d").to_string();
            let issues_json = match client.list_issues(&owner, &repo, "open").await {
                Ok(json) => json,
                Err(_) => return String::new(),
            };
            let issues: Vec<serde_json::Value> = match serde_json::from_str(&issues_json) {
                Ok(v) => v,
                Err(_) => return String::new(),
            };

            let overdue: Vec<String> = issues
                .iter()
                .filter(|i| {
                    i.get("milestone")
                        .and_then(|m| m.get("due_on"))
                        .and_then(|d| d.as_str())
                        .map(|due_on| &due_on[..10] < today_str.as_str())
                        .unwrap_or(false)
                })
                .map(|i| {
                    format!(
                        "#{} {}",
                        i["number"],
                        i["title"].as_str().unwrap_or("(無題)")
                    )
                })
                .collect();

            if overdue.is_empty() {
                return String::new(); // 期限超過なしなら通知しない
            }
            return format!("期限超過: {}件\n{}", overdue.len(), overdue.join("\n"));
        }
        "summary" => {
            // 全体サマリー
            let issues_json = match client.list_issues(&owner, &repo, "open").await {
                Ok(json) => json,
                Err(_) => return String::new(),
            };
            let issues: Vec<serde_json::Value> = match serde_json::from_str(&issues_json) {
                Ok(v) => v,
                Err(_) => return String::new(),
            };
            let total = issues.len();
            let in_progress = issues
                .iter()
                .filter(|i| {
                    i["labels"]
                        .as_array()
                        .map(|ls| {
                            ls.iter()
                                .any(|l| l["name"].as_str() == Some("状態:進行中"))
                        })
                        .unwrap_or(false)
                })
                .count();
            let blocked = issues
                .iter()
                .filter(|i| {
                    i["labels"]
                        .as_array()
                        .map(|ls| {
                            ls.iter()
                                .any(|l| l["name"].as_str() == Some("状態:ブロック"))
                        })
                        .unwrap_or(false)
                })
                .count();
            return format!(
                "オープン: {}件 / 進行中: {}件 / ブロック: {}件",
                total, in_progress, blocked
            );
        }
        "custom" => {
            // カスタムメッセージ
            return custom_message.unwrap_or("").to_string();
        }
        _ => return String::new(),
    }
}
