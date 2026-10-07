// ガントを開いたとき・マイルストーンを切り替えたときに、帯を日付の早い順に、左から右へ伸ばして出す（#215）。
// 1 回きりの動きなので requestAnimationFrame で動かす（くり返しの動きは lib/idle.ts の時計、の決まりには当たらない）
import type { GanttTask } from "./ganttTypes";

/** 全部の帯が出そろうまで（ミリ秒）。帯が多くても、これを大きくこえない */
const TOTAL_MS = 1000;
/** 1 本の帯が伸びきるまで（ミリ秒） */
const GROW_MS = 400;
/** となりの帯が伸び始めるまでの間の、いちばん長いもの（帯が少ないとき） */
const MAX_GAP_MS = 60;

export interface RevealPlan {
  /** 帯の順位（Issue の番号 → 0, 1, …。日付の早い順） */
  rank: Map<number, number>;
  /** となりの帯が伸び始めるまでの間（ミリ秒） */
  gap: number;
  /** 1 本の帯が伸びきるまで（ミリ秒） */
  grow: number;
  /** 全部の帯が伸びきるまで（ミリ秒） */
  total: number;
}

/** 帯の順位と速さを決める。日程のない帯は順位を持たない（伸ばさない） */
export function revealPlan(tasks: GanttTask[]): RevealPlan {
  const dated = tasks
    .filter((t) => t.startDate && t.endDate)
    .sort((a, b) => a.startDate!.localeCompare(b.startDate!) || a.endDate!.localeCompare(b.endDate!) || a.issueNumber - b.issueNumber);
  const rank = new Map(dated.map((t, i) => [t.issueNumber, i]));
  const n = dated.length;
  const gap = n > 1 ? Math.min(MAX_GAP_MS, (TOTAL_MS - GROW_MS) / (n - 1)) : 0;
  return { rank, gap, grow: GROW_MS, total: GROW_MS + gap * Math.max(0, n - 1) };
}

/** 始めてから t ミリ秒のとき、その帯がどこまで伸びているか（0〜1。終わりはゆっくり）。順位のない帯は 1 */
export function revealFraction(plan: RevealPlan, issueNumber: number, t: number): number {
  const r = plan.rank.get(issueNumber);
  if (r === undefined) return 1;
  const x = (t - r * plan.gap) / plan.grow;
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return 1 - (1 - x) ** 3;
}

/** 矢印を出してよいか（全部の帯が出そろってから） */
export function arrowsVisible(plan: RevealPlan, t: number): boolean {
  return t >= plan.total;
}
