// スマホのガント（#209）。PC の形（左の一覧と、横に長い絵）はスマホの幅に入らないので、行を 2 段にする
// （上の段に題名、下の段に帯）。目盛りは「全体」（期間を 1 画面に収める）と「週」「日」（横に流す）。
// 帯は見るだけで、指では動かさない（縦に流すつもりで帯を動かしてしまうため）。日程は詳細から変える。
// 押したタスクの先行と後続にだけ、帯の左の端（根本）から矢印を引く。行は始まる日の順に並ぶので、
// 下の行の帯は根本より右から始まり、根本の左はいつも空いている（矢印が帯の上を通らない）
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { GanttTask, GanttBarColors, GanttLink } from "../../lib/ganttTypes";
import { dateToDays, barColorOf, relatedOf } from "../../lib/ganttRenderer";
import { arrowKey } from "../../lib/ganttArrows";
import { issueRef } from "../../lib/issueRef";
import { Avatar } from "../common/Avatar";

export type MobileScale = "all" | "week" | "day";

/** 押したタスクの、詳しいことと先行・後続（GanttView で作る） */
export interface MobileGanttLinks {
  self: GanttTask;
  preds: GanttLink[];
  succs: GanttLink[];
  /** タスクの内容（本文のはじめ） */
  excerpt: string;
}

interface GanttMobileChartProps {
  tasks: GanttTask[];
  today: string;
  deadline: string | null;
  criticalPath: Set<number>;
  /** ふだん省いている矢印（ほかの矢印をたどってもつながる）。押したときは点線で引く */
  redundant: Set<string>;
  barColors: GanttBarColors;
  scale: MobileScale;
  focus: number | null;
  onFocus: (n: number | null) => void;
  links: MobileGanttLinks | null;
  onOpenIssue: (n: number) => void;
  /** 仮の日程を、本当の日程として書き込む */
  onFixTentative: (task: GanttTask) => void;
}

/** 1 行の高さ（上の段に題名、下の段に帯） */
const ROW = 50;
const BAR_TOP = 29;
const BAR_H = 13;
const BAR_MID = BAR_TOP + BAR_H / 2;
/** 左の余白（いちばん左の帯の根本からも、矢印を左へ出せるように） */
const PAD_L = 14;
const PAD_R = 10;
/** 矢印の幹を、帯の根本からどれだけ左に通すか */
const TRUNK = 7;
/** 「週」「日」の 1 日の幅 */
const PX_PER_DAY = { week: 14, day: 44 } as const;

