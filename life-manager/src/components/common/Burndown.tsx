import type { GitHubIssue } from "../../lib/types";
import { formatEstimate, formatNumber } from "../../lib/estimate";
import { burndown, dayOfDate, dayOfTime, dateOfDay, type PaceMode } from "../../lib/sprint";
import { issueRef } from "../../lib/issueRef";
import { useEstimateUnit } from "./EstimateChip";

/** YYYY-MM-DD → 「9/28」 */
function md(date: string): string {
  const [, m, d] = date.split("-").map(Number);
  return `${m}/${d}`;
}

interface BurndownProps {
  start: string;
  end: string | null;
  /** マイルストーンの Issue（開いている・閉じた） */
  issues: GitHubIssue[];
  mode: PaceMode;
}

// 図の大きさ（viewBox の中の座標）
const W = 760;
const H = 220;
const LEFT = 40;
const RIGHT = 750;
const TOP = 20;
const BOTTOM = 190;
/** 右の端から room の内側にあるか（文字が切れないよう、線の左に書くとき） */
const nearRight = (px: number, room: number) => px > RIGHT - room;

/**
 * マイルストーン（スプリント）のバーンダウン。残り・経過・このペースで終わる日の 3 つの数字と、
 * 日ごとの残りの図（点線が理想、途中で足した分は線が上がる、期限を超えた所は赤）
 */
