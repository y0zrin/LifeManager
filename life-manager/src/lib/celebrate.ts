// お祝い（完了したとき・新しく入ったとき）。画面のどこから呼んでも、いちばん上の重ね（Celebration）が
// キラキラ・スタンプ・完了の知らせを出す

export type CelebrateDetail =
  /** 完了した（label は「#45」や「3 件」。origin は押したところ。なければ知らせのそば。text があれば「〜を完了しました」の代わりに出す） */
  | { kind: "done"; label: string; origin?: { x: number; y: number }; text?: string }
  /** 新しく入った（メモなど）。そこから少しキラキラ */
  | { kind: "new"; origin: { x: number; y: number } };

export const CELEBRATE_EVENT = "lm-celebrate";

function centerOf(from: Element | DOMRect | null | undefined): { x: number; y: number } | undefined {
  if (!from) return undefined;
  const r = from instanceof Element ? from.getBoundingClientRect() : from;
  if (r.width === 0 && r.height === 0) return undefined;
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** 完了のお祝い（キラキラ・スタンプ・下に完了の知らせ）。text は知らせの文（「#12 をマージしました」など。なければ「#45 を完了しました」） */
export function celebrateDone(label: string, from?: Element | DOMRect | null, text?: string) {
  window.dispatchEvent(new CustomEvent<CelebrateDetail>(CELEBRATE_EVENT, { detail: { kind: "done", label, origin: centerOf(from), text } }));
}

/** 新しく入ったもののキラキラ */
export function sparkleNew(el: Element | null) {
  const origin = centerOf(el);
  if (!origin) return;
  window.dispatchEvent(new CustomEvent<CelebrateDetail>(CELEBRATE_EVENT, { detail: { kind: "new", origin } }));
}
