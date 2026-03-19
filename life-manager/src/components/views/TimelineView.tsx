import { useState, useEffect, useCallback, type ReactElement } from "react";
import { DatePickerButton } from "../common/DatePickerButton";

interface TimelineViewProps {
  onGenerateJournal: (date: string) => Promise<string>;
  onGetJournal: (date: string) => Promise<string>;
  onSaveNotes: (date: string, notes: string) => Promise<string>;
  onSelectIssue: (n: number) => void;
}

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const weekdayLabels = ["日", "月", "火", "水", "木", "金", "土"];

/** "YYYY-MM-DD" をローカルタイムの Date に変換 */
function parseLocalDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** "YYYY-MM-DD" から曜日インデックス(0=日〜6=土)を Date 非依存で計算 (Sakamoto算法) */
function dayOfWeek(dateStr: string): number {
  const t = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
  let [y, m, d] = dateStr.split("-").map(Number);
  if (m < 3) y -= 1;
  return (y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) + t[m - 1] + d) % 7;
}

export function TimelineView({ onGenerateJournal, onGetJournal, onSaveNotes, onSelectIssue }: TimelineViewProps) {
  const [selectedDate, setSelectedDate] = useState(formatDate(new Date()));
  const [journalContent, setJournalContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [notesText, setNotesText] = useState("");
  const [savedNotesText, setSavedNotesText] = useState("");
  const [savingNotes, setSavingNotes] = useState(false);

  function extractNotes(md: string): string {
    const marker = "## ノート\n";
    const idx = md.indexOf(marker);
    if (idx < 0) return "";
    const rest = md.substring(idx + marker.length);
    const nextSection = rest.indexOf("\n## ");
    const body = nextSection >= 0 ? rest.substring(0, nextSection) : rest;
    return body.trimEnd();
  }

  const fetchJournal = useCallback(async (date: string) => {
    setLoading(true);
    try {
      const content = await onGetJournal(date);
      setJournalContent(content);
      const n = extractNotes(content);
      setNotesText(n);
      setSavedNotesText(n);
    } catch {
      setJournalContent("");
      setNotesText("");
      setSavedNotesText("");
    } finally {
      setLoading(false);
    }
  }, [onGetJournal]);

  useEffect(() => {
    fetchJournal(selectedDate);
  }, [selectedDate, fetchJournal]);

  function handlePrevDay() {
    const d = parseLocalDate(selectedDate);
    d.setDate(d.getDate() - 1);
    setSelectedDate(formatDate(d));
  }

  function handleNextDay() {
    const d = parseLocalDate(selectedDate);
    d.setDate(d.getDate() + 1);
    setSelectedDate(formatDate(d));
  }

  function handleToday() {
    setSelectedDate(formatDate(new Date()));
  }

  async function handleGenerate() {
    setGenerating(true);
    try {
      const content = await onGenerateJournal(selectedDate);
      setJournalContent(content);
      const n = extractNotes(content);
      setNotesText(n);
      setSavedNotesText(n);
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
    const marker = "## ノート\n";
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

      if (line.startsWith("# ")) {
        elements.push(
          <h2 key={i} style={{ fontSize: "var(--font-2xl)", fontWeight: 600, margin: "0 0 12px 0", color: "var(--text-primary)" }}>
            {line.substring(2)}
          </h2>
        );
        continue;
      }

      if (line.startsWith("## ")) {
        elements.push(
          <h3 key={i} style={{
            fontSize: "var(--font-lg)", fontWeight: 600, margin: "16px 0 8px 0",
            color: "var(--accent-blue)", borderBottom: "1px solid var(--border-subtle)", paddingBottom: "4px",
          }}>
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
              const labelMatch = part.match(/\((分野:[^)]+)\)/);
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

  const weekday = weekdayLabels[dayOfWeek(selectedDate)];
  const isToday = selectedDate === formatDate(new Date());

  return (
    <div className="content">
      {/* 日付ナビゲーション */}
      <div className="flex-row flex-wrap" style={{ marginBottom: "var(--space-md)" }}>
        <button className="btn-sm" onClick={handlePrevDay}>&#9664; 前日</button>
        <button className="btn-sm" onClick={handleToday}>今日</button>
        <button className="btn-sm" onClick={handleNextDay}>翌日 &#9654;</button>
        <DatePickerButton value={selectedDate} onChange={setSelectedDate} />
        <span style={{ color: "var(--text-muted)", fontSize: "var(--font-md)" }}>
          {selectedDate} ({weekday || "?"})
          {isToday && <span style={{ color: "var(--accent-blue)", marginLeft: "6px" }}>今日</span>}
        </span>
      </div>

      {/* ツールバー */}
      <div className="toolbar">
        <button className="btn-primary" onClick={handleGenerate} disabled={generating}>
          {generating ? "生成中..." : "更新"}
        </button>
      </div>

      {/* ジャーナル表示 */}
      {loading ? (
        <div className="empty-message">読み込み中...</div>
      ) : journalContent ? (
        <div className="form-card" style={{ padding: "var(--space-lg)" }}>
          {/* タイトル部分（# で始まる行） */}
          {journalContent.split("\n").filter(l => l.startsWith("# ")).map((line, i) => (
            <h2 key={`title-${i}`} style={{ fontSize: "var(--font-2xl)", fontWeight: 600, margin: "0 0 12px 0", color: "var(--text-primary)" }}>
              {line.substring(2)}
            </h2>
          ))}

          {/* ノート（インライン編集） */}
          <div style={{
            margin: "8px 0 16px 0",
            padding: "var(--space-sm)",
            backgroundColor: "var(--bg-secondary)",
            borderRadius: "var(--radius-md)",
            borderLeft: "3px solid var(--accent-blue)",
          }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "6px" }}>
              <span style={{ fontSize: "var(--font-sm)", fontWeight: 600, color: "var(--accent-blue)" }}>ノート</span>
              {notesDirty && (
                <button
                  className="btn-primary"
                  onClick={handleSaveNotes}
                  disabled={savingNotes}
                  style={{ fontSize: "var(--font-xs)", padding: "2px 10px" }}
                >
                  {savingNotes ? "保存中..." : "保存"}
                </button>
              )}
            </div>
            <textarea
              value={notesText}
              onChange={(e) => setNotesText(e.target.value)}
              placeholder="この日のメモを自由に記入..."
              style={{
                width: "100%",
                minHeight: "60px",
                border: "1px solid var(--border-subtle)",
                borderRadius: "var(--radius-sm)",
                backgroundColor: "var(--bg-primary)",
                color: "var(--text-primary)",
                padding: "var(--space-sm)",
                fontSize: "var(--font-md)",
                resize: "vertical",
                fontFamily: "inherit",
              }}
            />
          </div>

          {/* 残りのセクション（ノートを除外して表示） */}
          {renderMarkdown(stripNotesSection(journalContent).split("\n").filter(l => !l.startsWith("# ")).join("\n"))}
        </div>
      ) : (
        <div className="empty-message">
          {selectedDate}のジャーナルはまだ生成されていません
        </div>
      )}
    </div>
  );
}
