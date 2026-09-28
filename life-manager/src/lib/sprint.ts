// スプリント（＝マイルストーン）: 開始日・バーンダウン・ベロシティ・サイクルタイム
import type { GitHubIssue, GitHubMilestone, TimelineEvent } from "./types";
import { convertEstimate, estimateOf, type EstimateUnit } from "./estimate";

/** 量の数え方: 見積もり（設定の単位）か、件数 */
export type PaceMode = "estimate" | "count";

/** マイルストーンの説明に書く開始日の行（GitHub の画面でもそのまま読める形） */
const START_LINE = /^[ \t]*開始[:：][ \t]*(\d{4}-\d{2}-\d{2})[ \t]*$/m;
const START_LINES = /^[ \t]*開始[:：][ \t]*\d{4}-\d{2}-\d{2}[ \t]*$\n?/gm;

const DAY_MS = 86400000;

/** その時刻の、この PC の日付（1970-01-01 からの日数） */
export function dayOfTime(t: Date): number {
  return Math.floor(Date.UTC(t.getFullYear(), t.getMonth(), t.getDate()) / DAY_MS);
}

export function dayOfIso(iso: string): number {
  return dayOfTime(new Date(iso));
}

export function dayOfDate(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
}

export function dateOfDay(day: number): string {
  return new Date(day * DAY_MS).toISOString().substring(0, 10);
}

/** 説明に書いた開始日（なければ null） */
export function writtenStartDate(description: string | null | undefined): string | null {
  return description?.match(START_LINE)?.[1] ?? null;
}

/** 開始日の行を外した説明（画面に出す・編集する形） */
export function descriptionText(description: string | null | undefined): string {
  return (description ?? "").replace(START_LINES, "").trim();
}

/** 説明に開始日の行を書く（date が null なら外す）。開始日の行は最後に置く */
export function withStartDate(description: string | null | undefined, date: string | null): string {
  const text = descriptionText(description);
  if (!date) return text;
  return text ? `${text}\n開始: ${date}` : `開始: ${date}`;
}

export interface SprintRange {
  /** YYYY-MM-DD。説明に書いた開始日、なければマイルストーンを作った日 */
  start: string | null;
  /** 開始日を説明に書いてあるか（書いていなければ、作った日を使っている） */
  written: boolean;
  /** YYYY-MM-DD（期限。なければ null） */
  end: string | null;
  /** 開始日から期限までの日数（両方あるとき） */
  days: number | null;
}

export function sprintRange(ms: Pick<GitHubMilestone, "description" | "due_on" | "created_at">): SprintRange {
  const written = writtenStartDate(ms.description);
  const start = written ?? (ms.created_at ? dateOfDay(dayOfIso(ms.created_at)) : null);
  const end = ms.due_on ? ms.due_on.substring(0, 10) : null;
  const days = start && end ? dayOfDate(end) - dayOfDate(start) + 1 : null;
  return { start, written: written !== null, end, days: days !== null && days > 0 ? days : null };
}

/** 1 件の量。件数なら 1、見積もりなら設定の単位に直した値（見積もりがない・直せないときは 0） */
export function weightOf(issue: GitHubIssue, mode: PaceMode, unit: EstimateUnit): number {
  if (mode === "count") return 1;
  const e = estimateOf(issue);
  return e ? convertEstimate(e, unit) ?? 0 : 0;
}

export interface ScopeAdd {
  date: string;
  amount: number;
  issues: number[];
}

export interface Burndown {
  start: string;
  end: string | null;
  /** 日ごとの残り（開始日から、今日か期限の早いほうまで） */
  points: { date: string; remaining: number }[];
  /** 開始日の量（そのあとに足した分は含まない） */
  initial: number;
  /** 全部の量と、終えた量 */
  total: number;
  done: number;
  /** 今の残り */
  remaining: number;
  /** 開始のあとに足した分（作った日で数える） */
  added: ScopeAdd[];
  addedTotal: number;
  /** 経過日数（開始日を 1 日目とする）と、全体の日数 */
  elapsed: number;
  totalDays: number | null;
  /** 理想なら、今日の終わりの残り */
  idealNow: number | null;
  /**
   * このペース（足した分も含めた、正味の減り方）で終わる日。
   * done＝もう終わった、early＝始まったばかりで出せない、stalled＝残りが減っていない、notStarted＝まだ始まっていない
   */
  projection:
    | { kind: "date"; date: string; lateDays: number | null }
    | { kind: "done" }
    | { kind: "early" }
    | { kind: "stalled" }
    | { kind: "notStarted" };
  /** 見積もりで数えるとき、見積もりのない Issue の数 */
  missing: number;
}

