// PC の git を呼び出す（スマホ版では使わない）。バックエンドの git::commands と対応する
import { invoke } from "@tauri-apps/api/core";
import type { GitBranch, GitFolderCheck, GitHistory, GitOperation, GitRun, GitSetupStatus, GitStash, GitStatus } from "./types";

// --- 準備 ---
export const gitVersion = () => invoke<string>("git_version");
export const setupStatus = () => invoke<GitSetupStatus>("git_setup_status");
/** Git をインストールする（数分かかる。途中で管理者の確認が出る） */
export const installGit = () => invoke<GitRun>("git_install");
export const setIdentity = (name: string, email: string) => invoke<GitRun>("git_set_identity", { name, email });
export const checkFolder = (path: string, owner: string, repo: string) =>
  invoke<GitFolderCheck>("git_check_folder", { path, owner, repo });
export const cloneRepo = (parent: string, owner: string, repo: string) =>
  invoke<{ run: GitRun; path: string }>("git_clone", { parent, owner, repo });

// --- 閲覧 ---
export const readStatus = (path: string) => invoke<GitStatus>("git_status", { path });
export const listBranches = (path: string) => invoke<GitBranch[]>("git_branches", { path });
export const listStashes = (path: string) => invoke<GitStash[]>("git_stashes", { path });
export const fileDiff = (path: string, file: string, staged: boolean, untracked: boolean) =>
  invoke<GitRun>("git_diff", { path, file, staged, untracked });
// --- プロジェクトを追加（URL からクローン・手元のフォルダを GitHub に上げる） ---
export interface CloneUrlResult {
  run: GitRun;
  path: string;
  /** GitHub のリポジトリなら、その持ち主と名前 */
  owner: string | null;
  repo: string | null;
}
export interface FolderState {
  /** このフォルダ自身がリポジトリ */
  is_repo: boolean;
  /** ほかのリポジトリの中にある（そのリポジトリのフォルダ） */
  inside: string | null;
  commits: number;
  files: number;
  has_gitignore: boolean;
  branch: string;
  origin: string | null;
}
/** .gitignore のひな形（Rust の git::publish と同じ名前） */
export type GitignoreTemplate = "visualstudio" | "unity" | "unreal" | "none";
export const cloneUrl = (parent: string, url: string) => invoke<CloneUrlResult>("git_clone_url", { parent, url });
export const folderState = (path: string) => invoke<FolderState>("git_folder_state", { path });
export const publishPrepare = (path: string, template: GitignoreTemplate, message: string) =>
  invoke<GitRun>("git_publish_prepare", { path, template, message });
export const remoteExists = (url: string) => invoke<boolean>("git_remote_exists", { url });
export const publishPush = (path: string, url: string) => invoke<GitRun>("git_publish_push", { path, url });

