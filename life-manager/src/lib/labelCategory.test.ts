// UT-42 の決まった区分の分（1.1 単体テスト仕様書）: 設定のラベルのタブの区分（#281。足した区分は #282 で）
import { describe, expect, it } from "vitest";
import { labelCategories, prefixOf } from "./labelCategory";

const label = (name: string) => ({ name, color: "cccccc", description: "" });

describe("labelCategories", () => {
  const labels = ["優先:高", "種別:メモ", "セクション:プログラマー", "分野:仕事", "見積:4時間", "状態:進行中", "てててててててててｔ", "工程:企画", "種別:バグ"].map(label);
  const cats = labelCategories(labels);

  it("並びは 種別・状態・優先・セクション・見積 → そのほか", () => {
    expect(cats.map((c) => c.prefix)).toEqual(["種別:", "状態:", "優先:", "セクション:", "見積:", ""]);
  });

  it("前の「分野:」はセクションに入る。頭のないもの・決まっていない頭のものは、そのほか", () => {
    const of = (prefix: string) => cats.find((c) => c.prefix === prefix)!.labels.map((l) => l.name);
    expect(of("種別:")).toEqual(["種別:メモ", "種別:バグ"]);
    expect(of("セクション:")).toEqual(["セクション:プログラマー", "分野:仕事"]);
    expect(of("")).toEqual(["てててててててててｔ", "工程:企画"]);
  });

  it("見積は「＋」で作らない。ラベルがない区分も出す", () => {
    expect(cats.find((c) => c.prefix === "見積:")!.canAdd).toBe(false);
    expect(labelCategories([]).map((c) => c.labels.length)).toEqual([0, 0, 0, 0, 0, 0]);
  });
});

describe("prefixOf", () => {
  const cats = labelCategories([]);
  const section = cats.find((c) => c.prefix === "セクション:")!;
  const other = cats.find((c) => c.prefix === "")!;

  it("区分のラベルは、そのラベルの頭（前の「分野:」も）", () => {
    expect(prefixOf("セクション:プログラマー", section)).toBe("セクション:");
    expect(prefixOf("分野:仕事", section)).toBe("分野:");
  });

  it("そのほかは頭なし（「:」があっても名前ごと）", () => {
    expect(prefixOf("工程:企画", other)).toBe("");
  });
});
