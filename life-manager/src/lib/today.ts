// 今日のあなた（#238）: その日に終えたタスクを数える。日は、この PC の時計の 0 時から
import type { GitHubIssue } from "./types";
import type { ActivityEvent } from "./activity";

/** 今日の 0 時（この PC の時計） */
export function localDayStart(now = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/** 日の名前（2026-10-03）。日が変わったかを見るのに使う */
export function dayKey(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/**
 * 今日、完了にしたタスク（予定なし・重複として閉じたものは数えない）。
 * 自分が担当しているもの、またはチームの動きで自分が閉じたもの
 */
export function doneToday(closed: GitHubIssue[], events: ActivityEvent[] | null, me: string, now = new Date()): GitHubIssue[] {
  const start = localDayStart(now).getTime();
  const mine = me.toLowerCase();
  const closedByMe = new Set(
    (events ?? [])
      .filter((e) => e.type === "IssuesEvent" && e.action === "closed" && e.actor.toLowerCase() === mine && e.number)
      .map((e) => e.number),
  );
  return closed.filter(
    (i) =>
      !!i.closed_at &&
      Date.parse(i.closed_at) >= start &&
      (i.state_reason ?? "completed") === "completed" &&
      (i.assignees.some((a) => a.login.toLowerCase() === mine) || closedByMe.has(i.number)),
  );
}
