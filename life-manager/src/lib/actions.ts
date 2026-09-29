// Actions（実行・ジョブ・ログ・もう一度実行・手で実行）と、セキュリティのお知らせ。
// 「解決する順の山」の積み方（どれを先に直すか）は、このファイルの buildStack にまとめる
import { invoke } from "@tauri-apps/api/core";

export interface Actor {
  login: string;
  avatar_url: string;
}

export interface Run {
  id: number;
  /** ワークフローの名前（テスト・ビルドなど） */
  name: string;
  /** 実行の題（コミットの 1 行目・プルリクの題など） */
  title: string;
  workflow_id: number;
  path: string;
  branch: string;
  sha: string;
  /** push / pull_request / schedule / workflow_dispatch など */
  event: string;
  /** queued / in_progress / waiting / requested / pending / completed */
  status: string;
  /** success / failure / cancelled / skipped / timed_out / action_required / neutral / stale / startup_failure（終わるまで null） */
  conclusion: string | null;
  run_number: number;
  run_attempt: number;
  /** もう一度動かして止めた実行（取り消し・2 回目以降）の、前の回の結果と、その回（山は前の回の結果のままにする） */
  previous_conclusion?: string | null;
  previous_attempt?: number | null;
  actor: Actor | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  html_url: string;
  /** この実行に付いているプルリクの番号 */
  pulls: number[];
  /** フォークから来た実行 */
  fork: boolean;
  commit_message: string;
  commit_author: string | null;
}

export interface Step {
  number: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export interface Job {
  id: number;
  run_id: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  html_url: string;
  labels: string[];
  steps: Step[];
}

export interface DependabotAlert {
  number: number;
  /** critical / high / medium / low */
  severity: string | null;
  package: string;
  ecosystem: string;
  manifest: string;
  summary: string;
  vulnerable: string | null;
  fixed: string | null;
  cve: string | null;
  ghsa: string | null;
  html_url: string;
  created_at: string;
}

export interface CodeAlert {
  number: number;
  /** critical / high / medium / low、なければ error / warning / note */
  severity: string | null;
  rule: string;
  tool: string;
  path: string | null;
  line: number | null;
  message: string | null;
  html_url: string;
  created_at: string;
}

/** ok: 読めた / off: 使っていない / forbidden: 権限がない / error: 読めなかった */
export interface SecurityState<T> {
  state: "ok" | "off" | "forbidden" | "error";
  alerts?: T[];
  message?: string;
}

export interface OpenPull {
  number: number;
  title: string;
  head: string;
  head_sha: string;
  draft: boolean;
}

export interface ActionsOverview {
  default_branch: string;
  can_push: boolean;
  /** 管理者か（Dependabot を有効にできる） */
  can_admin: boolean;
  /** 持ち主の種類: User（個人）/ Organization（組織） */
  owner_type: string | null;
  private: boolean;
  /** GitHub が見た、いちばん多い言語（ワークフローのひな形を選ぶ） */
  language: string | null;
  /** ワークフローの数（読めなければ null）。0 なら、はじめる準備を促す */
  workflow_count: number | null;
  /** このリポジトリで Actions を使うか（管理者でなければ読めないので null） */
  actions_enabled: boolean | null;
  /** ブランチの一覧（読めなければ null） */
  branches: string[] | null;
  protected: string[];
  /** 開いているプルリク（プルリクの権限がなければ null） */
  pulls: OpenPull[] | null;
  runs: Run[];
  dependabot: SecurityState<DependabotAlert>;
  code_scanning: SecurityState<CodeAlert>;
}

export interface DispatchInput {
  name: string;
  description: string | null;
  required: boolean;
  default: string | null;
  /** string / boolean / choice / number / environment */
  type: string;
  options: string[];
}

export interface Workflow {
  id: number;
  name: string;
  path: string;
  state: string;
  html_url: string;
  /** 手で実行できるなら、その入力（なければ空）。できなければ null */
  dispatch: DispatchInput[] | null;
}

export interface CheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  html_url: string;
  details_url: string | null;
  app: string | null;
  title: string | null;
  summary: string;
}

export interface CommitStatus {
  context: string;
  /** success / failure / error / pending */
  state: string;
  description: string | null;
  target_url: string | null;
  updated_at: string;
}

