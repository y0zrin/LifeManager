// 全体図のブランチの名前のうち、枠に入りきらないものを流し続ける（#292）。流し方の長さを決める

/** 流れる速さ（ピクセル／秒） */
export const FLOW_SPEED = 30;
/** 1 回のうち、流れているあいだの割合（頭で 15%・流れる 60%・終わりで 15%・戻る 10%。App.css の lh-flow と同じ） */
export const FLOW_SHARE = 0.6;
/** 1 回の長さの下限（秒）。はみ出しが少ない名前も、頭と終わりで止まるあいだを取る */
export const FLOW_MIN_CYCLE = 5;
/** 終わりまで流したとき、右の端の薄くしたところから名前の終わりを出す分（ピクセル） */
export const FLOW_TAIL = 10;

/** はみ出した長さ（ピクセル）から、ずらす長さ（左へ。負の数）と 1 回の長さ（秒）。はみ出していなければ null（流さない） */
export function flowTiming(overflow: number): { shift: number; duration: number } | null {
  if (!(overflow > 1)) return null;
  const shift = Math.ceil(overflow) + FLOW_TAIL;
  return { shift: -shift, duration: Math.max(FLOW_MIN_CYCLE, shift / FLOW_SPEED / FLOW_SHARE) };
}
