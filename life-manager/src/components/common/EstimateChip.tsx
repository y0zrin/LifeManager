import { createContext, useContext, useState } from "react";
import type { GitHubIssue } from "../../lib/types";
import { isEnter } from "../../lib/keys";
import {
  DEFAULT_UNIT, UNITS, estimateOf, formatEstimate,
  type Estimate, type EstimateSum, type EstimateUnit,
} from "../../lib/estimate";

/** リポジトリの見積もりの単位（App が config/estimate.yaml から読んで渡す） */
export const EstimateUnitContext = createContext<EstimateUnit>(DEFAULT_UNIT);

export function useEstimateUnit(): EstimateUnit {
  return useContext(EstimateUnitContext);
}

/** カードの「📏 3pt」の印（ラベル「見積:3pt」の代わりに出す）。plain なら「3pt」だけ（表の列） */
export function EstimateChip({ issue, plain = false }: { issue: GitHubIssue; plain?: boolean }) {
  const e = estimateOf(issue);
  if (!e) return plain ? <span className="tt-muted">—</span> : null;
  const text = formatEstimate(e.value, e.unit);
  return (
    <span className="est-chip" title={`見積もり ${text}`}>
      {plain ? text : `📏 ${text}`}
    </span>
  );
}

/** まとまり・列・一覧の「見積 8pt」。数えたものが 1 件もなければ出さない */
export function EstimateSumText({ sum, showMissing = true }: { sum: EstimateSum; showMissing?: boolean }) {
  if (sum.counted === 0 && sum.other === 0) return null;
  return (
    <span className="est-sum" title={`見積もりのある ${sum.counted} 件の合計（${UNITS[sum.unit].name}）`}>
      {sum.counted > 0 && <>見積 {formatEstimate(sum.total, sum.unit)}</>}
      {sum.counted > 0 && showMissing && sum.missing > 0 && <span className="est-sum-missing">（見積もりなし {sum.missing} 件）</span>}
      {sum.other > 0 && (
        <span className="est-sum-missing" title={`ポイントと時間の単位は換算できないので、今の単位（${UNITS[sum.unit].name}）の合計に入れていません`}>
          （単位の違う見積もり {sum.other} 件は数えていません）
        </span>
      )}
    </span>
  );
}

/**
 * 見積もりを選ぶボタンの並び（今の単位の数と「なし」）。other なら、ほかの数も打って付けられる。
 * 別の単位で付いている見積もりは、ボタンではなく横に小さく出す
 */
export function EstimatePicker({
  value,
  onChange,
  other = false,
  showGuide = true,
}: {
  value: Estimate | null;
  onChange: (value: number | null) => void;
  other?: boolean;
  showGuide?: boolean;
}) {
  const unit = useEstimateUnit();
  const spec = UNITS[unit];
  const [typed, setTyped] = useState("");
  const current = value && value.unit === unit ? value.value : null;
  const inList = current !== null && spec.values.includes(current);

  function submitTyped() {
    const v = Number(typed);
    if (!Number.isFinite(v) || v <= 0) return;
    onChange(v);
    setTyped("");
  }

  return (
    <>
      <span className="est-picker" role="group" aria-label={`見積もり（${spec.name}）`}>
        {spec.values.map((v) => (
          <button key={v} type="button" className={current === v ? "on" : ""} aria-pressed={current === v}
            title={spec.valueGuide?.[v] ?? formatEstimate(v, unit)}
            onClick={() => { if (current !== v) onChange(v); }}>
            {formatEstimate(v, unit)}
          </button>
        ))}
        <button type="button" disabled={value === null} onClick={() => onChange(null)}>
          なし
        </button>
      </span>
      {value && !inList && <span className="est-chip" title="今の見積もり">{formatEstimate(value.value, value.unit)}</span>}
      {other && (
        <input
          className="est-other"
          type="number"
          min="0"
          step="any"
          value={typed}
          placeholder="ほかの数"
          aria-label={`ほかの数（${spec.suffix}）`}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => { if (isEnter(e)) submitTyped(); }}
          onBlur={submitTyped}
        />
      )}
      {showGuide && <div className="est-guide">{spec.guide}</div>}
    </>
  );
}
