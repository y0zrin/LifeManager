import { useCallback, useState } from "react";

/** 全体図でのブランチの見せ方。線 = ブランチごとに 1 本、ラベル = Sourcetree と同じくコミットの横に名前を付ける */
export type BranchStyle = "label" | "line";

export interface DisplaySettings {
  /** 学習の補助: ステージ・コミット・退避などの意味と、対応する git コマンドを画面に添える */
  hints: boolean;
  branchStyle: BranchStyle;
}

const STORAGE_KEY = "display-settings";
const DEFAULTS: DisplaySettings = { hints: true, branchStyle: "label" };

function load(): DisplaySettings {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return {
      hints: typeof saved.hints === "boolean" ? saved.hints : DEFAULTS.hints,
      branchStyle: saved.branchStyle === "line" ? "line" : DEFAULTS.branchStyle,
    };
  } catch {
    return DEFAULTS;
  }
}

/** 表示の設定（この PC のこのアプリだけの好みなので、ブラウザの保存領域に置く） */
export function useDisplaySettings() {
  const [settings, setSettings] = useState<DisplaySettings>(load);

  const update = useCallback((patch: Partial<DisplaySettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // 保存できなくても表示は切り替わる
      }
      return next;
    });
  }, []);

  return { settings, update };
}
