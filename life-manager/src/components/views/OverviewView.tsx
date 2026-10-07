import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import type { GitCommit, GitHistory } from "../../lib/types";
import {
  appCommitBreakdown,
  dayKey,
  layoutGraph,
  shortDay,
  shortWhen,
  type BranchEntry,
  type GraphRow,
  type RefChip,
} from "../../lib/history";
import { easeScrollTo } from "../../lib/motion";
import { POP_DURATION, edgeReveal, popRank, popStep } from "../../lib/popReveal";
import type { BranchStyle } from "../../hooks/useDisplaySettings";
import { BranchPicker } from "../git/BranchPicker";
import { FlowingName } from "../common/FlowingName";
import { tr, trx } from "../../lib/i18n";

interface OverviewViewProps {
  history: GitHistory;
  entries: BranchEntry[];
  byHash: Map<string, GitCommit>;
  /** 見ているブランチ（ブランチ画面と共有） */
  selected: string | null;
  onSelect: (name: string) => void;
  /** 点をクリックしたとき: そのブランチのそのコミットへ寄る */
  onOpenCommit: (hash: string) => void;
  /** 作業中の変更の数（この PC の git のときだけ。0 なら出さない） */
  changes: number;
  onOpenWork: () => void;
  branchStyle: BranchStyle;
  onBranchStyleChange: (style: BranchStyle) => void;
  /** クリックで開くブランチ（コミット → ブランチ名） */
  home: Map<string, string>;
  /** コミット・ブランチの操作のメニュー（右クリック） */
  onCommitMenu: (pos: { x: number; y: number }, commit: GitCommit) => void;
  onBranchMenu: (pos: { x: number; y: number }, entry: BranchEntry) => void;
}

const ROW_H = 20;
const LANE_W = 40;
const LINE_W = 44;
const PAD_X = 20;
const HEAD_H = 76;

const laneX = (lane: number) => PAD_X + lane * LANE_W;
const colorClass = (n: number) => `c${n % 10}`;

type Tip = { x: number; y: number; row: GraphRow | null; life: BranchEntry | null };

