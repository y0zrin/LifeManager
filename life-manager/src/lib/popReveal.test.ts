// UT-54（1.1 単体テスト仕様書）: 開いたとき、下から上へ出す順番と速さ（#293）
import { describe, expect, it } from "vitest";
import { POP_STEP_MAX, POP_STEP_MIN, POP_TOTAL, edgeReveal, popRank, popStep } from "./popReveal";

describe("popStep", () => {
  it("少ないときはゆっくり（90 ミリ秒まで）、多いときは詰める（28 ミリ秒より短くしない）", () => {
    expect(popStep(0)).toBe(0);
    expect(popStep(1)).toBe(0);
    expect(popStep(3)).toBe(POP_STEP_MAX);
    expect(popStep(500)).toBe(POP_STEP_MIN);
  });

  it("あいだの数なら、全体で 1.1 秒ほどにする", () => {
    expect(popStep(21) * 20).toBeCloseTo(POP_TOTAL);
  });
});

describe("popRank", () => {
  it("見えている行は、下から 0, 1, 2 …", () => {
    expect([10, 9, 8, 5].map((r) => popRank(r, 5, 10))).toEqual([0, 1, 2, 5]);
  });

  it("見えていない行は -1（動かさない）", () => {
    expect(popRank(4, 5, 10)).toBe(-1);
    expect(popRank(11, 5, 10)).toBe(-1);
  });
});

describe("edgeReveal", () => {
  const step = 50;

  it("下の点が出たときに伸びはじめ、上の点が出るときに伸びきる", () => {
    // 見えている行 0〜10。行 7 → 行 9 の線: 行 9 は 1 番目（50ms）、行 7 は 3 番目（150ms）
    expect(edgeReveal(7, 9, 0, 10, step)).toEqual({ delay: 50, duration: 100 });
  });

  it("下へはみ出す線ははじめから、上へはみ出す線はいちばん上が出るときまで", () => {
    expect(edgeReveal(8, 30, 0, 10, step)).toEqual({ delay: 0, duration: 100 });
    expect(edgeReveal(2, 8, 5, 10, step)).toEqual({ delay: 100, duration: 150 });
  });

  it("となりの行どうしでも、1 つずつの間より短くしない", () => {
    expect(edgeReveal(3, 3, 0, 10, step)?.duration).toBe(step);
  });

  it("どちらの点も見えていない線は動かさない", () => {
    expect(edgeReveal(12, 20, 0, 10, step)).toBeNull();
    expect(edgeReveal(0, 3, 5, 10, step)).toBeNull();
  });
});
