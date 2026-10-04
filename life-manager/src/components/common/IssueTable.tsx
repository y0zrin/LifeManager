import type { GitHubIssue } from "../../lib/types";
import type { TaskGroup } from "../../lib/taskList";
import { issueRef } from "../../lib/issueRef";
import { DueChip } from "./DueChip";
import { EstimateChip, EstimateSumText, useEstimateUnit } from "./EstimateChip";
import { sumEstimates } from "../../lib/estimate";
import { IssueSendState, isUnsent } from "./Sending";
import { PendingChip } from "./PendingChip";
import { SubIssueBadge } from "./SubIssueMarks";
import { Avatar } from "./Avatar";
import { tr, trx, labelText } from "../../lib/i18n";

interface IssueTableProps {
  groups: TaskGroup[];
  onSelect: (n: number) => void;
  /** 「☑ 選ぶ」のあいだ（行を押すと選ぶ・外す） */
  picking: boolean;
  picked: Set<number>;
  onTogglePick: (n: number) => void;
  /** 新しく入った行（メモを投入したときなど）。上から入って、緑に光り、「NEW」を付ける */
  fresh?: Set<number>;
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
export function IssueTable({ groups, onSelect, picking, picked, onTogglePick, fresh }: IssueTableProps) {
  const columns = picking ? 9 : 8;
  const unit = useEstimateUnit();
  return (
    <div className="task-table-wrap">
      <table className="task-table">
        <thead>
          <tr>
            {picking && <th aria-label={tr("選ぶ")} />}
            <th>#</th>
            <th>{tr("題")}</th>
            <th>{tr("状態")}</th>
            <th>{tr("優先")}</th>
            <th>{tr("見積")}</th>
            <th>{tr("担当")}</th>
            <th>{tr("マイルストーン")}</th>
            <th>{tr("期限")}</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => [
            g.title ? (
              <tr key={`g:${g.title}`} className="task-table-group">
                <td colSpan={columns}>
                  {trx("{title}<0>{length} 件</0>", { title: labelText(g.title), length: g.rows.length }, [<span />])}
                  <EstimateSumText sum={sumEstimates(g.rows.map((r) => r.issue), unit)} />
                </td>
              </tr>
            ) : null,
            ...g.rows.map(({ issue, depth }) => {
              const isPicked = picked.has(issue.number);
              const isFresh = !!fresh?.has(issue.number);
              const assignee = issue.assignees?.[0];
              const more = (issue.assignees?.length ?? 0) - 1;
              return (
                <tr
                  key={issue.number}
                  data-issue={issue.number}
                  className={`task-row${isPicked ? " task-row--picked" : ""}${issue.state === "closed" ? " task-row--closed" : ""}${isFresh ? " task-row--fresh" : ""}${issue._sending ? " task-row--sending" : ""}${issue._failed ? " task-row--failed" : ""}`}
                  onClick={() => {
                    // 送っているあいだ・送れなかった仮の Issue は開かない
                    if (isUnsent(issue)) return;
                    if (picking) onTogglePick(issue.number);
                    else onSelect(issue.number);
                  }}
                >
                  {picking && (
                    <td className="tt-pick">
                      <input type="checkbox" checked={isPicked} disabled={isUnsent(issue)} onChange={() => onTogglePick(issue.number)}
                        onClick={(e) => e.stopPropagation()} aria-label={tr("{issueRef} を選ぶ", { issueRef: issueRef(issue.number) })} />
                    </td>
                  )}
                  <td className="tt-num">{issueRef(issue.number)}</td>
                  <td className="tt-title" style={depth > 0 ? { paddingLeft: `calc(var(--space-sm) + ${Math.min(depth, 3) * 18}px)` } : undefined}>
                    {depth > 0 && <span className="tt-child">└ </span>}
                    {issue.title}
                    {isFresh && <span className="task-row-new">NEW</span>}
                    <SubIssueBadge issue={issue} />
                    {issue._pending && <PendingChip />}
                    <IssueSendState issue={issue} />
                  </td>
                  <td>{issue.state === "closed" ? <span className="tt-pill tt-pill--closed">{tr("完了")}</span> : <LabelPill issue={issue} prefix="状態:" />}</td>
                  <td><LabelPill issue={issue} prefix="優先:" /></td>
                  <td><EstimateChip issue={issue} plain /></td>
                  <td>
                    {assignee ? (
                      <span className="tt-who" title={issue.assignees?.map((a) => a.login).join("、")}>
                        <Avatar login={assignee.login} url={assignee.avatar_url} alt="" className="avatar-sm" />
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
