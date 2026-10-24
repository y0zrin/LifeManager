// UT-48・UT-56（1.1 単体テスト仕様書）: ガントの帯が伸びて出る動きの計算（#215・#301・#304）
import { describe, expect, it } from "vitest";
import { ARROW_GROW_MS, REVEAL_GROW_MS, arrowProgress, newReveal, revealBusy, revealDelays, revealFraction, revealSeen } from "./ganttReveal";
import type { GanttTask } from "./ganttTypes";

const task = (issueNumber: number, startDate: string | null, endDate: string | null): GanttTask => ({
  issueNumber,
  title: `#${issueNumber}`,
  state: "open",
  assignees: [],
  labels: [],
  startDate,
  endDate,
  dependencies: [],
  progressMode: "checkbox",
  progressValue: 0,
  estimate: null,
});

/** 待つのをやめた形 */
const started = () => {
  const s = newReveal();
  s.waiting = false;
  return s;
};

describe("revealDelays", () => {
  it("日付の早い帯から間をあけ、日程のない帯は入れない", () => {
    const d = revealDelays([task(3, "2026-10-05", "2026-10-06"), task(1, "2026-10-01", "2026-10-03"), task(2, null, null), task(4, "2026-10-01", "2026-10-02")]);
    expect([...d.keys()]).toEqual([4, 1, 3]);
    expect(d.get(4)).toBe(0);
    expect(d.get(1)! - d.get(4)!).toBe(d.get(3)! - d.get(1)!);
  });

  it("帯が多くても、全体で 1.5 秒ほどにおさまる。1 本なら間なし", () => {
    const many = Array.from({ length: 200 }, (_, i) => task(i + 1, "2026-10-01", "2026-10-02"));
    expect(Math.max(...revealDelays(many).values()) + REVEAL_GROW_MS).toBeLessThanOrEqual(1500);
    expect([...revealDelays([task(1, "2026-10-01", "2026-10-02")]).values()]).toEqual([0]);
  });
});

describe("revealSeen", () => {
  it("待っているあいだは時刻を付けない", () => {
    const s = newReveal();
    expect(revealSeen(s, [task(1, "2026-10-01", "2026-10-02")], 0)).toBe(false);
    expect(s.start.size).toBe(0);
  });

  it("見えた帯に時刻を付け、一度付けた帯には付け直さない（また入ってきても伸ばさない）", () => {
    const s = started();
    expect(revealSeen(s, [task(1, "2026-10-01", "2026-10-02")], 100)).toBe(true);
    expect(s.start.get(1)).toBe(100);
    // あとでスクロールして入ってきた帯は、そのときから
    expect(revealSeen(s, [task(1, "2026-10-01", "2026-10-02"), task(2, "2026-10-03", "2026-10-04")], 5000)).toBe(true);
    expect(s.start.get(1)).toBe(100);
    expect(s.start.get(2)).toBe(5000);
    expect(revealSeen(s, [task(1, "2026-10-01", "2026-10-02"), task(2, "2026-10-03", "2026-10-04")], 9000)).toBe(false);
  });
});

describe("revealFraction", () => {
  it("待っているあいだは 0、まだ見えていない帯は 1", () => {
    const s = newReveal();
    expect(revealFraction(s, 1, 0)).toBe(0);
    expect(revealFraction(started(), 1, 0)).toBe(1);
  });

  it("時刻を付けた帯は 0 → 1 に伸び、減らない", () => {
    const s = started();
    revealSeen(s, [task(1, "2026-10-01", "2026-10-02")], 1000);
    expect(revealFraction(s, 1, 1000)).toBe(0);
    expect(revealFraction(s, 1, 1000 + REVEAL_GROW_MS)).toBe(1);
    let last = 0;
    for (let t = 1000; t <= 1000 + REVEAL_GROW_MS; t += 10) {
      const f = revealFraction(s, 1, t);
      expect(f).toBeGreaterThanOrEqual(last);
      last = f;
    }
  });

  it("伸びはじめの出だしが速すぎない（半分の時間で 8 割に届かない）", () => {
    const s = started();
    revealSeen(s, [task(1, "2026-10-01", "2026-10-02")], 0);
    expect(revealFraction(s, 1, REVEAL_GROW_MS / 2)).toBeLessThan(0.8);
  });
});

describe("arrowProgress・revealBusy", () => {
  it("矢印は、先行が伸びきって後続が伸びはじめてから、0 → 1 に伸びる。見えていない帯は伸びきったとみる", () => {
    const s = started();
    revealSeen(s, [task(1, "2026-10-01", "2026-10-02"), task(2, "2026-10-03", "2026-10-04")], 0);
    const gap = s.start.get(2)!;
    expect(arrowProgress(s, 1, 2, REVEAL_GROW_MS)).toBe(0);
    expect(arrowProgress(s, 1, 2, REVEAL_GROW_MS + ARROW_GROW_MS / 2)).toBeGreaterThan(0);
    expect(arrowProgress(s, 1, 2, REVEAL_GROW_MS + ARROW_GROW_MS / 2)).toBeLessThan(1);
    expect(arrowProgress(s, 1, 2, REVEAL_GROW_MS + ARROW_GROW_MS)).toBe(1);
    // 見えていない帯（99）との矢印: 後続が伸びはじめてから・先行が伸びきってから
    expect(arrowProgress(s, 99, 2, gap)).toBe(0);
    expect(arrowProgress(s, 99, 2, gap + ARROW_GROW_MS)).toBe(1);
    expect(arrowProgress(s, 2, 99, gap + REVEAL_GROW_MS + ARROW_GROW_MS)).toBe(1);
    // どちらも見えていない矢印は、はじめから出ている。待っているあいだは出さない
    expect(arrowProgress(s, 98, 99, 0)).toBe(1);
    expect(arrowProgress(newReveal(), 1, 2, 0)).toBe(0);
  });

  it("伸びている途中・これから伸びる帯や矢印があるあいだだけ busy", () => {
    const s = started();
    expect(revealBusy(s, 0)).toBe(false);
    revealSeen(s, [task(1, "2026-10-01", "2026-10-02"), task(2, "2026-10-03", "2026-10-04")], 0);
    const last = s.start.get(2)! + REVEAL_GROW_MS + ARROW_GROW_MS;
    expect(revealBusy(s, last - 1)).toBe(true);
    expect(revealBusy(s, last)).toBe(false);
  });
});
