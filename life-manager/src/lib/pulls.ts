// プルリク（一覧・詳細・作る・マージ・レビュー）。GitHub とのやりとりは Rust（github/pulls.rs）が小さな形にして返す
import { invoke } from "@tauri-apps/api/core";

export interface Person {
  login: string;
  avatar_url: string;
}

/** レビューした人ごとの最後の判断 */
export interface Verdicts {
  approved: string[];
  changes_requested: string[];
}

export interface PullSummary {
  number: number;
  /** GraphQL で使う id（下書きの切り替え） */
  node_id: string;
  title: string;
  body: string;
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  user: Person | null;
  /** 入れたい変更のあるブランチ */
  head: string;
  head_sha: string;
  /** フォークから出したプルリクは別のリポジトリ（owner/repo）。フォークが消されていると null */
  head_repo: string | null;
  /** 入れる先のブランチ */
  base: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  merged_at: string | null;
  requested_reviewers: Person[];
  labels: { name: string; color: string }[];
  html_url: string;
  /** 作業の流れで読んだとき（開いているものだけ） */
  verdicts?: Verdicts;
  /** 作業の流れで読んだとき: チェックのまとめ（Checks の権限がなければ無い） */
  checks?: { success: number; failure: number; pending: number };
}

/** 行に付けたコメント */
export interface ReviewComment {
  id: number;
  user: Person | null;
  path: string;
  line: number | null;
  side: "LEFT" | "RIGHT";
  body: string;
  diff_hunk: string;
  at: string;
  /** そのあと行が変わって、今の差分には出ない */
  outdated: boolean;
  in_reply_to: number | null;
}

/** 会話に出す出来事（GitHub のタイムライン） */
export interface PullEvent {
  event: string;
  actor: Person | null;
  at: string | null;
  id?: number;
  body?: string;
  /** レビュー: APPROVED / CHANGES_REQUESTED / COMMENTED / DISMISSED */
  state?: string;
  comments?: ReviewComment[];
  sha?: string;
  message?: string;
  author_name?: string;
  commit_id?: string | null;
  reviewer?: Person | null;
  from?: string;
  to?: string;
  label?: { name: string; color: string };
  assignee?: Person | null;
  source?: { number: number; title: string; pull: boolean; repo: string | null };
}

export interface PullDetail extends PullSummary {
  /** マージできるか。GitHub が調べているあいだは null */
  mergeable: boolean | null;
  /** clean / dirty（競合）/ blocked（保護ルール）/ behind / unstable / draft / unknown など */
  mergeable_state: string;
  merged_by: Person | null;
  merge_commit_sha: string | null;
  commits: number;
  additions: number;
  deletions: number;
  changed_files: number;
  comments: number;
  review_comments: number;
  verdicts: Verdicts;
  conversation: PullEvent[];
  /** 閉じたあと、GitHub にブランチが残っているか（開いているあいだ・わからないときは null） */
  head_exists: boolean | null;
  /** このリポジトリのブランチから出したか（フォークからなら false） */
  same_repo: boolean;
}

export interface PullFile {
  filename: string;
  previous_filename: string | null;
  /** added / removed / modified / renamed / copied / changed / unchanged */
  status: string;
  additions: number;
  deletions: number;
  /** 画像などのバイナリや、大きすぎる変更には無い */
  patch: string | null;
}

export interface PullCommit {
  sha: string;
  message: string;
  author_name: string;
  date: string;
  author: Person | null;
}

export interface PullRepoInfo {
  default_branch: string;
  branches: string[];
  allow_merge_commit: boolean;
  allow_squash_merge: boolean;
  allow_rebase_merge: boolean;
  /** GitHub の設定で、マージしたらブランチを自動で消す */
  delete_branch_on_merge: boolean;
  /** 自分が書き込めるか（マージ・レビューのお願いができるか） */
  can_push: boolean;
}

export interface Comparison {
  /** ahead / behind / diverged / identical */
  status: string;
  ahead_by: number;
  behind_by: number;
  total_commits: number;
  commits: PullCommit[];
  files: PullFile[];
}

export type MergeMethod = "merge" | "squash" | "rebase";

export interface MergeResult {
  sha: string;
  branch_deleted: boolean;
  branch_error: string | null;
}

export type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

// --- GitHub とのやりとり ---

