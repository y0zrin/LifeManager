// ガントの帯を、どれだけ動かしたら引きはじめるか（#290）

/** 日程のある帯。ピクセル */
export const BAR_DRAG_SLOP = 3;

/** 仮の帯（見積もりから置いた点線の帯）。押しただけで日程が書き込まれないよう、大きくする（「月」の目盛りの 1 日は 4 ピクセル） */
export const TENTATIVE_DRAG_SLOP = 10;

/** 押してから横に dx 動いたとき、帯を引きはじめるか */
export function startsBarDrag(dx: number, tentative: boolean): boolean {
  return Math.abs(dx) > (tentative ? TENTATIVE_DRAG_SLOP : BAR_DRAG_SLOP);
}
