import { useState } from "react";
import type { GitHubIssue, GitHubMilestone } from "../../lib/types";
import { TicketCard } from "../common/TicketCard";
import { DatePickerButton } from "../common/DatePickerButton";

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

export function MilestoneView({ milestones, issues, closedIssues, onCreateMilestone, onUpdateMilestone, onCloseMilestone, onRefresh, onSelectIssue }: MilestoneViewProps) {
  const [showForm, setShowForm] = useState(false);
  const [msTitle, setMsTitle] = useState("");
  const [msDesc, setMsDesc] = useState("");
  const [msDue, setMsDue] = useState("");
  const [expandedMs, setExpandedMs] = useState<number | null>(null);
  const [editingMs, setEditingMs] = useState<number | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editDue, setEditDue] = useState("");

  async function handleCreate() {
    if (!msTitle.trim()) return;
    const dueOn = msDue ? msDue + "T00:00:00Z" : null;
    await onCreateMilestone(msTitle, msDesc, dueOn);
    setMsTitle("");
    setMsDesc("");
    setMsDue("");
    setShowForm(false);
  }

  function startEditing(ms: GitHubMilestone) {
    setEditingMs(ms.number);
    setEditTitle(ms.title);
    setEditDesc(ms.description || "");
    setEditDue(ms.due_on ? ms.due_on.substring(0, 10) : "");
  }

  async function handleSaveEdit(milestoneNumber: number) {
    if (!editTitle.trim()) return;
    await onUpdateMilestone(milestoneNumber, {
      title: editTitle,
      description: editDesc,
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
      </div>

      {showForm && (
        <div className="form-card">
          <input value={msTitle} onChange={(e) => setMsTitle(e.target.value)}
            placeholder="マイルストーン名" className="input-full" />
          <input value={msDesc} onChange={(e) => setMsDesc(e.target.value)}
            placeholder="説明" className="input-full" />
          <DatePickerButton value={msDue} onChange={setMsDue} label={msDue || "期限を選択"} />
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
        return (
          <div key={ms.number} className="milestone-card" style={{ cursor: "pointer" }}
            onClick={() => setExpandedMs(isExpanded ? null : ms.number)}>

            {isEditing ? (
              <div onClick={(e) => e.stopPropagation()} style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)}
                  placeholder="マイルストーン名" className="input-full" />
                <input value={editDesc} onChange={(e) => setEditDesc(e.target.value)}
                  placeholder="説明" className="input-full" />
                <DatePickerButton value={editDue} onChange={setEditDue} label={editDue || "期限を選択"} />
                <div style={{ display: "flex", gap: "var(--space-sm)" }}>
                  <button className="btn-primary" style={{ fontSize: "var(--font-sm)" }}
                    onClick={() => handleSaveEdit(ms.number)}>保存</button>
                  <button className="btn-sm" onClick={() => setEditingMs(null)}>キャンセル</button>
                </div>
              </div>
            ) : (
              <>
                <div className="milestone-meta">
                  <strong>{isExpanded ? "▼" : "▶"} {ms.title}</strong>
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
                {ms.description && <p className="milestone-desc">{ms.description}</p>}
                <div className="milestone-progress">
                  <div className="progress-bar">
                    <div className="progress-fill" style={{ width: `${percent}%` }} />
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--space-sm)" }}>
                    <span className="milestone-progress-text" style={{ minWidth: 0 }}>
                      {percent}% ({closedCount}/{total})
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
