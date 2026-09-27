//! 設定ファイル（config/*.yaml）の読み書き。画面とは、ファイルの「一部」を JSON でやりとりする。
//! notifications.yaml は「通知スケジュール」と「イベント通知」の 2 つに分けて扱う（片方を書き換えても、もう片方は今のファイルのものを残す）
use crate::scheduler::routine::{EventNotificationConfig, NotificationConfig, Reminder, ReminderConfig, Routine, RoutineConfig};
use serde::Serialize;
use serde_json::Value;

pub struct Kind {
    pub key: &'static str,
    pub path: &'static str,
    /// 画面に出す名前（「〜を保存しました」）
    pub label: &'static str,
    /// ファイルがないときの内容
    pub empty: &'static str,
    pub commit: &'static str,
}

pub const KINDS: [Kind; 5] = [
    Kind { key: "routines", path: "config/routines.yaml", label: "ルーチン設定", empty: "[]", commit: "ルーチン設定を更新" },
    Kind {
        key: "notifications",
        path: "config/notifications.yaml",
        label: "通知スケジュール",
        empty: "[]",
        commit: "通知スケジュール設定を更新",
    },
    Kind {
        key: "event_notifications",
        path: "config/notifications.yaml",
        label: "イベント通知設定",
        empty: "null",
        commit: "イベント通知設定を更新",
    },
    Kind { key: "reminders", path: "config/reminders.yaml", label: "リマインダー", empty: "[]", commit: "リマインダーを更新" },
    Kind { key: "board", path: "config/board.yaml", label: "ボード設定", empty: "null", commit: "ボード設定を更新" },
];

pub fn kind(key: &str) -> Result<&'static Kind, String> {
    KINDS.iter().find(|k| k.key == key).ok_or_else(|| format!("知らない設定です: {}", key))
}

fn yaml_error(e: serde_yaml::Error) -> String {
    format!("YAMLパースエラー: {}", e)
}

fn json_error(e: serde_json::Error) -> String {
    format!("JSONパースエラー: {}", e)
}

fn to_json(value: &impl Serialize) -> Result<String, String> {
    serde_json::to_string(value).map_err(|e| e.to_string())
}

fn to_yaml(value: &impl Serialize) -> Result<String, String> {
    serde_yaml::to_string(value).map_err(|e| format!("YAMLシリアライズエラー: {}", e))
}

fn notification_config(content: Option<&str>) -> NotificationConfig {
    content
        .and_then(|c| serde_yaml::from_str::<NotificationConfig>(c).ok())
        .unwrap_or(NotificationConfig { notifications: Vec::new(), event_notifications: None })
}

/// ファイルの中身（ないときは None）から、画面に渡す JSON を作る
pub fn read_part(kind: &Kind, content: Option<&str>) -> Result<String, String> {
    let Some(content) = content else { return Ok(kind.empty.to_string()) };
    match kind.key {
        "routines" => to_json(&serde_yaml::from_str::<RoutineConfig>(content).map_err(yaml_error)?.routines),
        "notifications" => to_json(&serde_yaml::from_str::<NotificationConfig>(content).map_err(yaml_error)?.notifications),
        "event_notifications" => {
            match serde_yaml::from_str::<NotificationConfig>(content).map_err(yaml_error)?.event_notifications {
                Some(events) => to_json(&events),
                None => Ok("null".to_string()),
            }
        }
        "reminders" => to_json(&serde_yaml::from_str::<ReminderConfig>(content).map_err(yaml_error)?.reminders),
        _ => to_json(&serde_yaml::from_str::<Value>(content).map_err(yaml_error)?),
    }
}

