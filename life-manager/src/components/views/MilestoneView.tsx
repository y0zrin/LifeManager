import { useMemo, useState } from "react";
import type { GitHubIssue, GitHubMilestone } from "../../lib/types";
import { TicketCard } from "../common/TicketCard";
import { DatePickerButton } from "../common/DatePickerButton";
import { Burndown } from "../common/Burndown";
import { estimateOf, formatEstimate, formatNumber, sumEstimates } from "../../lib/estimate";
import { average, descriptionText, finishedMilestones, sprintRange, velocity, weightOf, withStartDate, writtenStartDate, type PaceMode } from "../../lib/sprint";
import { useEstimateUnit } from "../common/EstimateChip";

interface MilestoneViewProps {
  milestones: GitHubMilestone[];
  issues: GitHubIssue[];
  closedIssues: GitHubIssue[];
  onCreateMilestone: (title: string, description: string, dueOn: string | null) => Promise<void>;
  onUpdateMilestone: (milestoneNumber: number, updates: { title?: string; description?: string; dueOn?: string | null }) => Promise<void>;
  onCloseMilestone: (milestoneNumber: number) => Promise<void>;
  onRefresh: () => Promise<void>;
  onSelectIssue: (n: number) => void;
}

/** 量の数え方（見積もり／件数）。次に開いたときも同じ */
const MODE_STORE = "pace-mode";

/** YYYY-MM-DD → 「9/28」 */
function md(date: string): string {
  const [, m, d] = date.split("-").map(Number);
  return `${m}/${d}`;
}