/**
 * マイルストーン（スプリント）の残りの量を、日ごとに数える。
 * Issue がいつマイルストーンに入ったかは分からないので、作った日（開始日より前なら開始日）から数える
 */
export function burndown(
  range: { start: string; end: string | null },
  issues: GitHubIssue[],
  mode: PaceMode,
  unit: EstimateUnit,
  today: Date = new Date(),
): Burndown {
  const startDay = dayOfDate(range.start);
  const endDay = range.end ? dayOfDate(range.end) : null;
  const todayDay = dayOfTime(today);
  const items = issues.map((issue) => ({
    issue,
    w: weightOf(issue, mode, unit),
    added: Math.max(startDay, dayOfIso(issue.created_at)),
    closed: issue.state === "closed" && issue.closed_at ? dayOfIso(issue.closed_at) : null,
  }));
  const remainingOn = (d: number) =>
    items.reduce((sum, x) => (x.added <= d && (x.closed === null || x.closed > d) ? sum + x.w : sum), 0);

  const initial = items.reduce((sum, x) => (x.added === startDay && (x.closed === null || x.closed >= startDay) ? sum + x.w : sum), 0);
  const total = items.reduce((sum, x) => sum + x.w, 0);
  const done = items.reduce((sum, x) => (x.closed !== null ? sum + x.w : sum), 0);
  const missing = mode === "estimate" ? issues.filter((i) => !estimateOf(i)).length : 0;

  const addMap = new Map<number, ScopeAdd>();
  for (const x of items) {
    if (x.added <= startDay || x.w === 0) continue;
    const a = addMap.get(x.added) ?? { date: dateOfDay(x.added), amount: 0, issues: [] };
    a.amount += x.w;
    a.issues.push(x.issue.number);
    addMap.set(x.added, a);
  }
  const added = [...addMap.values()].sort((a, b) => a.date.localeCompare(b.date));
  const addedTotal = added.reduce((sum, a) => sum + a.amount, 0);

  const lastDay = endDay !== null ? Math.min(todayDay, endDay) : todayDay;
  const points: { date: string; remaining: number }[] = [];
  for (let d = startDay; d <= lastDay; d++) points.push({ date: dateOfDay(d), remaining: remainingOn(d) });

  const totalDays = endDay !== null ? endDay - startDay + 1 : null;
  const elapsed = Math.max(0, Math.min(todayDay, endDay ?? todayDay) - startDay + 1);
  const remaining = todayDay < startDay ? initial : remainingOn(todayDay);
  const idealNow = totalDays ? Math.max(0, initial * (1 - Math.min(elapsed, totalDays) / totalDays)) : null;

  let projection: Burndown["projection"];
  if (todayDay < startDay) projection = { kind: "notStarted" };
  else if (remaining <= 0) projection = { kind: "done" };
  else {
    const days = todayDay - startDay + 1;
    const rate = (initial - remaining) / days;
    if (rate <= 0) projection = days <= 2 ? { kind: "early" } : { kind: "stalled" };
    else {
      const finish = todayDay + Math.ceil(remaining / rate);
      projection = { kind: "date", date: dateOfDay(finish), lateDays: endDay !== null ? finish - endDay : null };
    }
  }

  return { start: range.start, end: range.end, points, initial, total, done, remaining, added, addedTotal, elapsed, totalDays, idealNow, projection, missing };
}

// --- チームのペース（終わったマイルストーン） ---

export interface VelocityEntry {
  number: number;
  title: string;
  /** 終えた量（閉じた Issue の量の合計） */
  done: number;
  /** 閉じた Issue の数 */
  closedCount: number;
  /** 並べる日（期限、なければ最後に閉じた日） */
  date: string;
}

