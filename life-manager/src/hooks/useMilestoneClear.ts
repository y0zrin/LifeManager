import { useEffect, useRef } from "react";
import type { GitHubIssue, GitHubMilestone } from "../lib/types";
import type { EstimateUnit } from "../lib/estimate";
import { buildStages, clearDetailOf, markCelebrated, wasCelebrated } from "../lib/milestoneStage";
import { celebrateMilestone } from "../lib/celebrate";

/**
 * マイルストーンの最後のタスクを完了にしたら（どの画面からでも。チームの人が閉じて、読み直したときも）、大きく祝う。
 * 同じマイルストーンで 1 回だけ（この PC）。開いているタスクが一覧から消えて、閉じたタスクの一覧に入っていれば「終えた」
 * （ほかのマイルストーンへ移しただけなら祝わない）。GitHub でもう閉じたマイルストーンは、画面の「完了」のときに祝う
 */
export function useMilestoneClear(
  repoKey: string,
  milestones: GitHubMilestone[],
  issues: GitHubIssue[],
  closedIssues: GitHubIssue[],
  unit: EstimateUnit,
  enabled: boolean,
) {
  const prev = useRef<{ repoKey: string; open: Map<number, Set<number>> } | null>(null);
  // 開いているタスクがなくなったが、閉じた一覧がまだ変わっていないマイルストーン（開いた一覧と閉じた一覧は、別々に変わることがある）
  const pending = useRef(new Map<number, Set<number>>());

  useEffect(() => {
    if (!enabled) {
      prev.current = null;
      pending.current.clear();
      return;
    }
    const open = new Map<number, Set<number>>();
    for (const i of issues) {
      const n = i.milestone?.number;
      if (n === undefined) continue;
      const set = open.get(n) ?? new Set<number>();
      set.add(i.number);
      open.set(n, set);
    }
    const before = prev.current;
    prev.current = { repoKey, open };
    // はじめて読んだとき・リポジトリを切り替えたときは、比べない
    if (!before || before.repoKey !== repoKey) {
      pending.current.clear();
      return;
    }
    for (const [n, set] of before.open) if (!open.has(n)) pending.current.set(n, set);
    for (const [n, set] of [...pending.current]) {
      // また開いた・タスクを足した
      if (open.has(n)) {
        pending.current.delete(n);
        continue;
      }
      const closedHere = [...set].every((num) => closedIssues.some((c) => c.number === num && c.milestone?.number === n));
      if (!closedHere) {
        // 開いたまま別のマイルストーンへ移した → 祝わない。まだ閉じた一覧が変わっていないだけなら、次に見る
        if ([...set].some((num) => issues.some((i) => i.number === num))) pending.current.delete(n);
        continue;
      }
      pending.current.delete(n);
      if (wasCelebrated(repoKey, n)) continue;
      const stage = buildStages(milestones, issues, closedIssues, "estimate", unit).find((s) => s.ms.number === n);
      if (!stage || stage.closed) continue;
      markCelebrated(repoKey, n);
      celebrateMilestone(clearDetailOf(stage, repoKey, unit, true));
    }
  }, [repoKey, milestones, issues, closedIssues, unit, enabled]);
}