export interface CommitChecks {
  checks: CheckRun[];
  statuses: CommitStatus[];
}

export interface CheckSummary {
  success: number;
  failure: number;
  pending: number;
}

/** このアカウントに入れてある Life Manager の権限（kind = token は、自分で作ったトークンで入っているとき） */
export interface InstallationInfo {
  kind: "app" | "token";
  installed?: boolean;
  html_url?: string | null;
  account_type?: string | null;
  /** 権限の名前（actions・pull_requests など）→ read / write */
  permissions?: Record<string, string> | null;
  repository_selection?: string | null;
}

/** 画面ごとに要る権限（key は GitHub の API の名前、name は GitHub の設定の画面の名前） */
export interface NeededPermission {
  key: string;
  name: string;
  access: "read" | "write";
}

export const PULL_PERMISSIONS: NeededPermission[] = [{ key: "pull_requests", name: "Pull requests", access: "write" }];
export const ACTIONS_PERMISSIONS: NeededPermission[] = [
  { key: "actions", name: "Actions", access: "write" },
  { key: "checks", name: "Checks", access: "read" },
  { key: "statuses", name: "Commit statuses", access: "read" },
];
export const SECURITY_PERMISSIONS: Record<"dependabot" | "code", NeededPermission[]> = {
  dependabot: [{ key: "vulnerability_alerts", name: "Dependabot alerts", access: "read" }],
  code: [{ key: "security_events", name: "Code scanning alerts", access: "read" }],
};

/** 入れてある権限に、要る権限が足りているか（write があれば read も足りる） */
export const hasPermission = (granted: Record<string, string> | null | undefined, p: NeededPermission) => {
  const g = granted?.[p.key];
  return g === "write" || g === "admin" || (p.access === "read" && g === "read");
};

/** エラーが「権限が足りない」ものか（github/errors.rs の言いかえ） */
export const isPermissionError = (message: string | null | undefined) => !!message && message.includes("の権限");

// --- GitHub とのやりとり ---

export const actionsOverview = (owner: string, repo: string) => invoke<ActionsOverview>("actions_overview", { owner, repo });
export const actionsWorkflows = (owner: string, repo: string) => invoke<Workflow[]>("actions_workflows", { owner, repo });
/** attempt を渡すと、その回のジョブ（もう一度動かして止めたときの、前の回の失敗など） */
export const runJobs = (owner: string, repo: string, runId: number, attempt?: number | null) =>
  invoke<Job[]>("run_jobs", { owner, repo, runId, attempt: attempt ?? null });
export const jobLog = (owner: string, repo: string, jobId: number) => invoke<{ lines: string[]; truncated: boolean }>("job_log", { owner, repo, jobId });
export const rerunRun = (owner: string, repo: string, runId: number, failedOnly: boolean) => invoke<void>("rerun_run", { owner, repo, runId, failedOnly });
export const cancelRun = (owner: string, repo: string, runId: number) => invoke<void>("cancel_run", { owner, repo, runId });
export const dispatchWorkflow = (owner: string, repo: string, workflowId: number, gitRef: string, inputs: Record<string, string>) =>
  invoke<void>("dispatch_workflow", { owner, repo, workflowId, gitRef, inputs });
export const commitChecks = (owner: string, repo: string, sha: string) => invoke<CommitChecks>("commit_checks", { owner, repo, sha });
export const installationPermissions = (owner: string) => invoke<InstallationInfo>("installation_permissions", { owner });
export const enableDependabot = (owner: string, repo: string) => invoke<void>("enable_dependabot", { owner, repo });
export const setActionsEnabled = (owner: string, repo: string, enabled: boolean) => invoke<void>("set_actions_enabled", { owner, repo, enabled });

/**
 * Actions のオン・オフと、非公開のリポジトリで動かす（もう一度・手で実行）のは「持ち主」だけ（持ち主の無料の時間を使うため）。
 * 個人のリポジトリは持ち主のアカウント本人、組織のリポジトリは管理者（組織の持ち主かどうかは App の権限では確かめられないので）
 */
export function canManageActions(ov: Pick<ActionsOverview, "owner_type" | "can_admin">, owner: string, me: string): boolean {
  if (ov.owner_type === "Organization") return ov.can_admin;
  return !!me && owner.toLowerCase() === me.toLowerCase();
}

