import { useCallback, useEffect, useRef, useState } from "react";
import { readGitHubHistory, readHistory, splitGitError } from "../lib/git";
import type { GitHistory } from "../lib/types";

interface HistorySource {
  /** この PC の作業フォルダ。なければ GitHub API から読む */
  folder: string | undefined;
  owner: string;
  repo: string;
}

/**
 * ブランチ画面・全体図の履歴。active のあいだ（その画面を開いているあいだ）だけ読み込み、
 * reloadKey が変わったら（git の操作のあと）読み直す
 */
export function useHistory({ folder, owner, repo }: HistorySource, active: boolean, reloadKey: string) {
  const [history, setHistory] = useState<GitHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const my = ++seq.current;
    if (!owner || !repo) return;
    setLoading(true);
    try {
      const h = folder ? await readHistory(folder) : await readGitHubHistory(owner, repo);
      if (my !== seq.current) return;
      setHistory(h);
      setError(null);
    } catch (e) {
      if (my !== seq.current) return;
      setError(splitGitError(e).message);
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, [folder, owner, repo]);

  // 読み込む先が変わったら、前のリポジトリの履歴は消す
  useEffect(() => {
    seq.current++;
    setHistory(null);
    setError(null);
  }, [folder, owner, repo]);

  useEffect(() => {
    if (active) reload();
  }, [active, reload, reloadKey]);

  return { history, error, loading, reload };
}

export type HistoryState = ReturnType<typeof useHistory>;
