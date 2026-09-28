import type { GitHubIssue } from "../../lib/types";
import { LabelBadge } from "./LabelBadge";
import { PendingChip } from "./PendingChip";
import { ParentMark, SubIssueBadge } from "./SubIssueMarks";
import { DueChip } from "./DueChip";
import { EstimateChip } from "./EstimateChip";
import { issueRef } from "../../lib/issueRef";
import { ESTIMATE_PREFIX } from "../../lib/estimate";

export function IssueCard({
  issue,
  onClose,
  onReopen,
  onPromote,
  onStatusChange,
  onSelect,
  depth = 0,
  picking = false,
  picked = false,
  onTogglePick,
}: {
  issue: GitHubIssue;
  onClose: (n: number) => void;
  onReopen: (n: number) => void;
  onPromote: (n: number) => void;
  onStatusChange: (n: number, status: string) => void;
  onSelect?: (n: number) => void;
  /** 親子でまとめたときの深さ（子は親の下に字下げし、「↑ 親」の印は出さない） */
  depth?: number;
  /** 「☑ 選ぶ」のあいだ（押すと選ぶ・外す。操作のボタンは隠す） */
  picking?: boolean;
  picked?: boolean;
  onTogglePick?: (n: number) => void;
}) {
  const isMemo = issue.labels.some((l) => l.name === "種別:メモ");
  const currentStatus = issue.labels.find((l) => l.name.startsWith("状態:"))?.name || "";
  const dateStr = new Date(issue.created_at).toLocaleDateString("ja-JP");

  const todoMatch = issue.body?.match(/- \[[ x]\]/g);
  const todoTotal = todoMatch?.length || 0;
  const todoDone = issue.body?.match(/- \[x\]/g)?.length || 0;
  // 本文の抜き出し（ガントの日程などの見えない印 <!-- … --> は出さない）
  const excerpt = (issue.body ?? "").replace(/<!--[\s\S]*?-->/g, "").trim();

  function handleCardClick(e: React.MouseEvent) {
    if ((e.target as HTMLElement).closest("button, select, input, [data-todo-progress]")) return;
    if (picking) onTogglePick?.(issue.number);
    else onSelect?.(issue.number);
  }

  return (
    <div className={`issue-card${depth > 0 ? " issue-card--child" : ""}${picked ? " issue-card--picked" : ""}`} onClick={handleCardClick}
      style={{ cursor: onSelect || picking ? "pointer" : "default", marginLeft: depth > 0 ? `${Math.min(depth, 3) * 28}px` : undefined }}>
      {depth === 0 && <ParentMark issue={issue} />}
      <div className="issue-card-header">
        <div style={{ flex: 1 }}>
          {picking && (
            <input type="checkbox" className="issue-card-pick" checked={picked}
              onChange={() => onTogglePick?.(issue.number)} aria-label={`${issueRef(issue.number)} を選ぶ`} />
          )}
          <span className="issue-card-number">{issueRef(issue.number)}</span>
          {issue._pending && <PendingChip />}
          <strong>{issue.title}</strong>
          {issue.milestone && (
            <span style={{ color: "var(--text-muted)", fontSize: "var(--font-xs)", marginLeft: "8px" }}>
              📌 {issue.milestone.title}
            </span>
          )}
          <SubIssueBadge issue={issue} />
          <DueChip issue={issue} />
          <EstimateChip issue={issue} />
        </div>
        <span className="issue-card-date">{dateStr}</span>
      </div>

      {excerpt && (
        <p className="issue-card-body">
          {excerpt.length > 120 ? excerpt.substring(0, 120) + "..." : excerpt}
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
        {/* 見積もりは上の「📏 3」で出すので、ラベルには並べない */}
        {issue.labels.filter((l) => !l.name.startsWith(ESTIMATE_PREFIX)).map((l) => (
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

      {!picking && <div className="issue-card-actions">
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
      </div>}
    </div>
  );
}
