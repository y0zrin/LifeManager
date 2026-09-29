// Actions の山（解決する順）のもとを読む。サイドバーの印（🔴・🟠 の数）のため、Actions の画面を開いていなくても 5 分ごとに読む。
// 画面を開いているあいだは、動いている実行があれば 15 秒ごと（なければ 1 分ごと）
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { actionsOverview, buildStack, isActive, type ActionsOverview } from "../lib/actions";

export function useActions(owner: string, repo: string, enabled: boolean, viewing: boolean) {
  const [overview, setOverview] = useState<ActionsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadedAt, setLoadedAt] = useState(0);
  const target = useRef(`${owner}/${repo}`);
  target.current = `${owner}/${repo}`;

  const load = useCallback(async () => {
    if (!owner || !repo) return;
    const key = `${owner}/${repo}`;
    setLoading(true);
    try {
      const ov = await actionsOverview(owner, repo);
      if (target.current !== key) return;
      setOverview(ov);
      setError(null);
      setLoadedAt(Date.now());
    } catch (e) {
      if (target.current === key) setError(String(e));
    } finally {
      if (target.current === key) setLoading(false);
    }
  }, [owner, repo]);

  useEffect(() => {
    setOverview(null);
    setError(null);
    if (enabled) load();
  }, [enabled, load]);

  // 画面を開いたら読み直す
  useEffect(() => {
    if (enabled && viewing) load();
  }, [enabled, viewing, load]);

  const running = !!overview?.runs.some(isActive);
  useEffect(() => {
    if (!enabled) return;
    const ms = viewing ? (running ? 15000 : 60000) : 300000;
    const t = window.setInterval(load, ms);
    return () => window.clearInterval(t);
  }, [enabled, viewing, running, load]);

  // 「直りました」「◯ 分前」を、読み直したときの時刻で決める
  const stack = useMemo(() => (overview ? buildStack(overview, loadedAt || Date.now()) : null), [overview, loadedAt]);
  const urgent = stack ? stack.counts[1] + stack.counts[2] : 0;

  return { overview, stack, error, loading, reload: load, urgent };
}

export type ActionsState = ReturnType<typeof useActions>;
