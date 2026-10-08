import type { GitHubIssue, SubIssuesSummary } from "./types";

/** GitHub の API の URL（…/repos/持ち主/名前/issues/番号）が指す Issue */
export interface IssueLocation {
  owner: string;
  repo: string;
  number: number;
}

export function parseIssueApiUrl(url: string | null | undefined): IssueLocation | null {
  const m = url?.match(/\/repos\/([^/]+)\/([^/]+)\/issues\/(-?\d+)$/);
  return m ? { owner: m[1], repo: m[2], number: Number(m[3]) } : null;
}

export function issueApiUrl(owner: string, repo: string, number: number): string {
  return `https://api.github.com/repos/${owner}/${repo}/issues/${number}`;
}

/** 同じリポジトリか（GitHub の持ち主・名前は、大文字と小文字を区別しない） */
export function isSameRepo(a: { owner: string; repo: string }, owner: string, repo: string): boolean {
  return a.owner.toLowerCase() === owner.toLowerCase() && a.repo.toLowerCase() === repo.toLowerCase();
}

/** この Issue のリポジトリ（サブイシューの一覧では、同じ持ち主のほかのリポジトリの Issue も混じる） */
export function repoOf(issue: GitHubIssue): { owner: string; repo: string } | null {
  const m = issue.repository_url?.match(/\/repos\/([^/]+)\/([^/]+)$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

/** 子の数（total）と、そのうち閉じた数（completed）を増やす・減らす（画面を先に変えておくため） */
export function adjustSummary(s: SubIssuesSummary | undefined, total: number, completed: number): SubIssuesSummary {
  const t = Math.max(0, (s?.total ?? 0) + total);
  const c = Math.min(t, Math.max(0, (s?.completed ?? 0) + completed));
  return { total: t, completed: c, percent_completed: t ? Math.round((c / t) * 100) : 0 };
}

/** GitHub が断ったときの文（"HTTP 422 …: {JSON}" から、中の message を取り出す） */
export function githubMessage(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  const brace = text.indexOf("{");
  if (text.startsWith("HTTP ") && brace > 0) {
    try {
      const body = JSON.parse(text.slice(brace)) as { message?: string; errors?: { message?: string }[] };
      const detail = body.errors?.map((x) => x.message).filter(Boolean).join(" / ");
      return `${text.slice(0, brace).replace(/:\s*$/, "")}：${detail || body.message || ""}`;
    } catch {
      // JSON でなければ、そのまま見せる
    }
  }
  return text;
}
