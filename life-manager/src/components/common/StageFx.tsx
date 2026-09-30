/**
 * 舞台: 画面の後ろに固定した層（テーマの光と、動く粒 3 枚。チョークの粉・金の粒・星・日ざし・花びら・雪 など）。
 * 見た目と動きは App.css の .stage-fx（テーマごと）。止めるのは html.stage-still（設定 → 表示 の「背景の動き」）
 */
export function StageFx() {
  return (
    <div className="stage-fx" aria-hidden="true">
      <i />
      <i />
      <i />
    </div>
  );
}
