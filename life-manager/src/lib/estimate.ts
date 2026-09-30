// 見積もり（タスクの大きさ・かかる時間）。単位はリポジトリ（チーム）ごとに決める（config/estimate.yaml）。
// GitHub にはラベル「見積:3pt」「見積:2時間」「見積:0.5日」「見積:1人月」として付ける（1 つの Issue に 1 つ）
import type { GitHubIssue } from "./types";

export const ESTIMATE_PREFIX = "見積:";
/** ラベルを作るときの色（画面の見積もりの印と同じ青緑） */
export const ESTIMATE_COLOR = "39C5CF";

export type EstimateUnit = "pt" | "hour" | "day" | "person_month";

export interface UnitSpec {
  /** 設定に出す名前 */
  name: string;
  /** 数のうしろに付ける字（ラベル・画面の表示） */
  suffix: string;
  /** 押して選べる数 */
  values: number[];
  /** 1 あたりの時間（時間・日・人月は換算して合計できる。ポイントは換算しない） */
  hours: number | null;
  /** 設定と見積もりの欄に出す、数の目安 */
  guide: string;
  /** 数ごとの目安（ボタンに乗せたときに出す） */
  valueGuide?: Record<number, string>;
}

/** 1 日＝8 時間、1 人月＝20 日（160 時間）で換算する */
export const HOURS_PER_DAY = 8;
export const DAYS_PER_PERSON_MONTH = 20;

export const UNITS: Record<EstimateUnit, UnitSpec> = {
  pt: {
    name: "ポイント",
    suffix: "pt",
    values: [1, 2, 3, 5, 8],
    hours: null,
    guide: "時間ではなく、ほかのタスクと比べた大きさ。最初は 1pt＝1 時間ほどを目安に、慣れたらチームで決めた基準のタスクと比べて付ける",
    valueGuide: {
      1: "1 時間ほど（文言や数値の直し）",
      2: "半日ほど",
      3: "1 日ほど（ふつうの機能一つ）",
      5: "2〜3 日",
      8: "1 週間近い（分けることを考える）",
    },
  },
  hour: {
    name: "時間",
    suffix: "時間",
    values: [1, 2, 4, 8, 16],
    hours: 1,
    guide: `実際にかかると思う時間。1 日＝${HOURS_PER_DAY} 時間。1 日を超えるものは分けることを考える`,
  },
  day: {
    name: "日",
    suffix: "日",
    values: [0.5, 1, 2, 3, 5],
    hours: HOURS_PER_DAY,
    guide: `1 人が働いてかかる日数。1 日＝${HOURS_PER_DAY} 時間として数える`,
  },
  person_month: {
    name: "人月",
    suffix: "人月",
    values: [0.25, 0.5, 1, 2, 3],
    hours: HOURS_PER_DAY * DAYS_PER_PERSON_MONTH,
    guide: `1 人月＝1 人が 1 か月（${DAYS_PER_PERSON_MONTH} 日・${HOURS_PER_DAY * DAYS_PER_PERSON_MONTH} 時間）働く量。大きな作業の計画向き`,
  },
};

export const UNIT_KEYS = Object.keys(UNITS) as EstimateUnit[];
export const DEFAULT_UNIT: EstimateUnit = "pt";

export function isEstimateUnit(v: unknown): v is EstimateUnit {
  return typeof v === "string" && v in UNITS;
}

export interface Estimate {
  value: number;
  unit: EstimateUnit;
}

/** 数を短く書く（小数は 2 けたまで。0.50 → 0.5） */
export function formatNumber(v: number): string {
  return String(Math.round(v * 100) / 100);
}

/** 「3pt」「2時間」「0.5日」「1.25人月」 */
export function formatEstimate(value: number, unit: EstimateUnit): string {
  return `${formatNumber(value)}${UNITS[unit].suffix}`;
}

export function estimateLabel(value: number, unit: EstimateUnit): string {
  return `${ESTIMATE_PREFIX}${formatEstimate(value, unit)}`;
}

