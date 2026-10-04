import { useEffect, useMemo, useState } from "react";
import type { GitHubIssue, TimelineEvent } from "../../lib/types";
import { formatEstimate, formatNumber } from "../../lib/estimate";
import { issueRef } from "../../lib/issueRef";
import {
  average, bucketize, cycleDays, FLOW_BUCKETS, IN_PROGRESS_LABEL, leadDays, median, startedAt,
  type PaceMode, type VelocityEntry,
} from "../../lib/sprint";
import { useEstimateUnit } from "./EstimateChip";
import { countOf } from "../../lib/count";
import { tr, trx } from "../../lib/i18n";

/** サイクルタイムを読む Issue の数（新しく閉じた順） */
const MAX_FLOW = 40;

interface TeamPaceProps {
  owner: string;
  repo: string;
  /** 終わったマイルストーンごとの終えた量（古い順） */
  entries: VelocityEntry[];
  /** 終わったマイルストーンの数（見積もりが付いていないものも入れて） */
  finishedCount: number;
  /** 閉じた Issue（サイクルタイムを数える） */
  closedIssues: GitHubIssue[];
  mode: PaceMode;
  onModeChange: (mode: PaceMode) => void;
  /** 変更の履歴（「進行中」にした日を知るため。つながっているときだけ） */
  onListTimeline: (issueNumber: number) => Promise<TimelineEvent[]>;
  onSelectIssue: (n: number) => void;
}

/** 覚えておく「進行中にした時刻」。閉じた時刻が変わったら（開き直して閉じたら）読み直す */
type StartedCache = Record<number, { closed: string; started: string | null }>;

function cacheKey(owner: string, repo: string) {
  return `pace-started:${owner}/${repo}`;
}

function loadCache(owner: string, repo: string): StartedCache {
  try {
    return JSON.parse(localStorage.getItem(cacheKey(owner, repo)) ?? "{}") as StartedCache;
  } catch {
    return {};
  }
}

function saveCache(owner: string, repo: string, cache: StartedCache) {
  try {
    localStorage.setItem(cacheKey(owner, repo), JSON.stringify(cache));
  } catch {
    // 覚えられなくても、次に開いたときに読み直すだけ
  }
}

const fmtDays = (v: number) => tr("{formatNumber} 日", { formatNumber: formatNumber(Math.round(v * 10) / 10) });

/**
 * マイルストーンの画面の上の「チームのペース」。終わったマイルストーンごとの終えた量（ベロシティ）と、
 * 手を付けて（「状態:進行中」にして）から閉じるまでの日数（サイクルタイム）
 */
