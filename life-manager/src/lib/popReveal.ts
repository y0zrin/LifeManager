// 開いたとき、見えているところの下（古いもの）から上（新しいもの）へ「ぽこぽこ」出す（#293）。
// 全体図・ブランチの履歴・ヒストリーで使う。順番と速さを決める（動きそのものは App.css。1 回きりの動きなので、ブラウザのまま動く）

/** 全体でかける長さの目安（ミリ秒） */
export const POP_TOTAL = 1100;
/** 1 つずつの間（ミリ秒）の上と下。少ないときはゆっくり、多いときは詰める */
export const POP_STEP_MAX = 90;
export const POP_STEP_MIN = 28;
/** 1 つが出る動き（はずむ）の長さ。App.css の pop-bounce・o-pop と同じ */
export const POP_DURATION = 420;

/** count 個を順に出すときの、1 つずつの間 */
export function popStep(count: number): number {
  if (count <= 1) return 0;
  return Math.min(POP_STEP_MAX, Math.max(POP_STEP_MIN, POP_TOTAL / (count - 1)));
}

/** 上から row 番目の行の、下からの順（見えている行は first〜last）。見えていない行は -1（動かさない） */
export function popRank(row: number, first: number, last: number): number {
  return row < first || row > last ? -1 : last - row;
}

/**
 * 線（上の行 from から下の行 to まで）を伸ばす時刻。下の点が出たときに伸びはじめ、上の点が出るときに伸びきる。
 * 下の点が見えていない（下へはみ出す）線は、はじめから伸びはじめる。上の点が見えていない（上へはみ出す）線は、いちばん上が出るときまで伸びる。
 * どちらも見えていない線は null（動かさない）
 */
export function edgeReveal(from: number, to: number, first: number, last: number, step: number): { delay: number; duration: number } | null {
  if (to < first || from > last) return null;
  const top = from < first ? last - first : last - from;
  const bottom = to > last ? -1 : last - to;
  const delay = bottom < 0 ? 0 : bottom * step;
  return { delay, duration: Math.max(step, top * step - delay) };
}

/**
 * 一覧の画面用（ブランチの履歴・ヒストリー）: 見えている items に、下から順に --pop-delay と pop-in を付ける。
 * 終わるまでの長さ（ミリ秒）を返す。見えているものがなければ 0。終わったら clearPop で外す
 */
export function revealList(box: HTMLElement, items: HTMLElement[]): number {
  const view = box.getBoundingClientRect();
  const top = Math.max(view.top, 0);
  const bottom = Math.min(view.bottom, window.innerHeight);
  const shown = items.filter((el) => {
    const r = el.getBoundingClientRect();
    return r.height > 0 && r.bottom > top && r.top < bottom;
  });
  const step = popStep(shown.length);
  shown.reverse().forEach((el, i) => {
    el.style.setProperty("--pop-delay", `${Math.round(i * step)}ms`);
    el.classList.add("pop-in");
  });
  return shown.length ? Math.round((shown.length - 1) * step) + POP_DURATION : 0;
}

/** revealList で付けたものを外す */
export function clearPop(items: Iterable<Element>) {
  for (const el of items) {
    el.classList.remove("pop-in");
    (el as HTMLElement).style.removeProperty("--pop-delay");
  }
}
