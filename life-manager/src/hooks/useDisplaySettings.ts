import { useCallback, useState } from "react";

/** 全体図でのブランチの見せ方。線 = ブランチごとに 1 本、ラベル = Sourcetree と同じくコミットの横に名前を付ける */
export type BranchStyle = "label" | "line";

/** サイドバーを置く場所（上・下は横に並んだ帯になる） */
export type SidebarPosition = "left" | "right" | "top" | "bottom";

export const SIDEBAR_POSITIONS: SidebarPosition[] = ["left", "right", "top", "bottom"];

/** メモのボタン（📝）を置く角。hidden はボタンを出さない（Ctrl+M だけで開く） */
export type MemoButtonPosition = "top-right" | "bottom-right" | "top-left" | "bottom-left" | "hidden";

export const MEMO_BUTTON_POSITIONS: MemoButtonPosition[] = ["top-right", "bottom-right", "top-left", "bottom-left", "hidden"];

/** 画面の動き。ふつう = 動いた向きで種類を変える（縦・横・奥行き）、少なめ = うすく出るだけ */
export type MotionLevel = "normal" | "reduced";

export interface DisplaySettings {
  /** 学習の補助: ステージ・コミット・退避などの意味と、対応する git コマンドを画面に添える */
  hints: boolean;
  branchStyle: BranchStyle;
  sidebarPosition: SidebarPosition;
  memoButton: MemoButtonPosition;
  motion: MotionLevel;
}

const STORAGE_KEY = "display-settings";
const DEFAULTS: DisplaySettings = { hints: true, branchStyle: "label", sidebarPosition: "left", memoButton: "bottom-left", motion: "normal" };

function load(): DisplaySettings {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return {
      hints: typeof saved.hints === "boolean" ? saved.hints : DEFAULTS.hints,
      branchStyle: saved.branchStyle === "line" ? "line" : DEFAULTS.branchStyle,
      sidebarPosition: SIDEBAR_POSITIONS.includes(saved.sidebarPosition) ? saved.sidebarPosition : DEFAULTS.sidebarPosition,
      memoButton: MEMO_BUTTON_POSITIONS.includes(saved.memoButton) ? saved.memoButton : DEFAULTS.memoButton,
      motion: saved.motion === "reduced" ? "reduced" : DEFAULTS.motion,
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
