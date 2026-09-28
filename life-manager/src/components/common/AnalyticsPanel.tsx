import { Fragment, useState } from "react";
import type { GitHubIssue } from "../../lib/types";
import { analyze, SOON_DAYS, WEEKS } from "../../lib/analytics";
import { dueOf } from "../../lib/due";
import { formatEstimate } from "../../lib/estimate";
import { issueRef } from "../../lib/issueRef";
import { EstimateSumText, useEstimateUnit } from "./EstimateChip";

/** たたんだかどうか（次に開いたときも同じ） */
const FOLD_STORE = "task-analytics";
/** 期限切れ・もうすぐの欄に並べる番号の数（それより多いと「ほか n 件」） */
const MAX_REFS = 4;
/** 担当ごとに並べる人数（それより多いと「ほか n 人」） */
const MAX_PEOPLE = 8;
/** 状態の色の数（App.css の --state-0〜7。ボードの列の順に使う） */
const STATE_COLORS = 8;

function loadFolded(): boolean {
  try {
    return localStorage.getItem(FOLD_STORE) === "folded";
  } catch {
    return false;
  }
}

/** YYYY-MM-DD → 「9/28」 */
function md(date: string): string {
  const [, m, d] = date.split("-").map(Number);
  return `${m}/${d}`;
}

const stateName = (key: string) => (key ? key.replace("状態:", "") : "状態なし");

interface AnalyticsPanelProps {
  /** 今の絞り込みに当てはまる Issue（開いている・閉じたの両方） */
  scope: GitHubIssue[];
  /** 今の絞り込みの説明（「マイルストーン:0.5.0／担当:y0zrin」）。絞り込んでいなければ空 */
  scopeText: string;
  /** 状態の順番（ボードの列の順）。色もこの順に決める */
  stateOrder: string[];
  onSelectIssue: (n: number) => void;
}

/**
 * タスク画面の一覧の上の「分析」。今の絞り込みの範囲で、開いている数と見積もり・期限切れ・もうすぐ・担当なし、
 * 状態ごとの割合、担当ごとの数、8 週の「作った数と閉じた数」を出す。たたむと数字の 1 行だけになる
 */
