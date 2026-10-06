// マイルストーンの画面（ステージセレクト）: マイルストーンを時間の順に並べた「ステージ」と、その残り・星・前に見たときの量
import type { GitHubIssue, GitHubMilestone, GitHubUser } from "./types";
import { dayOfDate, dayOfIso, dayOfTime, sprintRange, weightOf, type PaceMode, type SprintRange } from "./sprint";
import { formatEstimate, formatNumber, type EstimateUnit } from "./estimate";
import type { MilestoneClearDetail } from "./celebrate";
import { tr } from "./i18n";

/** 進み具合のバー。達成率（のびる）か HP（ボスの残りの体力。減る）か。auto はテーマに合わせる（クエストは HP） */
export type MilestoneBar = "auto" | "progress" | "hp";

export const MILESTONE_BARS: MilestoneBar[] = ["auto", "progress", "hp"];

export interface Stage {
  ms: GitHubMilestone;
  /** 時間の順の番号（1 から） */
  no: number;
  /** GitHub で閉じた */
  closed: boolean;
  open: GitHubIssue[];
  done: GitHubIssue[];
  /** 数え方（見積もりで数える画面でも、見積もりが 1 つもないマイルストーンは件数で） */
  measure: PaceMode;
  /** 残り（まだ閉じていない分）と全部 */
  remaining: number;
  total: number;
  /** いちばん先のマイルストーン（ゴール・最後のボス） */
  last: boolean;
  /** 終えた（閉じた、または開いているタスクがなく、終えたタスクがある） */
  cleared: boolean;
  /** 終えたときの星（期限までに全部 = 3、全部だが期限すぎ = 2、残して閉じた = 1。終えていなければ 0） */
  stars: number;
  range: SprintRange;
}

/** 並べる時（期限、なければ閉じた時・作った時。どれもなければ最後） */
function sortKey(ms: GitHubMilestone): string {
  return ms.due_on ?? ms.closed_at ?? ms.created_at ?? "9999-12-31";
}

/**
 * ステージの一覧（時間の順）。開いているマイルストーンは一覧から、閉じたものは Issue に付いているものから
 * （マイルストーンの一覧は開いているものしか読まないため）
 */
export function buildStages(milestones: GitHubMilestone[], issues: GitHubIssue[], closedIssues: GitHubIssue[], mode: PaceMode, unit: EstimateUnit): Stage[] {
  const all = new Map<number, GitHubMilestone>();
  for (const m of milestones) all.set(m.number, m);
  for (const i of [...closedIssues, ...issues]) {
    // 開いている一覧にないマイルストーンは、閉じたもの
    if (i.milestone && !all.has(i.milestone.number)) all.set(i.milestone.number, { ...i.milestone, state: "closed" });
  }
  const sorted = [...all.values()].sort((a, b) => sortKey(a).localeCompare(sortKey(b)) || a.number - b.number);
  return sorted.map((ms, index) => {
    const open = issues.filter((i) => i.milestone?.number === ms.number);
    const done = closedIssues.filter((i) => i.milestone?.number === ms.number);
    const sum = (list: GitHubIssue[], m: PaceMode) => list.reduce((s, i) => s + weightOf(i, m, unit), 0);
    const measure: PaceMode = mode === "estimate" && sum([...open, ...done], "estimate") > 0 ? "estimate" : "count";
    const remaining = sum(open, measure);
    const total = remaining + sum(done, measure);
    const closed = ms.state === "closed";
    const cleared = closed || (open.length === 0 && done.length > 0);
    return {
      ms,
      no: index + 1,
      closed,
      open,
      done,
      measure,
      remaining,
      total,
      last: index === sorted.length - 1 && sorted.length >= 2 && !closed,
      cleared,
      stars: cleared ? starsOf(ms, open, done) : 0,
      range: sprintRange(ms),
    };
  });
}

function starsOf(ms: GitHubMilestone, open: GitHubIssue[], done: GitHubIssue[]): number {
  if (open.length > 0) return 1;
  const finished = ms.closed_at ?? done.reduce((max, i) => (i.closed_at && i.closed_at > max ? i.closed_at : max), "");
  const onTime = !ms.due_on || !finished || dayOfIso(finished) <= dayOfIso(ms.due_on);
  return onTime ? 3 : 2;
}

