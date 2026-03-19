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
}

export interface GanttViewConfig {
  timeScale: TimeScale;
  startDate: string;  // visible range start "YYYY-MM-DD"
  endDate: string;    // visible range end "YYYY-MM-DD"
  rowHeight: number;
  headerHeight: number;
  pixelsPerDay: number;
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
  default: "デフォルト",
  inProgress: "進行中",
  blocked: "ブロック",
  closed: "完了",
  critical: "クリティカルパス",
  highPriority: "優先:高",
};

export const TIME_SCALE_CONFIG: Record<TimeScale, { pixelsPerDay: number; label: string }> = {
  day: { pixelsPerDay: 40, label: "日" },
  week: { pixelsPerDay: 12, label: "週" },
  month: { pixelsPerDay: 4, label: "月" },
};
