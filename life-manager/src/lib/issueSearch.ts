import type { GitHubIssue } from "./types";

/**
 * 番号かタイトルで Issue を探す（「#6」なら #6 を先に、そのあと #16・#60 など）。
 * まだ GitHub に送っていない Issue（仮の番号）は出さない
 */
export function findIssues(issues: GitHubIssue[], query: string, limit = 6): GitHubIssue[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const num = q.match(/^#?(\d+)$/)?.[1];
  const hits = issues.filter((i) => i.number > 0 && (num ? String(i.number).includes(num) : i.title.toLowerCase().includes(q)));
  if (num) {
    const exact = Number(num);
    hits.sort((a, b) => Number(b.number === exact) - Number(a.number === exact));
  }
  return hits.slice(0, limit);
}
