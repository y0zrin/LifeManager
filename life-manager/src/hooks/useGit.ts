import { useCallback, useEffect, useRef, useState } from "react";
import * as git from "../lib/git";
import type { GitBranch, GitRun, GitStash, GitStatus } from "../lib/types";

/** 画面の右下に出すお知らせ */
export interface GitNotice {
  id: number;
  kind: "ok" | "error";
  text: string;
  /** 実行したコマンド（どんな操作だったのかを見せる） */
  command?: string;
  /** 競合で止まった知らせ（直し終えたら・やめたら、自動で消す） */
  conflict?: boolean;
}

export type GitResult = { ok: true; run: GitRun } | { ok: false; message: string; command?: string };

export interface GitExecOptions {
  /** 成功しても知らせない（ステージのように何度も行う操作） */
  quiet?: boolean;
  /** 失敗をお知らせに出さない（ダイアログの中に出すとき） */
  inlineError?: boolean;
}

/** このブランチでいつコミット・プッシュしたか（作業の流れの表示に使う。アプリを開いている間だけ覚える） */
export interface GitMark {
  branch: string;
  at: number;
}

const POLL_MS = 10_000;
const NOTICE_MS = 5_000;
const MAX_NOTICES = 4;

/**
 * 今のリポジトリの git の状態と操作（PC のみ）。folder が未設定なら何もしない。
 * active のあいだ（作業・ブランチ・全体図を開いているあいだ）は、ほかのアプリでの編集に追いつくよう定期的に読み直す
 */
export function useGit(folder: string | undefined, active: boolean) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [stashes, setStashes] = useState<GitStash[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notices, setNotices] = useState<GitNotice[]>([]);
  const [lastCommit, setLastCommit] = useState<GitMark | null>(null);
  const [lastPush, setLastPush] = useState<GitMark | null>(null);
  // 操作をした回数（履歴の読み直しの合図に使う）
  const [opCount, setOpCount] = useState(0);

  // 読み込みが重なったときに、古い結果で上書きしないための番号
  const loadSeq = useRef(0);
  // git の操作は 1 つずつ順に実行する（同時に動かすと git のロックでぶつかる）
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const noticeSeq = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++loadSeq.current;
    if (!folder) return;
    try {
      const [st, br, sh] = await Promise.all([git.readStatus(folder), git.listBranches(folder), git.listStashes(folder)]);
      if (seq !== loadSeq.current) return;
      setStatus(st);
      setBranches(br);
      setStashes(sh);
      setLoadError(null);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setStatus(null);
      setBranches([]);
      setStashes([]);
      setLoadError(git.splitGitError(e).message);
    }
  }, [folder]);

  // フォルダが変わったら、前のリポジトリの内容を消して読み直す
  useEffect(() => {
    setStatus(null);
    setBranches([]);
    setStashes([]);
    setLoadError(null);
    setLastCommit(null);
    setLastPush(null);
    refresh();
  }, [refresh]);

  // ほかのアプリ（エディタなど）から戻ってきたら読み直す
  useEffect(() => {
    if (!folder) return;
    const onFocus = () => { refresh(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [folder, refresh]);

  useEffect(() => {
    if (!folder || !active) return;
    refresh();
    const timer = window.setInterval(() => {
      if (!document.hidden) refresh();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [folder, active, refresh]);

  const notify = useCallback((kind: GitNotice["kind"], text: string, command?: string, conflict?: boolean) => {
    const id = ++noticeSeq.current;
    setNotices((prev) => [...prev.slice(-(MAX_NOTICES - 1)), { id, kind, text, command, conflict }]);
    // 失敗は読み終わるまで残す（×で閉じる）
    if (kind === "ok") {
      window.setTimeout(() => setNotices((prev) => prev.filter((n) => n.id !== id)), NOTICE_MS);
    }
  }, []);

  const dismissNotice = useCallback((id: number) => {
    setNotices((prev) => prev.filter((n) => n.id !== id));
  }, []);

  // 競合を直し終えた・やめた（マージなどの途中 → 途中でない）ら、「競合で止まりました」の知らせは消す（古いまま残さない）
  const operation = status ? status.operation : undefined;
  const lastOperation = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (operation === undefined) return;
    if (lastOperation.current && operation === null) setNotices((prev) => prev.filter((n) => !n.conflict));
    lastOperation.current = operation;
  }, [operation]);

  /** git の操作を実行して、結果を知らせ、状態を読み直す */
  const exec = useCallback(
    (
      label: string,
      action: (path: string) => Promise<GitRun>,
      success: string | ((run: GitRun) => string),
      options: GitExecOptions = {},
    ): Promise<GitResult> => {
      const task = async (): Promise<GitResult> => {
        if (!folder) return { ok: false, message: "作業フォルダが設定されていません" };
        if (!options.quiet) setBusy(label);
        try {
          const run = await action(folder);
          if (!options.quiet) notify("ok", typeof success === "function" ? success(run) : success, run.command || undefined);
          return { ok: true, run };
        } catch (e) {
          const { command, message } = git.splitGitError(e);
          // 競合で止まったときは、git の英語のメッセージの代わりに、何が起きたかを日本語で出す（直し方は、別に出す知らせと作業タブで）
          const conflicted = git.conflictFilesIn(message);
          const shown = conflicted.length > 0
            ? `競合（コンフリクト）で止まりました（${conflicted.join("、")}）。どちらを残すかを「作業をする」で選びます`
            : message;
          if (!options.inlineError) notify("error", shown, command, conflicted.length > 0);
          return { ok: false, message, command };
        } finally {
          await refresh();
          if (!options.quiet) {
            setBusy(null);
            setOpCount((n) => n + 1);
          }
        }
      };
      const next = queue.current.then(task, task);
      queue.current = next.catch(() => undefined);
      return next;
    },
    [folder, notify, refresh],
  );

  const markCommit = useCallback((branch: string) => setLastCommit({ branch, at: Date.now() }), []);
  const markPush = useCallback((branch: string) => setLastPush({ branch, at: Date.now() }), []);

  return {
    folder,
    status,
    branches,
    stashes,
    loadError,
    busy,
    notices,
    lastCommit,
    lastPush,
    opCount,
    refresh,
    exec,
    notify,
    dismissNotice,
    markCommit,
    markPush,
  };
}

export type GitState = ReturnType<typeof useGit>;