export const listPulls = (owner: string, repo: string) => invoke<PullSummary[]>("list_pulls", { owner, repo });
export const pullVerdicts = (owner: string, repo: string, numbers: number[]) =>
  invoke<Record<string, Verdicts>>("pull_verdicts", { owner, repo, numbers });
export const pullDetail = (owner: string, repo: string, number: number) => invoke<PullDetail>("pull_detail", { owner, repo, number });
export const pullFiles = (owner: string, repo: string, number: number) => invoke<PullFile[]>("pull_files", { owner, repo, number });
export const pullCommits = (owner: string, repo: string, number: number) => invoke<PullCommit[]>("pull_commits", { owner, repo, number });
export const pullRepoInfo = (owner: string, repo: string) => invoke<PullRepoInfo>("pull_repo_info", { owner, repo });
export const compareBranches = (owner: string, repo: string, base: string, head: string) =>
  invoke<Comparison>("compare_branches", { owner, repo, base, head });
export const createPull = (
  owner: string,
  repo: string,
  p: { title: string; head: string; base: string; body: string; draft: boolean; reviewers: string[] },
) => invoke<{ pull: PullSummary; reviewers_error: string | null }>("create_pull", { owner, repo, ...p });
export const updatePull = (
  owner: string,
  repo: string,
  number: number,
  change: { title?: string; body?: string; pullState?: "open" | "closed" },
) => invoke<PullSummary>("update_pull", { owner, repo, number, ...change });
export const mergePull = (owner: string, repo: string, number: number, method: MergeMethod, sha: string, deleteBranch: string | null) =>
  invoke<MergeResult>("merge_pull", { owner, repo, number, method, sha, deleteBranch });
export const reviewPull = (owner: string, repo: string, number: number, event: ReviewEvent, body: string) =>
  invoke<void>("review_pull", { owner, repo, number, event, body });
export const commentPull = (owner: string, repo: string, number: number, body: string) =>
  invoke<void>("comment_pull", { owner, repo, number, body });
export const commentPullLine = (
  owner: string,
  repo: string,
  number: number,
  c: { commitId: string; path: string; line: number; side: "LEFT" | "RIGHT"; body: string },
) => invoke<void>("comment_pull_line", { owner, repo, number, ...c });
export const setPullReviewers = (owner: string, repo: string, number: number, add: string[], remove: string[]) =>
  invoke<void>("set_pull_reviewers", { owner, repo, number, add, remove });
export const updatePullBranch = (owner: string, repo: string, number: number, headSha: string) =>
  invoke<void>("update_pull_branch", { owner, repo, number, headSha });
export const setPullDraft = (nodeId: string, draft: boolean) => invoke<void>("set_pull_draft", { nodeId, draft });
export const deletePullBranch = (owner: string, repo: string, branch: string) => invoke<void>("delete_pull_branch", { owner, repo, branch });
export const restorePullBranch = (owner: string, repo: string, branch: string, sha: string) =>
  invoke<void>("restore_pull_branch", { owner, repo, branch, sha });
export const branchPull = (owner: string, repo: string, branch: string) => invoke<PullSummary | null>("branch_pull", { owner, repo, branch });

// --- 見せ方 ---

export type PullStatus = "open" | "draft" | "merged" | "closed";

export function pullStatus(p: Pick<PullSummary, "state" | "draft" | "merged">): PullStatus {
  if (p.merged) return "merged";
  if (p.state === "closed") return "closed";
  return p.draft ? "draft" : "open";
}

export const STATUS_LABELS: Record<PullStatus, string> = {
  open: "開いている",
  draft: "下書き",
  merged: "マージ済み",
  closed: "閉じた",
};

export const METHOD_LABELS: Record<MergeMethod, string> = {
  merge: "マージコミット",
  squash: "スカッシュ",
  rebase: "リベース",
};

/** マージの仕方の説明と、手元でするときに近い git のコマンド */
export function methodHelp(method: MergeMethod, head: string, base: string): { text: string; command: string } {
  if (method === "squash") {
    return {
      text: `${head} のコミットを 1 つにまとめて、${base} に入れます。${base} の履歴がすっきりします`,
      command: `git switch ${base} && git merge --squash ${head} && git commit`,
    };
  }
  if (method === "rebase") {
    return {
      text: `${head} のコミットを、${base} の先に 1 つずつ並べ直して入れます（合流のコミットは作りません）`,
      command: `git switch ${head} && git rebase ${base}（そのあと ${base} を進める）`,
    };
  }
  return {
    text: `${head} のコミットをそのまま残して、合流のコミットを 1 つ作ります。いつ・何を入れたかが履歴に残ります`,
    command: `git switch ${base} && git merge --no-ff ${head}`,
  };
}

