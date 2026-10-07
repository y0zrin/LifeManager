// UT-44・UT-45（1.1 単体テスト仕様書）: 画面に出すラベルと、付けたラベルが付いたかの見分け（#268）
import { describe, expect, it } from "vitest";
import { GITHUB_DEFAULT_LABELS, labelsApplied, visibleLabels } from "./labels";

const label = (name: string) => ({ name, color: "ededed" });

describe("visibleLabels", () => {
  it("GitHub がはじめに作る 9 つだけを外す", () => {
    const all = [...GITHUB_DEFAULT_LABELS].map(label);
    expect(GITHUB_DEFAULT_LABELS.size).toBe(9);
    expect(visibleLabels(all)).toEqual([]);
  });

  it("チームが作ったラベルは、名前の頭に関わらず残す", () => {
    const shown = visibleLabels([label("種別:イシュー"), label("bug"), label("てててててててててｔ"), label("UI"), label("分野:仕事")]);
    expect(shown.map((l) => l.name)).toEqual(["種別:イシュー", "てててててててててｔ", "UI", "分野:仕事"]);
  });
});

describe("labelsApplied", () => {
  it("並びが違っても、同じラベルなら付いている", () => {
    expect(labelsApplied(["優先:高", "状態:進行中"], [label("状態:進行中"), label("優先:高")])).toBe(true);
    expect(labelsApplied([], [])).toBe(true);
  });

  it("足りない・多いときは付いていない（GitHub が変更を捨てたとき）", () => {
    expect(labelsApplied(["状態:進行中"], [label("状態:未整理")])).toBe(false);
    expect(labelsApplied(["状態:進行中", "優先:高"], [label("状態:進行中")])).toBe(false);
    expect(labelsApplied([], [label("状態:未整理")])).toBe(false);
  });
});
