import { useState, useEffect, useCallback, useMemo, useRef, type ReactElement } from "react";
import type { GitHubIssue, GitHubMilestone } from "../../lib/types";
import { daysUntil } from "../../lib/due";
import { JournalCalendar, calendarMilestones, calendarTasks, fromYmd, md, ymd } from "./JournalCalendar";
import { tr, trx } from "../../lib/i18n";

interface TimelineViewProps {
  issues: GitHubIssue[];
  closedIssues: GitHubIssue[];
  milestones: GitHubMilestone[];
  /** ログインしている人（自分の担当の帯に、ふちをつける） */
  me: string;
  onGenerateJournal: (date: string) => Promise<string>;
  onGetJournal: (date: string) => Promise<string>;
  onListJournalDates: () => Promise<string[]>;
  onSaveNotes: (date: string, notes: string) => Promise<string>;
  onSelectIssue: (n: number) => void;
}

const weekdayLabels = [tr("日"), tr("月"), tr("火"), tr("水"), tr("木"), tr("金"), tr("土")];

/** 帯の色の順（予定の並び） */
const KIND_ORDER = { prog: 0, check: 1, block: 2, todo: 3, done: 4 } as const;

/** スマホ・せまい窓か（カレンダーを点で書き、日誌を下に並べる） */
function useNarrow(query = "(max-width: 900px)"): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = (e: MediaQueryListEvent) => setNarrow(e.matches);
    mq.addEventListener("change", on);
    setNarrow(mq.matches);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return narrow;
}

/**
 * 日誌: 左にカレンダー（タスクの期間の帯・マイルストーンの期限 🎯・日誌を書いた日の 📓）、右に選んだ日（その日の予定と、その日の日誌）。
 * 日誌は 1 日 1 つ（リポジトリの journal/日付.md）。ノートはその場で書いて保存、「更新」でその日の動きから作り直す
 */
