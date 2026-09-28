import type { GitHubIssue } from "../../lib/types";
import { estimateOf, type EstimateSum } from "../../lib/estimate";

/** カードの「📏 3」の印（見積もり。ラベル「見積:3」の代わりに出す） */
export function EstimateChip({ issue, plain = false }: { issue: GitHubIssue; plain?: boolean }) {
  const e = estimateOf(issue);
  if (e === null) return plain ? <span className="tt-muted">—</span> : null;
  return (
    <span className="est-chip" title={`見積もり ${e}（タスクの大きさ）`}>
      {plain ? e : `📏 ${e}`}
    </span>
  );
}

/** まとまり・列・一覧の「見積 8」。見積もりが 1 件もなければ出さない。見積もりのないものがあれば件数を添える */
export function EstimateSumText({ sum, showMissing = true }: { sum: EstimateSum; showMissing?: boolean }) {
  if (sum.counted === 0) return null;
  return (
    <span className="est-sum" title={`見積もりのある ${sum.counted} 件の合計`}>
      見積 {sum.total}
      {showMissing && sum.missing > 0 && <span className="est-sum-missing">（見積もりなし {sum.missing} 件）</span>}
    </span>
  );
}