/** 全体図: ブランチ画面から一歩引いて、どこから切られ、どう続き、いつマージされたかを見る */
export function OverviewView(props: OverviewViewProps) {
  const { history, entries, selected } = props;
  const local = history.source === "local";
  const defaultEntry = entries.find((e) => e.isDefault) ?? null;
  const currentEntry = entries.find((e) => e.isCurrent) ?? null;

  // 既定のブランチを左端、チェックアウト中をその隣のレーンに固定する（GitHub の控えがあればそちらを既定として使う）
  const seeds = useMemo(() => {
    const s: string[] = [];
    if (defaultEntry) s.push(defaultEntry.remoteTip ?? defaultEntry.tip);
    if (history.head) s.push(history.head);
    else if (currentEntry) s.push(currentEntry.tip);
    return s;
  }, [defaultEntry, currentEntry, history.head]);

  const layout = useMemo(() => layoutGraph(history, seeds), [history, seeds]);
  const lineMode = props.branchStyle === "line";

  // 「線」: 既定・チェックアウト中以外のブランチを、先頭のコミットから上へ伸びる 1 本の線で見せる
  const lifelines = useMemo(() => {
    if (!lineMode) return [];
    return entries
      .filter((e) => !e.isDefault && !e.isCurrent && layout.rowOf.has(e.tip))
      .map((e, k) => ({ entry: e, row: layout.rowOf.get(e.tip)!, column: k }));
  }, [lineMode, entries, layout]);

  const wip = local && props.changes > 0 && history.head !== null && layout.rowOf.has(history.head);
  const offset = wip ? 1 : 0;
  const rowY = (i: number) => (i + offset) * ROW_H + ROW_H / 2;
  const graphW = laneX(layout.laneCount - 1) + PAD_X;
  const lifeX = (k: number) => graphW + 8 + k * LINE_W;
  // 「ラベル」: 点から点線（leader）を右へ引き、その先にラベルを並べる。「線」: レーンの右にブランチの線を並べる
  const svgW = lineMode ? lifeX(lifelines.length) : graphW + 24;
  const labelsX = svgW + 4;
  const totalRows = layout.rows.length + offset;
  const height = totalRows * ROW_H + ROW_H;
  // ラベルの幅（だいたい）。「線」ではラベルを出さないので、作業中の変更のぶんだけ
  const labelsW = useMemo(() => {
    if (lineMode) return 160;
    const widths = layout.rows.map((r) => r.chips.reduce((w, c) => w + c.name.length * 7 + 34, 0));
    return Math.max(160, ...widths);
  }, [lineMode, layout]);

  // 日付（その日の最初の行にだけ出す）
  const dayStarts = useMemo(() => {
    const out: { row: number; label: string }[] = [];
    let last = "";
    layout.rows.forEach((r, i) => {
      const k = dayKey(r.commits[0].date);
      if (k !== last) out.push({ row: i, label: shortDay(r.commits[0].date) });
      last = k;
    });
    return out;
  }, [layout]);

  // 一覧から選んだブランチ（と最初に開いたとき）は、その先頭のコミットが見える位置へ
  const scrollRef = useRef<HTMLDivElement>(null);
  const [flashRow, setFlashRow] = useState<number | null>(null);
  const lastScrolled = useRef<string | null>(null);
  // 描く前に動かす（開いたときの動き〔#293〕が、見えているところを測れるように）
  useLayoutEffect(() => {
    const box = scrollRef.current;
    const entry = entries.find((e) => e.name === selected) ?? currentEntry ?? defaultEntry;
    if (!box || !entry) return;
    const row = layout.rowOf.get(entry.tip);
    if (row === undefined) return;
    const first = lastScrolled.current === null;
    if (lastScrolled.current === entry.name) return;
    lastScrolled.current = entry.name;
    const top = Math.max(0, HEAD_H + rowY(row) - box.clientHeight / 3);
    if (first) box.scrollTop = top;
    else {
      easeScrollTo(box, { top });
      setFlashRow(row);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, layout]);

  // 開いたとき、見えているところの下（古いコミット）から上へ、ぽこぽこ出す（#293）。
  // 点ははずみ、実線は下の点から上の点へ伸び、点線・日付・ラベルは薄く出る。見えていない行は動かさない
  const [reveal, setReveal] = useState<{ first: number; last: number; step: number; end: number } | null>(null);
  const revealed = useRef(false);
  useLayoutEffect(() => {
    const box = scrollRef.current;
    if (revealed.current || !box || layout.rows.length === 0) return;
    revealed.current = true;
    // 名前の見出し（HEAD_H）は上に貼り付いているので、見えているのは scrollTop から（高さ - HEAD_H）ぶん
    const top = box.scrollTop;
    const bottom = top + box.clientHeight - HEAD_H;
    const first = Math.max(0, Math.ceil((top - ROW_H / 2) / ROW_H) - offset);
    const last = Math.min(layout.rows.length - 1, Math.floor((bottom - ROW_H / 2) / ROW_H) - offset);
    if (last < first) return;
    const step = popStep(last - first + 1);
    setReveal({ first, last, step, end: Math.round((last - first) * step) + POP_DURATION });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout]);
  useEffect(() => {
    if (!reveal) return;
    const timer = window.setTimeout(() => setReveal(null), reveal.end + 300);
    return () => window.clearTimeout(timer);
  }, [reveal]);
  /** 行の点が出る時刻（ミリ秒）。動かさない行は null */
  const popAt = (row: number) => {
    if (!reveal) return null;
    const rank = popRank(row, reveal.first, reveal.last);
    return rank < 0 ? null : Math.round(rank * reveal.step);
  };
  /** 点のあとから薄く出すもの（点線・ラベル）。下へはみ出す行は、はじめから */
  const fadeAt = (row: number) => (!reveal || row < reveal.first ? null : row > reveal.last ? 0 : popAt(row)! + 120);
  const at = (ms: number | null): CSSProperties | undefined => (ms === null ? undefined : ({ "--d": `${ms}ms` } as CSSProperties));

  // マウスを重ねたコミットの内容
  const [tip, setTip] = useState<(Tip & { clientX: number; clientY: number }) | null>(null);

  // ブランチの名前（レーン・線の見出し、ラベル）を右クリック: そのブランチの操作
  const branchMenu = (name: string) => (ev: ReactMouseEvent) => {
    const entry = entries.find((e) => e.name === name) ?? entries.find((e) => `origin/${e.name}` === name);
    if (!entry) return;
    ev.preventDefault();
    setTip(null);
    props.onBranchMenu({ x: ev.clientX, y: ev.clientY }, entry);
  };

  const chipLabel = (c: RefChip) =>
    c.kind === "head" ? `● ${c.name}` : c.kind === "tag" ? `🏷️ ${c.name}` : c.kind === "remote" ? `☁ ${c.name}` : `🌿 ${c.name}`;

  const edgePath = (e: (typeof layout.edges)[number]) => {
    const x1 = laneX(e.fromLane);
    const y1 = rowY(e.from);
    const x2 = laneX(e.toLane);
    const y2 = e.to >= layout.rows.length ? height : rowY(e.to);
    if (x1 === x2) return `M${x1},${y1} V${y2}`;
    // マージの線はすぐに相手のレーンへ曲がり、枝分かれの線は最後に曲がる
    if (e.kind === "merge") return `M${x1},${y1} C${x1},${y1 + ROW_H / 2} ${x2},${y1 + ROW_H / 2} ${x2},${y1 + ROW_H} V${y2}`;
    return `M${x1},${y1} V${y2 - ROW_H} C${x1},${y2 - ROW_H / 2} ${x2},${y2 - ROW_H / 2} ${x2},${y2}`;
  };

  const node = (r: GraphRow, i: number) => {
    const x = laneX(r.lane);
    const y = rowY(i);
    const cls = colorClass(r.lane);
    const shape =
      r.kind === "merge" ? (
        <>
          <rect className={`nd merge ${cls}`} x={x - 6} y={y - 6} width={12} height={12} rx={1.5} />
          <rect className={`nd merge-in ${cls}`} x={x - 2.5} y={y - 2.5} width={5} height={5} rx={0.5} />
        </>
      ) : r.kind === "group" ? (
        <rect className="nd auto" x={x - 4} y={y - 7} width={8} height={14} rx={4} />
      ) : r.kind === "app" ? (
        <circle className="nd auto" cx={x} cy={y} r={3.5} />
      ) : (
        <circle className={`nd ${cls}`} cx={x} cy={y} r={5} />
      );
    return (
      <g
        key={r.commits[0].hash}
        className={`node${flashRow === i ? " flash" : ""}${popAt(i) === null ? "" : " pop"}`}
        style={at(popAt(i))}
        onMouseMove={(ev) => setTip({ x, y, row: r, life: null, clientX: ev.clientX, clientY: ev.clientY })}
        onMouseLeave={() => setTip(null)}
        onClick={() => props.onOpenCommit(r.commits[0].hash)}
        onContextMenu={(ev) => {
          ev.preventDefault();
          setTip(null);
          props.onCommitMenu({ x: ev.clientX, y: ev.clientY }, r.commits[0]);
        }}
      >
        {shape}
        {/* 出るとき、まわりに広がって消える輪（コミットは強めに。自動コミットには付けない） */}
        {popAt(i) !== null && r.kind !== "app" && r.kind !== "group" && (
          <circle className="nd-burst" cx={x} cy={y} r={6} style={{ stroke: `var(--lane-${r.lane % 10})` }} />
        )}
        <circle className="hit" cx={x} cy={y} r={9} />
      </g>
    );
  };

  const headRow = history.head ? layout.rowOf.get(history.head) : undefined;

  return (
    <div className="oview">
      <div className="o-bar">
        <div className="mini-seg" role="radiogroup" aria-label={tr("ブランチの見せ方")}>
          <span className="mini-seg-label">{tr("ブランチの見せ方")}</span>
          <button type="button" className={props.branchStyle === "label" ? "on" : ""} onClick={() => props.onBranchStyleChange("label")}>
            {tr("ラベル")}
          </button>
          <button type="button" className={props.branchStyle === "line" ? "on" : ""} onClick={() => props.onBranchStyleChange("line")}>
            {tr("線")}
          </button>
        </div>
        <span className="o-legend">
          <i className="lg-dot" /> {" "}{tr("コミット")}{" "} <i className="lg-merge" /> {" "}{tr("マージ")}{" "} <i className="lg-app" /> {" "}{tr("自動コミット（まとめ）")}
          {wip && (
            <>
              <i className="lg-wip" /> {" "}{tr("作業中")}
            </>
          )}
        </span>
        <span className="o-tools">
          <BranchPicker
            entries={entries}
            selected={selected}
            byHash={props.byHash}
            local={local}
            onPick={props.onSelect}
            onMenu={props.onBranchMenu}
          />
        </span>
      </div>

      <div className="o-scroll" ref={scrollRef} onScroll={() => setTip(null)}>
        <div
          className={`o-canvas${reveal ? " o-reveal" : ""}`}
          style={{ width: 96 + labelsX + labelsW, height: HEAD_H + height, ...(reveal ? { ["--o-end" as string]: `${reveal.end}ms` } : {}) }}
        >
          {/* レーン・線の名前 */}
          <div className="o-head" style={{ height: HEAD_H }}>
            {defaultEntry && (
              <span
                className="lh c0"
                style={{ left: 96 + laneX(0) }}
                title={defaultEntry.name}
                onContextMenu={branchMenu(defaultEntry.name)}
              >
                <i className="cdot" />
                <FlowingName className="lh-name" text={defaultEntry.name} />
              </span>
            )}
            {currentEntry && !currentEntry.isDefault && layout.laneCount > 1 && (
              <span
                className="lh c1"
                style={{ left: 96 + laneX(1) }}
                title={currentEntry.name}
                onContextMenu={branchMenu(currentEntry.name)}
              >
                <i className="cdot" />
                <FlowingName className="lh-name" text={currentEntry.name} />
              </span>
            )}
            {lifelines.map((l) => (
              <button
                key={l.entry.name}
                type="button"
                className={`lh ${colorClass(l.column + 2)}`}
                style={{ left: 96 + lifeX(l.column) }}
                title={l.entry.name}
                onClick={() => props.onOpenCommit(l.entry.tip)}
                onContextMenu={branchMenu(l.entry.name)}
              >
                <i className="cdot" />
                <FlowingName className="lh-name" text={l.entry.name} />
              </button>
            ))}
          </div>

          {/* 日付 */}
          <div className="o-dates" style={{ top: HEAD_H }}>
            {wip && (
              <span className="o-date now" style={{ top: 0 }}>
                {tr("いま")}
              </span>
            )}
            {dayStarts.map((d) => (
              <span key={d.row} className={`o-date${fadeAt(d.row) === null ? "" : " fade"}`} style={{ top: (d.row + offset) * ROW_H, ...at(fadeAt(d.row)) }}>
                {d.label}
              </span>
            ))}
          </div>

          <svg className="o-svg" width={svgW} height={height} style={{ left: 96, top: HEAD_H }}>
            {dayStarts.slice(1).map((d) => (
              <line
                key={d.row}
                className={`day-line${fadeAt(d.row) === null ? "" : " fade"}`}
                style={at(fadeAt(d.row))}
                x1={0}
                x2={svgW}
                y1={(d.row + offset) * ROW_H}
                y2={(d.row + offset) * ROW_H}
              />
            ))}
            {layout.edges.map((e, i) => {
              const open = e.to >= layout.rows.length;
              // 実線は下の点から上の点へ伸ばす。読み込んだ先へ続く点線は、上の点が出たあとに薄く出す
              const rv = reveal ? edgeReveal(e.from, e.to, reveal.first, reveal.last, reveal.step) : null;
              return (
                <path
                  key={i}
                  className={`ln ${colorClass(e.kind === "merge" ? e.toLane : e.fromLane)}${open ? " open" : ""}${rv ? (open ? " fade" : " draw") : ""}`}
                  d={edgePath(e)}
                  pathLength={rv && !open ? 1 : undefined}
                  style={rv ? ({ "--d": `${open ? rv.delay + rv.duration : rv.delay}ms`, "--len": `${rv.duration}ms` } as CSSProperties) : undefined}
                />
              );
            })}
            {lifelines.map((l) => {
              const x1 = laneX(layout.rows[l.row].lane);
              const y1 = rowY(l.row);
              const x2 = lifeX(l.column);
              return (
                <g
                  key={l.entry.name}
                  className={`life${fadeAt(l.row) === null ? "" : " fade"}`}
                  style={at(fadeAt(l.row))}
                  onMouseMove={(ev) => setTip({ x: x2, y: y1, row: null, life: l.entry, clientX: ev.clientX, clientY: ev.clientY })}
                  onMouseLeave={() => setTip(null)}
                  onClick={() => props.onOpenCommit(l.entry.tip)}
                  onContextMenu={branchMenu(l.entry.name)}
                >
                  <path className={`ln cut ${colorClass(l.column + 2)}`} d={`M${x1},${y1} C${x1},${y1 - 12} ${x2},${y1 - 8} ${x2},${y1 - ROW_H} V0`} />
                  <path className="hit-line" d={`M${x1},${y1} C${x1},${y1 - 12} ${x2},${y1 - 8} ${x2},${y1 - ROW_H} V0`} />
                </g>
              );
            })}
            {wip && headRow !== undefined && (
              <g className="wip-node" onClick={props.onOpenWork}>
                <path className={`ln wip-ln ${colorClass(layout.rows[headRow].lane)}`} d={`M${laneX(layout.rows[headRow].lane)},${ROW_H / 2} V${rowY(headRow)}`} />
                <circle className={`nd wip ${colorClass(layout.rows[headRow].lane)}`} cx={laneX(layout.rows[headRow].lane)} cy={ROW_H / 2} r={6} />
                <circle className="hit" cx={laneX(layout.rows[headRow].lane)} cy={ROW_H / 2} r={10} />
              </g>
            )}
            {!lineMode &&
              layout.rows.map((r, i) =>
                r.chips.length ? (
                  <line
                    key={`leader-${i}`}
                    className={`leader${fadeAt(i) === null ? "" : " fade"}`}
                    style={at(fadeAt(i))}
                    x1={laneX(r.lane) + 9}
                    x2={svgW}
                    y1={rowY(i)}
                    y2={rowY(i)}
                  />
                ) : null,
              )}
            {layout.rows.map(node)}
            {headRow !== undefined && (
              <circle className={`nd-ring ${colorClass(layout.rows[headRow].lane)}`} cx={laneX(layout.rows[headRow].lane)} cy={rowY(headRow)} r={8.5} />
            )}
          </svg>

          {/* ラベル（「ラベル」のときだけ） */}
          <div className="o-labels" style={{ left: 96 + labelsX, top: HEAD_H }}>
            {wip && (
              <div className="lbl-row" style={{ top: 0 }}>
                <button type="button" className="rchip wip-chip" onClick={props.onOpenWork}>
                  {trx("✎ 作業中の変更 {changes}", { changes: props.changes })}
                </button>
              </div>
            )}
            {!lineMode &&
              layout.rows.map((r, i) =>
                r.chips.length ? (
                  <div key={i} className={`lbl-row${fadeAt(i) === null ? "" : " fade"}`} style={{ top: (i + offset) * ROW_H, ...at(fadeAt(i)) }}>
                    {r.chips.map((c) => (
                      <span
                        key={`${c.kind}:${c.name}`}
                        className={`rchip ${c.kind}`}
                        onContextMenu={c.kind === "tag" ? undefined : branchMenu(c.name)}
                      >
                        {chipLabel(c)}
                      </span>
                    ))}
                  </div>
                ) : null,
              )}
          </div>
        </div>
      </div>

      {tip && <OverviewTip tip={tip} home={props.home} history={history} />}
    </div>
  );
}

// --- マウスを重ねたときのカード ---

function OverviewTip({
  tip,
  home,
  history,
}: {
  tip: Tip & { clientX: number; clientY: number };
  home: Map<string, string>;
  history: GitHistory;
}) {
  const style = { left: Math.min(tip.clientX + 14, window.innerWidth - 340), top: tip.clientY + 14 };
  if (tip.life) {
    const c = history.commits.find((x) => x.hash === tip.life!.tip);
    return (
      <div className="o-tip popover" style={style} role="tooltip">
        <div className="t-title">🌿 {tip.life.name}</div>
        {c && <div className="t-sub">{trx("先頭のコミット: {subject}", { subject: c.subject })}</div>}
        {c && <div className="t-when">{shortWhen(c.date)} · {c.hash.slice(0, 7)}</div>}
        <div className="t-hint">{trx("クリックで {name} を表示", { name: tip.life.name })}</div>
      </div>
    );
  }
  const r = tip.row!;
  const c = r.commits[0];
  const where = home.get(c.hash);
  return (
    <div className="o-tip popover" style={style} role="tooltip">
      {r.chips.length > 0 && (
        <div className="t-chips">
          {r.chips.map((ch) => (
            <span key={`${ch.kind}:${ch.name}`} className={`rchip ${ch.kind}`}>{ch.name}</span>
          ))}
        </div>
      )}
      {r.kind === "group" ? (
        <>
          <div className="t-title">{trx("🤖 アプリの自動コミット {length} 件", { length: r.commits.length })}</div>
          <div className="t-sub">{appCommitBreakdown(r.commits)}</div>
          <div className="t-when">
            {shortWhen(r.commits[r.commits.length - 1].date)} 〜 {shortWhen(c.date)}
          </div>
        </>
      ) : (
        <>
          <div className="t-title">{c.subject}</div>
          {r.kind === "merge" && <div className="t-sub">{tr("マージ（2 つの流れを 1 つにまとめたコミット）")}</div>}
          <div className="t-when">
            {shortWhen(c.date)} · {c.hash.slice(0, 7)} · {c.author}
          </div>
        </>
      )}
      {where && <div className="t-hint">{trx("クリックで {where} のこのコミットへ", { where })}</div>}
    </div>
  );
}