/** マイルストーンごとの閉じた Issue（Issue に付いているマイルストーンから。一覧は開いているものしか読まないため） */
function closedByMilestone(closedIssues: GitHubIssue[]) {
  const groups = new Map<number, { ms: NonNullable<GitHubIssue["milestone"]>; closed: GitHubIssue[] }>();
  for (const i of closedIssues) {
    if (!i.milestone) continue;
    const g = groups.get(i.milestone.number) ?? { ms: i.milestone, closed: [] };
    g.closed.push(i);
    groups.set(i.milestone.number, g);
  }
  return groups;
}

/** 終わったマイルストーン（閉じた・期限を過ぎた・閉じた Issue があって開いている Issue がない）の番号 */
export function finishedMilestones(openIssues: GitHubIssue[], closedIssues: GitHubIssue[], today: Date = new Date()): Set<number> {
  const todayDay = dayOfTime(today);
  const openByMs = new Set(openIssues.map((i) => i.milestone?.number).filter((n): n is number => n !== undefined));
  const done = new Set<number>();
  for (const { ms } of closedByMilestone(closedIssues).values()) {
    const due = ms.due_on ? dayOfIso(ms.due_on) : null;
    if (ms.state === "closed" || (due !== null && due < todayDay) || !openByMs.has(ms.number)) done.add(ms.number);
  }
  return done;
}

/**
 * 終わったマイルストーンごとの、終えた量。古い順に最後の limit 個。
 * 見積もりで数えるときは、見積もりを 1 つも付けていないマイルストーンは外す（量が比べられないため）
 */
export function velocity(
  openIssues: GitHubIssue[],
  closedIssues: GitHubIssue[],
  mode: PaceMode,
  unit: EstimateUnit,
  today: Date = new Date(),
  limit = 5,
): VelocityEntry[] {
  const finished = finishedMilestones(openIssues, closedIssues, today);
  const entries: VelocityEntry[] = [];
  for (const { ms, closed } of closedByMilestone(closedIssues).values()) {
    if (!finished.has(ms.number)) continue;
    if (mode === "estimate" && closed.every((i) => weightOf(i, mode, unit) === 0)) continue;
    const lastClosed = closed.reduce((max, i) => (i.closed_at && i.closed_at > max ? i.closed_at : max), "");
    const date = ms.due_on ? ms.due_on.substring(0, 10) : lastClosed ? dateOfDay(dayOfIso(lastClosed)) : "";
    entries.push({
      number: ms.number,
      title: ms.title,
      done: closed.reduce((sum, i) => sum + weightOf(i, mode, unit), 0),
      closedCount: closed.length,
      date,
    });
  }
  return entries.sort((a, b) => a.date.localeCompare(b.date) || a.number - b.number).slice(-limit);
}

/** 平均（なければ null） */
export function average(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

/** 真ん中の値（なければ null） */
export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** 作ってから閉じるまでの日数（リードタイム） */
export function leadDays(issue: GitHubIssue): number | null {
  return issue.closed_at ? dayOfIso(issue.closed_at) - dayOfIso(issue.created_at) : null;
}

/** 進んでいることを表すラベル。これを最初に付けた日から閉じるまでを、サイクルタイムとする */
export const IN_PROGRESS_LABEL = "状態:進行中";

/** 変更の履歴から、「進行中」を最初に付けた時刻（なければ null） */
export function startedAt(events: TimelineEvent[]): string | null {
  const hit = events.find((e) => e.event === "labeled" && e.label?.name === IN_PROGRESS_LABEL && e.created_at);
  return hit?.created_at ?? null;
}

/** 手を付けて（進行中にして）から閉じるまでの日数 */
export function cycleDays(closedAt: string, started: string): number {
  return Math.max(0, dayOfIso(closedAt) - dayOfIso(started));
}

/** 日数の分け方（サイクルタイムの分布） */
export const FLOW_BUCKETS: { label: string; max: number }[] = [
  { label: "1 日以内", max: 1 },
  { label: "2〜3 日", max: 3 },
  { label: "4〜7 日", max: 7 },
  { label: "8 日以上", max: Number.POSITIVE_INFINITY },
];

export function bucketize(values: number[]): number[] {
  return FLOW_BUCKETS.map((b, i) => values.filter((v) => v <= b.max && (i === 0 || v > FLOW_BUCKETS[i - 1].max)).length);
}
