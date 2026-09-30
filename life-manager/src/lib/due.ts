import type { GitHubIssue } from "./types";
import { parseGanttDates } from "./ganttParser";

/** Issue の期限（ガントの終了日。なければマイルストーンの期限） */
export interface Due {
  /** YYYY-MM-DD */
  date: string;
  source: "gantt" | "milestone";
}

export function dueOf(issue: GitHubIssue): Due | null {
  const gantt = parseGanttDates(issue.body);
  if (gantt) return { date: gantt.end, source: "gantt" };
  const milestone = issue.milestone?.due_on;
  return milestone ? { date: milestone.substring(0, 10), source: "milestone" } : null;
}

/** 今日から期限まで、あと何日か（今日なら 0、過ぎていれば負の数） */
export function daysUntil(date: string, today: Date = new Date()): number {
  const [y, m, d] = date.split("-").map(Number);
  const due = Date.UTC(y, m - 1, d);
  const now = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((due - now) / 86400000);
}
