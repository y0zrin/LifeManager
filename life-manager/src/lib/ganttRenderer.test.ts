// UT-55（1.1 単体テスト仕様書）: 描いた帯の右端。帯が伸びて出るときに、期限を過ぎた赤い延長も一緒に伸ばすため（#301）
import { describe, expect, it } from "vitest";
import { barReach, dateToDays } from "./ganttRenderer";
import type { GanttTask } from "./ganttTypes";

const task = (endDate: string, extra: Partial<GanttTask> = {}): GanttTask => ({
  issueNumber: 1,
  title: "#1",
  state: "open",
  assignees: [],
  labels: [],
  startDate: "2026-10-01",
  endDate,
  dependencies: [],
  progressMode: "checkbox",
  progressValue: 0,
  estimate: null,
  ...extra,
});

const today = dateToDays("2026-10-22");

describe("barReach", () => {
  it("期限を過ぎた開いている帯は、赤い延長の右端まで", () => {
    expect(barReach(task("2026-10-13"), 100, 10, today)).toBe(100 + 9 * 10);
  });

  it("延長が 25 ピクセル以下なら、外に出る「+3d」の字の分も足す", () => {
    expect(barReach(task("2026-10-20"), 100, 10, today)).toBe(100 + 20 + 26);
  });

  it("期限の内・閉じた帯・仮の帯は、終わりの日の右", () => {
    expect(barReach(task("2026-10-22"), 100, 10, today)).toBe(100);
    expect(barReach(task("2026-10-13", { state: "closed" }), 100, 10, today)).toBe(100);
    expect(barReach(task("2026-10-13", { tentative: true }), 100, 10, today)).toBe(100);
  });
});
