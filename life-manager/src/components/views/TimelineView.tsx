import { useState, useEffect, useCallback, type ReactElement } from "react";

interface TimelineViewProps {
  onGenerateJournal: (date: string) => Promise<string>;
  onGetJournal: (date: string) => Promise<string>;
}

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const weekdayLabels = ["日", "月", "火", "水", "木", "金", "土"];

export function TimelineView({ onGenerateJournal, onGetJournal }: TimelineViewProps) {
  const [selectedDate, setSelectedDate] = useState(formatDate(new Date()));
  const [journalContent, setJournalContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);

  const fetchJournal = useCallback(async (date: string) => {
    setLoading(true);
    try {
      const content = await onGetJournal(date);
      setJournalContent(content);
    } catch {
      setJournalContent("");
    } finally {
      setLoading(false);
    }
  }, [onGetJournal]);

  useEffect(() => {
    fetchJournal(selectedDate);
  }, [selectedDate, fetchJournal]);

  function handlePrevDay() {
    const d = new Date(selectedDate);
    d.setDate(d.getDate() - 1);
    setSelectedDate(formatDate(d));
  }

  function handleNextDay() {
    const d = new Date(selectedDate);
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
    } catch {
      // handled by useGitHub setStatus
    } finally {
      setGenerating(false);
    }
  }

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
                return (
                  <span key={j} style={{ color: "var(--accent-blue)", fontWeight: 500 }}>
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

  const dateObj = new Date(selectedDate);
  const weekday = weekdayLabels[dateObj.getDay()];
  const isToday = selectedDate === formatDate(new Date());

  return (
    <div className="content">
      {/* 日付ナビゲーション */}
      <div className="flex-row flex-wrap" style={{ marginBottom: "var(--space-md)" }}>
        <button className="btn-sm" onClick={handlePrevDay}>&#9664; 前日</button>
        <button className="btn-sm" onClick={handleToday}>今日</button>
        <button className="btn-sm" onClick={handleNextDay}>翌日 &#9654;</button>
        <input
          type="date"
          value={selectedDate}
          onChange={(e) => setSelectedDate(e.target.value)}
          className="select-sm"
        />
        <span style={{ color: "var(--text-muted)", fontSize: "var(--font-md)" }}>
          {selectedDate} ({weekday})
          {isToday && <span style={{ color: "var(--accent-blue)", marginLeft: "6px" }}>今日</span>}
        </span>
      </div>

      {/* ツールバー */}
      <div className="toolbar">
        <button className="btn-primary" onClick={handleGenerate} disabled={generating}>
          {generating ? "生成中..." : "手動生成"}
        </button>
        <button className="btn-sm" onClick={() => fetchJournal(selectedDate)}>更新</button>
      </div>

      {/* ジャーナル表示 */}
      {loading ? (
        <div className="empty-message">読み込み中...</div>
      ) : journalContent ? (
        <div className="form-card" style={{ padding: "var(--space-lg)" }}>
          {renderMarkdown(journalContent)}
        </div>
      ) : (
        <div className="empty-message">
          {selectedDate}のジャーナルはまだ生成されていません
        </div>
      )}
    </div>
  );
}
