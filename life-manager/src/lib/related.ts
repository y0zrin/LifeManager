import type { GitHubIssue } from "./types";

// 関連 Issue は、本文の見えない印 <!-- related:#12,#15 --> に残す（ガントの先行 <!-- depends: --> と同じやり方）。
// 片方の Issue に書けば、相手の Issue の詳細にも出す

const RELATED = /<!--\s*related:(#-?\d+(?:,#-?\d+)*)\s*-->\n?/;

/** 本文に書いてある関連 Issue の番号 */
export function parseRelated(body: string | null | undefined): number[] {
  const m = body?.match(RELATED);
  if (!m) return [];
  return m[1].split(",").map((s) => Number(s.replace("#", ""))).filter((n) => !Number.isNaN(n));
}

/** 本文の関連 Issue を書き換える（空なら印ごと消す） */
export function withRelated(body: string | null | undefined, numbers: number[]): string {
  const rest = (body ?? "").replace(RELATED, "").trimEnd();
  const unique = [...new Set(numbers)];
  if (unique.length === 0) return rest;
  return `${rest}${rest ? "\n" : ""}<!-- related:${unique.map((n) => `#${n}`).join(",")} -->`;
}

export interface RelatedLink {
  issue: GitHubIssue;
  /** どちらの本文に書いてあるか（self＝この Issue、other＝相手の Issue） */
  storedIn: "self" | "other";
}

/** この Issue の関連（自分の本文に書いたもの＋相手の本文でこの Issue を指しているもの） */
export function relatedOf(issue: GitHubIssue, all: GitHubIssue[]): RelatedLink[] {
  const byNumber = new Map(all.map((i) => [i.number, i]));
  const links: RelatedLink[] = [];
  const seen = new Set<number>();
  for (const n of parseRelated(issue.body)) {
    const other = byNumber.get(n);
    if (other && !seen.has(n)) {
      links.push({ issue: other, storedIn: "self" });
      seen.add(n);
    }
  }
  for (const other of all) {
    if (other.number === issue.number || seen.has(other.number)) continue;
    if (parseRelated(other.body).includes(issue.number)) {
      links.push({ issue: other, storedIn: "other" });
      seen.add(other.number);
    }
  }
  return links;
}