function daysToDate(n: number): string {
  const d = new Date(n * 86400000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** 「2026-10-12」→「10/12」 */
function md(date: string): string {
  const [, m, d] = date.split("-").map(Number);
  return `${m}/${d}`;
}

function shortTitle(title: string, max: number): string {
  return title.length > max ? title.slice(0, max - 1) + "…" : title;
}

const hasBar = (t: GanttTask) => !!(t.startDate && t.endDate);

/** 角を丸めた折れ線 */
function roundedPath(pts: [number, number][], r: number): string {
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[i + 1];
    const l1 = Math.hypot(x1 - x0, y1 - y0) || 1;
    const l2 = Math.hypot(x2 - x1, y2 - y1) || 1;
    const rr = Math.min(r, l1 / 2, l2 / 2);
    d += ` L${x1 - ((x1 - x0) / l1) * rr},${y1 - ((y1 - y0) / l1) * rr} Q${x1},${y1} ${x1 + ((x2 - x1) / l2) * rr},${y1 + ((y2 - y1) / l2) * rr}`;
  }
  const last = pts[pts.length - 1];
  return `${d} L${last[0]},${last[1]}`;
}

type Head = "right" | "left" | "up";

interface MobileArrow {
  key: string;
  d: string;
  tip: [number, number];
  head: Head;
  kind: "pred" | "succ";
  broken: boolean;
  redundant: boolean;
}

export function GanttMobileChart({
  tasks, today, deadline, criticalPath, redundant, barColors, scale, focus, onFocus, links, onOpenIssue, onFixTentative,
}: GanttMobileChartProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // 見えている幅（題名の段の幅と、「全体」の 1 日の幅に使う）
  const [vw, setVw] = useState(0);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setVw(el.clientWidth);
    const ro = new ResizeObserver(() => setVw(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 閉じていて日程のないタスクは、下にたたむ（帯がなく、ほとんど見ないので）
  const [showDone, setShowDone] = useState(false);
  const rows = useMemo(() => tasks.filter((t) => hasBar(t) || t.state !== "closed"), [tasks]);
  const doneNoBar = useMemo(() => tasks.filter((t) => !hasBar(t) && t.state === "closed"), [tasks]);
  const shown = useMemo(() => (showDone ? [...rows, ...doneNoBar] : rows), [rows, doneNoBar, showDone]);

  // 出す期間: 「全体」はタスクの日程と今日と期限が入る分だけ。「週」「日」は PC と同じく前後に余白
  const range = useMemo(() => {
    let min = dateToDays(today);
    let max = deadline && deadline > today ? dateToDays(deadline) : min;
    for (const t of tasks) {
      if (t.startDate) min = Math.min(min, dateToDays(t.startDate));
      if (t.endDate) max = Math.max(max, dateToDays(t.endDate));
    }
    if (scale !== "all") return { start: min - 7, days: max - min + 1 + 21 };
    return { start: min, days: Math.max(7, max - min + 1) };
  }, [tasks, today, deadline, scale]);
  const dayW = scale === "all" ? Math.max(1, (vw - PAD_L - PAD_R) / range.days) : PX_PER_DAY[scale];
  const width = scale === "all" ? vw : PAD_L + range.days * dayW + PAD_R;
  const xOf = (date: string) => PAD_L + (dateToDays(date) - range.start) * dayW;
  const todayDays = dateToDays(today);

  // 目盛り: 字が重ならない間隔（毎日 → 1 日おき → 月曜 → 1 日と 15 日 → 月の頭）
  const ticks = useMemo(() => {
    const step = dayW >= 20 ? 1 : dayW >= 11 ? 2 : dayW >= 4 ? 7 : dayW >= 2 ? 15 : 30;
    const out: { x: number; label: string; strong: boolean; weekend: boolean }[] = [];
    let lastMonth = -1;
    for (let i = 0; i < range.days; i++) {
      const date = daysToDate(range.start + i);
      const [, m, d] = date.split("-").map(Number);
      const dow = new Date(date + "T00:00:00Z").getUTCDay();
      const show = step <= 2 ? i % step === 0 : step === 7 ? dow === 1 : step === 15 ? d === 1 || d === 15 : d === 1;
      if (!show) continue;
      const newMonth = m !== lastMonth;
      lastMonth = m;
      out.push({
        x: PAD_L + (i + 0.5) * dayW,
        label: step === 30 ? `${m}月` : newMonth ? `${m}/${d}` : `${d}`,
        strong: newMonth,
        weekend: step <= 2 && (dow === 0 || dow === 6),
      });
    }
    return out;
  }, [range, dayW]);

  // 土日のうすい帯（1 日が細すぎるときは出さない）
  const weekends = useMemo(() => {
    if (dayW < 6) return [];
    const out: number[] = [];
    for (let i = 0; i < range.days; i++) {
      const dow = new Date(daysToDate(range.start + i) + "T00:00:00Z").getUTCDay();
      if (dow === 0 || dow === 6) out.push(i);
    }
    return out;
  }, [range, dayW]);

  const byNum = useMemo(() => new Map(tasks.map((t) => [t.issueNumber, t])), [tasks]);
  const rel = useMemo(() => (focus === null ? null : relatedOf(tasks, focus)), [tasks, focus]);

  // 行の印: ⚠ 開いている先行が終わる前に始まる（順番が逆）、⏳ 開いている先行が遅れている（終わりの日が過ぎた）
  const marksOf = (t: GanttTask) => {
    const reversed: number[] = [];
    const late: number[] = [];
    if (t.state === "closed") return { reversed, late };
    for (const p of new Set(t.dependencies)) {
      const pt = byNum.get(p);
      if (!pt || pt.state === "closed" || !pt.endDate || p === t.issueNumber) continue;
      if (t.startDate && dateToDays(t.startDate) <= dateToDays(pt.endDate)) reversed.push(p);
      else if (!pt.tentative && dateToDays(pt.endDate) < todayDays) late.push(p);
    }
    return { reversed, late };
  };

  // 矢印（押したタスクの分だけ）: 先行の帯の根本から少し左へ出て、縦に下ろし（上げ）、後続の帯の左の端へ入れる
  const arrows = useMemo(() => {
    if (rel === null) return [];
    const rowOf = new Map(shown.map((t, i) => [t.issueNumber, i]));
    const out: MobileArrow[] = [];
    const add = (from: number, to: number, kind: "pred" | "succ") => {
      const a = byNum.get(from);
      const b = byNum.get(to);
      const ra = rowOf.get(from);
      const rb = rowOf.get(to);
      if (!a?.startDate || !a.endDate || !b?.startDate || !b.endDate || ra === undefined || rb === undefined) return;
      const xa = xOf(a.startDate);
      const tx = xa - TRUNK;
      const ya = ra * ROW + BAR_MID;
      const yb = rb * ROW + BAR_MID;
      const bs = xOf(b.startDate);
      const be = xOf(b.endDate) + dayW;
      let pts: [number, number][];
      let head: Head;
      if (tx <= bs - 3) {
        // いつもの形: 後続の帯は、幹より右から始まる
        pts = [[xa, ya], [tx, ya], [tx, yb], [bs, yb]];
        head = "right";
      } else if (tx < be - 3) {
        // 後続（上の行）の帯が幹の上にかかる: 帯の下から入れる
        const bottom = rb * ROW + BAR_TOP + BAR_H + 1;
        pts = [[xa, ya], [tx, ya], [tx, bottom]];
        head = "up";
      } else {
        // 後続の帯が幹より左で終わる: 後続の行まで行って、帯の右の端へ
        pts = [[xa, ya], [tx, ya], [tx, yb], [be, yb]];
        head = "left";
      }
      const tip = pts[pts.length - 1];
      // 頭の三角の分だけ、線を手前で止める
      const back: [number, number] = head === "right" ? [tip[0] - 5, tip[1]] : head === "left" ? [tip[0] + 5, tip[1]] : [tip[0], tip[1] + 5];
      out.push({
        key: arrowKey(from, to),
        d: roundedPath([...pts.slice(0, -1), back], 4),
        tip,
        head,
        kind,
        broken: dateToDays(b.startDate) <= dateToDays(a.endDate),
        redundant: redundant.has(arrowKey(from, to)),
      });
    };
    for (const p of rel.preds) add(p, rel.focus, "pred");
    for (const s of rel.succs) add(rel.focus, s, "succ");
    return out;
    // xOf は range と dayW から決まる
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rel, shown, byNum, range, dayW, redundant]);

  // 「週」「日」に変えたときは、今日が左の近くに来るまで送る。「全体」は左の端から
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || vw === 0) return;
    el.scrollLeft = scale === "all" ? 0 : Math.max(0, PAD_L + (todayDays - range.start - 3) * dayW);
    // 目盛りを変えたときと、はじめに幅が分かったときだけ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale, vw === 0]);

  // 押したタスクの行が、下の板の出たぶん隠れたら、見える所まで送る
  useEffect(() => {
    if (focus === null) return;
    const el = scrollRef.current;
    const row = el?.querySelector<HTMLElement>(`[data-n="${focus}"]`);
    if (!el || !row) return;
    const top = row.offsetTop;
    const head = 36;
    if (top - head < el.scrollTop || top + ROW > el.scrollTop + el.clientHeight) {
      el.scrollTo({ top: Math.max(0, top - head - ROW), behavior: "smooth" });
    }
  }, [focus]);

  /** 下の板の札から、相手の行まで送る（押したタスクはそのまま） */
  const jumpTo = (n: number) => {
    const el = scrollRef.current;
    const row = el?.querySelector<HTMLElement>(`[data-n="${n}"]`);
    if (!el || !row) return;
    const t = byNum.get(n);
    const left = scale !== "all" && t?.startDate ? Math.max(0, xOf(t.startDate) - 3 * dayW) : el.scrollLeft;
    el.scrollTo({ top: Math.max(0, row.offsetTop - el.clientHeight / 3), left, behavior: "smooth" });
  };

  const rowsHeight = shown.length * ROW;
  const color = (kind: "pred" | "succ", broken: boolean) => (broken ? "var(--accent-red)" : kind === "pred" ? "var(--gantt-pred)" : "var(--gantt-succ)");

  return (
    <>
      <div className="mg-scroll" ref={scrollRef} onClick={() => onFocus(null)}>
        {vw > 0 && (
          <div className="mg-inner" style={{ width, ["--mg-vw" as string]: `${vw}px` }}>
            {/* 目盛り（上に貼りつく） */}
            <div className="mg-head">
              {ticks.map((t) => (
                <span key={t.x} className={`mg-tick${t.strong ? " strong" : ""}${t.weekend ? " weekend" : ""}`} style={{ left: t.x }}>
                  {t.label}
                </span>
              ))}
              <span className="mg-tag today" style={{ left: xOf(today) + dayW / 2 }}>今日</span>
              {deadline && <span className="mg-tag due" style={{ left: xOf(deadline) + dayW }}>期限 {md(deadline)}</span>}
            </div>

            <div className="mg-rows" style={{ height: rowsHeight }}>
              {weekends.map((i) => (
                <div key={i} className="mg-wkend" style={{ left: PAD_L + i * dayW, width: dayW }} />
              ))}
              <div className="mg-today" style={{ left: xOf(today) + dayW / 2 }} />
              {deadline && <div className="mg-due" style={{ left: xOf(deadline) + dayW }} />}

              {shown.map((t) => {
                const r = rel === null ? null : t.issueNumber === rel.focus ? "focus" : rel.preds.has(t.issueNumber) ? "pred" : rel.succs.has(t.issueNumber) ? "succ" : "dim";
                const mk = marksOf(t);
                return (
                  <div
                    key={t.issueNumber}
                    data-n={t.issueNumber}
                    className={`mg-row${r ? ` ${r}` : ""}${t.state === "closed" ? " closed" : ""}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      // もう一度押すと外す
                      onFocus(focus === t.issueNumber ? null : t.issueNumber);
                    }}
                  >
                    <div className="mg-title">
                      <span className="mg-num">{issueRef(t.issueNumber)}</span>
                      <span className="mg-name">{t.title}</span>
                      {t.tentative && <span className="gantt-kari">仮</span>}
                      {t.estimate && <span className="est-chip gantt-est">{t.estimate}</span>}
                      {mk.reversed.length > 0 && (
                        <span className="mg-mark rev" title={`${mk.reversed.map(issueRef).join(" ")} が終わる前に始まる日程です（順番が逆）`}>⚠</span>
                      )}
                      {mk.late.length > 0 && (
                        <span className="mg-mark late" title={`先行の ${mk.late.map(issueRef).join(" ")} が遅れています`}>⏳</span>
                      )}
                      {r === "pred" && <span className="gantt-rel pred">先行</span>}
                      {r === "succ" && <span className="gantt-rel succ">後続</span>}
                      {!hasBar(t) && t.state !== "closed" && <span className="gantt-none">日程なし</span>}
                      {t.assignees[0] && (
                        <Avatar login={t.assignees[0].login} url={t.assignees[0].avatar_url} title={t.assignees.map((a) => a.login).join(", ")} className="avatar-sm mg-who" />
                      )}
                    </div>
                    {hasBar(t) && <MobileBar task={t} xOf={xOf} dayW={dayW} todayDays={todayDays} deadline={deadline} critical={criticalPath.has(t.issueNumber)} colors={barColors} />}
                  </div>
                );
              })}

              {arrows.length > 0 && (
                <svg className="mg-arrows" width={width} height={rowsHeight} aria-hidden="true">
                  {/* 下地（題名や格子の上でも線が読めるように）を先に、全部の矢印の分だけ */}
                  {arrows.map((a) => (
                    <path key={`h${a.key}`} d={a.d} className="mg-arrow-halo" />
                  ))}
                  {arrows.map((a) => (
                    <path
                      key={a.key}
                      d={a.d}
                      fill="none"
                      stroke={color(a.kind, a.broken)}
                      strokeWidth={2}
                      strokeDasharray={a.broken ? "4 3" : a.redundant ? "6 4" : undefined}
                      strokeLinejoin="round"
                    />
                  ))}
                  {arrows.map((a) => {
                    const [x, y] = a.tip;
                    const p = a.head === "right" ? `${x},${y} ${x - 6},${y - 3.5} ${x - 6},${y + 3.5}` : a.head === "left" ? `${x},${y} ${x + 6},${y - 3.5} ${x + 6},${y + 3.5}` : `${x},${y} ${x - 3.5},${y + 6} ${x + 3.5},${y + 6}`;
                    return <polygon key={`t${a.key}`} points={p} fill={color(a.kind, a.broken)} />;
                  })}
                </svg>
              )}
            </div>

            {doneNoBar.length > 0 && (
              <button type="button" className="mg-fold" onClick={(e) => { e.stopPropagation(); setShowDone(!showDone); }}>
                {showDone ? "▾" : "▸"} 終わった {doneNoBar.length} 件（日程なし）
              </button>
            )}
            {focus === null && <div className="mg-hint">帯か題名を押すと、先行と後続が出ます</div>}
          </div>
        )}
      </div>

      {/* 押したタスクの、詳しいことと先行・後続（札を押すと、その行まで送る） */}
      {links && (
        <div className="mg-info">
          <div className="mg-info-title">
            {issueRef(links.self.issueNumber)} {links.self.title}
          </div>
          <div className="mg-info-meta">
            {[
              links.self.startDate && links.self.endDate ? `${links.self.tentative ? "仮に " : ""}${md(links.self.startDate)}〜${md(links.self.endDate)}` : "日程なし",
              links.self.estimate ? `見積 ${links.self.estimate}` : null,
              `進み ${links.self.progressValue}%`,
              links.self.assignees.length > 0 ? `担当 ${links.self.assignees.map((a) => a.login).join(", ")}` : "担当なし",
            ]
              .filter(Boolean)
              .join(" ・ ")}
          </div>
          {links.excerpt && <div className="mg-info-body">{links.excerpt}</div>}
          {(["pred", "succ"] as const).map((kind) => {
            const list = kind === "pred" ? links.preds : links.succs;
            return (
              <div key={kind} className="mg-info-links">
                <span className={`gantt-info-label ${kind}`}>{kind === "pred" ? "先行" : "後続"}</span>
                {list.length === 0 && <span className="mg-info-none">なし</span>}
                {list.map((l) => (
                  <span key={l.n} className="mg-link">
                    <button type="button" className={`gantt-link ${l.reason ? "off" : kind}`} disabled={l.reason !== null} onClick={() => jumpTo(l.n)}>
                      {issueRef(l.n)} {shortTitle(l.title, 12)}
                      {l.redundant ? "（点線）" : ""}
                      {l.reason ? `（${l.reason}）` : ""}
                    </button>
                    {l.broken && <span className="gantt-link-warn">順番が逆</span>}
                    {l.late && <span className="mg-link-late">遅れている</span>}
                  </span>
                ))}
              </div>
            );
          })}
          <div className="mg-info-actions">
            <button type="button" className="btn-sm" onClick={() => onFocus(null)}>外す</button>
            {links.self.tentative && (
              <button type="button" className="btn-sm" onClick={() => onFixTentative(links.self)}>この日程で決める</button>
            )}
            <button type="button" className="btn-primary" onClick={() => onOpenIssue(links.self.issueNumber)}>詳細を開く</button>
          </div>
        </div>
      )}
    </>
  );
}

/** 帯 1 本（色・進み具合・CP の枠・遅れの赤い延長は PC と同じ決まり。仮の帯は点線で、期限を超えた分は赤） */
function MobileBar({
  task, xOf, dayW, todayDays, deadline, critical, colors,
}: {
  task: GanttTask;
  xOf: (date: string) => number;
  dayW: number;
  todayDays: number;
  deadline: string | null;
  critical: boolean;
  colors: GanttBarColors;
}) {
  const left = xOf(task.startDate!);
  const right = xOf(task.endDate!) + dayW;
  const width = Math.max(3, right - left);
  if (task.tentative) {
    const over = deadline && task.endDate! > deadline ? Math.max(left, xOf(deadline) + dayW) : null;
    return (
      <div className="mg-bar kari" style={{ left, width }}>
        {over !== null && <i className="mg-over" style={{ left: over - left }} />}
      </div>
    );
  }
  const c = barColorOf(task, critical, colors);
  const lateDays = task.state === "closed" ? 0 : todayDays - dateToDays(task.endDate!);
  const lateW = lateDays > 0 ? lateDays * dayW : 0;
  return (
    <>
      <div
        className={`mg-bar${critical ? " cp" : ""}`}
        style={{ left, width, background: `${c}40`, borderColor: critical ? colors.critical : c }}
      >
        {task.progressValue > 0 && <i className="mg-prog" style={{ width: `${task.progressValue}%`, background: `${c}B0` }} />}
      </div>
      {lateW > 0 && (
        <div className={`mg-late${lateW > 26 ? "" : " narrow"}`} style={{ left: right, width: lateW, background: colors.blocked }}>
          <span style={lateW > 26 ? undefined : { color: colors.blocked }}>+{lateDays}d</span>
        </div>
      )}
    </>
  );
}
