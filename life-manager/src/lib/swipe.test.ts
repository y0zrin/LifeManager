// UT-47（1.1 単体テスト仕様書）: ブランチの画面を引いて移るときの決め方（#258）
import { describe, expect, it } from "vitest";
import { decideSwipe, movedEnough } from "./swipe";

describe("decideSwipe", () => {
  it("ページの幅の 4 分の 1 より左へ引くと次、右へ引くと前", () => {
    expect(decideSwipe(-101, 400)).toBe(1);
    expect(decideSwipe(-100, 400)).toBe(1);
    expect(decideSwipe(120, 400)).toBe(-1);
  });

  it("それより少なければ、元のページへ戻す", () => {
    expect(decideSwipe(-99, 400)).toBe(0);
    expect(decideSwipe(60, 400)).toBe(0);
    expect(decideSwipe(0, 400)).toBe(0);
  });

  it("ページの幅がわからないときは移らない", () => {
    expect(decideSwipe(-300, 0)).toBe(0);
  });
});

describe("movedEnough", () => {
  it("5 ピクセル以下は押しただけ", () => {
    expect(movedEnough(3, 4)).toBe(false);
    expect(movedEnough(5)).toBe(false);
    expect(movedEnough(6)).toBe(true);
    expect(movedEnough(0, -8)).toBe(true);
  });
});
