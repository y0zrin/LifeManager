// ヒストリーの「チームの仕事」: これまでの合計（減らない数）と、前に見た数・届いた節目（この PC に覚える）
import { invoke } from "./invoke";
import { tr } from "./i18n";

export interface TeamTotals {
  /** 既定のブランチのコミット */
  commits: number | null;
  /** 終えたタスク（閉じた Issue） */
  done: number | null;
  /** マージしたプルリク */
  merged: number | null;
  /** コメント（Issue とプルリクの会話） */
  comments: number | null;
  releases: number | null;
}

export const teamTotals = (owner: string, repo: string) => invoke<TeamTotals>("team_totals", { owner, repo });

export const TEAM_PARTS: { key: keyof TeamTotals; icon: string; label: string }[] = [
  { key: "commits", icon: "⬆", label: tr("コミット") },
  { key: "done", icon: "✅", label: tr("終えたタスク") },
  { key: "merged", icon: "🔃", label: tr("マージしたプルリク") },
  { key: "comments", icon: "💬", label: tr("コメント") },
  { key: "releases", icon: "🏷", label: tr("リリース") },
];

/** 読めなかった数（null。問い合わせの 1 つが時間切れなど）は、前に見た数で埋める。一時的に読めなかっただけで、合計が減って見え、
 *  次に読めたときに「+400」「1,000 に届きました」とまちがえないように */
export function fillMissing(t: TeamTotals, before: TeamTotals | null | undefined): TeamTotals {
  const out = { ...t };
  for (const p of TEAM_PARTS) {
    if (out[p.key] === null && before && typeof before[p.key] === "number") out[p.key] = before[p.key];
  }
  return out;
}

export function sumTotals(t: TeamTotals): number {
  return TEAM_PARTS.reduce((sum, p) => sum + (t[p.key] ?? 0), 0);
}

/** 節目（ここに届いたときだけ、静かに光る） */
export const TEAM_STEPS = [10, 30, 50, 100, 200, 300, 500, 1000, 1500, 2000, 3000, 5000, 7500, 10000, 15000, 20000, 30000, 50000, 100000];

/** 今いる道（前の節目 → 次の節目） */
export function roadOf(total: number): { from: number; to: number } {
  const i = TEAM_STEPS.findIndex((s) => s > total);
  if (i < 0) return { from: TEAM_STEPS[TEAM_STEPS.length - 1], to: TEAM_STEPS[TEAM_STEPS.length - 1] * 2 };
  return { from: i === 0 ? 0 : TEAM_STEPS[i - 1], to: TEAM_STEPS[i] };
}

/** 前に見た数から今の数までのあいだに届いた節目（いちばん大きいもの） */
export function crossedStep(before: number, now: number): number | null {
  const hit = TEAM_STEPS.filter((s) => before < s && s <= now);
  return hit.length ? hit[hit.length - 1] : null;
}

export interface TeamSeen {
  total: number;
  /** 見た時（ISO） */
  at: string;
  parts: TeamTotals;
}

const SEEN_KEY = (repo: string) => `teamwork:${repo}`;

export function loadTeamSeen(repo: string): TeamSeen | null {
  try {
    const v = JSON.parse(localStorage.getItem(SEEN_KEY(repo)) ?? "null");
    return v && typeof v.total === "number" ? v : null;
  } catch {
    return null;
  }
}

export function saveTeamSeen(repo: string, seen: TeamSeen) {
  try {
    localStorage.setItem(SEEN_KEY(repo), JSON.stringify(seen));
  } catch {
    // 覚えられなければ、次は「+」を出さない
  }
}

/** 1,284 */
export const fmt = (n: number) => n.toLocaleString("ja-JP");