/** Actions の「はじめる準備」に出すもの。「今は使わない」で隠したものは、設定 → その他 で戻す */
export type SetupItem = "workflow" | "dependabot" | "code";

export const SETUP_ITEMS: { key: SetupItem; label: string; about: string }[] = [
  { key: "workflow", label: "ワークフローを置く", about: "ワークフローがないとき、ひな形から置くのを勧めます" },
  { key: "dependabot", label: "Dependabot のお知らせ", about: "止まっているとき、有効にするのを勧めます" },
  { key: "code", label: "コードスキャン", about: "公開のリポジトリで使っていないとき、勧めます" },
];

const setupHiddenKey = (owner: string, repo: string) => `actions-setup-hidden:${owner}/${repo}`;

/** 「今は使わない」で隠したもの（リポジトリごとに、この PC に覚える） */
export function loadSetupHidden(owner: string, repo: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(setupHiddenKey(owner, repo)) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function saveSetupHidden(owner: string, repo: string, hidden: string[]) {
  try {
    localStorage.setItem(setupHiddenKey(owner, repo), JSON.stringify(hidden));
  } catch {
    // 覚えられなくても、今は選んだとおりに出す
  }
}

/** 非公開のリポジトリで Actions を「既定でオフ」にしたか・持ち主が確かめて使うことにしたか（リポジトリごとに、この PC に覚える） */
export type ActionsChoice = "auto-off" | "consented";

const choiceKey = (owner: string, repo: string) => `actions-default:${owner}/${repo}`;

export function loadActionsChoice(owner: string, repo: string): ActionsChoice | null {
  try {
    const v = localStorage.getItem(choiceKey(owner, repo));
    return v === "auto-off" || v === "consented" ? v : null;
  } catch {
    return null;
  }
}

export function saveActionsChoice(owner: string, repo: string, choice: ActionsChoice) {
  try {
    localStorage.setItem(choiceKey(owner, repo), choice);
  } catch {
    // 覚えられなくても、GitHub の設定は変わっている
  }
}

/**
 * 既定でオフにするか: 非公開・持ち主・今オン・まだワークフローも実行もない（まだ使っていない）・この PC でまだ決めていない。
 * もう使っているリポジトリ（ワークフローや実行がある）は、チームの設定なので変えない
 */
export function shouldDefaultOff(ov: ActionsOverview, owner: string, me: string, choice: ActionsChoice | null): boolean {
  return ov.private && ov.actions_enabled === true && ov.workflow_count === 0 && ov.runs.length === 0 && choice === null && canManageActions(ov, owner, me);
}

/** 非公開のリポジトリで、GitHub Free のアカウントに毎月ついてくる Actions の無料の時間（分） */
export const FREE_MINUTES = 2000;

/**
 * 今月このリポジトリで動いた時間の目安（分）。最近の 100 回の実行の、始まりから終わりまでを 1 分単位で切り上げて足す。
 * GitHub はジョブごと（並んで動いた分も別々に）・Windows は 2 倍で数えるので、本当の使った時間はこれより多い
 */
export function monthMinutes(runs: Run[], now = new Date()): number {
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  return runs
    .filter((r) => r.status === "completed" && r.started_at && !r.fork)
    .filter((r) => {
      const d = new Date(r.created_at);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}` === month;
    })
    .reduce((sum, r) => sum + Math.max(1, Math.ceil((Date.parse(r.updated_at) - Date.parse(r.started_at!)) / 60000)), 0);
}
export const repoRootFiles = (owner: string, repo: string) => invoke<string[]>("repo_root_files", { owner, repo });
export const commitsChecks = (owner: string, repo: string, shas: string[]) => invoke<Record<string, CheckSummary>>("commits_checks", { owner, repo, shas });

// --- 解決する順の山 ---

/** 1: すぐ直す / 2: 早めに / 3: 手が空いたら / 4: 待つだけ */
export type Level = 1 | 2 | 3 | 4;

export const LEVELS: { level: Level; icon: string; label: string }[] = [
  { level: 1, icon: "🔴", label: "すぐ直す" },
  { level: 2, icon: "🟠", label: "早めに" },
  { level: 3, icon: "🟡", label: "手が空いたら" },
  { level: 4, icon: "●", label: "待つだけ" },
];

export interface StackCard {
  key: string;
  level: Level;
  kind: "run" | "dependabot" | "code";
  title: string;
  why: string;
  /** 失敗し始めた日時・お知らせが出た日時（同じ色の中で、古いものほど上） */
  since: string | null;
  /** 続けて失敗した回数 */
  streak: number;
  /** 最後の実行（失敗した・動いている） */
  run?: Run;
  /** 続けて失敗した実行（新しい順） */
  failures?: Run[];
  /** 失敗のあと、今もう一度動いている実行 */
  rerunning?: Run | null;
  pull?: { number: number; title: string } | null;
  dependabot?: DependabotAlert;
  /** Dependabot が直すプルリクを出しているとき */
  fixPull?: OpenPull | null;
  code?: CodeAlert;
}

export interface Stack {
  cards: StackCard[];
  /** 24 時間以内に直ったもの（失敗のあとに成功した） */
  fixed: { key: string; run: Run; was: number }[];
  /** 最後の結果が成功のもの（ワークフロー × ブランチ） */
  fine: Run[];
  counts: Record<Level, number>;
}

const FAILED = new Set(["failure", "timed_out", "startup_failure", "action_required"]);
const ACTIVE = new Set(["queued", "in_progress", "waiting", "requested", "pending"]);
/** これより長く動いていないブランチ（既定・保護されたブランチのほか）は、山に入れない */
export const STALE_DAYS = 30;
/** 失敗のあとに成功したものを「直りました」と出しておく時間 */
const FIXED_HOURS = 24;

export const isFailed = (r: { conclusion: string | null }) => r.conclusion !== null && FAILED.has(r.conclusion);
export const isActive = (r: { status: string }) => ACTIVE.has(r.status);

const SECURITY_LEVEL: Record<string, Level> = { critical: 1, high: 2, error: 2, medium: 3, moderate: 3, low: 3, warning: 3, note: 3 };
export const SEVERITY_LABELS: Record<string, string> = {
  critical: "重大",
  high: "高",
  medium: "中",
  moderate: "中",
  low: "低",
  error: "エラー",
  warning: "注意",
  note: "メモ",
};

/**
 * 積む順の決まり:
 * - 1 枚 ＝ ワークフロー × ブランチの最後に終わった実行（取り消し・とばしたものは見ない）。失敗が続いていれば重ねて ×N
 * - 🔴 すぐ直す: 既定のブランチ・保護されたブランチの失敗、セキュリティ「重大」
 * - 🟠 早めに: 開いているプルリクのブランチの失敗（マージを止める）、セキュリティ「高」
 * - 🟡 手が空いたら: ほかのブランチの失敗、セキュリティ「中・低」
 * - ● 待つだけ: 実行中・順番待ち（失敗のあとにもう一度動いているものは、失敗の方に「もう一度動いています」と出す）
 * - 同じ色の中は、失敗し始めた（お知らせが出た）のが古いものほど上
 * - 消したブランチ・30 日以上動いていないブランチ・フォークから来た実行は入れない
 */
export function buildStack(ov: ActionsOverview, now = Date.now()): Stack {
  const branchSet = ov.branches ? new Set(ov.branches) : null;
  const important = new Set([ov.default_branch, ...ov.protected]);
  const prByBranch = new Map((ov.pulls ?? []).map((p) => [p.head, p] as const));
  const cards: StackCard[] = [];
  const fixed: Stack["fixed"] = [];
  const fine: Run[] = [];

  // もう一度動かして止めた実行は、前の回の結果のまま（取り消しでは直っていない）
  const runs = ov.runs
    .filter((r) => !r.fork && r.branch)
    .map((r) => (r.conclusion === "cancelled" && r.previous_conclusion ? { ...r, conclusion: r.previous_conclusion } : r))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const groups = new Map<string, Run[]>();
  for (const r of runs) {
    const key = `${r.workflow_id}|${r.branch}`;
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }

  for (const [key, list] of groups) {
    const branch = list[0].branch;
    if (branchSet && !branchSet.has(branch)) continue;
    if (!important.has(branch) && now - Date.parse(list[0].created_at) > STALE_DAYS * 86400000) continue;
    const active = list.find(isActive) ?? null;
    const decided = list.filter((r) => r.status === "completed" && (isFailed(r) || r.conclusion === "success"));
    const last = decided[0];
    if (last && isFailed(last)) {
      let streak = 0;
      while (streak < decided.length && isFailed(decided[streak])) streak++;
      const failures = decided.slice(0, streak);
      const open = prByBranch.get(branch);
      const pull = open ? { number: open.number, title: open.title } : last.pulls[0] ? { number: last.pulls[0], title: "" } : null;
      const level: Level = important.has(branch) ? 1 : pull ? 2 : 3;
      const why =
        level === 1
          ? branch === ov.default_branch
            ? `${branch} はみんなが使うブランチです。最初に直します`
            : `${branch} は保護されたブランチです。最初に直します`
          : level === 2
            ? "直すまで、マージしない方が安全です"
            : `まだプルリクのないブランチです。作業している人が直します（${last.actor?.login ?? "?"}）`;
      cards.push({
        key,
        level,
        kind: "run",
        title: level === 2 && pull ? `プルリク #${pull.number} の ${last.name} が失敗しています` : `${branch} の ${last.name} が失敗しています`,
        why,
        since: failures[failures.length - 1].created_at,
        streak,
        run: last,
        failures,
        rerunning: active && active.created_at >= last.created_at ? active : null,
        pull,
      });
      continue;
    }
    if (active) {
      cards.push({
        key,
        level: 4,
        kind: "run",
        title: `${active.name} #${active.run_number} が動いています`,
        why: "終わるのを待つだけです。終わると、この山に入るか消えます",
        since: active.created_at,
        streak: 0,
        run: active,
        pull: prByBranch.has(branch) ? { number: prByBranch.get(branch)!.number, title: prByBranch.get(branch)!.title } : null,
      });
    }
    if (last) {
      fine.push(last);
      const before = decided[1];
      if (before && isFailed(before) && now - Date.parse(last.updated_at) < FIXED_HOURS * 3600000) {
        let was = 1;
        while (was + 1 < decided.length && isFailed(decided[was + 1])) was++;
        fixed.push({ key, run: last, was });
      }
    }
  }

  if (ov.dependabot.state === "ok") {
    for (const a of ov.dependabot.alerts ?? []) {
      const fixPull =
        (ov.pulls ?? []).find((p) => p.head.startsWith("dependabot/") && p.head.toLowerCase().includes(a.package.toLowerCase())) ?? null;
      const severity = a.severity ?? "medium";
      cards.push({
        key: `dependabot|${a.number}`,
        level: SECURITY_LEVEL[severity] ?? 3,
        kind: "dependabot",
        title: `🛡 ${a.package}${a.vulnerable ? ` ${a.vulnerable}` : ""} に危険度「${SEVERITY_LABELS[severity] ?? severity}」の問題`,
        why: fixPull
          ? `Dependabot のプルリク #${fixPull.number} をマージすると直ります`
          : a.fixed
            ? `${a.fixed} 以上に上げると直ります`
            : "直した版はまだありません。使い方を見直すか、ほかのものに替えます",
        since: a.created_at,
        streak: 0,
        dependabot: a,
        fixPull,
      });
    }
  }
  if (ov.code_scanning.state === "ok") {
    for (const a of ov.code_scanning.alerts ?? []) {
      const severity = a.severity ?? "warning";
      cards.push({
        key: `code|${a.number}`,
        level: SECURITY_LEVEL[severity] ?? 3,
        kind: "code",
        title: `🔍 ${a.rule}`,
        why: `${a.path ?? ""}${a.line ? `:${a.line}` : ""}${a.message ? ` — ${a.message}` : ""}`,
        since: a.created_at,
        streak: 0,
        code: a,
      });
    }
  }

  cards.sort((a, b) => a.level - b.level || (a.since ?? "").localeCompare(b.since ?? "") || a.key.localeCompare(b.key));
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0 } as Record<Level, number>;
  for (const c of cards) counts[c.level] += 1;
  return { cards, fixed, fine, counts };
}

