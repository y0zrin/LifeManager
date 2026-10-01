import type { GitHubIssue, GitHubMilestone } from "../../lib/types";
import { parseGanttDates } from "../../lib/ganttParser";
import { isSending } from "../../lib/issueRef";

/** カレンダーの帯（ガントの日付があるタスク）。kind は帯の色（状態） */
export interface CalTask {
  number: number;
  title: string;
  /** YYYY-MM-DD */
  start: string;
  end: string;
  kind: "prog" | "check" | "block" | "todo" | "done";
  /** 状態の名前（「進行中」など。閉じていれば「完了」） */
  status: string;
  mine: boolean;
}

/** カレンダーのマイルストーン（期限の日に 🎯） */
export interface CalMilestone {
  number: number;
  title: string;
  /** YYYY-MM-DD */
  date: string;
  open: boolean;
}

const CHECK_STATES = new Set(["状態:チェック待ち", "状態:動作確認", "状態:完了承認待ち"]);

/** "YYYY-MM-DD"（この PC の日付で） */
export function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** "YYYY-MM-DD" → この PC の日付の Date */
export function fromYmd(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** "YYYY-MM-DD" → 「9/29」 */
export function md(s: string): string {
  const [, m, d] = s.split("-").map(Number);
  return `${m}/${d}`;
}

/** ガントの日付があるタスク（閉じたものも。送っている途中の仮の Issue は出さない） */
export function calendarTasks(issues: GitHubIssue[], me: string): CalTask[] {
  return issues.flatMap((i) => {
    if (isSending(i.number)) return [];
    const g = parseGanttDates(i.body);
    if (!g) return [];
    const st = i.labels.find((l) => l.name.startsWith("状態:"))?.name ?? "";
    const kind: CalTask["kind"] =
      i.state === "closed" ? "done" : st === "状態:進行中" ? "prog" : CHECK_STATES.has(st) ? "check" : st === "状態:ブロック" ? "block" : "todo";
    const status = i.state === "closed" ? "完了" : st ? st.replace("状態:", "") : "状態なし";
    return [{ number: i.number, title: i.title, start: g.start, end: g.end, kind, status, mine: !!me && (i.assignees ?? []).some((a) => a.login === me) }];
  });
}

/** 期限のあるマイルストーン */
export function calendarMilestones(milestones: GitHubMilestone[]): CalMilestone[] {
  return milestones
    .filter((m) => m.due_on)
    .map((m) => ({ number: m.number, title: m.title, date: (m.due_on as string).substring(0, 10), open: m.state !== "closed" }));
}

/** 1 日に重ねて書く帯の数（それより多いと「+2」） */
const LANES = 3;
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

interface JournalCalendarProps {
  /** 見ている月（その月の 1 日） */
  month: Date;
  selected: string;
  today: string;
  journals: Set<string>;
  tasks: CalTask[];
  milestones: CalMilestone[];
  /** スマホ: 帯の代わりに点で */
  compact: boolean;
  onSelect: (date: string) => void;
  onMonth: (delta: number) => void;
  onToday: () => void;
  onOpenIssue: (n: number) => void;
}

/**
 * 日誌のカレンダー（1 か月）。タスクの期間（ガントの開始〜終了）を状態の色の帯で、マイルストーンの期限を 🎯 で書き、
 * 日誌を書いた日に 📓 をつける。日を押すと、その日を選ぶ（右に、その日の予定と日誌）。帯を押すと、そのタスクの詳細
 */
export function JournalCalendar({ month, selected, today, journals, tasks, milestones, compact, onSelect, onMonth, onToday, onOpenIssue }: JournalCalendarProps) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const weeksCount = Math.ceil((first.getDay() + daysInMonth) / 7);
  const gridStart = new Date(first);
  gridStart.setDate(1 - first.getDay());
  const weeks = Array.from({ length: weeksCount }, (_, w) =>
    Array.from({ length: 7 }, (_, i) => {
      const d = new Date(gridStart);
      d.setDate(gridStart.getDate() + w * 7 + i);
      return d;
    }),
  );
  const msByDate = new Map<string, CalMilestone[]>();
  for (const m of milestones) msByDate.set(m.date, [...(msByDate.get(m.date) ?? []), m]);

  const head = (
    <div className="jc-head">
      <button type="button" className="jc-nav" onClick={() => onMonth(-1)} aria-label="前の月">◀</button>
      <span className="jc-month">
        <small>{month.getFullYear()} 年</small>
        {month.getMonth() + 1} 月
      </span>
      <button type="button" className="jc-nav" onClick={() => onMonth(1)} aria-label="次の月">▶</button>
      <button type="button" className="btn-sm jc-today" onClick={onToday}>今日</button>
      {!compact && (
        <span className="jc-legend" aria-hidden="true">
          <span><i className="jc-swatch" />タスクの期間</span>
          <span>🎯 マイルストーンの期限</span>
          <span>📓 日誌あり</span>
        </span>
      )}
    </div>
  );
  const dows = (
    <div className="jc-dows" aria-hidden="true">
      {WEEKDAYS.map((w, i) => (
        <span key={w} className={i === 0 ? "sun" : i === 6 ? "sat" : undefined}>{w}</span>
      ))}
    </div>
  );
  const dayLabel = (d: Date) => `${d.getMonth() + 1}月${d.getDate()}日`;

  if (compact) {
    // スマホ: 日ごとに、状態の色の点（4 つまで）と 🎯・📓
    return (
      <div className="jc jc--compact">
        {head}
        {dows}
        <div className="jc-mgrid">
          {weeks.flat().map((d) => {
            const key = ymd(d);
            const on = tasks.filter((t) => t.start <= key && key <= t.end).slice(0, 4);
            const out = d.getMonth() !== month.getMonth();
            return (
              <button key={key} type="button" className={`jc-mday${out ? " out" : ""}${key === today ? " today" : ""}${key === selected ? " sel" : ""}`}
                onClick={() => onSelect(key)} aria-label={dayLabel(d)} aria-pressed={key === selected}>
                <b>{d.getDate()}</b>
                {journals.has(key) && <span className="jc-jr">📓</span>}
                <span className="jc-dots">
                  {on.map((t) => <i key={t.number} className={`k-${t.kind}`} />)}
                </span>
                {msByDate.has(key) && <span className="jc-flag">🎯</span>}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="jc">
      {head}
      {dows}
      <div className="jc-weeks" style={{ gridTemplateRows: `repeat(${weeksCount}, minmax(96px, 1fr))` }}>
        {weeks.map((days) => {
          const a0 = ymd(days[0]);
          const a6 = ymd(days[6]);
          // この週にかかるタスクを、空いている段に置く（はじめの日が早い順、同じなら長い順）
          const lanes: [number, number][][] = Array.from({ length: LANES }, () => []);
          const over = Array<number>(7).fill(0);
          const bars: { t: CalTask; a: number; b: number; lane: number }[] = [];
          const week = tasks
            .filter((t) => t.start <= a6 && t.end >= a0)
            .sort((x, y) => (x.start < y.start ? -1 : x.start > y.start ? 1 : y.end.localeCompare(x.end)));
          for (const t of week) {
            const a = Math.max(0, Math.round((fromYmd(t.start).getTime() - days[0].getTime()) / 86400000));
            const b = Math.min(6, Math.round((fromYmd(t.end).getTime() - days[0].getTime()) / 86400000));
            const lane = lanes.findIndex((l) => l.every(([x, y]) => b < x || a > y));
            if (lane < 0) {
              for (let i = a; i <= b; i++) over[i]++;
              continue;
            }
            lanes[lane].push([a, b]);
            bars.push({ t, a, b, lane });
          }
          return (
            <div key={a0} className="jc-week">
              {days.map((d, i) => {
                const key = ymd(d);
                const out = d.getMonth() !== month.getMonth();
                return (
                  <button key={key} type="button" className={`jc-day${out ? " out" : ""}${key === today ? " today" : ""}${key === selected ? " sel" : ""}`}
                    style={{ gridColumn: i + 1 }} onClick={() => onSelect(key)} aria-label={dayLabel(d)} aria-pressed={key === selected} />
                );
              })}
              {days.map((d, i) => {
                const key = ymd(d);
                const out = d.getMonth() !== month.getMonth();
                return (
                  <span key={`n${key}`} className={`jc-num${i === 0 ? " sun" : i === 6 ? " sat" : ""}${out ? " out" : ""}${key === today ? " today" : ""}`} style={{ gridColumn: i + 1 }}>
                    {key === today ? <b>{d.getDate()}</b> : d.getDate() === 1 ? `${d.getMonth() + 1}/1` : d.getDate()}
                  </span>
                );
              })}
              {days.map((d, i) => {
                const key = ymd(d);
                return journals.has(key) ? <span key={`j${key}`} className="jc-jr" style={{ gridColumn: i + 1 }} title="日誌あり">📓</span> : null;
              })}
              {days.map((d, i) => {
                const list = msByDate.get(ymd(d));
                if (!list) return null;
                return (
                  <span key={`m${ymd(d)}`} className={`jc-ms${list.every((m) => !m.open) ? " closed" : ""}`} style={{ gridColumn: i + 1 }} title={list.map((m) => `🎯 ${m.title} の期限`).join("\n")}>
                    🎯 {list[0].title}{list.length > 1 ? ` ほか ${list.length - 1}` : ""}
                  </span>
                );
              })}
              {bars.map(({ t, a, b, lane }) => {
                const contL = t.start < a0;
                const contR = t.end > a6;
                return (
                  <button key={t.number} type="button"
                    className={`jc-bar k-${t.kind}${t.mine ? " mine" : ""}${contL ? " cont-l" : ""}${contR ? " cont-r" : ""}`}
                    style={{ gridColumn: `${a + 1} / ${b + 2}`, gridRow: 3 + lane }}
                    title={`#${t.number} ${t.title}（${t.status}・${md(t.start)}〜${md(t.end)}）`}
                    onClick={() => onOpenIssue(t.number)}>
                    {contL ? "" : `#${t.number} `}
                    {t.title}
                  </button>
                );
              })}
              {over.map((n, i) => (n > 0 ? <span key={`o${i}`} className="jc-more" style={{ gridColumn: i + 1 }}>+{n}</span> : null))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