export function MilestoneView({ milestones, issues, closedIssues, onCreateMilestone, onUpdateMilestone, onCloseMilestone, onRefresh, onSelectIssue }: MilestoneViewProps) {
  const unit = useEstimateUnit();
  const [showForm, setShowForm] = useState(false);
  const [msTitle, setMsTitle] = useState("");
  const [msDesc, setMsDesc] = useState("");
  const [msStart, setMsStart] = useState("");
  const [msDue, setMsDue] = useState("");
  const [expandedMs, setExpandedMs] = useState<number | null>(null);
  const [editingMs, setEditingMs] = useState<number | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editStart, setEditStart] = useState("");
  const [editDue, setEditDue] = useState("");

  // 数え方: 選んだことがあればそれ、なければ見積もりのある Issue があるときは見積もり
  const hasEstimates = useMemo(() => [...issues, ...closedIssues].some((i) => estimateOf(i) !== null), [issues, closedIssues]);
  const [chosenMode, setChosenMode] = useState<PaceMode | null>(() => {
    try {
      const v = localStorage.getItem(MODE_STORE);
      return v === "estimate" || v === "count" ? v : null;
    } catch {
      return null;
    }
  });
  const mode: PaceMode = chosenMode ?? (hasEstimates ? "estimate" : "count");
  function changeMode(m: PaceMode) {
    setChosenMode(m);
    try {
      localStorage.setItem(MODE_STORE, m);
    } catch {
      // 覚えられなくても、今は切り替わる
    }
  }

  // 終わったマイルストーンごとの終えた量（ベロシティ）と、その平均（次のスプリントの目安）
  const entries = useMemo(() => velocity(issues, closedIssues, mode, unit), [issues, closedIssues, mode, unit]);
  const avg = average(entries.map((e) => (mode === "count" ? e.closedCount : e.done)));
  // 終わったマイルストーン（目安と比べるのは、まだ終わっていないものだけ。チームのペースはオーバービューに出す）
  const finished = useMemo(() => finishedMilestones(issues, closedIssues), [issues, closedIssues]);
  const fmt = (v: number) => (mode === "count" ? `${formatNumber(v)} 件` : formatEstimate(Math.round(v * 10) / 10, unit));

  async function handleCreate() {
    if (!msTitle.trim()) return;
    const dueOn = msDue ? msDue + "T00:00:00Z" : null;
    await onCreateMilestone(msTitle, withStartDate(msDesc, msStart || null), dueOn);
    setMsTitle("");
    setMsDesc("");
    setMsStart("");
    setMsDue("");
    setShowForm(false);
  }

  function startEditing(ms: GitHubMilestone) {
    setEditingMs(ms.number);
    setEditTitle(ms.title);
    setEditDesc(descriptionText(ms.description));
    setEditStart(writtenStartDate(ms.description) ?? "");
    setEditDue(ms.due_on ? ms.due_on.substring(0, 10) : "");
  }

  async function handleSaveEdit(milestoneNumber: number) {
    if (!editTitle.trim()) return;
    await onUpdateMilestone(milestoneNumber, {
      title: editTitle,
      description: withStartDate(editDesc, editStart || null),
      dueOn: editDue ? editDue + "T00:00:00Z" : null,
    });
    setEditingMs(null);
  }

  return (
    <div className="content">
      <div className="toolbar">
        <button onClick={() => setShowForm(!showForm)} className="btn-sm">
          {showForm ? "×" : "+ マイルストーン"}
        </button>
        <button onClick={onRefresh} className="btn-sm">更新</button>
        {(issues.length > 0 || closedIssues.length > 0) && (
          <span className="pace-mode ms-mode" role="group" aria-label="数え方" title="バーンダウンと目安を、見積もりで数えるか件数で数えるか（オーバービューのチームのペースと同じ）">
            {(["estimate", "count"] as PaceMode[]).map((m) => (
              <button key={m} type="button" className={mode === m ? "on" : ""} aria-pressed={mode === m} onClick={() => changeMode(m)}>
                {m === "estimate" ? "見積もり" : "件数"}
              </button>
            ))}
          </span>
        )}
      </div>

      {showForm && (
        <div className="form-card">
          <input value={msTitle} onChange={(e) => setMsTitle(e.target.value)}
            placeholder="マイルストーン名" className="input-full" />
          <input value={msDesc} onChange={(e) => setMsDesc(e.target.value)}
            placeholder="説明" className="input-full" />
          <div className="ms-dates">
            <DatePickerButton value={msStart} onChange={setMsStart} label={msStart ? `開始 ${msStart}` : "開始日を選択（スプリントの始まり）"} />
            <DatePickerButton value={msDue} onChange={setMsDue} label={msDue || "期限を選択"} />
          </div>
          <button onClick={handleCreate} className="btn-primary">作成</button>
        </div>
      )}

      {milestones.map((ms) => {
        const dueStr = ms.due_on ? new Date(ms.due_on).toLocaleDateString("ja-JP") : "期限なし";
        const isExpanded = expandedMs === ms.number;
        const isEditing = editingMs === ms.number;
        const msOpenIssues = issues.filter((i) => i.milestone?.number === ms.number);
        const msClosedIssues = closedIssues.filter((i) => i.milestone?.number === ms.number);
        const openCount = msOpenIssues.length;
        const closedCount = msClosedIssues.length;
        const total = openCount + closedCount;
        const percent = total > 0 ? Math.round((closedCount / total) * 100) : 0;
        // 見積もり（済んだ分／全部）。見積もりが 1 件もなければ出さない
        const estAll = sumEstimates([...msOpenIssues, ...msClosedIssues], unit);
        const estDone = sumEstimates(msClosedIssues, unit);
        // スプリントとしての期間（開始日は説明の「開始: 」の行、なければ作った日）
        const range = sprintRange(ms);
        const desc = descriptionText(ms.description);
        // まだ終わっていないマイルストーンは、入れた量を、最近のペース（平均）と比べる
        const planned = [...msOpenIssues, ...msClosedIssues].reduce((sum, i) => sum + weightOf(i, mode, unit), 0);
        const over = avg !== null && !finished.has(ms.number) && planned > avg * 1.1;
        return (
          <div key={ms.number} className="milestone-card" style={{ cursor: "pointer" }}
            onClick={() => setExpandedMs(isExpanded ? null : ms.number)}>

            {isEditing ? (
              <div onClick={(e) => e.stopPropagation()} style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)}
                  placeholder="マイルストーン名" className="input-full" />
                <input value={editDesc} onChange={(e) => setEditDesc(e.target.value)}
                  placeholder="説明" className="input-full" />
                <div className="ms-dates">
                  <DatePickerButton value={editStart} onChange={setEditStart}
                    label={editStart ? `開始 ${editStart}` : "開始日を選択（決めなければ、作った日）"} />
                  <DatePickerButton value={editDue} onChange={setEditDue} label={editDue || "期限を選択"} />
                </div>
                <p className="ms-dates-note">開始日は、説明の最後に「開始: 2026-09-28」の形で書きます（GitHub の画面でも読めます）。</p>
                <div style={{ display: "flex", gap: "var(--space-sm)" }}>
                  <button className="btn-primary" style={{ fontSize: "var(--font-sm)" }}
                    onClick={() => handleSaveEdit(ms.number)}>保存</button>
                  <button className="btn-sm" onClick={() => setEditingMs(null)}>キャンセル</button>
                </div>
              </div>
            ) : (
              <>
                <div className="milestone-meta">
                  <strong>
                    {isExpanded ? "▼" : "▶"} {ms.title}
                    {range.start && (
                      <span className="ms-range" title={range.written ? "開始日は説明に書いた日" : "開始日を決めていないので、マイルストーンを作った日から"}>
                        {md(range.start)}〜{range.end ? md(range.end) : ""}{range.days ? `（${range.days} 日）` : ""}
                      </span>
                    )}
                  </strong>
                  <div style={{ display: "flex", alignItems: "center", gap: "var(--space-sm)" }}>
                    <span style={{ color: "var(--text-muted)", fontSize: "var(--font-sm)" }}>期限: {dueStr}</span>
                    <button
                      className="btn-sm"
                      style={{ fontSize: "var(--font-xs)", padding: "2px 8px" }}
                      onClick={(e) => { e.stopPropagation(); startEditing(ms); }}
                    >
                      編集
                    </button>
                  </div>
                </div>
                {desc && <p className="milestone-desc">{desc}</p>}
                <div className="milestone-progress">
                  <div className="progress-bar">
                    <div className="progress-fill" style={{ width: `${percent}%` }} />
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--space-sm)" }}>
                    <span className="milestone-progress-text" style={{ minWidth: 0 }}>
                      {percent}% ({closedCount}/{total})
                      {estAll.counted > 0 && (
                        <span className="est-sum" title={`見積もりのある ${estAll.counted} 件のうち、閉じた分の合計／全部の合計`}>
                          見積 {formatNumber(estDone.total)}/{formatEstimate(estAll.total, unit)}
                        </span>
                      )}
                      {avg !== null && !finished.has(ms.number) && total > 0 && (
                        <span className={`ms-target${over ? " ms-target--over" : ""}`}
                          title="最近のマイルストーンで終えた量の平均（チームのペース）と比べています">
                          目安 {fmt(avg)} に対して {fmt(planned)}
                        </span>
                      )}
                    </span>
                    <button
                      className="btn-sm"
                      style={{ fontSize: "var(--font-xs)", padding: "2px 8px", flexShrink: 0 }}
                      onClick={async (e) => {
                        e.stopPropagation();
                        if (confirm(`「${ms.title}」を完了しますか？`)) {
                          await onCloseMilestone(ms.number);
                        }
                      }}
                    >
                      完了
                    </button>
                  </div>
                </div>
              </>
            )}

            {isExpanded && !isEditing && (
              <div style={{ marginTop: "var(--space-sm)", borderTop: "1px solid var(--border-default)", paddingTop: "var(--space-sm)" }}
                onClick={(e) => e.stopPropagation()}>
                {range.start && total > 0 && (
                  <Burndown start={range.start} end={range.end} issues={[...msOpenIssues, ...msClosedIssues]} mode={mode} />
                )}
                {msOpenIssues.length > 0 && (
                  <>
                    <p style={{ fontSize: "var(--font-xs)", color: "var(--text-muted)", marginBottom: "4px" }}>オープン ({msOpenIssues.length})</p>
                    {msOpenIssues.map((i) => (
                      <TicketCard key={i.number} issue={i} onSelect={onSelectIssue} />
                    ))}
                  </>
                )}
                {msClosedIssues.length > 0 && (
                  <>
                    <p style={{ fontSize: "var(--font-xs)", color: "var(--text-muted)", marginTop: "8px", marginBottom: "4px" }}>クローズ済み ({msClosedIssues.length})</p>
                    {msClosedIssues.map((i) => (
                      <div key={i.number} style={{ opacity: 0.5 }}>
                        <TicketCard issue={i} onSelect={onSelectIssue} />
                      </div>
                    ))}
                  </>
                )}
                {msOpenIssues.length === 0 && msClosedIssues.length === 0 && (
                  <p style={{ fontSize: "var(--font-xs)", color: "var(--text-faint)" }}>紐付けされたイシューはありません</p>
                )}
              </div>
            )}
          </div>
        );
      })}
      {milestones.length === 0 && <p className="empty-message">マイルストーンがありません</p>}
    </div>
  );
}