/// 今のファイルの中身（ないときは None）の一部を json で置き換えた、新しいファイルの中身
pub fn write_part(kind: &Kind, content: Option<&str>, json: &str) -> Result<String, String> {
    match kind.key {
        "routines" => {
            let routines: Vec<Routine> = serde_json::from_str(json).map_err(json_error)?;
            to_yaml(&RoutineConfig { routines })
        }
        "notifications" => {
            let mut config = notification_config(content);
            config.notifications = serde_json::from_str(json).map_err(json_error)?;
            to_yaml(&config)
        }
        "event_notifications" => {
            let mut config = notification_config(content);
            config.event_notifications = serde_json::from_str::<Option<EventNotificationConfig>>(json).map_err(json_error)?;
            to_yaml(&config)
        }
        "reminders" => {
            let reminders: Vec<Reminder> = serde_json::from_str(json).map_err(json_error)?;
            // GitHub に作れなかった Issue（仮の番号のまま）のリマインダーは書かない
            let reminders = reminders.into_iter().filter(|r| r.issue_number > 0).collect();
            to_yaml(&ReminderConfig { reminders })
        }
        _ => to_yaml(&serde_json::from_str::<Value>(json).map_err(json_error)?),
    }
}

/// まだ GitHub に作っていない Issue（仮の番号）のリマインダーがあるか
pub fn has_temporary_reminders(json: &str) -> bool {
    serde_json::from_str::<Vec<Value>>(json)
        .map(|list| list.iter().any(|r| r["issue_number"].as_i64().map_or(false, |n| n < 0)))
        .unwrap_or(false)
}

/// JSON として同じ内容か（空白や並びの書き方の違いは気にしない）
pub fn same_json(a: &str, b: &str) -> bool {
    match (serde_json::from_str::<Value>(a), serde_json::from_str::<Value>(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => a == b,
    }
}

/// 一覧（JSON の配列）を、足したもの・外したものだけ当ててまとめる（リマインダー用。どちらの変更も残る）
pub fn merge_lists(base: &str, local: &str, remote: &str) -> Option<String> {
    let parse = |s: &str| serde_json::from_str::<Vec<Value>>(s).ok();
    let (base, local, remote) = (parse(base)?, parse(local)?, parse(remote)?);
    let mut merged: Vec<Value> = remote.into_iter().filter(|r| !(base.contains(r) && !local.contains(r))).collect();
    for added in local.iter().filter(|l| !base.contains(l)) {
        if !merged.contains(added) {
            merged.push(added.clone());
        }
    }
    serde_json::to_string(&merged).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn changing_schedules_keeps_event_settings_in_the_same_file() {
        let file = "notifications:\n- name: 朝\n  schedule:\n    frequency: daily\n    time: '08:00'\n  type: today_tasks\n  channels: [os]\nevent_notifications:\n  enabled: true\n  os_for_own_actions: false\n  events: {}\n";
        let schedules = kind("notifications").unwrap();
        let events = kind("event_notifications").unwrap();
        let written = write_part(schedules, Some(file), "[]").unwrap();
        assert_eq!(read_part(schedules, Some(&written)).unwrap(), "[]");
        assert!(same_json(&read_part(events, Some(&written)).unwrap(), &read_part(events, Some(file)).unwrap()));
        // ファイルがないときは空
        assert_eq!(read_part(events, None).unwrap(), "null");
    }

    #[test]
    fn reminders_added_on_both_sides_are_all_kept() {
        let a = r#"{"issue_number":1,"title":"a","datetime":"2026-10-01T09:00","channels":["os"]}"#;
        let b = r#"{"issue_number":2,"title":"b","datetime":"2026-10-02T09:00","channels":["os"]}"#;
        let c = r#"{"issue_number":3,"title":"c","datetime":"2026-10-03T09:00","channels":["os"]}"#;
        // 手元: b を足した。GitHub: a が済んで消え、c が足された
        let merged = merge_lists(&format!("[{}]", a), &format!("[{},{}]", a, b), &format!("[{}]", c)).unwrap();
        assert!(same_json(&merged, &format!("[{},{}]", c, b)));
        // 仮の番号のリマインダーは GitHub に書かない
        let reminders = kind("reminders").unwrap();
        let yaml = write_part(reminders, None, &format!("[{},{}]", a, a.replace("\"issue_number\":1", "\"issue_number\":-1"))).unwrap();
        assert_eq!(serde_yaml::from_str::<ReminderConfig>(&yaml).unwrap().reminders.len(), 1);
    }
}
