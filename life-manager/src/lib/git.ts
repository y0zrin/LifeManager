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

// --- 途中で止まった操作 ---
export const abortOperation = (path: string, operation: GitOperation) => invoke<GitRun>("git_abort", { path, operation });
export const continueOperation = (path: string, operation: GitOperation) =>
  invoke<GitRun>("git_continue", { path, operation });

// --- 画面に見せるコマンド ---

/**
 * 表示用のコマンド文字列（バックエンドの display_command と同じ書き方: 空白や " を含む引数だけ " で囲み、
 * 40 桁のコミットのハッシュは 7 桁で見せる）
 */
export function displayCommand(args: string[]): string {
  const parts = args.map((a) =>
    /^[0-9a-f]{40}$/i.test(a) ? a.slice(0, 7) : a === "" || /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a,
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
  const text = String(e);
  const nl = text.indexOf("\n");
  if (text.startsWith("git ") && nl > 0) {
    return { command: text.slice(0, nl), message: text.slice(nl + 1).trim() };
  }
  return { message: text };
}
