import type { GitHubIssue } from "./types";
import { dueOf } from "./due";
import { isSectionLabel } from "./section";

// --- ラベルの絞り込み（種類ごとに複数選べる。どれか＝OR、すべて＝AND） ---

export type LabelFilterMode = "any" | "all";

export interface LabelFilter {
  values: string[];
  mode: LabelFilterMode;
}

/** 種類（"セクション:" など）ごとの絞り込み */
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

// --- 見方（カード／表）とまとめ方 ---

/** 一覧の見せ方。カードは今までの形、表は 1 行に 1 件 */
export type ListMode = "card" | "table";

export type GroupKey = "none" | "tree" | "state" | "priority" | "field" | "assignee" | "milestone";

export const GROUP_LABELS: Record<GroupKey, string> = {
  none: "なし",
  tree: "親子",
  state: "状態",
  priority: "優先",
  field: "セクション",
  assignee: "担当",
  milestone: "マイルストーン",
};

/** まとまり。まとめないときは見出しが空のまとまりが 1 つ */
export interface TaskGroup {
  title: string;
  rows: TaskRow[];
}

// 当てはまらないものは、それぞれ最後のまとまりにする
const NONE_TITLE: Record<Exclude<GroupKey, "none" | "tree">, string> = {
  state: "状態なし",
  priority: "優先なし",
  field: "セクションなし",
  assignee: "担当なし",
  milestone: "マイルストーンなし",
};
const CLOSED_TITLE = "完了";

function groupTitle(issue: GitHubIssue, key: Exclude<GroupKey, "none" | "tree">): string {
  const names = issue.labels.map((l) => l.name);
  const labelOf = (prefix: string) => names.find((n) => n.startsWith(prefix));
  switch (key) {
    case "state":
      // 閉じた Issue は、状態のラベルが残っていても「完了」にまとめる
      return issue.state === "closed" ? CLOSED_TITLE : labelOf("状態:") ?? NONE_TITLE.state;
    case "priority":
      return labelOf("優先:") ?? NONE_TITLE.priority;
    case "field":
      return names.find(isSectionLabel) ?? NONE_TITLE.field;
    case "assignee":
      return issue.assignees?.[0] ? `担当:${issue.assignees[0].login}` : NONE_TITLE.assignee;
    case "milestone":
      return issue.milestone ? `マイルストーン:${issue.milestone.title}` : NONE_TITLE.milestone;
  }
}

/**
 * 並べた Issue を、選んだ項目でまとめる。まとまりの中は元の並びのまま。
 * まとまりの順は、状態はボードの列の順（stateOrder）、優先は 高・中・低、ほかは一覧に出てきた順。
 * 「〜なし」と「完了」は最後に置く
 */
export function groupIssues(
  sorted: GitHubIssue[],
  key: GroupKey,
  opts: { parentOf: (issue: GitHubIssue) => number | null; stateOrder: string[] },
): TaskGroup[] {
  if (key === "none") return [{ title: "", rows: sorted.map((issue) => ({ issue, depth: 0 })) }];
  if (key === "tree") return [{ title: "", rows: groupByParent(sorted, opts.parentOf) }];
  const buckets = new Map<string, GitHubIssue[]>();
  for (const issue of sorted) {
    const title = groupTitle(issue, key);
    buckets.set(title, [...(buckets.get(title) ?? []), issue]);
  }
  const first = [...buckets.keys()];
  const rank = (title: string): number => {
    if (title === CLOSED_TITLE) return 2_000_000;
    if (title === NONE_TITLE[key]) return 1_000_000;
    if (key === "state") {
      const i = opts.stateOrder.indexOf(title);
      return i >= 0 ? i : 1000 + first.indexOf(title);
    }
    if (key === "priority") return ["優先:高", "優先:中", "優先:低"].indexOf(title);
    return first.indexOf(title);
  };
  return first
    .sort((a, b) => rank(a) - rank(b))
    .map((title) => ({ title, rows: (buckets.get(title) ?? []).map((issue) => ({ issue, depth: 0 })) }));
}
