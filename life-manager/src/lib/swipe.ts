// ブランチの画面を、マウスで横に引いて移る（#258）。どれだけ引いたら、となりへ移るか

/** これより動かなければ「押しただけ」（引かない。離したあとの click も止めない）。ピクセル */
export const CLICK_SLOP = 5;

/** 押してからの動き（dx・dy）が、引いたことになるか */
export function movedEnough(dx: number, dy = 0): boolean {
  return Math.hypot(dx, dy) > CLICK_SLOP;
}

/** 引いた量 dx（右へ引くと正）から、移る向き（-1: 前のブランチ・+1: 次のブランチ・0: 元のページへ戻す）。
 *  ページの幅の 4 分の 1 より動いたら移る */
export function decideSwipe(dx: number, pageWidth: number): -1 | 0 | 1 {
  if (pageWidth <= 0) return 0;
  if (dx <= -pageWidth / 4) return 1;
  if (dx >= pageWidth / 4) return -1;
  return 0;
}
