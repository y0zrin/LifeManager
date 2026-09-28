// 見積もり（タスクの大きさ）。時間ではなく、ほかのタスクと比べた大きさを 1・2・3・5・8 で表す。
// GitHub にはラベル「見積:3」として付ける（「優先:高」と同じ形。GitHub の画面でも見え、絞り込める）
import type { GitHubIssue } from "./types";

export const ESTIMATE_PREFIX = "見積:";
export const ESTIMATE_VALUES = [1, 2, 3, 5, 8] as const;
/** ラベルを作るときの色（画面の見積もりの印と同じ青緑。ラベルの一括作成 setup_labels と同じ） */
export const ESTIMATE_COLOR = "39C5CF";
export const ESTIMATE_DESCRIPTION = "見積もり（タスクの大きさ）";

export function estimateLabel(value: number): string {
  return `${ESTIMATE_PREFIX}${value}`;
}

/** Issue の見積もり。付いていなければ null（GitHub で「見積:13」のように付けたものも読む） */
export function estimateOf(issue: GitHubIssue): number | null {
  for (const l of issue.labels) {
    if (!l.name.startsWith(ESTIMATE_PREFIX)) continue;
    const n = Number(l.name.slice(ESTIMATE_PREFIX.length).trim());
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/** ラベルの並びの見積もりを付け替える（null なら外す）。見積もりは 1 つだけ */
export function withEstimate(names: string[], value: number | null): string[] {
  const kept = names.filter((n) => !n.startsWith(ESTIMATE_PREFIX));
  return value === null ? kept : [...kept, estimateLabel(value)];
}

export interface EstimateSum {
  /** 見積もりの合計 */
  total: number;
  /** 見積もりのある件数 */
  counted: number;
  /** 見積もりのない件数 */
  missing: number;
}

export function sumEstimates(issues: GitHubIssue[]): EstimateSum {
  let total = 0;
  let counted = 0;
  let missing = 0;
  for (const issue of issues) {
    const e = estimateOf(issue);
    if (e === null) {
      missing++;
    } else {
      total += e;
      counted++;
    }
  }
  return { total, counted, missing };
}
