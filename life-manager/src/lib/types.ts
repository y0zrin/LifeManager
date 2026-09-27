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
  /** まだ GitHub に送っていない変更がある（オフラインのあいだの変更）。まだ作っていない Issue の番号は負の数（仮の番号） */
  _pending?: boolean;
}

export interface GitHubComment {
  id: number;
  body: string;
  user: { login: string; avatar_url: string };
  created_at: string;
  updated_at: string;
  /** まだ GitHub に送っていないコメント */
  _pending?: boolean;
}

// --- オフラインのあいだの変更（送信待ち） ---

/** 送信待ちの 1 件 */
export interface PendingItem {
  number: number;
  title: string;
  /** 何をするか（「作る」「閉じる」「ラベル・本文を変える」「コメントする」など） */
  action: string;
  at: string;
}

/** 送るときに GitHub 側の変更とぶつかった・送れなかったもの */
export interface SyncConflict {
  id: number;
  number: number;
  title: string;
  field: "title" | "body" | "state" | "milestone" | "error";
  local: string;
  remote: string;
  message: string;
}

export interface OfflineStatus {
  /** 最後の通信ができなかった */
  offline: boolean;
  pending: PendingItem[];
  conflicts: SyncConflict[];
}

export interface SyncResult {
  sent: number;
  pending: number;
  offline: boolean;
  /** 送るのを止めた理由（トークンが無効など） */
  stopped: string | null;
  /** 仮の番号 → GitHub の番号 */
  mapping: Record<string, number>;
}

export interface RoutineSchedule {
  frequency: string;
  days?: string[];
  day?: string | number;
  time: string;
  start_date?: string;
  end_date?: string;
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
  | "routine_created"
  | "issue_closed"
  | "issue_reopened"
  | "status_changed"
  | "comment_added"
  | "todo_toggled"
  | "issue_promoted"
  | "issue_updated";

export const EVENT_TYPE_LABELS: Record<EventType, string> = {
  issue_created: "Issue作成",
  routine_created: "ルーチン実行",
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

// --- git（PC のみ。スマホ版では使わない） ---

/** git の実行結果。command は画面に見せる「実行したコマンド」 */
export interface GitRun {
  command: string;
  output: string;
}

/** 追加・削除した行数 */
export interface GitLineStat {
  added: number;
  deleted: number;
}

/** 変更のあるファイル。staged / unstaged は git status の 1 文字（A/M/D/R/C/U/?）、変化がなければ空 */
export interface GitFileChange {
  path: string;
  orig_path: string | null;
  staged: string;
  unstaged: string;
  /** 行数。バイナリファイルなど数えられないときは null */
  staged_lines: GitLineStat | null;
  unstaged_lines: GitLineStat | null;
}

export interface GitStatus {
  /** 今のブランチ。ブランチから切り離されているときは空 */
  branch: string;
  /** 先頭のコミット（短縮）。まだコミットがなければ空 */
  head: string;
  last_subject: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** まだどのリモートにもないコミットの数 */
  unpushed: number;
  /** GitHub の既定のブランチ（分かるときだけ） */
  default_branch: string | null;
  files: GitFileChange[];
  conflicted: boolean;
  /** 途中で止まっている操作（競合を直して続けるか、中止するのを待っている） */
  operation: GitOperation | null;
}

export type GitOperation = "merge" | "rebase" | "cherry-pick" | "revert";

export interface GitBranch {
  name: string;
  current: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** 上流のブランチが GitHub 側で消されている */
  gone: boolean;
  head: string;
  date: string;
  subject: string;
}

export interface GitStash {
  index: number;
  message: string;
  date: string;
  /** 退避したファイルの数（0 なら中身は空）。調べられなかったときは null */
  files: number | null;
}

/** 履歴のコミット 1 件 */
export interface GitCommit {
  hash: string;
  parents: string[];
  author: string;
  /** 作った日時（ISO 8601） */
  date: string;
  subject: string;
}

/** ブランチやタグが指しているコミット。remote は origin/… など、GitHub にあるブランチの控え */
export interface GitRefTip {
  kind: "branch" | "remote" | "tag";
  name: string;
  hash: string;
}

/** ブランチ画面・全体図の履歴（この PC の git か、GitHub API から作る） */
export interface GitHistory {
  /** 新しい順。子のコミットは必ず親より前 */
  commits: GitCommit[];
  refs: GitRefTip[];
  /** チェックアウト中のブランチ（この PC の git のときだけ） */
  head_branch: string | null;
  head: string | null;
  default_branch: string | null;
  truncated: boolean;
  source: "local" | "github";
}

/** 使う準備ができているか（Git が入っているか、コミットに使う名前とメールアドレスが決まっているか） */
export interface GitSetupStatus {
  /** Git のバージョン。入っていなければ null */
  git: string | null;
  user_name: string | null;
  user_email: string | null;
  /** この PC で使えるインストールの方法。自動では入れられないときは null */
  installer: "winget" | "download" | "xcode" | null;
}

export interface GitFolderCheck {
  is_repo: boolean;
  top_level: string;
  remote_url: string | null;
  /** origin がこのプロジェクトの GitHub リポジトリを指している */
  matches_project: boolean;
}

export type ViewType =
  | "work"
  | "dashboard" | "kanban" | "milestones" | "routines" | "timeline" | "gantt"
  | "branches" | "overview"
  | "settings";
