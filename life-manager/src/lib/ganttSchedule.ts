// ガントの「仮の日程」。日程（開始・終了）のないタスクに、見積もりから仮の帯を置く
import type { GitHubIssue } from "./types";
import type { GanttTask } from "./ganttTypes";
import { dueOf } from "./due";
import { estimateDays, estimateOf, formatEstimate } from "./estimate";
import { priorityRank } from "./taskList";

export interface TentativePlan {
  /** YYYY-MM-DD */
  start: string;
  end: string;
  /** 帯の長さ（日。見積もりを日に直して切り上げたもの） */
  days: number;
  /** 見積もり（「2日」「5pt」など） */
  estimate: string;
}

const DAY_MS = 86400000;

function toDays(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
}

function toDate(days: number): string {
  const d = new Date(days * DAY_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** start 日以降で、busy のどれとも重ならずに days 日続けて空いている、最初の日 */
function firstFree(start: number, days: number, busy: [number, number][]): number {
  let s = start;
  // 始まりの順に見ていけば、一度通るだけで決まる（s は増えるだけ）
  for (const [from, to] of [...busy].sort((a, b) => a[0] - b[0])) {
    if (from <= s + days - 1 && to >= s) s = to + 1;
  }
  return s;
}

/**
 * 日程がなく見積もりのある、開いているタスクに仮の日程を置く。
 * - 長さ: 見積もりを日に直し、端数は 1 日に切り上げる（土日も数える）
 * - 始まり: 今日から。先行タスクがあれば、その終わりの次の日から（先行タスクが仮なら、先にそれを置く）
 * - 同じ担当のタスクとは重ならないよう、空いている日に置く。日程のあるタスクを先に置き、
 *   仮のタスクは優先度 → 期限 → 番号の順に置く（担当なしは、それぞれ今日から）
 * 日程のあるタスクは動かさない
 */
export function planTentative(tasks: GanttTask[], issues: GitHubIssue[], today: string): Map<number, TentativePlan> {
  const taskOf = new Map(tasks.map((t) => [t.issueNumber, t]));
  const issueOf = new Map(issues.map((i) => [i.number, i]));
  const todayDays = toDays(today);
  const plans = new Map<number, TentativePlan>();
  // 担当ごとの、ふさがっている日（日程のある開いたタスクと、置いた仮の帯）
  const busy = new Map<string, [number, number][]>();
  const addBusy = (login: string, from: number, to: number) => busy.set(login, [...(busy.get(login) ?? []), [from, to]]);
  for (const t of tasks) {
    if (t.state !== "open" || !t.startDate || !t.endDate) continue;
    for (const a of t.assignees) addBusy(a.login, toDays(t.startDate), toDays(t.endDate));
  }
  const visiting = new Set<number>();

  const candidate = (t: GanttTask) => {
    const issue = issueOf.get(t.issueNumber);
    return (!t.startDate || !t.endDate) && t.state === "open" && issue !== undefined && estimateOf(issue) !== null;
  };

  // 先行タスクの終わりの日。日程も仮の日程もなければ null
  const endOf = (n: number): number | null => {
    const t = taskOf.get(n);
    if (!t) return null;
    if (t.startDate && t.endDate) return toDays(t.endDate);
    if (candidate(t)) place(t);
    const p = plans.get(n);
    return p ? toDays(p.end) : null;
  };

  const place = (t: GanttTask) => {
    const n = t.issueNumber;
    if (plans.has(n) || visiting.has(n)) return;
    visiting.add(n);
    const est = estimateOf(issueOf.get(n)!)!;
    let start = todayDays;
    for (const dep of t.dependencies) {
      const end = endOf(dep);
      if (end !== null) start = Math.max(start, end + 1);
    }
    const days = Math.max(1, Math.ceil(estimateDays(est) - 1e-9));
    const logins = t.assignees.map((a) => a.login);
    start = firstFree(start, days, logins.flatMap((login) => busy.get(login) ?? []));
    const end = start + days - 1;
    for (const login of logins) addBusy(login, start, end);
    plans.set(n, { start: toDate(start), end: toDate(end), days, estimate: formatEstimate(est.value, est.unit) });
    visiting.delete(n);
  };

  const order = tasks
    .filter(candidate)
    .map((t) => ({ t, issue: issueOf.get(t.issueNumber)! }))
    .sort(
      (a, b) =>
        priorityRank(a.issue) - priorityRank(b.issue) ||
        (dueOf(a.issue)?.date ?? "9999").localeCompare(dueOf(b.issue)?.date ?? "9999") ||
        a.issue.number - b.issue.number,
    );
  for (const { t } of order) place(t);
  return plans;
}
