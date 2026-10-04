import { createContext, useContext, useState } from "react";
import type { GitHubIssue } from "../../lib/types";
import { isEnter } from "../../lib/keys";
import {
  DEFAULT_UNIT, UNITS, estimateOf, formatEstimate,
  type Estimate, type EstimateSum, type EstimateUnit,
} from "../../lib/estimate";
import { tr, trx } from "../../lib/i18n";

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
    <span className="est-chip" title={tr("見積もり {text}", { text })}>
      {plain ? text : `📏 ${text}`}
    </span>
  );
}

/** まとまり・列・一覧の「見積 8pt」。数えたものが 1 件もなければ出さない */
export function EstimateSumText({ sum, showMissing = true }: { sum: EstimateSum; showMissing?: boolean }) {
  if (sum.counted === 0 && sum.other === 0) return null;
  return (
    <span className="est-sum" title={tr("見積もりのある {counted} 件の合計（{name}）", { counted: sum.counted, name: UNITS[sum.unit].name })}>
      {sum.counted > 0 && <>{trx("見積 {formatEstimate}", { formatEstimate: formatEstimate(sum.total, sum.unit) })}</>}
      {sum.counted > 0 && showMissing && sum.missing > 0 && <span className="est-sum-missing">{trx("（見積もりなし {missing} 件）", { missing: sum.missing })}</span>}
      {sum.other > 0 && (
        <span className="est-sum-missing" title={tr("ポイントと時間の単位は換算できないので、今の単位（{name}）の合計に入れていません", { name: UNITS[sum.unit].name })}>
          {trx("（単位の違う見積もり {other} 件は数えていません）", { other: sum.other })}
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
      <span className="est-picker" role="group" aria-label={tr("見積もり（{name}）", { name: spec.name })}>
        {spec.values.map((v) => (
          <button key={v} type="button" className={current === v ? "on" : ""} aria-pressed={current === v}
            title={spec.valueGuide?.[v] ?? formatEstimate(v, unit)}
            onClick={() => { if (current !== v) onChange(v); }}>
            {formatEstimate(v, unit)}
          </button>
        ))}
        <button type="button" disabled={value === null} onClick={() => onChange(null)}>
          {tr("なし")}
        </button>
      </span>
      {value && !inList && <span className="est-chip" title={tr("今の見積もり")}>{formatEstimate(value.value, value.unit)}</span>}
      {other && (
        <input
          className="est-other"
          type="number"
          min="0"
          step="any"
          value={typed}
          placeholder={tr("ほかの数")}
          aria-label={tr("ほかの数（{suffix}）", { suffix: spec.suffix })}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => { if (isEnter(e)) submitTyped(); }}
          onBlur={submitTyped}
        />
      )}
      {showGuide && <div className="est-guide">{spec.guide}</div>}
    </>
  );
}