/** はじめに選ぶステージ: 今日が期間に入っている → 期限がこれからの、いちばん近いもの → 開いているもの → いちばん後ろ */
export function defaultStage(stages: Stage[], today: Date = new Date()): number {
  const day = dayOfTime(today);
  const active = stages.filter((s) => !s.closed);
  const inRange = active.find((s) => s.range.start && s.range.end && dayOfDate(s.range.start) <= day && day <= dayOfDate(s.range.end));
  const upcoming = active.find((s) => s.range.end && dayOfDate(s.range.end) >= day);
  const pick = inRange ?? upcoming ?? active[0] ?? stages[stages.length - 1];
  return pick ? stages.indexOf(pick) : 0;
}

/** 量の書き方（見積もり: 「10pt」、件数: 「3 件」） */
export function formatAmount(v: number, measure: PaceMode, unit: EstimateUnit): string {
  const rounded = Math.round(v * 10) / 10;
  return measure === "count" ? tr("{formatNumber} 件", { formatNumber: formatNumber(rounded) }) : formatEstimate(rounded, unit);
}

/** 期限までの日数（「あと 7 日」「今日まで」「3 日すぎ」。閉じたものと期限のないものは null） */
export function daysLeftText(stage: Stage, today: Date = new Date()): string | null {
  if (stage.closed || !stage.ms.due_on) return null;
  const left = dayOfIso(stage.ms.due_on) - dayOfTime(today);
  if (left > 0) return tr("あと {left} 日", { left });
  return left === 0 ? tr("今日まで") : tr("{v} 日すぎ", { v: -left });
}

/** ステージにかかわった人（担当。5 人まで） */
export function stageTeam(stage: Pick<Stage, "open" | "done">, limit = 5): GitHubUser[] {
  const seen = new Map<string, GitHubUser>();
  for (const i of [...stage.open, ...stage.done]) for (const a of i.assignees ?? []) if (!seen.has(a.login)) seen.set(a.login, a);
  return [...seen.values()].slice(0, limit);
}

// --- 前に見たときの量（ふと見たときに、前と比べて減った分を見せる。この PC だけ） ---

export interface Seen {
  remaining: number;
  total: number;
}

const SEEN_STORE = "milestone-seen";

function readSeenAll(): Record<string, Seen> {
  try {
    const v = JSON.parse(localStorage.getItem(SEEN_STORE) ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

/** key は「owner/repo#番号#数え方」 */
export function readSeen(key: string): Seen | null {
  const v = readSeenAll()[key];
  return v && typeof v.remaining === "number" && typeof v.total === "number" ? v : null;
}

export function writeSeen(key: string, seen: Seen) {
  try {
    const all = readSeenAll();
    all[key] = seen;
    localStorage.setItem(SEEN_STORE, JSON.stringify(all));
  } catch {
    // 覚えられなくても、次は前と比べずに出すだけ
  }
}

// --- 達成のお祝い（同じマイルストーンで 1 回だけ。この PC だけ） ---

const CLEARED_STORE = "milestone-celebrated";

export function wasCelebrated(repoKey: string, n: number): boolean {
  try {
    return (JSON.parse(localStorage.getItem(CLEARED_STORE) ?? "{}")[repoKey] ?? []).includes(n);
  } catch {
    return false;
  }
}

export function markCelebrated(repoKey: string, n: number) {
  try {
    const all = JSON.parse(localStorage.getItem(CLEARED_STORE) ?? "{}");
    all[repoKey] = [...new Set([...(all[repoKey] ?? []), n])];
    localStorage.setItem(CLEARED_STORE, JSON.stringify(all));
  } catch {
    // 覚えられなくても、もう一度出るだけ
  }
}

/** 達成のお祝いに出すもの（終えたタスクの数・見積もり・期限まで何日残したか・かかわった人） */
export function clearDetailOf(stage: Stage, repoKey: string, unit: EstimateUnit, canClose: boolean, today: Date = new Date()): MilestoneClearDetail {
  const leftDays = stage.ms.due_on ? dayOfIso(stage.ms.due_on) - dayOfTime(today) : null;
  return {
    repoKey,
    number: stage.ms.number,
    title: stage.ms.title,
    no: stage.no,
    last: stage.last,
    doneCount: stage.done.length,
    amount: stage.measure === "estimate" ? formatAmount(stage.total, "estimate", unit) : null,
    leftDays,
    team: stageTeam(stage).map((u) => ({ login: u.login, avatar_url: u.avatar_url })),
    canClose,
  };
}