// ラベルの後ろの単位（書き方の揺れも受ける。単位のないものはポイント）
const SUFFIXES: [RegExp, EstimateUnit][] = [
  [/^(?:pt|ポイント|p)?$/i, "pt"],
  [/^(?:時間|h|hr|hours?)$/i, "hour"],
  [/^(?:日|d|days?|人日)$/i, "day"],
  [/^(?:人月|pm)$/i, "person_month"],
];

/** ラベルの名前から見積もりを読む（「見積:3pt」「見積:2時間」「見積:13」など）。見積もりでなければ null */
export function parseEstimateLabel(name: string): Estimate | null {
  if (!name.startsWith(ESTIMATE_PREFIX)) return null;
  const m = name.slice(ESTIMATE_PREFIX.length).trim().match(/^([0-9]+(?:\.[0-9]+)?)\s*(.*)$/);
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = SUFFIXES.find(([re]) => re.test(m[2].trim()))?.[1];
  return unit ? { value, unit } : null;
}

/** Issue の見積もり。付いていなければ null */
export function estimateOf(issue: GitHubIssue): Estimate | null {
  for (const l of issue.labels) {
    const e = parseEstimateLabel(l.name);
    if (e) return e;
  }
  return null;
}

/** 見積もりを、別の単位の数にする。ポイントと時間の単位のあいだは換算できないので null */
export function convertEstimate(e: Estimate, to: EstimateUnit): number | null {
  if (e.unit === to) return e.value;
  const from = UNITS[e.unit].hours;
  const into = UNITS[to].hours;
  return from !== null && into !== null ? (e.value * from) / into : null;
}

/** ラベルの並びの見積もりを付け替える（value が null なら外す）。見積もりは 1 つだけ */
export function withEstimate(names: string[], value: number | null, unit: EstimateUnit): string[] {
  const kept = names.filter((n) => !n.startsWith(ESTIMATE_PREFIX));
  return value === null ? kept : [...kept, estimateLabel(value, unit)];
}

// ポイントを日数に直す目安（ポイントの valueGuide と同じ: 1pt＝1 時間・2pt＝半日・3pt＝1 日・5pt＝2〜3 日・8pt＝1 週間）
const PT_DAYS: [number, number][] = [
  [0, 0],
  [1, 1 / HOURS_PER_DAY],
  [2, 0.5],
  [3, 1],
  [5, 2.5],
  [8, 5],
];

/**
 * 見積もりを日数に直す（ガントの仮の日程に使う。1 日＝8 時間）。
 * ポイントは目安の表で直し、表の点のあいだは直線でつなぐ（8pt より上は最後の傾きでのばす）
 */
export function estimateDays(e: Estimate): number {
  const hours = UNITS[e.unit].hours;
  if (hours !== null) return (e.value * hours) / HOURS_PER_DAY;
  for (let i = 1; i < PT_DAYS.length; i++) {
    const [p1, d1] = PT_DAYS[i - 1];
    const [p2, d2] = PT_DAYS[i];
    if (e.value <= p2) return d1 + ((e.value - p1) * (d2 - d1)) / (p2 - p1);
  }
  const [pa, da] = PT_DAYS[PT_DAYS.length - 2];
  const [pb, db] = PT_DAYS[PT_DAYS.length - 1];
  return db + ((e.value - pb) * (db - da)) / (pb - pa);
}

export interface EstimateSum {
  /** 見積もりの合計（決めた単位に換算したもの） */
  total: number;
  unit: EstimateUnit;
  /** 数えた件数 */
  counted: number;
  /** 見積もりのない件数 */
  missing: number;
  /** 単位が違って換算できない見積もりの件数（ポイントと時間が混ざったとき） */
  other: number;
}

export function sumEstimates(issues: GitHubIssue[], unit: EstimateUnit): EstimateSum {
  const sum: EstimateSum = { total: 0, unit, counted: 0, missing: 0, other: 0 };
  for (const issue of issues) {
    const e = estimateOf(issue);
    if (!e) {
      sum.missing++;
      continue;
    }
    const v = convertEstimate(e, unit);
    if (v === null) {
      sum.other++;
    } else {
      sum.total += v;
      sum.counted++;
    }
  }
  return sum;
}
