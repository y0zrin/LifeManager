import type { GitHubIssue } from "./types";
import { dueOf } from "./due";

// --- ラベルの絞り込み（種類ごとに複数選べる。どれか＝OR、すべて＝AND） ---

export type LabelFilterMode = "any" | "all";

export interface LabelFilter {
  values: string[];
  mode: LabelFilterMode;
}

/** 種類（"分野:" など）ごとの絞り込み */
export type LabelFilters = Record<string, LabelFilter>;

/** 種類ごとの条件をすべて満たすか（種類どうしは AND。種類の中は、選んだ方式） */
export function matchesLabelFilters(issue: GitHubIssue, filters: LabelFilters): boolean {
  const names = issue.labels.map((l) => l.name);
  return Object.values(filters).every((f) => {
    if (!f || f.values.length === 0) return true;
    return f.mode === "all" ? f.values.every((v) => names.includes(v)) : f.values.some((v) => names.includes(v));
  });
}

// --- 並び ---

export type SortKey = "new" | "old" | "updated" | "priority" | "due";

export const SORT_LABELS: Record<SortKey, string> = {
  new: "新しい順",
  old: "古い順",
  updated: "更新が新しい順",
  priority: "優先度順",
  due: "期限が近い順",
};

/** 優先度の順番（高 → 中・なし → 低）。優先のない Issue は「中」と同じに扱う */
export function priorityRank(issue: GitHubIssue): number {
  const names = issue.labels.map((l) => l.name);
  if (names.includes("優先:高")) return 0;
  if (names.includes("優先:低")) return 2;
  return 1;
}

const byNumberDesc = (a: GitHubIssue, b: GitHubIssue) => b.number - a.number;

export function sortIssues(list: GitHubIssue[], key: SortKey): GitHubIssue[] {
  const compare: Record<SortKey, (a: GitHubIssue, b: GitHubIssue) => number> = {
    new: (a, b) => b.created_at.localeCompare(a.created_at) || byNumberDesc(a, b),
    old: (a, b) => a.created_at.localeCompare(b.created_at) || a.number - b.number,
    updated: (a, b) => b.updated_at.localeCompare(a.updated_at) || byNumberDesc(a, b),
    priority: (a, b) => priorityRank(a) - priorityRank(b) || byNumberDesc(a, b),
    // 期限のないものは後ろ。同じ日なら優先度の高いほうを先に
    due: (a, b) =>
      (dueOf(a)?.date ?? "9999").localeCompare(dueOf(b)?.date ?? "9999") || priorityRank(a) - priorityRank(b) || byNumberDesc(a, b),
  };
  return [...list].sort(compare[key]);
}

// --- 親子でまとめる ---

export interface TaskRow {
  issue: GitHubIssue;
  /** 0 = 親（または親が一覧にない子）、1 以上 = 子の深さ */
  depth: number;
}

/**
 * 子を親のすぐ下に並べる（並びの順は保つ）。親が一覧に出ていない子は、自分の位置にそのまま出す。
 * parentOf は、同じリポジトリの親の番号（なければ null）
 */
export function groupByParent(sorted: GitHubIssue[], parentOf: (issue: GitHubIssue) => number | null): TaskRow[] {
  const shown = new Set(sorted.map((i) => i.number));
  const children = new Map<number, GitHubIssue[]>();
  const roots: GitHubIssue[] = [];
  for (const issue of sorted) {
    const parent = parentOf(issue);
    if (parent !== null && parent !== issue.number && shown.has(parent)) {
      children.set(parent, [...(children.get(parent) ?? []), issue]);
    } else {
      roots.push(issue);
    }
  }
  const rows: TaskRow[] = [];
  const seen = new Set<number>();
  const visit = (issue: GitHubIssue, depth: number) => {
    if (seen.has(issue.number)) return;
    seen.add(issue.number);
    rows.push({ issue, depth });
    for (const child of children.get(issue.number) ?? []) visit(child, depth + 1);
  };
  roots.forEach((issue) => visit(issue, 0));
  // 親子が輪になっているなど、どこからもたどれなかったものも落とさない
  for (const issue of sorted) if (!seen.has(issue.number)) rows.push({ issue, depth: 0 });
  return rows;
}