/** GitHub Actions のチェックの詳しい URL（…/actions/runs/123/job/456）から、実行とジョブの番号を読む */
export function runOfCheck(url: string | null | undefined): { runId: number; jobId: number | null } | null {
  const m = /\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/.exec(url ?? "");
  return m ? { runId: Number(m[1]), jobId: m[2] ? Number(m[2]) : null } : null;
}

// --- 見せ方 ---

const EVENT_LABELS: Record<string, string> = {
  push: "プッシュ",
  pull_request: "プルリク",
  pull_request_target: "プルリク",
  schedule: "決まった時刻",
  workflow_dispatch: "手で実行",
  workflow_run: "ほかのワークフローのあと",
  release: "リリース",
  merge_group: "マージの列",
  repository_dispatch: "外からの合図",
  dynamic: "GitHub の自動",
};

export const eventLabel = (e: string) => EVENT_LABELS[e] ?? e;

export interface ResultInfo {
  icon: string;
  tone: "ok" | "ng" | "wait" | "muted" | "warn";
  label: string;
}

/** 実行・ジョブ・ステップの結果の印 */
export function resultOf(x: { status: string; conclusion: string | null }): ResultInfo {
  if (x.status !== "completed") {
    if (x.status === "queued" || x.status === "pending" || x.status === "requested") return { icon: "●", tone: "wait", label: "順番待ち" };
    if (x.status === "waiting") return { icon: "●", tone: "wait", label: "承認待ち" };
    return { icon: "●", tone: "wait", label: "実行中" };
  }
  switch (x.conclusion) {
    case "success":
      return { icon: "✔", tone: "ok", label: "成功" };
    case "failure":
      return { icon: "✖", tone: "ng", label: "失敗" };
    case "timed_out":
      return { icon: "✖", tone: "ng", label: "時間切れ" };
    case "startup_failure":
      return { icon: "✖", tone: "ng", label: "始められなかった" };
    case "action_required":
      return { icon: "!", tone: "warn", label: "承認がいる" };
    case "cancelled":
      return { icon: "⊘", tone: "muted", label: "取り消し" };
    case "skipped":
      return { icon: "⊘", tone: "muted", label: "とばした" };
    default:
      return { icon: "○", tone: "muted", label: x.conclusion ?? "" };
  }
}

