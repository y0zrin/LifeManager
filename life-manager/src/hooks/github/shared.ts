// GitHub とやりとりするフック（useGitHub と、その分け先）で共通に使うもの
import type { EventNotificationConfig, EventNotice, EventType } from "../../lib/types";
import { tr, jaOf } from "../../lib/i18n";

/** つながらないときの変更は送信待ちに並ぶ（結果に _pending が付く）。そのときに状態の表示に添える言葉 */
export const PENDING_NOTE = tr("（未送信。つながったら GitHub に送ります）");

export function isPending(result: unknown): boolean {
  try {
    return !!JSON.parse(result as string)?._pending;
  } catch {
    return false;
  }
}

/** 設定の保存の結果（バックエンドが返す言葉）が、送信待ちに並んだことを表しているか */
export function pendingNote(result: unknown): string {
  return jaOf(String(result)).includes("未送信") ? PENDING_NOTE : "";
}

/** 分けたフックに渡す、今のリポジトリと状態の表示 */
export interface RepoScope {
  owner: string;
  repo: string;
  setStatus: (status: string) => void;
  /** エラーを、画面に出す言葉に直す（404・401・403） */
  friendlyError: (e: unknown) => string;
}

/** イベント通知の設定が保存されていないときの決まり: 全イベント Discord のみ有効 */
export const DEFAULT_EVENT_NOTIF_CONFIG: EventNotificationConfig = {
  enabled: true,
  os_for_own_actions: false,
  events: {
    issue_created: { enabled: true, channels: ["discord"] },
    routine_created: { enabled: true, channels: ["os", "discord"] },
    issue_closed: { enabled: true, channels: ["discord"] },
    issue_reopened: { enabled: true, channels: ["discord"] },
    status_changed: { enabled: true, channels: ["discord"] },
    comment_added: { enabled: true, channels: ["discord"] },
    todo_toggled: { enabled: true, channels: ["discord"] },
    issue_promoted: { enabled: true, channels: ["discord"] },
    issue_updated: { enabled: true, channels: ["discord"] },
  },
};

/**
 * 操作と一緒にバックエンドへ渡すお知らせ（Discord・OS）。GitHub に送れたときに出る（つながらないときは、つながって送れたとき）。
 * message の「{issue}」は送れたあとの番号（#12）になり、Issue へのリンクが付く
 */
export type MakeEventNotice = (eventType: EventType, message: string) => EventNotice | null;
