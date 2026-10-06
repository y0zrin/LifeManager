// お祝い（完了したとき・新しく入ったとき）。画面のどこから呼んでも、いちばん上の重ね（Celebration）が
// キラキラ・スタンプ・完了の知らせを出す

export type CelebrateDetail =
  /** 完了した（label は「#45」や「3 件」。origin は押したところ。なければ知らせのそば。text があれば「〜を完了しました」の代わりに出す。
   *  undo があれば、知らせに「元に戻す」を出す） */
  | { kind: "done"; label: string; origin?: { x: number; y: number }; text?: string; undo?: () => void }
  /** 新しく入った（メモなど）。そこから少しキラキラ */
  | { kind: "new"; origin: { x: number; y: number } };

export const CELEBRATE_EVENT = "lm-celebrate";

function centerOf(from: Element | DOMRect | null | undefined): { x: number; y: number } | undefined {
  if (!from) return undefined;
  const r = from instanceof Element ? from.getBoundingClientRect() : from;
  if (r.width === 0 && r.height === 0) return undefined;
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/**
 * 完了のお祝い（キラキラ・スタンプ・下に完了の知らせ）。text は知らせの文（「#12 をマージしました」など。なければ「#45 を完了しました」）。
 * undo を渡すと、知らせに「元に戻す」が出る（#232）
 */
export function celebrateDone(label: string, from?: Element | DOMRect | null, text?: string, undo?: () => void) {
  window.dispatchEvent(new CustomEvent<CelebrateDetail>(CELEBRATE_EVENT, { detail: { kind: "done", label, origin: centerOf(from), text, undo } }));
}

/** 新しく入ったもののキラキラ */
export function sparkleNew(el: Element | null) {
  const origin = centerOf(el);
  if (!origin) return;
  window.dispatchEvent(new CustomEvent<CelebrateDetail>(CELEBRATE_EVENT, { detail: { kind: "new", origin } }));
}

// --- マイルストーンの達成（画面全体を暗くして、大きく祝う） ---

export interface MilestoneClearDetail {
  repoKey: string;
  number: number;
  title: string;
  /** 時間の順の番号（クエストのボスの絵）と、いちばん先のマイルストーンか（最後のボス） */
  no: number;
  last: boolean;
  /** 終えたタスクの数 */
  doneCount: number;
  /** 見積もりの合計（「23pt」。見積もりがなければ null） */
  amount: string | null;
  /** 期限まで何日残して終えたか（すぎたらマイナス。期限がなければ null） */
  leftDays: number | null;
  team: { login: string; avatar_url: string }[];
  /** まだ GitHub で閉じていない（「マイルストーンを閉じる」を出す） */
  canClose: boolean;
}

export const MILESTONE_CLEAR_EVENT = "lm-milestone-clear";

/** マイルストーンの達成のお祝い（いちばん上の重ね MilestoneCelebration が出す） */
export function celebrateMilestone(detail: MilestoneClearDetail) {
  window.dispatchEvent(new CustomEvent<MilestoneClearDetail>(MILESTONE_CLEAR_EVENT, { detail }));
}
