import type { GitHubIssue } from "./types";
import type { GanttTask, ProgressMode } from "./ganttTypes";

/** Issue bodyから <!-- gantt:YYYY-MM-DD/YYYY-MM-DD --> を抽出 */
export function parseGanttDates(body: string | null): { start: string; end: string } | null {
  if (!body) return null;
  const m = body.match(/<!--\s*gantt:(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})\s*-->/);
  if (!m) return null;
  return { start: m[1], end: m[2] };
}

/** Issue bodyから <!-- depends:#N,#N --> を抽出 */
export function parseDependencies(body: string | null): number[] {
  if (!body) return [];
  const m = body.match(/<!--\s*depends:(#\d+(?:,#\d+)*)\s*-->/);
  if (!m) return [];
  return m[1].split(",").map((s) => parseInt(s.replace("#", ""), 10)).filter((n) => !isNaN(n));
}

/** Issue bodyから progress-mode と progress 値を抽出 */
export function parseProgress(body: string | null): { mode: ProgressMode; value: number | string } {
  if (!body) return { mode: "checkbox", value: 0 };

  const modeMatch = body.match(/<!--\s*progress-mode:(checkbox|manual|binary)\s*-->/);
  const mode: ProgressMode = modeMatch ? modeMatch[1] as ProgressMode : "checkbox";

  if (mode === "manual") {
    const valMatch = body.match(/<!--\s*progress:(\d+)\s*-->/);
    return { mode, value: valMatch ? parseInt(valMatch[1], 10) : 0 };
  }

  if (mode === "binary") {
    const valMatch = body.match(/<!--\s*progress:(done|undone)\s*-->/);
    return { mode, value: valMatch ? valMatch[1] : "undone" };
  }

  return { mode: "checkbox", value: 0 };
}

/** チェックボックスの進捗率を算出 */
function computeCheckboxProgress(body: string | null): number {
  if (!body) return 0;
  const all = body.match(/- \[([ x])\]/g);
  if (!all || all.length === 0) return 0;
  const checked = all.filter((m) => m === "- [x]").length;
  return Math.round((checked / all.length) * 100);
}

/** GitHubIssue から最終的な進捗率 (0-100) を算出 */
export function computeProgress(issue: GitHubIssue): number {
  if (issue.state === "closed") return 100;

  const { mode, value } = parseProgress(issue.body);

  switch (mode) {
    case "checkbox":
      return computeCheckboxProgress(issue.body);
    case "manual":
      return Math.min(100, Math.max(0, typeof value === "number" ? value : 0));
    case "binary":
      return value === "done" ? 100 : 0;
    default:
      return 0;
  }
}

/** Issue body内のメタデータコメントを更新または追加 */
export function updateBodyMetadata(body: string | null, pattern: RegExp, newComment: string): string {
  const b = body || "";
  if (pattern.test(b)) {
    return b.replace(pattern, newComment);
  }
  return b.trimEnd() + "\n" + newComment;
}

/** gantt日付メタデータを生成 */
export function serializeGanttDates(start: string, end: string): string {
  return `<!-- gantt:${start}/${end} -->`;
}

/** 依存関係メタデータを生成 */
export function serializeDependencies(deps: number[]): string {
  if (deps.length === 0) return "";
  return `<!-- depends:${deps.map((n) => `#${n}`).join(",")} -->`;
}

/** 進捗モードメタデータを生成 */
export function serializeProgress(mode: ProgressMode, value?: number | string): string {
  let result = `<!-- progress-mode:${mode} -->`;
  if (mode === "manual" && value !== undefined) {
    result += `\n<!-- progress:${value} -->`;
  } else if (mode === "binary" && value !== undefined) {
    result += `\n<!-- progress:${value} -->`;
  }
  return result;
}

/** GitHubIssue[] を GanttTask[] に変換 */
export function issuesToGanttTasks(issues: GitHubIssue[]): GanttTask[] {
  return issues.map((issue) => {
    const dates = parseGanttDates(issue.body);
    const deps = parseDependencies(issue.body);
    const { mode } = parseProgress(issue.body);
    const progress = computeProgress(issue);

    return {
      issueNumber: issue.number,
      title: issue.title,
      state: issue.state,
      assignees: issue.assignees,
      labels: issue.labels,
      startDate: dates?.start ?? null,
      endDate: dates?.end ?? null,
      dependencies: deps,
      progressMode: mode,
      progressValue: progress,
    };
  });
}

/** body からガントメタデータ行をすべて除去 */
export function stripGanttMetadata(body: string): string {
  return body
    .replace(/<!--\s*gantt:[^>]*-->\n?/g, "")
    .replace(/<!--\s*depends:[^>]*-->\n?/g, "")
    .replace(/<!--\s*progress-mode:[^>]*-->\n?/g, "")
    .replace(/<!--\s*progress:\d+\s*-->\n?/g, "")
    .replace(/<!--\s*progress:(done|undone)\s*-->\n?/g, "")
    .trimEnd();
}
