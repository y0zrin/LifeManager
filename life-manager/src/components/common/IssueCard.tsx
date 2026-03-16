import type { GitHubIssue } from "../../lib/types";
import { LabelBadge } from "./LabelBadge";

export function IssueCard({
  issue,
  onClose,
  onReopen,
  onPromote,
  onStatusChange,
  onSelect,
}: {
  issue: GitHubIssue;
  onClose: (n: number) => void;
  onReopen: (n: number) => void;
  onPromote: (n: number) => void;
  onStatusChange: (n: number, status: string) => void;
  onSelect?: (n: number) => void;
}) {
  const isMemo = issue.labels.some((l) => l.name === "種別:メモ");
  const currentStatus = issue.labels.find((l) => l.name.startsWith("状態:"))?.name || "";
  const dateStr = new Date(issue.created_at).toLocaleDateString("ja-JP");

  const todoMatch = issue.body?.match(/- \[[ x]\]/g);
  const todoTotal = todoMatch?.length || 0;
  const todoDone = issue.body?.match(/- \[x\]/g)?.length || 0;

  function handleCardClick(e: React.MouseEvent) {
    if ((e.target as HTMLElement).closest("button, select, [data-todo-progress]")) return;
    onSelect?.(issue.number);
  }

  return (
    <div className="issue-card" onClick={handleCardClick}
      style={{ cursor: onSelect ? "pointer" : "default" }}>
      <div className="issue-card-header">
        <div style={{ flex: 1 }}>
          <span className="issue-card-number">#{issue.number}</span>
          <strong>{issue.title}</strong>
          {issue.milestone && (
            <span style={{ color: "var(--text-muted)", fontSize: "var(--font-xs)", marginLeft: "8px" }}>
              📌 {issue.milestone.title}
            </span>
          )}
        </div>
        <span className="issue-card-date">{dateStr}</span>
      </div>

      {issue.body && (
        <p className="issue-card-body">
          {issue.body.length > 120 ? issue.body.substring(0, 120) + "..." : issue.body}
        </p>
      )}

      {todoTotal > 0 && (
        <div data-todo-progress style={{ fontSize: "var(--font-xs)", color: "var(--text-muted)", margin: "4px 0" }}>
          タスク: {todoDone}/{todoTotal}
          <div style={{ width: "100px", height: "4px", background: "var(--border-default)", borderRadius: "2px", display: "inline-block", marginLeft: "6px", verticalAlign: "middle" }}>
            <div style={{ width: `${(todoDone / todoTotal) * 100}%`, height: "100%", background: "var(--accent-green)", borderRadius: "2px" }} />
          </div>
        </div>
      )}

      <div className="issue-card-labels">
        {issue.labels.map((l) => (
          <LabelBadge key={l.name} name={l.name} color={l.color} />
        ))}
        {issue.assignees && issue.assignees.length > 0 && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: "2px", marginLeft: "4px" }}>
            {issue.assignees.map((a) => (
              <img key={a.login} src={a.avatar_url} alt={a.login} title={a.login} className="avatar-md" />
            ))}
          </span>
        )}
      </div>

      <div className="issue-card-actions">
        {issue.state === "open" ? (
          <button className="btn-sm" onClick={() => onClose(issue.number)}>完了</button>
        ) : (
          <button className="btn-sm" onClick={() => onReopen(issue.number)}>再開</button>
        )}
        {isMemo && issue.state === "open" && (
          <button className="btn-sm" onClick={() => onPromote(issue.number)}>昇華</button>
        )}
        {issue.state === "open" && (
          <select
            className="btn-sm"
            value={currentStatus}
            onChange={(e) => onStatusChange(issue.number, e.target.value)}
            style={{ fontSize: "var(--font-xs)" }}
          >
            <option value="">状態変更...</option>
            <option value="状態:未整理">未整理</option>
            <option value="状態:進行中">進行中</option>
            <option value="状態:ブロック">ブロック</option>
            <option value="状態:いつか">いつか</option>
          </select>
        )}
      </div>
    </div>
  );
}
