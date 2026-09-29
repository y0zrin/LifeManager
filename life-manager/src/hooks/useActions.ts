// Actions の山（解決する順）のもとを読む。サイドバーの印（🔴・🟠 の数）のため、Actions の画面を開いていなくても 5 分ごとに読む。
// 画面を開いているあいだは、動いている実行があれば 15 秒ごと（なければ 1 分ごと）
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { actionsOverview, buildStack, isActive, loadActionsChoice, saveActionsChoice, setActionsEnabled, shouldDefaultOff, type ActionsOverview } from "../lib/actions";

export function useActions(owner: string, repo: string, enabled: boolean, viewing: boolean, me: string) {
  const [overview, setOverview] = useState<ActionsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadedAt, setLoadedAt] = useState(0);
  const target = useRef(`${owner}/${repo}`);
  target.current = `${owner}/${repo}`;
  // 既定でオフにしようとしたリポジトリ（この起動のあいだに 1 回だけ）
  const tried = useRef(new Set<string>());

  const load = useCallback(async () => {
    if (!owner || !repo) return;
    const key = `${owner}/${repo}`;
    setLoading(true);
    try {
      let ov = await actionsOverview(owner, repo);
      if (target.current !== key) return;
      // 非公開のリポジトリは、Actions を既定でオフにする（持ち主のアプリが、まだ使っていないリポジトリに 1 回だけ）
      if (!tried.current.has(key) && shouldDefaultOff(ov, owner, me, loadActionsChoice(owner, repo))) {
        tried.current.add(key);
        try {
          await setActionsEnabled(owner, repo, false);
          saveActionsChoice(owner, repo, "auto-off");
          ov = await actionsOverview(owner, repo);
          if (target.current !== key) return;
        } catch {
          // 変えられなければ（権限など）、そのまま。画面では「オンです」と出る
        }
      }
      setOverview(ov);
      setError(null);
      setLoadedAt(Date.now());
    } catch (e) {
      if (target.current === key) setError(String(e));
    } finally {
      if (target.current === key) setLoading(false);
    }
  }, [owner, repo, me]);

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
  // Life Manager が既定でオフにしたままか（この PC の記録から。読み直しても知らせが消えないように）
  const autoOff = overview?.actions_enabled === false && loadActionsChoice(owner, repo) === "auto-off";

  return { overview, stack, error, loading, reload: load, urgent, autoOff };
}

export type ActionsState = ReturnType<typeof useActions>;