export function TeamPace({ owner, repo, entries, finishedCount, closedIssues, mode, onModeChange, onListTimeline, onSelectIssue }: TeamPaceProps) {
  const unit = useEstimateUnit();
  const fmt = (v: number) => (mode === "count" ? tr("{formatNumber} 件", { formatNumber: formatNumber(v) }) : formatEstimate(Math.round(v * 10) / 10, unit));

  // --- ベロシティ ---
  const values = entries.map((e) => (mode === "count" ? e.closedCount : e.done));
  const avg = average(values);
  const recent = values.slice(-3);
  const maxV = Math.max(1, ...values);

  // --- サイクルタイム（終わったマイルストーンの、閉じた Issue） ---
  const targets = useMemo(() => {
    const ms = new Set(entries.map((e) => e.number));
    return closedIssues
      .filter((i) => i.milestone && ms.has(i.milestone.number) && i.closed_at && i.number > 0)
      .sort((a, b) => (b.closed_at ?? "").localeCompare(a.closed_at ?? ""))
      .slice(0, MAX_FLOW);
  }, [entries, closedIssues]);

  const [cache, setCache] = useState<StartedCache>(() => loadCache(owner, repo));
  const [reading, setReading] = useState<{ done: number; total: number } | null>(null);
  const [readError, setReadError] = useState<string | null>(null);

  // 覚えていない（または閉じ直した）Issue の変更の履歴を、1 件ずつ読んで覚える（読めた分から出す）。
  // 読む Issue の並びが変わったときだけ動く（画面を描き直すたびには読まない）
  const targetKey = targets.map((i) => `${i.number}:${i.closed_at}`).join(",");
  useEffect(() => {
    let alive = true;
    (async () => {
      let current = loadCache(owner, repo);
      setCache(current);
      const todo = targets.filter((i) => current[i.number]?.closed !== i.closed_at);
      if (todo.length === 0) return;
      setReadError(null);
      for (let k = 0; k < todo.length; k++) {
        if (!alive) return;
        setReading({ done: k, total: todo.length });
        const issue = todo[k];
        try {
          const started = startedAt(await onListTimeline(issue.number));
          current = { ...current, [issue.number]: { closed: issue.closed_at!, started } };
          saveCache(owner, repo, current);
          if (alive) setCache(current);
        } catch (e) {
          if (alive) setReadError(String(e));
          break;
        }
      }
      if (alive) setReading(null);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey, owner, repo]);

  const flow = targets.map((i) => {
    const started = cache[i.number]?.closed === i.closed_at ? cache[i.number]?.started ?? null : null;
    return { issue: i, cycle: started ? cycleDays(i.closed_at!, started) : null, lead: leadDays(i) };
  });
  const cycles = flow.map((f) => f.cycle).filter((v): v is number => v !== null);
  const leads = flow.map((f) => f.lead).filter((v): v is number => v !== null);
  const buckets = bucketize(cycles);
  const maxB = Math.max(1, ...buckets);
  const slowest = flow.filter((f) => f.cycle !== null).sort((a, b) => (b.cycle ?? 0) - (a.cycle ?? 0)).slice(0, 2);
  const medCycle = median(cycles);
  const medLead = median(leads);

  return (
    <section className="pace" aria-label={tr("チームのペース")}>
      <div className="pace-head">
        <b>{tr("🏃 チームのペース")}</b>
        <span className="pace-scope">{tr("終わったマイルストーンから")}{entries.length > 0 ? tr("（最近 {countOf}）", { countOf: countOf(entries.length, tr("個")) }) : ""}</span>
        <span className="pace-mode" role="group" aria-label={tr("数え方")}>
          {(["estimate", "count"] as PaceMode[]).map((m) => (
            <button key={m} type="button" className={mode === m ? "on" : ""} aria-pressed={mode === m} onClick={() => onModeChange(m)}>
              {m === "estimate" ? tr("見積もり") : tr("件数")}
            </button>
          ))}
        </span>
      </div>

      {entries.length === 0 ? (
        <p className="pace-note">
          {mode === "estimate" && finishedCount > 0 ? (
            <>
              {tr("終わったマイルストーン（")}{countOf(finishedCount, tr("個"))}{tr("）の Issue には、見積もりが付いていません。")}
              <button type="button" className="link-button" onClick={() => onModeChange("count")}>{tr("件数で数える")}</button>
            </>
          ) : (
            tr("終わったマイルストーンがまだありません。")
          )}
        </p>
      ) : (
        <div className="pace-grid">
          <div className="pace-box">
            <h5>{tr("ベロシティ（1 つのマイルストーンで終えた量）")}</h5>
            <div className="pace-bars">
              {entries.map((e, k) => (
                <div key={e.number} className="pace-bar" title={tr("{title}: {fmt}（閉じた Issue {closedCount} 件）", { title: e.title, fmt: fmt(values[k]), closedCount: e.closedCount })}>
                  <small className="pace-bar-v">{mode === "count" ? formatNumber(values[k]) : formatNumber(Math.round(values[k] * 10) / 10)}</small>
                  <i style={{ height: `${(values[k] / maxV) * 100}%` }} />
                  <small className="pace-bar-t">{e.title}</small>
                </div>
              ))}
            </div>
            {avg !== null && (
              <p className="pace-note">
                {trx("次のスプリントに入れる量の目安: <0>{fmt}</0>（最近", { fmt: fmt(avg) }, [<b className="pace-em" />])}{" "} {countOf(values.length, tr("個"))}{tr("の平均。直近")}{" "} {countOf(recent.length, tr("個"))}{trx("は {fmt}〜{fmt2}）", { fmt: fmt(Math.min(...recent)), fmt2: fmt(Math.max(...recent)) })}
              </p>
            )}
          </div>

          <div className="pace-box">
            <h5>{tr("サイクルタイム（「進行中」にしてから閉じるまで）")}</h5>
            {medCycle !== null ? (
              <div className="pace-flow-head">
                {trx("<0>{fmtDays}</0><1>真ん中の値・{length} 件</1>", { fmtDays: fmtDays(medCycle), length: cycles.length }, [<span className="pace-big" />, <span className="pace-note" />])}
                {medLead !== null && <span className="pace-note">{trx("作ってから閉じるまで（リードタイム）は {fmtDays}", { fmtDays: fmtDays(medLead) })}</span>}
              </div>
            ) : (
              <p className="pace-note">
                {reading ? tr("変更の履歴を読んでいます…") : tr("「{IN_PROGRESS_LABEL}」を付けてから閉じた Issue が、まだありません。", { IN_PROGRESS_LABEL })}
                {medLead !== null && <>{trx("作ってから閉じるまで（リードタイム）は {fmtDays}。", { fmtDays: fmtDays(medLead) })}</>}
              </p>
            )}
            {cycles.length > 0 && (
              <div className="pace-hist">
                {FLOW_BUCKETS.map((bk, k) => (
                  <div key={bk.label}>
                    <i className={k === FLOW_BUCKETS.length - 1 ? "long" : ""} style={{ height: `${(buckets[k] / maxB) * 100}%` }} />
                    <small>{bk.label} {buckets[k]}</small>
                  </div>
                ))}
              </div>
            )}
            {slowest.length > 0 && (
              <p className="pace-note">
                {tr("長くかかった:")}{" "}
                {slowest.map((f, k) => (
                  <span key={f.issue.number}>
                    {k > 0 && tr("・")}
                    <button type="button" className="pace-ref" onClick={() => onSelectIssue(f.issue.number)} title={f.issue.title}>
                      {issueRef(f.issue.number)}
                    </button>{" "}
                    {fmtDays(f.cycle ?? 0)}
                  </span>
                ))}
              </p>
            )}
            {reading && <p className="pace-note">{trx("変更の履歴を読んでいます（{done} / {total} 件）…", { done: reading.done, total: reading.total })}</p>}
            {readError && <p className="pace-note">{trx("変更の履歴を読めませんでした（{readError}）。つながっているときに開き直すと、続きから読みます。", { readError })}</p>}
          </div>
        </div>
      )}
    </section>
  );
}
