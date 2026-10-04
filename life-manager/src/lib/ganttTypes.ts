import { tr } from "./i18n";
export type ProgressMode = "checkbox" | "manual" | "binary";
export type TimeScale = "day" | "week" | "month";

export interface GanttTask {
  issueNumber: number;
  title: string;
  state: string; // "open" | "closed"
  assignees: { login: string; avatar_url: string }[];
  labels: { name: string; color: string }[];
  startDate: string | null; // "YYYY-MM-DD"
  endDate: string | null;   // "YYYY-MM-DD"
  dependencies: number[];   // issue numbers
  progressMode: ProgressMode;
  progressValue: number;    // 0-100
  /** 見積もり（「2日」「5pt」など。付いていなければ null） */
  estimate: string | null;
  /** 日程がないので、見積もりから仮に置いた日程か（lib/ganttSchedule.ts） */
  tentative?: boolean;
}

/** 押した（乗せた）タスクの、先行・後続の相手（下の帯・スマホの下の板に出す） */
export interface GanttLink {
  n: number;
  title: string;
  /** 帯がない理由（帯があれば null。押して送れない） */
  reason: string | null;
  /** ふだん省いている矢印（乗せたときだけ点線で出す） */
  redundant: boolean;
  /** 順番が逆（後続が、先行の終わる前にはじまる） */
  broken: boolean;
  /** 先行が遅れている（終わりの日が過ぎたのに、まだ開いている）。先行のときだけ */
  late: boolean;
}

export interface GanttViewConfig {
  timeScale: TimeScale;
  startDate: string;  // visible range start "YYYY-MM-DD"
  endDate: string;    // visible range end "YYYY-MM-DD"
  rowHeight: number;
  headerHeight: number;
  pixelsPerDay: number;
  /** マイルストーンの期限（YYYY-MM-DD）。線を引き、仮の帯の超えた分を赤くする */
  deadline?: string | null;
}

export interface GanttBarColors {
  default: string;
  inProgress: string;
  blocked: string;
  closed: string;
  critical: string;
  highPriority: string;
}

export const DEFAULT_BAR_COLORS: GanttBarColors = {
  default: "#888888",
  inProgress: "#0075CA",
  blocked: "#D73A4A",
  closed: "#2DA44E",
  critical: "#CF222E",
  highPriority: "#E16F24",
};

export const BAR_COLOR_LABELS: Record<keyof GanttBarColors, string> = {
  default: tr("デフォルト"),
  inProgress: tr("進行中"),
  blocked: tr("ブロック"),
  closed: tr("完了"),
  critical: tr("クリティカルパス"),
  highPriority: "優先:高",
};

export const TIME_SCALE_CONFIG: Record<TimeScale, { pixelsPerDay: number; label: string }> = {
  day: { pixelsPerDay: 40, label: tr("日") },
  week: { pixelsPerDay: 12, label: tr("週") },
  month: { pixelsPerDay: 4, label: tr("月") },
};
