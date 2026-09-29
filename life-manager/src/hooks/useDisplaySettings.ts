import { useCallback, useState } from "react";
import { BOARD_LOOKS, type BoardLook } from "../lib/board";
import { DEFAULT_BAR_COLORS, type GanttBarColors } from "../lib/ganttTypes";

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
  /** ボードの見た目（ボードの上でも切り替えられる） */
  boardLook: BoardLook;
  /** ガントの帯の色 */
  ganttColors: GanttBarColors;
}

const STORAGE_KEY = "display-settings";
const DEFAULTS: DisplaySettings = {
  hints: true,
  branchStyle: "label",
  sidebarPosition: "left",
  memoButton: "bottom-left",
  motion: "normal",
  boardLook: "chalk",
  ganttColors: DEFAULT_BAR_COLORS,
};
// 前は、ボード・ガントの画面ごとに覚えていた（はじめて読むときは、その値を引き継ぐ）
const OLD_BOARD_LOOK_KEY = "board-look";
const OLD_GANTT_COLORS_KEY = "gantt-bar-colors";

function isBoardLook(v: unknown): v is BoardLook {
  return BOARD_LOOKS.some((l) => l.key === v);
}

/** 帯の色。#rrggbb でないものは、はじめの色にする */
function loadGanttColors(saved: unknown): GanttBarColors {
  let src = saved;
  if (!src || typeof src !== "object") {
    try {
      src = JSON.parse(localStorage.getItem(OLD_GANTT_COLORS_KEY) ?? "null");
    } catch {
      src = null;
    }
  }
  const colors = { ...DEFAULT_BAR_COLORS };
  if (!src || typeof src !== "object") return colors;
  for (const key of Object.keys(colors) as (keyof GanttBarColors)[]) {
    const v = (src as Record<string, unknown>)[key];
    if (typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v)) colors[key] = v;
  }
  return colors;
}

function load(): DisplaySettings {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return {
      hints: typeof saved.hints === "boolean" ? saved.hints : DEFAULTS.hints,
      branchStyle: saved.branchStyle === "line" ? "line" : DEFAULTS.branchStyle,
      sidebarPosition: SIDEBAR_POSITIONS.includes(saved.sidebarPosition) ? saved.sidebarPosition : DEFAULTS.sidebarPosition,
      memoButton: MEMO_BUTTON_POSITIONS.includes(saved.memoButton) ? saved.memoButton : DEFAULTS.memoButton,
      motion: saved.motion === "reduced" ? "reduced" : DEFAULTS.motion,
      boardLook: isBoardLook(saved.boardLook) ? saved.boardLook : [localStorage.getItem(OLD_BOARD_LOOK_KEY)].find(isBoardLook) ?? DEFAULTS.boardLook,
      ganttColors: loadGanttColors(saved.ganttColors),
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