export function TimelineView({ issues, closedIssues, milestones, me, onGenerateJournal, onGetJournal, onListJournalDates, onSaveNotes, onSelectIssue }: TimelineViewProps) {
  const [selectedDate, setSelectedDate] = useState(ymd(new Date()));
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [journalDates, setJournalDates] = useState<Set<string>>(new Set());
  const [journalContent, setJournalContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [notesText, setNotesText] = useState("");
  const [savedNotesText, setSavedNotesText] = useState("");
  const [savingNotes, setSavingNotes] = useState(false);
  const narrow = useNarrow();
  const today = ymd(new Date());

  function extractNotes(md: string): string {
    const marker = tr("## ノート\n");
    const idx = md.indexOf(marker);
    if (idx < 0) return "";
    const rest = md.substring(idx + marker.length);
    const nextSection = rest.indexOf("\n## ");
    const body = nextSection >= 0 ? rest.substring(0, nextSection) : rest;
    return body.trimEnd();
  }

  // 親が描き直すたびに関数が作り直されても読み直さないよう、最新の関数を覚えておく（書きかけのノートが消えないように）
  const getJournalRef = useRef(onGetJournal);
  getJournalRef.current = onGetJournal;
  const listDatesRef = useRef(onListJournalDates);
  listDatesRef.current = onListJournalDates;

  // 日誌がある日（📓）
  useEffect(() => {
    let alive = true;
    void listDatesRef.current().then((dates) => {
      if (alive) setJournalDates(new Set(dates));
    });
    return () => {
      alive = false;
    };
  }, []);

  /** 日誌を読めた・作れた日を、📓 の日に足す */
  const markJournal = useCallback((date: string) => {
    setJournalDates((prev) => (prev.has(date) ? prev : new Set(prev).add(date)));
  }, []);

  const fetchJournal = useCallback(async (date: string) => {
    setLoading(true);
    try {
      const content = await getJournalRef.current(date);
      setJournalContent(content);
      const n = extractNotes(content);
      setNotesText(n);
      setSavedNotesText(n);
      if (content) markJournal(date);
    } catch {
      setJournalContent("");
      setNotesText("");
      setSavedNotesText("");
    } finally {
      setLoading(false);
    }
  }, [markJournal]);

  useEffect(() => {
    fetchJournal(selectedDate);
  }, [selectedDate, fetchJournal]);

  /** 日を選ぶ（ほかの月の日なら、カレンダーもその月へ） */
  function selectDate(date: string) {
    setSelectedDate(date);
    const d = fromYmd(date);
    setMonth((m) => (m.getFullYear() === d.getFullYear() && m.getMonth() === d.getMonth() ? m : new Date(d.getFullYear(), d.getMonth(), 1)));
  }

  function moveDay(delta: number) {
    const d = fromYmd(selectedDate);
    d.setDate(d.getDate() + delta);
    selectDate(ymd(d));
  }

  function moveMonth(delta: number) {
    setMonth((m) => new Date(m.getFullYear(), m.getMonth() + delta, 1));
  }

  async function handleGenerate() {
    setGenerating(true);
    try {
      const content = await onGenerateJournal(selectedDate);
      setJournalContent(content);
      const n = extractNotes(content);
      setNotesText(n);
      setSavedNotesText(n);
      markJournal(selectedDate);
    } catch {
      // handled by useGitHub setStatus
    } finally {
      setGenerating(false);
    }
  }

  async function handleSaveNotes() {
    setSavingNotes(true);
    try {
      const updatedContent = await onSaveNotes(selectedDate, notesText);
      setJournalContent(updatedContent);
      setSavedNotesText(notesText);
    } catch {
      // handled by useGitHub setStatus
    } finally {
      setSavingNotes(false);
    }
  }

  // ノートセクションを除いたMarkdownを返す
  function stripNotesSection(md: string): string {
    const marker = tr("## ノート\n");
    const idx = md.indexOf(marker);
    if (idx < 0) return md;
    const before = md.substring(0, idx);
    const rest = md.substring(idx + marker.length);
    const nextSection = rest.indexOf("\n## ");
    if (nextSection >= 0) {
      return before.trimEnd() + rest.substring(nextSection);
    }
    return before.trimEnd();
  }

  const notesDirty = notesText !== savedNotesText;

  function renderMarkdown(md: string) {
    const lines = md.split("\n");
    const elements: ReactElement[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.startsWith("## ")) {
        elements.push(
          <h3 key={i} className="jv-jsec">
            {line.substring(3)}
          </h3>
        );
        continue;
      }

      if (line.startsWith("- ")) {
        const text = line.substring(2);
        const parts = text.split(/(\[#\d+\])/g);
        elements.push(
          <div key={i} style={{ padding: "3px 0 3px 12px", fontSize: "var(--font-md)", color: "var(--text-secondary)" }}>
            <span style={{ color: "var(--text-faint)", marginRight: "6px" }}>-</span>
            {parts.map((part, j) => {
              if (/^\[#\d+\]$/.test(part)) {
                const num = parseInt(part.replace(/[^\d]/g, ""));
                return (
                  <span key={j} style={{ color: "var(--accent-blue)", fontWeight: 500, cursor: "pointer", textDecoration: "underline" }}
                    onClick={() => onSelectIssue(num)}>
                    {part}
                  </span>
                );
              }
              const labelMatch = part.match(/\(((?:セクション|分野):[^)]+)\)/);
              if (labelMatch) {
                const before = part.substring(0, part.indexOf("("));
                const label = labelMatch[1];
                return (
                  <span key={j}>
                    {before}
                    <span style={{
                      display: "inline-block", padding: "1px 6px", borderRadius: "10px",
                      fontSize: "var(--font-xs)", fontWeight: 600, backgroundColor: "var(--bg-tertiary)", color: "var(--text-muted)",
                    }}>
                      {label}
                    </span>
                  </span>
                );
              }
              return <span key={j}>{part}</span>;
            })}
          </div>
        );
        continue;
      }

      if (line.trim() === "") {
        elements.push(<div key={i} style={{ height: "4px" }} />);
        continue;
      }

      elements.push(
        <p key={i} style={{ fontSize: "var(--font-md)", color: "var(--text-secondary)", margin: "2px 0" }}>
          {line}
        </p>
      );
    }

    return elements;
  }

  // カレンダーの帯とマイルストーン（開いている・閉じた Issue の両方）
  const tasks = useMemo(() => calendarTasks([...issues, ...closedIssues], me), [issues, closedIssues, me]);
  const calMilestones = useMemo(() => calendarMilestones(milestones), [milestones]);

  // 選んだ日の予定: その日にかかっているタスク、その日が期限のマイルストーン（なければ次のマイルストーン）
  const dayTasks = tasks
    .filter((t) => t.start <= selectedDate && selectedDate <= t.end)
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.number - b.number);
  const dayMilestones = calMilestones.filter((m) => m.date === selectedDate);
  const nextMilestone = dayMilestones.length > 0 ? null : calMilestones.filter((m) => m.open && m.date > selectedDate).sort((a, b) => a.date.localeCompare(b.date))[0] ?? null;
  const planCount = dayTasks.length + dayMilestones.length;

  const sel = fromYmd(selectedDate);
  const weekday = weekdayLabels[sel.getDay()];
  const isToday = selectedDate === today;

  const plans = (
    <div className="jv-sec">
      <h3 className="jv-sec-title">
        {trx("この日の予定 <0>{planCount} 件</0>", { planCount }, [<small />])}
      </h3>
      {dayTasks.map((t) => (
        <button key={t.number} type="button" className="jv-plan" onClick={() => onSelectIssue(t.number)} title={`#${t.number} ${t.title}`}>
          <span className={`jv-st k-${t.kind}`}>{t.status}</span>
          <span className="jv-plan-t">
            <span className="jv-no">#{t.number}</span> {t.title}
          </span>
          {t.end === selectedDate ? (
            <span className="jv-due">{tr("この日が期限")}</span>
          ) : (
            <span className="jv-when">{t.start === selectedDate ? tr("この日から（〜{md}）", { md: md(t.end) }) : `${md(t.start)}〜${md(t.end)}`}</span>
          )}
        </button>
      ))}
      {dayMilestones.map((m) => (
        <div key={m.number} className="jv-plan ms">
          {trx("<0>🎯</0><1>{title}</1><2>この日が期限</2>", { title: m.title }, [<span aria-hidden="true" />, <span className="jv-plan-t" />, <span className="jv-due" />])}
        </div>
      ))}
      {nextMilestone && (
        <div className="jv-plan ms next">
          <span aria-hidden="true">🎯</span>
          <span className="jv-plan-t">{nextMilestone.title}</span>
          <span className="jv-when">
            {trx("次の期限 {md}", { md: md(nextMilestone.date) })}
            {isToday ? tr("（あと {daysUntil} 日）", { daysUntil: daysUntil(nextMilestone.date) }) : ""}
          </span>
        </div>
      )}
      {planCount === 0 && !nextMilestone && <p className="jv-none">{tr("この日の予定はありません")}</p>}
    </div>
  );

  const journal = (
    <div className="jv-sec">
      <h3 className="jv-sec-title">
        {tr("📓 日誌")}
        <span className="grow" />
        <button type="button" className="btn-primary jv-btn" onClick={handleGenerate} disabled={generating || loading}>
          {generating ? tr("作っています…") : journalContent ? tr("更新") : tr("日誌を作る")}
        </button>
      </h3>
      {loading ? (
        <div className="empty-message">{tr("読み込み中...")}</div>
      ) : journalContent ? (
        <>
          {/* ノート（インライン編集） */}
          <div className="jv-note">
            <div className="jv-note-head">
              <span>{tr("ノート")}</span>
              {notesDirty && (
                <button type="button" className="btn-primary jv-btn" onClick={handleSaveNotes} disabled={savingNotes}>
                  {savingNotes ? tr("保存中...") : tr("保存")}
                </button>
              )}
            </div>
            <textarea value={notesText} onChange={(e) => setNotesText(e.target.value)} placeholder={tr("この日のメモを自由に記入...")} />
          </div>
          {/* 残りのセクション（題名の行とノートを除いて表示） */}
          {renderMarkdown(stripNotesSection(journalContent).split("\n").filter((l) => !l.startsWith("# ")).join("\n"))}
        </>
      ) : (
        <p className="jv-none">{tr("この日の日誌はまだありません")}</p>
      )}
    </div>
  );

  return (
    <div className={`content journal-view${narrow ? " narrow" : ""}`}>
      <section className="form-card jv-cal">
        <JournalCalendar
          month={month}
          selected={selectedDate}
          today={today}
          journals={journalDates}
          tasks={tasks}
          milestones={calMilestones}
          compact={narrow}
          onSelect={selectDate}
          onMonth={moveMonth}
          onToday={() => selectDate(today)}
          onOpenIssue={onSelectIssue}
        />
      </section>
      <section className="form-card jv-day" aria-label={tr("{v}月{getDate}日", { v: sel.getMonth() + 1, getDate: sel.getDate() })}>
        <div className="jv-day-head">
          <h2>
            {sel.getMonth() + 1} {" "}{trx("月 {getDate} 日（{weekday}）", { getDate: sel.getDate(), weekday })}
          </h2>
          {isToday && <span className="jv-today">{tr("今日")}</span>}
          <span className="grow" />
          <button type="button" className="btn-sm" onClick={() => moveDay(-1)} aria-label={tr("前の日")}>◀</button>
          <button type="button" className="btn-sm" onClick={() => moveDay(1)} aria-label={tr("次の日")}>▶</button>
        </div>
        {plans}
        {journal}
      </section>
    </div>
  );
}
