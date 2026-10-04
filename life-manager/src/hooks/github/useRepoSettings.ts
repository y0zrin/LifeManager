// リポジトリに置く設定（ルーチン・通知・リマインダー・ボード・保存した見方・見積もりの単位・イベント通知）と、Discord への知らせ
import { useState, useCallback } from "react";
import { invoke } from "../../lib/invoke";
import { normalizeViews, type SavedView } from "../../lib/savedViews";
import { DEFAULT_UNIT, isEstimateUnit, type EstimateUnit } from "../../lib/estimate";
import { issueRef } from "../../lib/issueRef";
import type { BoardConfig, EventNotificationConfig, EventType, NotificationSchedule, Reminder, Routine } from "../../lib/types";
import { DEFAULT_EVENT_NOTIF_CONFIG, pendingNote, type MakeEventNotice, type RepoScope } from "./shared";
import { tr } from "../../lib/i18n";

export function useRepoSettings({ owner, repo, setStatus }: RepoScope) {
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [notificationSchedules, setNotificationSchedules] = useState<NotificationSchedule[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [boardConfig, setBoardConfig] = useState<BoardConfig | null>(null);
  // タスク一覧の「保存した見方」（config/views.yaml。チームで共有する）
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  // 見積もりの単位（config/estimate.yaml。チームで一つ）
  const [estimateUnit, setEstimateUnit] = useState<EstimateUnit>(DEFAULT_UNIT);
  const [eventNotifConfig, setEventNotifConfig] = useState<EventNotificationConfig | null>(null);

  // --- ロード ---

  const loadRoutines = useCallback(async () => {
    try {
      const result = await invoke("get_routines", { owner, repo });
      setRoutines(JSON.parse(result as string));
    } catch (e) {
      console.error(e);
    }
  }, [owner, repo]);

  const loadNotificationSchedules = useCallback(async () => {
    try {
      const result = await invoke("get_notification_schedules", { owner, repo });
      setNotificationSchedules(JSON.parse(result as string));
    } catch (e) {
      console.error(e);
    }
  }, [owner, repo]);

  const loadReminders = useCallback(async () => {
    try {
      const result = await invoke("get_reminders", { owner, repo });
      setReminders(JSON.parse(result as string));
    } catch (e) {
      console.error(e);
    }
  }, [owner, repo]);

  const loadBoardConfig = useCallback(async () => {
    try {
      const result = await invoke("get_board_config", { owner, repo });
      const parsed = JSON.parse(result as string);
      if (parsed) {
        setBoardConfig(parsed);
      }
    } catch (e) {
      console.error(e);
    }
  }, [owner, repo]);

  const loadEventNotifConfig = useCallback(async () => {
    try {
      const result = await invoke("get_event_notification_config", { owner, repo });
      const parsed = JSON.parse(result as string);
      if (parsed) {
        // 保存済み設定に不足しているイベントタイプをデフォルトで補完
        const merged: EventNotificationConfig = {
          ...DEFAULT_EVENT_NOTIF_CONFIG,
          ...parsed,
          events: { ...DEFAULT_EVENT_NOTIF_CONFIG.events, ...parsed.events },
        };
        setEventNotifConfig(merged);
      } else {
        setEventNotifConfig(null);
      }
    } catch (e) {
      console.error(e);
    }
  }, [owner, repo]);

  const loadSavedViews = useCallback(async () => {
    try {
      const result = await invoke("get_saved_views", { owner, repo });
      setSavedViews(normalizeViews(JSON.parse(result as string)));
    } catch (e) {
      console.error(e);
    }
  }, [owner, repo]);

  const loadEstimateConfig = useCallback(async () => {
    try {
      const result = await invoke("get_estimate_config", { owner, repo });
      const parsed = JSON.parse(result as string) as { unit?: unknown } | null;
      setEstimateUnit(isEstimateUnit(parsed?.unit) ? parsed.unit : DEFAULT_UNIT);
    } catch (e) {
      console.error(e);
    }
  }, [owner, repo]);

  /** プロジェクトを切り替えるとき、前のリポジトリの設定を消す（イベント通知の設定は、読み直すまで前のものを使う） */
  function clear() {
    setRoutines([]);
    setNotificationSchedules([]);
    setReminders([]);
    setBoardConfig(null);
    setSavedViews([]);
    setEstimateUnit(DEFAULT_UNIT);
  }

  // --- イベント通知ヘルパー ---

  const eventNotice: MakeEventNotice = (eventType: EventType, message: string) => {
    const config = eventNotifConfig ?? DEFAULT_EVENT_NOTIF_CONFIG;
    if (!config.enabled) return null;
    // 保存済み設定に未登録のイベントタイプはデフォルトにフォールバック
    const event = config.events?.[eventType] ?? DEFAULT_EVENT_NOTIF_CONFIG.events[eventType];
    if (!event?.enabled || !event.channels?.length) return null;
    // 自分の操作時はOS通知をスキップ（os_for_own_actionsがfalseの場合）
    const channels = event.channels.filter(ch => ch !== "os" || config.os_for_own_actions);
    return channels.length > 0 ? { message, channels } : null;
  };

  // --- ルーチン操作 ---

  async function saveRoutines(routinesList: Routine[]) {
    try {
      const json = JSON.stringify(routinesList);
      const result = await invoke("save_routines", { owner, repo, routines: json });
      setRoutines(routinesList);
      setStatus(result as string);
    } catch (e) {
      setStatus(tr("エラー: ") + e);
      throw e;
    }
  }

  // --- 通知 ---

  async function sendNotification(title: string, body: string) {
    try {
      await invoke("send_notification", { title, body });
      setStatus(tr("通知を送信しました"));
    } catch (e) {
      setStatus(tr("通知エラー: ") + e);
    }
  }

  // --- リマインダー ---

  async function addReminder(issueNumber: number, title: string, datetime: string, channels: string[]) {
    try {
      const newReminder: Reminder = { issue_number: issueNumber, title, datetime, channels };
      const updated = [...reminders, newReminder];
      const json = JSON.stringify(updated);
      const result = await invoke("save_reminders", { owner, repo, reminders: json });
      await invoke("refresh_scheduler");
      setReminders(updated);
      setStatus(tr("{issueRef} のリマインダーを設定しました{pendingNote}", { issueRef: issueRef(issueNumber), pendingNote: pendingNote(result) }));
    } catch (e) {
      setStatus(tr("エラー: ") + e);
      throw e;
    }
  }

  async function removeReminder(issueNumber: number, datetime: string) {
    try {
      const updated = reminders.filter(
        (r) => !(r.issue_number === issueNumber && r.datetime === datetime)
      );
      const json = JSON.stringify(updated);
      const result = await invoke("save_reminders", { owner, repo, reminders: json });
      await invoke("refresh_scheduler");
      setReminders(updated);
      setStatus(tr("リマインダーを削除しました{pendingNote}", { pendingNote: pendingNote(result) }));
    } catch (e) {
      setStatus(tr("エラー: ") + e);
      throw e;
    }
  }

  // --- 通知スケジュール ---

  async function saveNotificationSchedules(schedules: NotificationSchedule[]) {
    try {
      const json = JSON.stringify(schedules);
      const result = await invoke("save_notification_schedules", { owner, repo, schedules: json });
      setNotificationSchedules(schedules);
      setStatus(result as string);
    } catch (e) {
      setStatus(tr("エラー: ") + e);
      throw e;
    }
  }

  // --- イベント通知設定 ---

  async function saveEventNotifConfig(config: EventNotificationConfig) {
    try {
      const json = JSON.stringify(config);
      const result = await invoke("save_event_notification_config", { owner, repo, configJson: json });
      setEventNotifConfig(config);
      setStatus(result as string);
    } catch (e) {
      setStatus(tr("エラー: ") + e);
      throw e;
    }
  }

  // --- ボード設定 ---

  async function saveBoardConfig(config: BoardConfig) {
    try {
      const json = JSON.stringify(config);
      const result = await invoke("save_board_config", { owner, repo, config: json });
      setBoardConfig(config);
      setStatus(result as string);
    } catch (e) {
      setStatus(tr("エラー: ") + e);
      throw e;
    }
  }

  // --- 保存した見方（タスク一覧） ---

  async function saveSavedViews(views: SavedView[]) {
    try {
      const result = await invoke("save_saved_views", { owner, repo, views: JSON.stringify(views) });
      setSavedViews(views);
      setStatus(result as string);
    } catch (e) {
      setStatus(tr("エラー: ") + e);
      throw e;
    }
  }

  // --- 見積もりの単位 ---

  /** 見積もりの単位を変える（config/estimate.yaml に書いて GitHub に送る） */
  async function saveEstimateUnit(unit: EstimateUnit) {
    try {
      const result = await invoke("save_estimate_config", { owner, repo, config: JSON.stringify({ unit }) });
      setEstimateUnit(unit);
      setStatus(result as string);
    } catch (e) {
      setStatus(tr("エラー: ") + e);
      throw e;
    }
  }

  // --- Discord Webhook ---

  async function setDiscordWebhook(webhookUrl: string) {
    try {
      const result = await invoke("set_discord_webhook", { owner, repo, webhookUrl });
      setStatus(result as string);
    } catch (e) {
      setStatus(tr("エラー: ") + e);
      throw e;
    }
  }

  async function loadDiscordWebhook(): Promise<string> {
    try {
      const result = await invoke("load_discord_webhook", { owner, repo });
      return result as string;
    } catch (e) {
      console.error("Discord Webhook読み込みエラー:", e);
      return "";
    }
  }

  async function testDiscordWebhook(webhookUrl: string) {
    try {
      const result = await invoke("test_discord_webhook", { webhookUrl });
      setStatus(result as string);
    } catch (e) {
      setStatus(tr("Discordテスト送信エラー: ") + e);
      throw e;
    }
  }

  return {
    routines, notificationSchedules, reminders, boardConfig, savedViews, estimateUnit, eventNotifConfig,
    loadRoutines, loadNotificationSchedules, loadReminders, loadBoardConfig, loadEventNotifConfig, loadSavedViews, loadEstimateConfig,
    clear, eventNotice,
    saveRoutines, sendNotification, addReminder, removeReminder, saveNotificationSchedules, saveEventNotifConfig,
    saveBoardConfig, saveSavedViews, saveEstimateUnit,
    setDiscordWebhook, loadDiscordWebhook, testDiscordWebhook,
  };
}