export function AnalyticsPanel({ scope, scopeText, stateOrder, onSelectIssue }: AnalyticsPanelProps) {
  const unit = useEstimateUnit();
  const [folded, setFolded] = useState(loadFolded);
  const a = analyze(scope, unit, stateOrder);

  function toggle() {
    const next = !folded;
    setFolded(next);
    try {
      localStorage.setItem(FOLD_STORE, next ? "folded" : "open");
    } catch {
      // 覚えられなくても、今は切り替わる
    }
  }

  // 状態の色は、ボードの列の順に決める（ラベルの色は同じ色のことがあり、見分けにくい）。列にない状態は、そのあとの色
  const extra = a.states.map((s) => s.key).filter((k) => k && !stateOrder.includes(k));
  const colorOf = (key: string) => {
    if (!key) return "var(--text-faint)";
    const i = stateOrder.indexOf(key);
    return `var(--state-${(i >= 0 ? i : stateOrder.length + extra.indexOf(key)) % STATE_COLORS})`;
  };

  const refs = (list: GitHubIssue[]) =>
    list.length === 0 ? (
      <span className="analytics-muted">なし</span>
    ) : (
      <>
        {list.slice(0, MAX_REFS).map((issue, k) => {
          const due = dueOf(issue);
          return (
            <Fragment key={issue.number}>
              {k > 0 && "・"}
              <button type="button" className="analytics-ref" onClick={() => onSelectIssue(issue.number)}
                title={`${issue.title}${due ? `（期限 ${md(due.date)}）` : ""}`}>
                {issueRef(issue.number)}
              </button>
            </Fragment>
          );
        })}
        {list.length > MAX_REFS && <span className="analytics-muted"> ほか {list.length - MAX_REFS} 件</span>}
      </>
    );

  const scopeLabel = scopeText ? `今の絞り込み（${scopeText}）` : "絞り込みなし（このリポジトリの全部）";
  const named = a.people.filter((p) => p.login !== null);
  const noOne = a.people.find((p) => p.login === null);
  const rest = named.slice(MAX_PEOPLE);
  const maxCount = Math.max(1, ...a.people.map((p) => p.count));
  const maxWeek = Math.max(0, ...a.weeks.flatMap((w) => [w.created, w.closed]));
  const createdSum = a.weeks.reduce((n, w) => n + w.created, 0);
  const closedSum = a.weeks.reduce((n, w) => n + w.closed, 0);
  const estimateOf = (sum: typeof a.openEstimate) =>
    sum.counted > 0 ? <span className="analytics-est">見積 {formatEstimate(sum.total, sum.unit)}</span> : null;

  return (
    <section className={`analytics${folded ? " analytics--folded" : ""}`} aria-label="分析">
      <div className="analytics-head">
        <b>📈 分析</b>
        <span className="analytics-scope" title="オープン・クローズの切り替えにかかわらず、開いている Issue を数えます（8 週の流れは閉じた Issue も入れます）">
          {scopeLabel}
        </span>
        {folded && (
          <span className="analytics-line">
            開いている <b>{a.open.length}</b>
            {a.openEstimate.counted > 0 && <>（{estimateOf(a.openEstimate)}）</>}
            ・期限切れ <b className={a.overdue.length ? "analytics-over" : ""}>{a.overdue.length}</b>
            ・{SOON_DAYS} 日以内 <b className={a.soon.length ? "analytics-soon" : ""}>{a.soon.length}</b>
            ・担当なし <b>{a.unassigned.length}</b>
          </span>
        )}
        <button type="button" className="analytics-toggle" aria-expanded={!folded} onClick={toggle}>
          {folded ? "ひらく ▾" : "たたむ ▴"}
        </button>
      </div>

      {!folded && (
        <>
          <div className="analytics-kpis">
            <div className="analytics-kpi">
              <div className="analytics-kpi-k">開いている</div>
              <div className="analytics-kpi-v">{a.open.length}</div>
              <div className="analytics-kpi-s"><EstimateSumText sum={a.openEstimate} /></div>
            </div>
            <div className={`analytics-kpi${a.overdue.length ? " analytics-kpi--over" : ""}`}>
              <div className="analytics-kpi-k">期限切れ</div>
              <div className="analytics-kpi-v">{a.overdue.length}</div>
              <div className="analytics-kpi-s">{refs(a.overdue)}</div>
            </div>
            <div className={`analytics-kpi${a.soon.length ? " analytics-kpi--soon" : ""}`}>
              <div className="analytics-kpi-k">{SOON_DAYS} 日以内</div>
              <div className="analytics-kpi-v">{a.soon.length}</div>
              <div className="analytics-kpi-s">{refs(a.soon)}</div>
            </div>
            <div className="analytics-kpi">
              <div className="analytics-kpi-k">担当なし</div>
              <div className="analytics-kpi-v">{a.unassigned.length}</div>
              <div className="analytics-kpi-s">{estimateOf(a.unassignedEstimate)}</div>
            </div>
          </div>

          <div className="analytics-charts">
            <div className="analytics-box">
              <h5>状態ごと（件数）</h5>
              {a.open.length === 0 ? (
                <p className="analytics-muted">開いている Issue はありません</p>
              ) : (
                <>
                  <div className="analytics-stack" role="img" aria-label={a.states.map((s) => `${stateName(s.key)} ${s.count} 件`).join("、")}>
                    {a.states.map((s) => (
                      <i key={s.key} style={{ width: `${(s.count / a.open.length) * 100}%`, background: colorOf(s.key) }}
                        title={`${stateName(s.key)} ${s.count} 件`} />
                    ))}
                  </div>
                  <div className="analytics-legend">
                    {a.states.map((s) => (
                      <span key={s.key}><i style={{ background: colorOf(s.key) }} />{stateName(s.key)} {s.count}</span>
                    ))}
                  </div>
                </>
              )}
              <h5>担当ごと（件数・見積もり）</h5>
              {a.people.length === 0 && <p className="analytics-muted">開いている Issue はありません</p>}
              {named.slice(0, MAX_PEOPLE).map((p) => (
                <div key={p.login} className="analytics-person">
                  <span className="analytics-name" title={p.login ?? ""}>{p.login}</span>
                  <div className="analytics-bar"><i style={{ width: `${(p.count / maxCount) * 100}%` }} /></div>
                  <span className="analytics-num">{p.count} 件 {estimateOf(p.estimate)}</span>
                </div>
              ))}
              {rest.length > 0 && (
                <div className="analytics-muted analytics-rest">ほか {rest.length} 人（{rest.reduce((n, p) => n + p.count, 0)} 件）</div>
              )}
              {noOne && (
                <div className="analytics-person analytics-person--none">
                  <span className="analytics-name">担当なし</span>
                  <div className="analytics-bar"><i style={{ width: `${(noOne.count / maxCount) * 100}%` }} /></div>
                  <span className="analytics-num">{noOne.count} 件 {estimateOf(noOne.estimate)}</span>
                </div>
              )}
            </div>

            <div className="analytics-box">
              <h5>{WEEKS} 週の流れ（作った数 と 閉じた数）</h5>
              <div className="analytics-weeks">
                {a.weeks.map((w) => (
                  <div key={w.start} className="analytics-week" title={`${md(w.start)} からの週: 作った ${w.created} 件・閉じた ${w.closed} 件`}>
                    <div className="analytics-pair">
                      <i className="created" style={{ height: `${maxWeek ? (w.created / maxWeek) * 100 : 0}%` }} />
                      <i className="closed" style={{ height: `${maxWeek ? (w.closed / maxWeek) * 100 : 0}%` }} />
                    </div>
                    <small>{md(w.start)}</small>
                  </div>
                ))}
              </div>
              <div className="analytics-wlegend">
                <span><i className="created" />作った数 {createdSum}</span>
                <span><i className="closed" />閉じた数 {closedSum}</span>
                <span className="analytics-muted">（{WEEKS} 週の合計。閉じた数が作った数を上回ると、残りが減っています）</span>
              </div>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
