// 画面に出すラベル（#268）。チームが作ったラベルは、名前の頭（種別: など）に関わらず出す。
// GitHub がリポジトリを作ったときに入れる 9 つ（bug など）は出さない
import type { GitHubLabel } from "./types";

/** GitHub がリポジトリを作ったときに入れるラベル */
export const GITHUB_DEFAULT_LABELS: ReadonlySet<string> = new Set([
  "bug",
  "documentation",
  "duplicate",
  "enhancement",
  "good first issue",
  "help wanted",
  "invalid",
  "question",
  "wontfix",
]);

/** 画面に出すラベル（GitHub のはじめの 9 つを外したもの） */
export function visibleLabels(labels: GitHubLabel[]): GitHubLabel[] {
  return labels.filter((l) => !GITHUB_DEFAULT_LABELS.has(l.name));
}

/** 送ったラベルが、GitHub から返ってきた Issue に全部付いているか（並びは見ない）。
 *  GitHub は、書き込みの権限がない人のラベルの変更を、エラーにせず捨てる */
export function labelsApplied(requested: string[], returned: { name: string }[]): boolean {
  const want = new Set(requested);
  const got = new Set(returned.map((l) => l.name));
  return want.size === got.size && [...want].every((name) => got.has(name));
}
