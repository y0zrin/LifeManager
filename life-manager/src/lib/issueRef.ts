// Issue の番号の見せ方。
// オフラインのあいだに作った Issue は、まだ GitHub の番号がないので仮の番号（負の数）を持つ。
// つながって GitHub に作られたら、本当の番号に置き換わる

/** まだ GitHub に作っていない Issue（仮の番号）か */
export function isTemporary(n: number): boolean {
  return n < 0;
}

/** 送っているあいだ（GitHub から返事が来るまで）の Issue の番号。オフラインの仮の番号（-1, -2 …）とぶつからないよう、ずっと小さい数 */
const SENDING_BASE = -1_000_000;
let sendingSeq = 0;

export function nextSendingNumber(): number {
  sendingSeq += 1;
  return SENDING_BASE - sendingSeq;
}

/** 送っているあいだの Issue か（まだ番号がない） */
export function isSending(n: number): boolean {
  return n <= SENDING_BASE;
}

/** 「#12」、仮の番号なら「仮1」、送っているあいだは「#—」 */
export function issueRef(n: number): string {
  if (isSending(n)) return "#—";
  return isTemporary(n) ? `仮${-n}` : `#${n}`;
}
