import { useState } from "react";
import type { GitHubMilestone } from "../../lib/types";

interface MilestoneViewProps {
  milestones: GitHubMilestone[];
  onCreateMilestone: (title: string, description: string, dueOn: string | null) => Promise<void>;
  onRefresh: () => Promise<void>;
}

export function MilestoneView({ milestones, onCreateMilestone, onRefresh }: MilestoneViewProps) {
  const [showForm, setShowForm] = useState(false);
  const [msTitle, setMsTitle] = useState("");
  const [msDesc, setMsDesc] = useState("");
  const [msDue, setMsDue] = useState("");

  async function handleCreate() {
    if (!msTitle.trim()) return;
    const dueOn = msDue ? msDue + "T00:00:00Z" : null;
    await onCreateMilestone(msTitle, msDesc, dueOn);
    setMsTitle("");
    setMsDesc("");
    setMsDue("");
    setShowForm(false);
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
          <input type="date" value={msDue} onChange={(e) => setMsDue(e.target.value)}
            className="input-full" />
          <button onClick={handleCreate} className="btn-primary">作成</button>
        </div>
      )}

      {milestones.map((ms) => {
        const total = ms.open_issues + ms.closed_issues;
        const percent = total > 0 ? Math.round((ms.closed_issues / total) * 100) : 0;
        const dueStr = ms.due_on ? new Date(ms.due_on).toLocaleDateString("ja-JP") : "期限なし";
        return (
          <div key={ms.number} className="milestone-card">
            <div className="milestone-meta">
              <strong>{ms.title}</strong>
              <span style={{ color: "var(--text-muted)", fontSize: "var(--font-sm)" }}>期限: {dueStr}</span>
            </div>
            {ms.description && <p className="milestone-desc">{ms.description}</p>}
            <div className="milestone-progress">
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${percent}%` }} />
              </div>
              <span className="milestone-progress-text">
                {percent}% ({ms.closed_issues}/{total})
              </span>
            </div>
          </div>
        );
      })}
      {milestones.length === 0 && <p className="empty-message">マイルストーンがありません</p>}
    </div>
  );
}