export function Burndown({ start, end, issues, mode }: BurndownProps) {
  const unit = useEstimateUnit();
  const b = burndown({ start, end }, issues, mode, unit);
  const fmt = (v: number) => (mode === "count" ? `${formatNumber(v)} 件` : formatEstimate(v, unit));

  // --- 数字 ---
  const proj = b.projection;
  const paceValue =
    proj.kind === "date" ? `${md(proj.date)} ごろ` :
    proj.kind === "done" ? "終わりました" :
    proj.kind === "notStarted" ? "まだ" :
    proj.kind === "early" ? "—" : "—";
  const paceNote =
    proj.kind === "date"
      ? proj.lateDays === null ? "期限は決まっていません"
        : proj.lateDays > 0 ? `期限より ${proj.lateDays} 日遅れの見込み`
        : "期限に間に合う見込み"
      : proj.kind === "done" ? "残りはありません"
      : proj.kind === "notStarted" ? `始まるのは ${md(start)}`
      : proj.kind === "early" ? "始まったばかりで、まだ出せません"
      : "残りが減っていません（足した分と同じくらい）";
  const late = proj.kind === "date" && proj.lateDays !== null && proj.lateDays > 0;

  // --- 図 ---
  const startDay = dayOfDate(start);
  const endDay = end ? dayOfDate(end) : null;
  const lastPoint = b.points.length ? dayOfDate(b.points[b.points.length - 1].date) : startDay;
  const projDay = proj.kind === "date" ? dayOfDate(proj.date) : null;
  // 見込みの日が遠すぎるときは、期限の 3 週間あとまでで切る
  const maxDay = Math.max(endDay ?? lastPoint, lastPoint, projDay !== null ? Math.min(projDay, (endDay ?? lastPoint) + 21) : 0, startDay + 1);
  const top = Math.max(b.initial + b.addedTotal, ...b.points.map((p) => p.remaining), 1);
  const yMax = niceMax(top);
  const x = (day: number) => LEFT + ((day - startDay) / (maxDay - startDay)) * (RIGHT - LEFT);
  const y = (v: number) => BOTTOM - (v / yMax) * (BOTTOM - TOP);
  const actual = b.points.map((p) => `${x(dayOfDate(p.date)).toFixed(1)},${y(p.remaining).toFixed(1)}`).join(" ");
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * yMax);
  const labelDays = [...new Set([startDay, endDay, lastPoint, maxDay].filter((d): d is number => d !== null))];
  const biggestAdd = b.added.reduce<(typeof b.added)[number] | null>((m, a) => (!m || a.amount > m.amount ? a : m), null);

  return (
    <div className="burndown">
      <div className="bd-kpis">
        <div className="bd-kpi">
          <div className="bd-kpi-k">残り</div>
          <div className="bd-kpi-v bd-est">{fmt(b.remaining)}</div>
          <div className="bd-kpi-s">
            全体 {fmt(b.total)}
            {b.addedTotal > 0 && <>（途中で +{fmt(b.addedTotal)}）</>}
            {b.missing > 0 && <>・見積もりなし {b.missing} 件</>}
          </div>
        </div>
        <div className="bd-kpi">
          <div className="bd-kpi-k">経過</div>
          <div className="bd-kpi-v">{b.totalDays ? `${Math.min(b.elapsed, b.totalDays)} / ${b.totalDays} 日` : `${b.elapsed} 日`}</div>
          <div className="bd-kpi-s">{b.idealNow !== null ? `理想なら残り ${fmt(Math.round(b.idealNow * 10) / 10)}` : "期限を決めると理想の線が出ます"}</div>
        </div>
        <div className={`bd-kpi${late ? " bd-kpi--late" : ""}`}>
          <div className="bd-kpi-k">このペースだと</div>
          <div className="bd-kpi-v">{paceValue}</div>
          <div className="bd-kpi-s">{paceNote}</div>
        </div>
      </div>

      {b.points.length > 0 && (
        <div className="bd-box">
          <div className="bd-title">バーンダウン（残りの量）</div>
          <svg viewBox={`0 0 ${W} ${H}`} className="bd-svg" role="img"
            aria-label={`残り ${fmt(b.remaining)}。開始 ${md(start)}${end ? `、期限 ${md(end)}` : ""}`}>
            {ticks.map((v) => (
              <g key={v}>
                <line x1={LEFT} y1={y(v)} x2={RIGHT} y2={y(v)} className={v === 0 ? "bd-axis" : "bd-grid"} />
                <text x={LEFT - 6} y={y(v) + 4} className="bd-label" textAnchor="end">{formatNumber(Math.round(v * 10) / 10)}</text>
              </g>
            ))}
            {endDay !== null && (
              <>
                {maxDay > endDay && <rect x={x(endDay)} y={TOP} width={x(maxDay) - x(endDay)} height={BOTTOM - TOP} className="bd-over" />}
                <line x1={x(endDay)} y1={TOP} x2={x(endDay)} y2={BOTTOM} className="bd-deadline" />
                {/* 右の端に近いときは、線の左に書く（切れないように） */}
                <text x={nearRight(x(endDay), 70) ? x(endDay) - 4 : x(endDay) + 4} y={TOP + 12} className="bd-deadline-text"
                  textAnchor={nearRight(x(endDay), 70) ? "end" : "start"}>期限 {md(end!)}</text>
                <line x1={x(startDay)} y1={y(b.initial)} x2={x(endDay)} y2={y(0)} className="bd-ideal" />
              </>
            )}
            <polyline points={actual} className="bd-actual" />
            {proj.kind === "date" && projDay !== null && projDay <= maxDay && (
              <>
                <line x1={x(lastPoint)} y1={y(b.remaining)} x2={x(projDay)} y2={y(0)} className="bd-proj" />
                <circle cx={x(projDay)} cy={y(0)} r={4} className={late ? "bd-proj-dot bd-proj-dot--late" : "bd-proj-dot"} />
                <text x={x(projDay) - 4} y={y(0) - 10} className={late ? "bd-proj-text bd-proj-text--late" : "bd-proj-text"} textAnchor="end">
                  このペースだと {md(proj.date)}
                </text>
              </>
            )}
            {dayOfTime(new Date()) === lastPoint && (
              <>
                <line x1={x(lastPoint)} y1={TOP} x2={x(lastPoint)} y2={BOTTOM} className="bd-today" />
                <text x={nearRight(x(lastPoint), 40) ? x(lastPoint) - 4 : x(lastPoint) + 4} y={TOP + 26} className="bd-today-text"
                  textAnchor={nearRight(x(lastPoint), 40) ? "end" : "start"}>今日</text>
              </>
            )}
            {biggestAdd && (
              <text x={nearRight(x(dayOfDate(biggestAdd.date)), 220) ? x(dayOfDate(biggestAdd.date)) - 4 : x(dayOfDate(biggestAdd.date)) + 4}
                y={Math.max(TOP + 12, y(top) - 2)} className="bd-add-text"
                textAnchor={nearRight(x(dayOfDate(biggestAdd.date)), 220) ? "end" : "start"}>
                +{fmt(biggestAdd.amount)}（{biggestAdd.issues.slice(0, 2).map(issueRef).join("・")}{biggestAdd.issues.length > 2 ? " ほか" : ""} を足した）
              </text>
            )}
            {labelDays.map((d) => (
              <text key={d} x={x(d)} y={H - 12} className="bd-label"
                textAnchor={d === startDay ? "start" : d === maxDay ? "end" : "middle"}>{md(dateOfDay(d))}</text>
            ))}
          </svg>
          <div className="bd-legend">
            <span><i className="bd-leg-ideal" />理想（期限にちょうど 0）</span>
            <span><i className="bd-leg-actual" />実際の残り</span>
            <span><i className="bd-leg-proj" />このペースの見込み</span>
            <span className="bd-legend-note">Issue は作った日から数えます（途中で足した分は線が上がります）</span>
          </div>
        </div>
      )}
    </div>
  );
}

/** 目盛りの上の端（4 つに分けてきりのよい数になるよう丸める。例: 51 → 60） */
function niceMax(v: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 1.2, 1.6, 2, 2.4, 3, 4, 5, 6, 8, 10]) if (v <= m * p) return m * p;
  return 10 * p;
}
