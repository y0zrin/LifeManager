// ヒストリー（チームの動き）と「あなたがすること」を読む。サイドバーの数とおしらせのため、画面を開いていなくても 2 分ごとに読む
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { activityFeed, buildTodos, type ActivityFeed } from "../lib/activity";
import { pullVerdicts, type Verdicts } from "../lib/pulls";
import { commitsChecks, type CheckSummary, type Stack } from "../lib/actions";
import type { GitHubIssue } from "../lib/types";

const SEEN_KEEP = 300;

function loadSeen(key: string): string[] {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "[]") as string[];
  } catch {
    return [];
  }
}

export function useActivity(
  owner: string,
  repo: string,
  me: string,
  enabled: boolean,
  viewing: boolean,
  issues: GitHubIssue[],
  stack: Stack | null,
) {
  const [feed, setFeed] = useState<ActivityFeed | null>(null);
  const [verdicts, setVerdicts] = useState<Record<string, Verdicts>>({});
  const [checks, setChecks] = useState<Record<string, CheckSummary>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seenKey = `activity-seen:${owner}/${repo}`;
  const [seen, setSeen] = useState<string[]>(() => loadSeen(seenKey));
  const target = useRef(`${owner}/${repo}`);
  target.current = `${owner}/${repo}`;

  useEffect(() => setSeen(loadSeen(seenKey)), [seenKey]);

  const load = useCallback(async () => {
    if (!owner || !repo) return;
    const key = `${owner}/${repo}`;
    setLoading(true);
    try {
      const f = await activityFeed(owner, repo);
      if (target.current !== key) return;
      setFeed(f);
      setError(null);
      // 自分のプルリクの、承認・修正の依頼とチェック（どちらも読めなければ出さない）
      const mine = (f.pulls ?? []).filter((p) => p.user.toLowerCase() === me.toLowerCase());
      if (mine.length > 0) {
        pullVerdicts(owner, repo, mine.map((p) => p.number)).then((v) => target.current === key && setVerdicts(v)).catch(() => {});
        commitsChecks(owner, repo, mine.map((p) => p.head_sha)).then((c) => target.current === key && setChecks(c)).catch(() => {});
      } else {
        setVerdicts({});
        setChecks({});
      }
    } catch (e) {
      if (target.current === key) setError(String(e));
    } finally {
      if (target.current === key) setLoading(false);
    }
  }, [owner, repo, me]);

  useEffect(() => {
    setFeed(null);
    setVerdicts({});
    setChecks({});
    setError(null);
    if (enabled) load();
  }, [enabled, load]);

  useEffect(() => {
    if (enabled && viewing) load();
  }, [enabled, viewing, load]);

  useEffect(() => {
    if (!enabled) return;
    // 見ていないときも 2 分ごと（おしらせ・助けを求められたのを、早めに知らせるため）
    const t = window.setInterval(load, viewing ? 60000 : 120000);
    return () => window.clearInterval(t);
  }, [enabled, viewing, load]);

  const all = useMemo(
    () => buildTodos({ me, pulls: feed?.pulls ?? null, verdicts, checks, issues, events: feed?.events ?? [], stack }),
    [me, feed, verdicts, checks, issues, stack],
  );
  const todos = useMemo(() => all.filter((t) => !seen.includes(t.key)), [all, seen]);

  /** 見た（この PC に覚える。中身が変わると、また出る） */
  const dismiss = useCallback(
    (key: string) => {
      const next = [...seen.filter((k) => k !== key), key].slice(-SEEN_KEEP);
      setSeen(next);
      try {
        localStorage.setItem(seenKey, JSON.stringify(next));
      } catch {
        // 覚えられなくても、今は消える
      }
    },
    [seen, seenKey],
  );

  return { feed, error, loading, reload: load, todos, all, dismiss };
}

export type ActivityState = ReturnType<typeof useActivity>;
