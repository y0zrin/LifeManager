// UT-48（1.1 単体テスト仕様書）: ガントの帯が伸びて出る動きの計算（#215）
import { describe, expect, it } from "vitest";
import { arrowsVisible, revealFraction, revealPlan } from "./ganttReveal";
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

describe("revealPlan", () => {
  it("日付の早い帯から順位を付け、日程のない帯には付けない", () => {
    const plan = revealPlan([task(3, "2026-10-05", "2026-10-06"), task(1, "2026-10-01", "2026-10-03"), task(2, null, null), task(4, "2026-10-01", "2026-10-02")]);
    expect([...plan.rank.entries()]).toEqual([[4, 0], [1, 1], [3, 2]]);
  });

  it("帯が多くても、全体で 1 秒ほどにおさまる", () => {
    const many = Array.from({ length: 200 }, (_, i) => task(i + 1, "2026-10-01", "2026-10-02"));
    expect(revealPlan(many).total).toBeLessThanOrEqual(1000);
    expect(revealPlan([task(1, "2026-10-01", "2026-10-02")]).total).toBe(400);
  });
});

describe("revealFraction・arrowsVisible", () => {
  const plan = revealPlan([task(1, "2026-10-01", "2026-10-02"), task(2, "2026-10-03", "2026-10-04"), task(3, "2026-10-05", "2026-10-06")]);

  it("順位の早い帯から 0 → 1 に伸び、全部そろうと矢印を出す", () => {
    expect(revealFraction(plan, 1, 0)).toBe(0);
    expect(revealFraction(plan, 1, 200)).toBeGreaterThan(revealFraction(plan, 2, 200));
    expect(revealFraction(plan, 3, plan.gap * 2)).toBe(0);
    for (const n of [1, 2, 3]) expect(revealFraction(plan, n, plan.total)).toBe(1);
    expect(arrowsVisible(plan, plan.total - 1)).toBe(false);
    expect(arrowsVisible(plan, plan.total)).toBe(true);
  });

  it("伸び方は時間とともに減らない", () => {
    let last = 0;
    for (let t = 0; t <= plan.total; t += 10) {
      const f = revealFraction(plan, 2, t);
      expect(f).toBeGreaterThanOrEqual(last);
      last = f;
    }
  });

  it("順位のない帯（日程なし）は、はじめから出ている", () => {
    expect(revealFraction(plan, 99, 0)).toBe(1);
  });
});
