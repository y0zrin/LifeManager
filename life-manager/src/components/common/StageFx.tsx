import type { CSSProperties } from "react";

/**
 * ナイトの、十字に光る星（場所は画面の割合・一回りの秒・ずらし・大きさ）。サイドバーと中身の面の外（左右の余白・上下）に多めに置く。
 * ほかのテーマでは出さない（App.css）
 */
const GLINTS: { x: number; y: number; t: number; d: number; s: number }[] = [
  { x: 22, y: 18, t: 7.2, d: 0, s: 1 },
  { x: 91, y: 12, t: 8.4, d: -2.1, s: 1.25 },
  { x: 96, y: 46, t: 6.6, d: -4.3, s: 0.9 },
  { x: 18, y: 58, t: 9.1, d: -1.2, s: 1.1 },
  { x: 88, y: 78, t: 7.7, d: -5.6, s: 1 },
  { x: 24, y: 90, t: 8.8, d: -3.4, s: 0.85 },
  { x: 60, y: 6, t: 6.9, d: -6.1, s: 0.8 },
  { x: 78, y: 30, t: 9.6, d: -7.3, s: 0.95 },
  { x: 40, y: 96, t: 7.4, d: -2.8, s: 0.9 },
  { x: 97, y: 88, t: 8.1, d: -0.6, s: 1.15 },
];

/**
 * 舞台: 画面の後ろに固定した層（テーマの光と、動く粒 3 枚。チョークの粉・金の粒・星・日ざし・花びら・雪 など）。
 * ナイトでは、十字に光る星と流れ星も出す。見た目と動きは App.css の .stage-fx（テーマごと）。止めるのは html.stage-still（設定 → 表示 の「背景の動き」）
 */
export function StageFx() {
  return (
    <div className="stage-fx" aria-hidden="true">
      <i />
      <i />
      <i />
      <em className="fx-shoot" />
      {GLINTS.map((g, n) => (
        <b key={n} style={{ "--x": `${g.x}%`, "--y": `${g.y}%`, "--t": `${g.t}s`, "--d": `${g.d}s`, "--s": g.s } as CSSProperties} />
      ))}
    </div>
  );
}