/** 「3 分 12 秒」「45 秒」「1 時間 2 分」 */
export function duration(start: string | null | undefined, end: string | null | undefined, now = Date.now()): string {
  if (!start) return "";
  const s = Math.max(0, Math.round(((end ? Date.parse(end) : now) - Date.parse(start)) / 1000));
  if (Number.isNaN(s)) return "";
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${String(s % 60).padStart(2, "0")} 秒`;
  return `${Math.floor(m / 60)} 時間 ${m % 60} 分`;
}

// --- ログ ---

export type LogKind = "error" | "warning" | "group" | "debug" | "command" | "plain";

/** ログの 1 行の種類と、見せる文（GitHub の ##[error] などの印を外す） */
export function logLine(line: string): { kind: LogKind; text: string } {
  const m = /^##\[(error|warning|group|endgroup|debug|command|notice)\](.*)$/.exec(line);
  if (m) {
    if (m[1] === "endgroup") return { kind: "debug", text: "" };
    if (m[1] === "group") return { kind: "group", text: m[2].replace(/^Run /, "▸ ") };
    if (m[1] === "notice") return { kind: "warning", text: m[2] };
    return { kind: m[1] as LogKind, text: m[2] };
  }
  if (/\b(FAIL|FAILED|failed|Error|ERROR|error)\b|✕|✖|panicked/.test(line)) return { kind: "error", text: line };
  return { kind: "plain", text: line };
}

/** エラーのまわりだけを見せる範囲（最初の ##[error] の 25 行前から最後の ##[error] まで。なければ最後の 40 行） */
export function errorRange(lines: string[]): { start: number; end: number } {
  const marks = lines.map((l, i) => (l.startsWith("##[error]") ? i : -1)).filter((i) => i >= 0);
  if (marks.length === 0) return { start: Math.max(0, lines.length - 40), end: lines.length };
  return { start: Math.max(0, marks[0] - 25), end: Math.min(lines.length, marks[marks.length - 1] + 3) };
}
