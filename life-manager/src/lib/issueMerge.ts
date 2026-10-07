// 読み直した Issue の一覧を、今の一覧に入れる（#269）。
// 変わっていない Issue（updated_at と送信待ちの印が同じ）は、今のオブジェクトをそのまま使う（画面を作り直さず、書きかけの入力を守る）
import type { GitHubIssue } from "./types";

/** 変わっていないか（GitHub の updated_at と、送信待ち・送っている・送れなかったの印が同じ） */
function same(a: GitHubIssue, b: GitHubIssue): boolean {
  return a.updated_at === b.updated_at && !!a._pending === !!b._pending && !!a._sending === !!b._sending && a._failed === b._failed;
}

/** fresh の並びで、変わっていないものは prev のオブジェクトにした一覧。何も変わっていなければ prev をそのまま返す */
export function mergeIssueList(prev: GitHubIssue[], fresh: GitHubIssue[]): GitHubIssue[] {
  const byNumber = new Map(prev.map((i) => [i.number, i]));
  let changed = prev.length !== fresh.length;
  const merged = fresh.map((issue, index) => {
    const old = byNumber.get(issue.number);
    const keep = old && same(old, issue) ? old : issue;
    if (keep !== prev[index]) changed = true;
    return keep;
  });
  return changed ? merged : prev;
}
