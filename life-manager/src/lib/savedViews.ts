// タスク一覧の「保存した見方」。リポジトリの config/views.yaml に置き、チームで共有する
import { GROUP_LABELS, SORT_LABELS, type GroupKey, type LabelFilters, type ListMode, type SortKey } from "./taskList";

export type StateFilter = "open" | "closed" | "all";

/** マイルストーンの絞り込み（番号か、マイルストーンのないもの） */
export type MilestoneFilter = number | "none";

export interface SavedView {
  name: string;
  /** ラベルの絞り込み（種類ごとに、値と どれか／すべて） */
  filters: LabelFilters;
  /** 担当。ME は開いた人（自分）、空は全員 */
  assignee: string;
  /** マイルストーン（番号）。"none" はマイルストーンなし、ないときは全部 */
  milestone?: MilestoneFilter;
  state: StateFilter;
  sort: SortKey;
  group: GroupKey;
  mode: ListMode;
}

/** 見方の中の「自分」。開いた人に読み替える（同じ見方をチームの全員が使えるように） */
export const ME = "@me";

/** 画面の今の設定（見方から名前を除いたもの） */
export type ViewSettings = Omit<SavedView, "name">;

const STATES: StateFilter[] = ["open", "closed", "all"];

function normalizeFilters(raw: unknown): LabelFilters {
  const out: LabelFilters = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, f] of Object.entries(raw as Record<string, unknown>)) {
    const r = (f ?? {}) as { values?: unknown; mode?: unknown };
    const values = Array.isArray(r.values) ? r.values.filter((x): x is string => typeof x === "string") : [];
    if (values.length > 0) out[key] = { values, mode: r.mode === "all" ? "all" : "any" };
  }
  return out;
}

function milestoneOf(raw: unknown): { milestone?: MilestoneFilter } {
  if (raw === "none") return { milestone: "none" };
  const n = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 ? { milestone: n } : {};
}

/** 読んだ一覧を確かめ、足りない所を補う（手で書き換えた views.yaml でも画面が止まらないように） */
export function normalizeViews(raw: unknown): SavedView[] {
  if (!Array.isArray(raw)) return [];
  const out: SavedView[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (typeof r.name !== "string" || !r.name.trim()) continue;
    out.push({
      name: r.name.trim(),
      filters: normalizeFilters(r.filters),
      assignee: typeof r.assignee === "string" ? r.assignee : "",
      ...milestoneOf(r.milestone),
      state: STATES.includes(r.state as StateFilter) ? (r.state as StateFilter) : "open",
      sort: typeof r.sort === "string" && r.sort in SORT_LABELS ? (r.sort as SortKey) : "new",
      group: typeof r.group === "string" && r.group in GROUP_LABELS ? (r.group as GroupKey) : "none",
      mode: r.mode === "table" ? "table" : "card",
    });
  }
  return out;
}

function filterKey(filters: LabelFilters): string {
  return Object.entries(filters)
    .filter(([, f]) => f && f.values.length > 0)
    .map(([key, f]) => `${key}=${f.mode}:${[...f.values].sort().join(",")}`)
    .sort()
    .join("|");
}

/** 今の設定が、その見方と同じか（絞り込みの選んだ順の違いは気にしない） */
export function sameSettings(a: ViewSettings, b: ViewSettings): boolean {
  return (
    a.assignee === b.assignee &&
    (a.milestone ?? null) === (b.milestone ?? null) &&
    a.state === b.state &&
    a.sort === b.sort &&
    a.group === b.group &&
    a.mode === b.mode &&
    filterKey(a.filters) === filterKey(b.filters)
  );
}

/** マイルストーンの絞り込みの説明（「マイルストーン:0.5.0」など）。titleOf は番号から名前を引く */
export function describeMilestone(m: MilestoneFilter, titleOf?: (n: number) => string | undefined): string {
  if (m === "none") return "マイルストーンなし";
  return `マイルストーン:${titleOf?.(m) ?? `#${m}`}`;
}

/** メニューに出す、見方の中身の短い説明 */
export function describeView(v: ViewSettings, milestoneTitle?: (n: number) => string | undefined): string {
  const parts: string[] = [];
  if (v.milestone !== undefined) parts.push(describeMilestone(v.milestone, milestoneTitle));
  for (const f of Object.values(v.filters)) {
    if (f && f.values.length > 0) parts.push(f.values.join(f.mode === "all" ? "＋" : "・"));
  }
  if (v.assignee) parts.push(v.assignee === ME ? "担当:自分" : `担当:${v.assignee}`);
  if (v.state !== "open") parts.push(v.state === "closed" ? "クローズのみ" : "オープンとクローズ");
  parts.push(SORT_LABELS[v.sort]);
  if (v.group !== "none") parts.push(`${GROUP_LABELS[v.group]}でまとめる`);
  parts.push(v.mode === "table" ? "表" : "カード");
  return parts.join("／");
}
