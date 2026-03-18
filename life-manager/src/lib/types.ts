export interface GitHubUser {
  login: string;
  avatar_url: string;
}

export interface GitHubLabel {
  name: string;
  color: string;
  description?: string;
}

export interface GitHubMilestone {
  number: number;
  title: string;
  description: string | null;
  due_on: string | null;
  state: string;
  open_issues: number;
  closed_issues: number;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  labels: GitHubLabel[];
  milestone: GitHubMilestone | null;
  assignees: GitHubUser[];
  comments: number;
  created_at: string;
  updated_at: string;
}

export interface GitHubComment {
  id: number;
  body: string;
  user: { login: string; avatar_url: string };
  created_at: string;
  updated_at: string;
}

export interface RoutineSchedule {
  frequency: string;
  days?: string[];
  day?: string | number;
  time: string;
}

export interface RoutineIssueTemplate {
  title: string;
  labels: string[];
  body?: string;
}

export interface Routine {
  name: string;
  schedule: RoutineSchedule;
  issue: RoutineIssueTemplate;
  auto_close?: string;
}

export interface NotificationSchedule {
  name: string;
  schedule: RoutineSchedule;
  type: string; // "today_tasks" | "overdue" | "summary" | "custom"
  message?: string;
  channels: string[];
}

export interface Reminder {
  issue_number: number;
  title: string;
  datetime: string; // "YYYY-MM-DDTHH:mm"
  channels: string[];
}

export interface EventEntry {
  enabled: boolean;
  channels: string[];
}

export interface EventNotificationConfig {
  enabled: boolean;
  os_for_own_actions: boolean;
  events: Record<string, EventEntry>;
}

export type EventType =
  | "issue_created"
  | "issue_closed"
  | "issue_reopened"
  | "status_changed"
  | "comment_added"
  | "todo_toggled"
  | "issue_promoted"
  | "issue_updated";

export const EVENT_TYPE_LABELS: Record<EventType, string> = {
  issue_created: "Issue作成",
  issue_closed: "Issue完了",
  issue_reopened: "Issue再開",
  status_changed: "状態変更",
  comment_added: "コメント追加",
  todo_toggled: "チェックボックス操作",
  issue_promoted: "メモ昇華",
  issue_updated: "Issue編集",
};

export interface BoardColumn {
  key: string;       // label name like "状態:進行中" or "none" for uncategorized
  title: string;     // display name like "進行中"
  emoji: string;     // emoji like "🔥"
}

export interface BoardConfig {
  columns: BoardColumn[];
}

export interface Project {
  owner: string;
  repo: string;
  name: string;
}

export type ViewType = "dashboard" | "kanban" | "milestones" | "routines" | "timeline" | "gantt" | "settings";
