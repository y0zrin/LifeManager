// UT-46（1.1 単体テスト仕様書）: 読み直した一覧の入れ方（#269）
import { describe, expect, it } from "vitest";
import { mergeIssueList } from "./issueMerge";
import type { GitHubIssue } from "./types";

const issue = (number: number, updated_at: string, extra: Partial<GitHubIssue> = {}): GitHubIssue =>
  ({ number, title: `#${number}`, body: "", state: "open", labels: [], milestone: null, assignees: [], comments: 0, created_at: updated_at, updated_at, ...extra }) as GitHubIssue;

describe("mergeIssueList", () => {
  it("変わっていない Issue は、前と同じオブジェクトを使う", () => {
    const a = issue(1, "2026-10-07T01:00:00Z");
    const b = issue(2, "2026-10-07T02:00:00Z");
    const merged = mergeIssueList([a, b], [issue(1, "2026-10-07T01:00:00Z"), issue(2, "2026-10-07T05:00:00Z", { title: "変えた" })]);
    expect(merged[0]).toBe(a);
    expect(merged[1]).not.toBe(b);
    expect(merged[1].title).toBe("変えた");
  });

  it("何も変わっていなければ、一覧そのものも前のまま", () => {
    const prev = [issue(1, "2026-10-07T01:00:00Z"), issue(2, "2026-10-07T02:00:00Z")];
    expect(mergeIssueList(prev, [issue(1, "2026-10-07T01:00:00Z"), issue(2, "2026-10-07T02:00:00Z")])).toBe(prev);
  });

  it("増えた・減った・並びが変わったときは、読み直した並びにする", () => {
    const a = issue(1, "2026-10-07T01:00:00Z");
    const b = issue(2, "2026-10-07T02:00:00Z");
    const merged = mergeIssueList([a, b], [issue(3, "2026-10-07T06:00:00Z"), issue(2, "2026-10-07T02:00:00Z")]);
    expect(merged.map((i) => i.number)).toEqual([3, 2]);
    expect(merged[1]).toBe(b);
  });

  it("送信待ちの印が変わったら、入れ替える", () => {
    const a = issue(1, "2026-10-07T01:00:00Z", { _pending: true });
    const merged = mergeIssueList([a], [issue(1, "2026-10-07T01:00:00Z")]);
    expect(merged[0]).not.toBe(a);
    expect(merged[0]._pending).toBeUndefined();
  });
});
