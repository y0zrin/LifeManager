import { createContext, useContext } from "react";
import type { GitHubIssue } from "../../lib/types";
import { issueRef } from "../../lib/issueRef";
import { isSameRepo, parseIssueApiUrl } from "../../lib/subIssues";
import { tr } from "../../lib/i18n";

/** いま開いているリポジトリと、その Issue（開いている・閉じた）を番号で引くもの。カードに親の題名を出すのに使う */
export interface IssueIndex {
  owner: string;
  repo: string;
  find: (n: number) => GitHubIssue | undefined;
}

export const IssueIndexContext = createContext<IssueIndex>({ owner: "", repo: "", find: () => undefined });

/** 親の Issue（同じリポジトリなら番号と題名。ほかのリポジトリなら「名前#番号」） */
export function useParentOf(issue: GitHubIssue): { label: string; title: string; number: number; sameRepo: boolean; htmlUrl: string } | null {
  const index = useContext(IssueIndexContext);
  const parent = parseIssueApiUrl(issue.parent_issue_url);
  if (!parent) return null;
  const sameRepo = isSameRepo(parent, index.owner, index.repo);
  return {
    label: sameRepo ? issueRef(parent.number) : `${parent.repo}#${parent.number}`,
    title: sameRepo ? index.find(parent.number)?.title ?? "" : "",
    number: parent.number,
    sameRepo,
    htmlUrl: `https://github.com/${parent.owner}/${parent.repo}/issues/${parent.number}`,
  };
}

/** カードの「↑ 親」の印 */
export function ParentMark({ issue }: { issue: GitHubIssue }) {
  const parent = useParentOf(issue);
  if (!parent) return null;
  return (
    <div className="parent-mark" title={tr("この Issue の親（サブイシューのもと）")}>
      ↑ {parent.label} {parent.title}
    </div>
  );
}

/** カードの「🧩 2/5」の印（子の Issue のうち、閉じた数） */
export function SubIssueBadge({ issue }: { issue: GitHubIssue }) {
  const s = issue.sub_issues_summary;
  if (!s || s.total === 0) return null;
  return (
    <span className="sub-badge" title={tr("サブイシュー（子の Issue）{total} 件のうち {completed} 件が完了", { total: s.total, completed: s.completed })}>
      🧩 {s.completed}/{s.total}
      <span className="sub-badge-bar">
        <i style={{ width: `${s.percent_completed}%` }} />
      </span>
    </span>
  );
}
