import type { GitHubIssue } from "../../lib/types";
import type { TaskGroup } from "../../lib/taskList";
import { issueRef } from "../../lib/issueRef";
import { DueChip } from "./DueChip";
import { EstimateChip, EstimateSumText, useEstimateUnit } from "./EstimateChip";
import { sumEstimates } from "../../lib/estimate";
import { PendingChip } from "./PendingChip";
import { SubIssueBadge } from "./SubIssueMarks";

interface IssueTableProps {
  groups: TaskGroup[];
  onSelect: (n: number) => void;
  /** 「☑ 選ぶ」のあいだ（行を押すと選ぶ・外す） */
  picking: boolean;
  picked: Set<number>;
  onTogglePick: (n: number) => void;
}

/** ラベル（状態・優先）を、頭の「状態:」を外して色つきの丸い札で出す */
function LabelPill({ issue, prefix }: { issue: GitHubIssue; prefix: string }) {
  const label = issue.labels.find((l) => l.name.startsWith(prefix));
  if (!label) return <span className="tt-muted">—</span>;
  return (
    <span className="tt-pill" style={{ color: `#${label.color}`, backgroundColor: `#${label.color}22`, borderColor: `#${label.color}66` }}>
      {label.name.slice(prefix.length)}
    </span>
  );
}

/** タスク一覧の「表」。1 行に 1 件。まとめたときは、まとまりごとに見出しの行を入れる */
export function IssueTable({ groups, onSelect, picking, picked, onTogglePick }: IssueTableProps) {
  const columns = picking ? 9 : 8;
  const unit = useEstimateUnit();
  return (
    <div className="task-table-wrap">
      <table className="task-table">
        <thead>
          <tr>
            {picking && <th aria-label="選ぶ" />}
            <th>#</th>
            <th>題</th>
            <th>状態</th>
            <th>優先</th>
            <th>見積</th>
            <th>担当</th>
            <th>マイルストーン</th>
            <th>期限</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => [
            g.title ? (
              <tr key={`g:${g.title}`} className="task-table-group">
                <td colSpan={columns}>
                  {g.title}
                  <span>{g.rows.length} 件</span>
                  <EstimateSumText sum={sumEstimates(g.rows.map((r) => r.issue), unit)} />
                </td>
              </tr>
            ) : null,
            ...g.rows.map(({ issue, depth }) => {
              const isPicked = picked.has(issue.number);
              const assignee = issue.assignees?.[0];
              const more = (issue.assignees?.length ?? 0) - 1;
              return (
                <tr
                  key={issue.number}
                  data-issue={issue.number}
                  className={`task-row${isPicked ? " task-row--picked" : ""}${issue.state === "closed" ? " task-row--closed" : ""}`}
                  onClick={() => (picking ? onTogglePick(issue.number) : onSelect(issue.number))}
                >
                  {picking && (
                    <td className="tt-pick">
                      <input type="checkbox" checked={isPicked} onChange={() => onTogglePick(issue.number)}
                        onClick={(e) => e.stopPropagation()} aria-label={`${issueRef(issue.number)} を選ぶ`} />
                    </td>
                  )}
                  <td className="tt-num">{issueRef(issue.number)}</td>
                  <td className="tt-title" style={depth > 0 ? { paddingLeft: `calc(var(--space-sm) + ${Math.min(depth, 3) * 18}px)` } : undefined}>
                    {depth > 0 && <span className="tt-child">└ </span>}
                    {issue.title}
                    <SubIssueBadge issue={issue} />
                    {issue._pending && <PendingChip />}
                  </td>
                  <td>{issue.state === "closed" ? <span className="tt-pill tt-pill--closed">完了</span> : <LabelPill issue={issue} prefix="状態:" />}</td>
                  <td><LabelPill issue={issue} prefix="優先:" /></td>
                  <td><EstimateChip issue={issue} plain /></td>
                  <td>
                    {assignee ? (
                      <span className="tt-who" title={issue.assignees?.map((a) => a.login).join("、")}>
                        <img src={assignee.avatar_url} alt="" className="avatar-sm" />
                        {assignee.login}
                        {more > 0 && <span className="tt-muted">＋{more}</span>}
                      </span>
                    ) : (
                      <span className="tt-muted">—</span>
                    )}
                  </td>
                  <td className="tt-muted">{issue.milestone?.title ?? "—"}</td>
                  <td><DueChip issue={issue} /></td>
                </tr>
              );
            }),
          ])}
        </tbody>
      </table>
    </div>
  );
}
