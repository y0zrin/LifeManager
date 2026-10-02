// ガントの「仮の日程」。日程（開始・終了）のないタスクに、見積もりから仮の帯を置く
import type { GitHubIssue } from "./types";
import type { GanttTask } from "./ganttTypes";
import { issuesToGanttTasks } from "./ganttParser";
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

/** 番号の並び。まだ送っていない Issue（仮の番号 = 負の数）は、送った Issue のあとに作った順で */
function numberOrder(n: number): number {
  return n < 0 ? Number.MAX_SAFE_INTEGER / 2 - n : n;
}

/**
 * 日程がなく見積もりのある、開いているタスクに仮の日程を置く。
 * - 長さ: 見積もりを日に直し、端数は 1 日に切り上げる（土日も数える）
 * - 始まり: 今日から。先行タスクがあれば、その終わりの次の日から
 * - 同じ担当のタスクとは重ならないよう、空いている日に置く。日程のあるタスクを先に置く（担当なしは、それぞれ今日から）
 * - 置く順: すぐ始められる（先行の仮の帯をもう置いた）タスクから選ぶ。選び方は
 *   急ぐ度合い（優先度 → 期限。そのタスクに続くタスクの分も見る＝急ぐタスクの先行は、いっしょに急ぐ）
 *   → 合流するタスク（先行が 2 つ以上）を先に → 番号の順。
 *   合流するタスクを、先行が終わったらすぐ置くと、ガントの矢印が互い違いになりにくく、交わりが減る（#196）
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

  const candidate = (t: GanttTask) => {
    const issue = issueOf.get(t.issueNumber);
    return (!t.startDate || !t.endDate) && t.state === "open" && issue !== undefined && estimateOf(issue) !== null;
  };

  // 先行タスクの終わりの日。日程も仮の日程もなければ null
  const endOf = (n: number): number | null => {
    const t = taskOf.get(n);
    if (!t) return null;
    if (t.startDate && t.endDate) return toDays(t.endDate);
    const p = plans.get(n);
    return p ? toDays(p.end) : null;
  };

  const place = (t: GanttTask) => {
    const n = t.issueNumber;
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
  };

  // 急ぐ度合い: そのタスクと、あとに続く開いたタスクのうち、いちばん急ぐもの（優先度の順位と期限）
  const followers = new Map<number, number[]>();
  for (const t of tasks) {
    if (t.state !== "open") continue;
    for (const d of t.dependencies) followers.set(d, [...(followers.get(d) ?? []), t.issueNumber]);
  }
  const urgencyOf = new Map<number, { rank: number; due: string }>();
  const urgency = (n: number, seen: Set<number>): { rank: number; due: string } => {
    const known = urgencyOf.get(n);
    if (known) return known;
    const issue = issueOf.get(n);
    let rank = issue ? priorityRank(issue) : 1;
    let due = (issue && dueOf(issue)?.date) || "9999";
    seen.add(n);
    for (const f of followers.get(n) ?? []) {
      if (seen.has(f)) continue; // 先行が輪になっている
      const u = urgency(f, seen);
      rank = Math.min(rank, u.rank);
      if (u.due < due) due = u.due;
    }
    seen.delete(n);
    const u = { rank, due };
    urgencyOf.set(n, u);
    return u;
  };
  const merges = (t: GanttTask) => (t.dependencies.filter((d) => taskOf.has(d)).length >= 2 ? 0 : 1);
  const compare = (a: GanttTask, b: GanttTask) => {
    const ua = urgency(a.issueNumber, new Set());
    const ub = urgency(b.issueNumber, new Set());
    return ua.rank - ub.rank || ua.due.localeCompare(ub.due) || merges(a) - merges(b) || numberOrder(a.issueNumber) - numberOrder(b.issueNumber);
  };

  const candidates = tasks.filter(candidate);
  const waiting = new Set(candidates.map((t) => t.issueNumber));
  while (waiting.size > 0) {
    const rest = candidates.filter((t) => waiting.has(t.issueNumber));
    const ready = rest.filter((t) => t.dependencies.every((d) => d === t.issueNumber || !waiting.has(d)));
    // 先行が輪になっていて、どれも始められないときは、待っているものから選ぶ
    const next = [...(ready.length > 0 ? ready : rest)].sort(compare)[0];
    place(next);
    waiting.delete(next.issueNumber);
  }
  return plans;
}

/** 今日（この PC の日付。YYYY-MM-DD） */
export function localToday(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/**
 * 選んだタスクの仮の日程（タスク一覧でまとめて決める）。ガントと同じく、マイルストーンごとに、
 * そのマイルストーンの全部のタスク（閉じたものも）で置く。日程があるか見積もりのないタスクは入らない
 */
export function plansFor(targets: GitHubIssue[], all: GitHubIssue[], today: string): Map<number, TentativePlan> {
  const out = new Map<number, TentativePlan>();
  const msOf = (i: GitHubIssue) => i.milestone?.number ?? null;
  for (const ms of new Set(targets.map(msOf))) {
    const group = all.filter((i) => msOf(i) === ms);
    const plans = planTentative(issuesToGanttTasks(group), group, today);
    for (const t of targets) {
      const p = msOf(t) === ms ? plans.get(t.number) : undefined;
      if (p) out.set(t.number, p);
    }
  }
  return out;
}
