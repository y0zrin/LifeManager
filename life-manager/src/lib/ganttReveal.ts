// ガントの帯が伸びて出る動き（#215）。帯が初めて画面に入ったときに、左から右へ伸ばす（#304）。
// 開いたとき・マイルストーンを切り替えたときは見えている帯を日付の早い順に、スクロールで入ってきた帯は入ってきたときに。
// 1 回きりの動きなので requestAnimationFrame で動かす（くり返しの動きは lib/idle.ts の時計、の決まりには当たらない）
import type { GanttTask } from "./ganttTypes";

/** いっしょに見えた帯が出そろうまで（ミリ秒）。帯が多くても、これを大きくこえない */
const TOTAL_MS = 1500;
/** 1 本の帯が伸びきるまで（ミリ秒）。短いと伸びるところが見えない（#301） */
export const REVEAL_GROW_MS = 600;
/** となりの帯が伸び始めるまでの間の、いちばん長いもの（帯が少ないとき） */
const MAX_GAP_MS = 90;

export interface RevealState {
  /** 画面を切り替える動きを待っているあいだ（帯を出さない。#301） */
  waiting: boolean;
  /** 見えた帯の、伸びはじめる時刻（Issue の番号 → performance.now() のミリ秒） */
  start: Map<number, number>;
}

/** 待っている形で作る */
export function newReveal(): RevealState {
  return { waiting: true, start: new Map() };
}

/** いっしょに見えた帯の、伸びはじめるまでの遅れ（Issue の番号 → ミリ秒）。日付の早い順に間をあける。日程のない帯は入れない */
export function revealDelays(tasks: GanttTask[]): Map<number, number> {
  const dated = tasks
    .filter((t) => t.startDate && t.endDate)
    .sort((a, b) => a.startDate!.localeCompare(b.startDate!) || a.endDate!.localeCompare(b.endDate!) || a.issueNumber - b.issueNumber);
  const n = dated.length;
  const gap = n > 1 ? Math.min(MAX_GAP_MS, (TOTAL_MS - REVEAL_GROW_MS) / (n - 1)) : 0;
  return new Map(dated.map((t, i) => [t.issueNumber, i * gap]));
}

/** 見えている帯のうち、まだ伸ばしていないものに、伸びはじめる時刻を付ける（state を書き換える）。付けたら true。待っているあいだは付けない */
export function revealSeen(state: RevealState, visible: GanttTask[], now: number): boolean {
  if (state.waiting) return false;
  const delays = revealDelays(visible.filter((t) => !state.start.has(t.issueNumber)));
  for (const [n, d] of delays) state.start.set(n, now + d);
  return delays.size > 0;
}

/** その帯がどこまで伸びているか（0〜1。終わりはゆっくり。出だしが速すぎると伸びるところが見えないので 2 次。#301）。
 *  待っているあいだは 0。まだ見えていない帯は 1（画面の外なので、描いても見えない） */
export function revealFraction(state: RevealState, issueNumber: number, now: number): number {
  if (state.waiting) return 0;
  const s = state.start.get(issueNumber);
  if (s === undefined) return 1;
  const x = (now - s) / REVEAL_GROW_MS;
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return 1 - (1 - x) ** 2;
}

/** 矢印を出してよいか（先行の帯が伸びきって、後続の帯が伸びはじめてから。矢印は先行の右の端から、後続の左の端へ向かうので） */
export function arrowShown(state: RevealState, pred: number, succ: number, now: number): boolean {
  return revealFraction(state, pred, now) >= 1 && revealFraction(state, succ, now) > 0;
}

/** 伸びている途中か、これから伸びる帯があるか（あるあいだだけ描き直しを続ける） */
export function revealBusy(state: RevealState, now: number): boolean {
  for (const s of state.start.values()) if (now < s + REVEAL_GROW_MS) return true;
  return false;
}
