// Issue の番号の見せ方。
// オフラインのあいだに作った Issue は、まだ GitHub の番号がないので仮の番号（負の数）を持つ。
// つながって GitHub に作られたら、本当の番号に置き換わる

/** まだ GitHub に作っていない Issue（仮の番号）か */
export function isTemporary(n: number): boolean {
  return n < 0;
}

/** 「#12」、仮の番号なら「仮1」 */
export function issueRef(n: number): string {
  return isTemporary(n) ? `仮${-n}` : `#${n}`;
}
