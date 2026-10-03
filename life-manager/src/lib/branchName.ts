// 「作業をする」で作るブランチの名前（#251）: Issue の番号（issue-12）ではなく、Issue の題名から作る。
// 作ったブランチと Issue の組はこの PC に覚えておき、題名を変えたあとも、前のブランチ（issue-12 も）で続けられるようにする
import { issueOfBranch } from "./pulls";

type IssueLike = { number: number; title: string };

/** ブランチの名前の長さ（字の数）。長い題名は切る */
const MAX_CHARS = 40;

/**
 * Issue の題名から、ブランチの名前を作る。
 * 空白と、git で使えない字（~ ^ : ? * [ \ など）・シェルや URL で困る字・日本語の括弧や句読点は - にする。
 * 作れないとき（題名が記号だけなど）は issue-12
 */
export function branchNameFor(issue: IssueLike): string {
  let s = issue.title.normalize("NFKC");
  s = s
    .replace(/\s+/g, "-")
    .replace(/[~^:?*[\]\\/'"`<>|!$&;(){}#,@%=+]/g, "-")
    .replace(/[「」『』（）［］【】〈〉《》、。・！？：；“”‘’…]/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  if (s.toLowerCase().endsWith(".lock")) s = s.slice(0, -5).replace(/[-.]+$/, "");
  const chars = [...s];
  if (chars.length > MAX_CHARS) s = chars.slice(0, MAX_CHARS).join("").replace(/[-.]+$/, "");
  return s || `issue-${issue.number}`;
}

const storeKey = (owner: string, repo: string) => `work-branches:${owner}/${repo}`;

function loadMap(owner: string, repo: string): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(storeKey(owner, repo)) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

/** この Issue の作業に使ったブランチを覚える */
export function rememberWorkBranch(owner: string, repo: string, issueNumber: number, branch: string) {
  const map = loadMap(owner, repo);
  if (map[String(issueNumber)] === branch) return;
  map[String(issueNumber)] = branch;
  try {
    localStorage.setItem(storeKey(owner, repo), JSON.stringify(map));
  } catch {
    // 覚えられなくても、題名から作った名前で探せる
  }
}

/**
 * この Issue の作業のブランチ: 覚えたブランチ → 前の名前（issue-12）→ 題名から作った名前、の順に、この PC にあるものを選ぶ。
 * どれもなければ、題名から作った名前（これから作る）
 */
export function workBranchOf(owner: string, repo: string, issue: IssueLike, localBranches: string[]): string {
  const remembered = loadMap(owner, repo)[String(issue.number)];
  const fromTitle = branchNameFor(issue);
  for (const name of [remembered, `issue-${issue.number}`, fromTitle]) {
    if (name && localBranches.includes(name)) return name;
  }
  return fromTitle;
}

/** ブランチの Issue: 覚えた組 → 題名から作った名前 → 名前の中の番号（issue-12・feature/12-boss など）。見つからなければ null */
export function issueForBranch(branch: string, issues: IssueLike[], owner?: string, repo?: string): number | null {
  if (!branch) return null;
  if (owner && repo) {
    const map = loadMap(owner, repo);
    for (const [n, name] of Object.entries(map)) {
      if (name === branch && issues.some((i) => i.number === Number(n))) return Number(n);
    }
  }
  const byTitle = issues.find((i) => branchNameFor(i) === branch);
  if (byTitle) return byTitle.number;
  const n = issueOfBranch(branch);
  return n !== null && issues.some((i) => i.number === n) ? n : null;
}