/** GitHub の URL（https・ssh）や「持ち主/名前」から、持ち主と名前を取り出す（Rust の parse_github と同じ決まり） */
export function parseGitHub(input: string): { owner: string; repo: string } | null {
  const s = input.trim();
  const at = s.toLowerCase().indexOf("github.com");
  let rest: string;
  if (at >= 0) rest = s.slice(at + "github.com".length);
  else if (!s.includes(":") && !s.includes("\\") && s.split("/").length === 2) rest = s;
  else return null;
  const parts = rest.replace(/^[:/]+/, "").split(/[/?#]/);
  const valid = (x: string | undefined): x is string => !!x && !x.startsWith("-") && /^[A-Za-z0-9._-]+$/.test(x);
  const owner = parts[0];
  const repo = parts[1]?.replace(/\.git$/, "");
  return valid(owner) && valid(repo) ? { owner, repo } : null;
}

/** 履歴（この PC の git から） */
export const readHistory = (path: string) => invoke<GitHistory>("git_history", { path });
/** 履歴（GitHub API から。スマホ版や、作業フォルダのない PC で使う。git の有無に関係なく使える） */
export const readGitHubHistory = (owner: string, repo: string) => invoke<GitHistory>("github_history", { owner, repo });

// --- 作業 ---
export const stage = (path: string, files: string[]) => invoke<GitRun>("git_stage", { path, files });
export const unstage = (path: string, files: string[]) => invoke<GitRun>("git_unstage", { path, files });
/** messages の 1 つ目が要約、2 つ目からは説明の段落 */
export const commit = (path: string, messages: string[], amend: boolean, allowEmpty: boolean) =>
  invoke<GitRun>("git_commit", { path, messages, amend, allowEmpty });
export const push = (path: string) => invoke<GitRun>("git_push", { path });
export const pull = (path: string) => invoke<GitRun>("git_pull", { path });
export const fetch = (path: string) => invoke<GitRun>("git_fetch", { path });
/** create なら作ってから切り替える（start があれば、そのコミットから作る） */
export const switchBranch = (path: string, branch: string, create: boolean, start: string | null = null) =>
  invoke<GitRun>("git_switch", { path, branch, create, start });
export const stashPush = (path: string, message: string) => invoke<GitRun>("git_stash_push", { path, message });
export const stashPop = (path: string, index: number) => invoke<GitRun>("git_stash_pop", { path, index });
export const stashDrop = (path: string, index: number) => invoke<GitRun>("git_stash_drop", { path, index });
export const tag = (path: string, name: string, target: string | null) =>
  invoke<GitRun>("git_tag", { path, name, target });
export const discardAll = (path: string, includeUntracked: boolean) =>
  invoke<GitRun>("git_discard_all", { path, includeUntracked });
export const openTerminal = (path: string) => invoke<void>("git_open_terminal", { path });

// --- 無視するファイル（.gitignore） ---
/** パターンに当てはまる、git で管理しているファイル（.gitignore に書いても無視されないもの） */
export const ignoreTracked = (path: string, pattern: string) => invoke<string[]>("git_ignore_tracked", { path, pattern });
/** .gitignore にパターンを 1 行書き足す。untrack があれば、先にそのパスのファイルを管理から外す（git rm --cached） */
export const ignoreAdd = (path: string, pattern: string, untrack: string | null, recursive: boolean) =>
  invoke<GitRun>("git_ignore_add", { path, pattern, untrack, recursive });
/** .gitignore の中身（改行は \n にそろえてある）。まだ無ければ exists: false */
export const readGitignore = (path: string) => invoke<{ text: string; exists: boolean }>("git_gitignore_read", { path });
export const writeGitignore = (path: string, text: string) => invoke<GitRun>("git_gitignore_write", { path, text });

/** 右クリックの「無視する」の選び方 */
export interface IgnoreRule {
  kind: "file" | "ext" | "folder";
  /** 画面に出す名前（ファイル名・.log・build/ など） */
  label: string;
  /** .gitignore に書く 1 行 */
  pattern: string;
  /** すでに管理しているファイルを外すときの、git rm のパスの指定（pattern と同じ範囲に当てはまる） */
  pathspec: string;
  /** git rm に -r が要る（フォルダ・拡張子） */
  recursive: boolean;
}

/** .gitignore で特別な意味を持つ文字（* ? [ \）と末尾の空白を、ただの文字として書く */
function escapeIgnore(name: string): string {
  return name.replace(/[\\*?[]/g, "\\$&").replace(/ +$/, (spaces) => spaces.replace(/ /g, "\\ "));
}

/**
 * そのファイルを無視するときの選び方: このファイルだけ・同じ拡張子のファイル・入っているフォルダ（すぐ上と、いちばん上）。
 * ファイルとフォルダは頭に / を付けて、その場所だけに当てはまるようにする（git rm --cached で外す範囲と同じになる）
 */
export function ignoreRules(path: string): IgnoreRule[] {
  const parts = path.split("/");
  const name = parts[parts.length - 1];
  const rules: IgnoreRule[] = [{ kind: "file", label: name, pattern: `/${escapeIgnore(path)}`, pathspec: path, recursive: false }];
  const dot = name.lastIndexOf(".");
  if (dot > 0 && dot < name.length - 1) {
    const ext = name.slice(dot + 1);
    rules.push({ kind: "ext", label: `.${ext}`, pattern: `*.${escapeIgnore(ext)}`, pathspec: `*.${ext}`, recursive: true });
  }
  const folders = new Set(parts.length > 1 ? [parts.slice(0, -1).join("/"), parts[0]] : []);
  for (const dir of folders) {
    rules.push({ kind: "folder", label: `${dir}/`, pattern: `/${escapeIgnore(dir)}/`, pathspec: `${dir}/`, recursive: true });
  }
  return rules;
}

// --- コミットの操作 ---
export const detach = (path: string, hash: string) => invoke<GitRun>("git_detach", { path, hash });
/** コミットの内容（git show） */
export const showCommit = (path: string, hash: string) => invoke<GitRun>("git_show", { path, hash });
/** コミットの内容（GitHub API から。作業フォルダのないとき。形は git show と同じ） */
export const showGitHubCommit = (owner: string, repo: string, hash: string) =>
  invoke<GitRun>("github_commit_detail", { owner, repo, hash });
export const cherryPick = (path: string, hash: string) => invoke<GitRun>("git_cherry_pick", { path, hash });
export const revert = (path: string, hash: string) => invoke<GitRun>("git_revert", { path, hash });
export const reset = (path: string, hash: string, mode: "soft" | "mixed" | "hard") =>
  invoke<GitRun>("git_reset", { path, hash, mode });

// --- ブランチの操作 ---
export const merge = (path: string, branch: string) => invoke<GitRun>("git_merge", { path, branch });
export const rebase = (path: string, branch: string) => invoke<GitRun>("git_rebase", { path, branch });
export const pushBranch = (path: string, branch: string) => invoke<GitRun>("git_push_branch", { path, branch });
export const setUpstream = (path: string, branch: string) => invoke<GitRun>("git_set_upstream", { path, branch });
export const renameBranch = (path: string, from: string, to: string) =>
  invoke<GitRun>("git_rename_branch", { path, from, to });
export const deleteBranch = (path: string, branch: string, force: boolean) =>
  invoke<GitRun>("git_delete_branch", { path, branch, force });

// --- 競合を直す（マージツール） ---
export interface ConflictText {
  text: string;
  /** 文字でないファイル（画像など） */
  binary: boolean;
  /** 作業フォルダにない（片方で消されていた） */
  missing: boolean;
}
export const conflictFile = (path: string, file: string) => invoke<ConflictText>("git_conflict_file", { path, file });
/** 直した中身を書いて、ステージする */
export const resolveConflict = (path: string, file: string, text: string) => invoke<GitRun>("git_resolve_conflict", { path, file, text });
/** ファイルを片方の内容（ours・theirs）にするか、消したままにして（delete）、ステージする */
export const takeSide = (path: string, file: string, side: "ours" | "theirs" | "delete") => invoke<GitRun>("git_take_side", { path, file, side });
/** ファイルを、いつものアプリ（エディタなど）で開く */
export const openFile = (path: string, file: string) => invoke<void>("git_open_file", { path, file });

/** git のメッセージから、競合したファイルを読み取る（CONFLICT (content): Merge conflict in menu.txt など） */
export function conflictFilesIn(message: string): string[] {
  const files: string[] = [];
  for (const line of message.split(/\r?\n/)) {
    const m = /^CONFLICT \([^)]*\): (?:Merge conflict in )?(.+)$/.exec(line.trim());
    if (m) files.push(m[1].replace(/ deleted in .*$/, "").trim());
  }
  return files;
}

// --- 途中で止まった操作 ---
export const abortOperation = (path: string, operation: GitOperation) => invoke<GitRun>("git_abort", { path, operation });
export const continueOperation = (path: string, operation: GitOperation) =>
  invoke<GitRun>("git_continue", { path, operation });

// --- 画面に見せるコマンド ---

/**
 * 表示用のコマンド文字列（バックエンドの display_command と同じ書き方: 空白・"・* ? を含む引数だけ " で囲み、
 * 40 桁のコミットのハッシュは 7 桁で見せる）
 */
export function displayCommand(args: string[]): string {
  const parts = args.map((a) =>
    /^[0-9a-f]{40}$/i.test(a) ? a.slice(0, 7) : a === "" || /[\s"*?]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a,
  );
  return ["git", ...parts].join(" ");
}

/** コミットの引数（バックエンドの git_commit と同じ順に並べる） */
export function commitArgs(messages: string[], amend: boolean, allowEmpty: boolean): string[] {
  const args = ["commit"];
  if (amend) args.push("--amend");
  if (allowEmpty) args.push("--allow-empty");
  for (const m of messages.map((s) => s.trim()).filter(Boolean)) args.push("-m", m);
  return args;
}

/**
 * バックエンドのエラーを「実行したコマンド」と「git のメッセージ」に分ける。
 * git の実行に失敗したときは 1 行目がコマンドになっている
 */
export function splitGitError(e: unknown): { command?: string; message: string } {
  // 画面の側で投げたエラー（Error）は、頭に「Error: 」を付けずに文だけ見せる
  const text = e instanceof Error ? e.message : String(e);
  const nl = text.indexOf("\n");
  if (text.startsWith("git ") && nl > 0) {
    return { command: text.slice(0, nl), message: text.slice(nl + 1).trim() };
  }
  return { message: text };
}
