// タスク画面の「分析」。今の絞り込みの範囲で、開いている数・期限・状態・担当・8 週の流れを数える
import type { GitHubIssue } from "./types";
import { daysUntil, dueOf } from "./due";
import { sumEstimates, type EstimateSum, type EstimateUnit } from "./estimate";

/** 期限まで、この日数以内なら「もうすぐ」（カードの黄色と同じ） */
export const SOON_DAYS = 3;
/** 流れを見る週の数 */
export const WEEKS = 8;

export interface StateCount {
  /** ラベルの名前（「状態:進行中」）。状態のラベルがないものは "" */
  key: string;
  count: number;
}

export interface PersonLoad {
  /** 担当の login。担当なしは null */
  login: string | null;
  count: number;
  estimate: EstimateSum;
}

export interface WeekFlow {
  /** その週の月曜（YYYY-MM-DD） */
  start: string;
  created: number;
  closed: number;
}

export interface Analytics {
  open: GitHubIssue[];
  openEstimate: EstimateSum;
  /** 期限を過ぎた、開いている Issue（期限の古い順） */
  overdue: GitHubIssue[];
  /** 期限まで SOON_DAYS 日以内（今日を含む）の、開いている Issue（期限の近い順） */
  soon: GitHubIssue[];
  unassigned: GitHubIssue[];
  unassignedEstimate: EstimateSum;
  /** 状態ごとの数（ボードの列の順。そのあとに列にない状態、最後に状態なし） */
  states: StateCount[];
  /** 担当ごとの数（多い順。2 人で担当している Issue は 2 人ともに数える）。担当なしは最後 */
  people: PersonLoad[];
  /** 古い週から今週まで */
  weeks: WeekFlow[];
}

const DAY_MS = 86400000;

/** その時刻の、この PC の日付（1970-01-01 からの日数） */
function localDay(d: Date): number {
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS);
}

function dayToDate(day: number): string {
  return new Date(day * DAY_MS).toISOString().substring(0, 10);
}

/**
 * scope は今の絞り込みに当てはまる Issue（開いている・閉じたの両方）。
 * 数字と状態・担当は開いている Issue で、8 週の流れは閉じたものも入れて数える
 */
export function analyze(scope: GitHubIssue[], unit: EstimateUnit, stateOrder: string[], today: Date = new Date()): Analytics {
  const open = scope.filter((i) => i.state === "open");

  const withDays = open
    .map((issue) => {
      const due = dueOf(issue);
      return due ? { issue, date: due.date, days: daysUntil(due.date, today) } : null;
    })
    .filter((x): x is { issue: GitHubIssue; date: string; days: number } => x !== null)
    .sort((a, b) => a.date.localeCompare(b.date) || a.issue.number - b.issue.number);
  const overdue = withDays.filter((x) => x.days < 0).map((x) => x.issue);
  const soon = withDays.filter((x) => x.days >= 0 && x.days <= SOON_DAYS).map((x) => x.issue);

  const unassigned = open.filter((i) => !i.assignees?.length);

  // 状態ごと
  const stateCounts = new Map<string, number>();
  for (const issue of open) {
    const key = issue.labels.find((l) => l.name.startsWith("状態:"))?.name ?? "";
    stateCounts.set(key, (stateCounts.get(key) ?? 0) + 1);
  }
  const rank = (key: string) => {
    if (key === "") return Number.MAX_SAFE_INTEGER;
    const i = stateOrder.indexOf(key);
    return i >= 0 ? i : stateOrder.length;
  };
  const states = [...stateCounts]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key));

  // 担当ごと
  const byPerson = new Map<string, GitHubIssue[]>();
  for (const issue of open) {
    for (const a of issue.assignees ?? []) byPerson.set(a.login, [...(byPerson.get(a.login) ?? []), issue]);
  }
  const people: PersonLoad[] = [...byPerson]
    .map(([login, list]) => ({ login, count: list.length, estimate: sumEstimates(list, unit) }))
    .sort((a, b) => b.count - a.count || b.estimate.total - a.estimate.total || a.login.localeCompare(b.login));
  const unassignedEstimate = sumEstimates(unassigned, unit);
  if (unassigned.length > 0) people.push({ login: null, count: unassigned.length, estimate: unassignedEstimate });

  // 8 週の流れ（週は月曜から）
  const todayDay = localDay(today);
  const thisMonday = todayDay - ((today.getDay() + 6) % 7);
  const firstMonday = thisMonday - 7 * (WEEKS - 1);
  const weeks: WeekFlow[] = Array.from({ length: WEEKS }, (_, i) => ({ start: dayToDate(firstMonday + 7 * i), created: 0, closed: 0 }));
  const weekOf = (iso: string | null | undefined): WeekFlow | null => {
    if (!iso) return null;
    const t = new Date(iso);
    if (Number.isNaN(t.getTime())) return null;
    const day = localDay(t);
    if (day < firstMonday || day > todayDay) return null;
    return weeks[Math.floor((day - firstMonday) / 7)] ?? null;
  };
  for (const issue of scope) {
    const created = weekOf(issue.created_at);
    if (created) created.created++;
    if (issue.state === "closed") {
      const closed = weekOf(issue.closed_at);
      if (closed) closed.closed++;
    }
  }

  return {
    open,
    openEstimate: sumEstimates(open, unit),
    overdue,
    soon,
    unassigned,
    unassignedEstimate,
    states,
    people,
    weeks,
  };
}