/** 本文の「Closes #45」「fixes #3」など（マージすると、その Issue を閉じる言葉）の番号 */
export function closingIssues(body: string): number[] {
  const found: number[] = [];
  const re = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d+)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const n = Number(m[1]);
    if (!found.includes(n)) found.push(n);
  }
  return found;
}

/** ブランチの名前から Issue の番号（issue-12・feature/12-boss・12-fix など） */
export function issueOfBranch(branch: string): number | null {
  const m = /(?:^|[/_-])(?:issue[-_]?)?#?(\d+)(?:$|[/_-])/i.exec(branch);
  return m ? Number(m[1]) : null;
}

/** 「たった今」「5 分前」「3 時間前」「昨日」「4 日前」「9/12」 */
export function ago(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const minutes = Math.floor((Date.now() - t) / 60000);
  if (minutes < 1) return "たった今";
  if (minutes < 60) return `${minutes} 分前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 時間前`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "昨日";
  if (days < 30) return `${days} 日前`;
  const d = new Date(t);
  return `${d.getFullYear() === new Date().getFullYear() ? "" : `${d.getFullYear()}/`}${d.getMonth() + 1}/${d.getDate()}`;
}

export const firstLine = (message: string) => message.split("\n")[0];

// --- 差分（ファイルごとの patch）を、行番号つきの行にする ---

export interface PatchLine {
  kind: "a" | "d" | "c";
  text: string;
  /** 変える前の行番号（追加した行は null） */
  old: number | null;
  /** 変えたあとの行番号（消した行は null） */
  new: number | null;
}

export type PatchRow = PatchLine | { kind: "h"; text: string } | { kind: "note"; text: string };

/** GitHub の patch（@@ から始まる差分）を行にする */
export function parsePatch(patch: string): PatchRow[] {
  const rows: PatchRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  const lines = patch.replace(/\n$/, "").split("\n");
  for (const line of lines) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (m) {
      oldNo = Number(m[1]);
      newNo = Number(m[2]);
      rows.push({ kind: "h", text: line });
    } else if (line.startsWith("\\")) {
      rows.push({ kind: "note", text: "（ファイルの最後に改行がありません）" });
    } else if (line.startsWith("+")) {
      rows.push({ kind: "a", text: line.slice(1), old: null, new: newNo++ });
    } else if (line.startsWith("-")) {
      rows.push({ kind: "d", text: line.slice(1), old: oldNo++, new: null });
    } else {
      rows.push({ kind: "c", text: line.startsWith(" ") ? line.slice(1) : line, old: oldNo++, new: newNo++ });
    }
  }
  return rows;
}

/** 左右に並べるときの 1 行（左が変える前、右が変えたあと） */
export type SplitRow =
  | { kind: "h"; text: string }
  | { kind: "note"; text: string }
  | { kind: "pair"; left: PatchLine | null; right: PatchLine | null };

/** 消した行と追加した行を、左右に並べる（続けて消して・続けて足したところを 1 行ずつ組にする） */
export function splitRows(rows: PatchRow[]): SplitRow[] {
  const out: SplitRow[] = [];
  let dels: PatchLine[] = [];
  let adds: PatchLine[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) out.push({ kind: "pair", left: dels[i] ?? null, right: adds[i] ?? null });
    dels = [];
    adds = [];
  };
  for (const r of rows) {
    if (r.kind === "d") {
      if (adds.length > 0) flush();
      dels.push(r);
    } else if (r.kind === "a") {
      adds.push(r);
    } else if (r.kind === "c") {
      flush();
      out.push({ kind: "pair", left: r, right: r });
    } else if (r.kind === "h" || r.kind === "note") {
      flush();
      out.push(r);
    }
  }
  flush();
  return out;
}

/** 行のコメントの置き場所（RIGHT は変えたあとの行番号、LEFT は変える前の行番号） */
export const lineKey = (side: "LEFT" | "RIGHT", line: number) => `${side}:${line}`;

/** 差分が同じかを見分ける短い印（「見た」を、差分が変わったら外すため） */
export function fingerprint(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
