import type { GitHubIssue } from "../../lib/types";

interface TicketCardProps {
  issue: GitHubIssue;
  onSelect: (n: number) => void;
}

export function TicketCard({ issue, onSelect }: TicketCardProps) {
  // Priority detection
  const priorityLabel = issue.labels.find((l) => l.name.startsWith("優先:"));
  const priorityColor = priorityLabel?.name === "優先:高" ? "#f85149"
    : priorityLabel?.name === "優先:中" ? "#d29922"
    : priorityLabel?.name === "優先:低" ? "#3fb950"
    : "transparent";

  // Category labels (分野, 種別 - exclude 状態 and 優先 since shown elsewhere)
  const displayLabels = issue.labels.filter(
    (l) => !l.name.startsWith("状態:") && !l.name.startsWith("優先:")
  );

  // Todo progress
  const todoMatch = issue.body?.match(/- \[[ x]\]/g);
  const todoTotal = todoMatch?.length || 0;
  const todoDone = issue.body?.match(/- \[x\]/g)?.length || 0;

  // Milestone due date
  const dueDate = issue.milestone?.due_on
    ? new Date(issue.milestone.due_on)
    : null;
  const isOverdue = dueDate ? dueDate < new Date() : false;

  return (
    <div
      className="ticket-card"
      onClick={() => onSelect(issue.number)}
      style={{ borderLeft: `3px solid ${priorityColor}` }}
    >
      {/* Header: number + title */}
      <div className="ticket-header">
        <span className="ticket-number">#{issue.number}</span>
        <span className="ticket-title">{issue.title}</span>
      </div>

      {/* Labels row */}
      {displayLabels.length > 0 && (
        <div className="ticket-labels">
          {displayLabels.map((l) => (
            <span key={l.name} className="ticket-label" style={{
              background: `#${l.color}33`,
              color: `#${l.color}`,
              border: `1px solid #${l.color}44`
            }}>
              {l.name.includes(":") ? l.name.split(":")[1] : l.name}
            </span>
          ))}
        </div>
      )}

      {/* Meta row: milestone, due date, todo progress, comments */}
      <div className="ticket-meta">
        {issue.milestone && (
          <span className="ticket-meta-item" title={issue.milestone.title}>
            🎯 {issue.milestone.title}
          </span>
        )}
        {dueDate && (
          <span className="ticket-meta-item" style={{ color: isOverdue ? "#f85149" : "#8b949e" }}>
            📅 {dueDate.toLocaleDateString("ja-JP", { month: "short", day: "numeric" })}
          </span>
        )}
        {todoTotal > 0 && (
          <span className="ticket-meta-item">
            ✅ {todoDone}/{todoTotal}
          </span>
        )}
        {issue.comments > 0 && (
          <span className="ticket-meta-item">
            💬 {issue.comments}
          </span>
        )}
      </div>

      {/* Footer: assignees + todo progress bar */}
      <div className="ticket-footer">
        {todoTotal > 0 && (
          <div className="ticket-progress">
            <div className="ticket-progress-fill" style={{ width: `${(todoDone / todoTotal) * 100}%` }} />
          </div>
        )}
        {issue.assignees && issue.assignees.length > 0 && (
          <div className="ticket-assignees">
            {issue.assignees.map((a) => (
              <img key={a.login} src={a.avatar_url} alt={a.login} title={a.login}
                className="ticket-avatar" />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
