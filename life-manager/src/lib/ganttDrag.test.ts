// UT-52（1.1 単体テスト仕様書）: ガントの帯を引きはじめる距離（#290）
import { describe, expect, it } from "vitest";
import { startsBarDrag } from "./ganttDrag";

describe("startsBarDrag", () => {
  it("日程のある帯は 3 ピクセルをこえたら引きはじめる", () => {
    expect(startsBarDrag(3, false)).toBe(false);
    expect(startsBarDrag(4, false)).toBe(true);
    expect(startsBarDrag(-4, false)).toBe(true);
  });

  it("仮の帯は 10 ピクセルをこえるまで引かない（押したときのずれでは動かない）", () => {
    expect(startsBarDrag(4, true)).toBe(false);
    expect(startsBarDrag(-10, true)).toBe(false);
    expect(startsBarDrag(11, true)).toBe(true);
    expect(startsBarDrag(-11, true)).toBe(true);
  });
});
