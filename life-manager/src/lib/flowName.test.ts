// UT-53（1.1 単体テスト仕様書）: 全体図のブランチの名前を流す長さ（#292）
import { describe, expect, it } from "vitest";
import { FLOW_MIN_CYCLE, FLOW_SHARE, FLOW_SPEED, FLOW_TAIL, flowTiming } from "./flowName";

describe("flowTiming", () => {
  it("はみ出していなければ流さない（1 ピクセルまでは字の丸めとみる）", () => {
    expect(flowTiming(0)).toBeNull();
    expect(flowTiming(1)).toBeNull();
    expect(flowTiming(-20)).toBeNull();
    expect(flowTiming(Number.NaN)).toBeNull();
  });

  it("はみ出した長さに、右の端の分を足してずらす", () => {
    expect(flowTiming(80.4)?.shift).toBe(-(81 + FLOW_TAIL));
  });

  it("長い名前は、流れる速さが一定になる長さにする", () => {
    const t = flowTiming(290)!;
    expect(t.duration).toBeCloseTo((290 + FLOW_TAIL) / FLOW_SPEED / FLOW_SHARE);
    expect(-t.shift / (t.duration * FLOW_SHARE)).toBeCloseTo(FLOW_SPEED);
  });

  it("短いはみ出しでも、1 回は 5 秒より短くしない", () => {
    expect(flowTiming(12)?.duration).toBe(FLOW_MIN_CYCLE);
  });
});
