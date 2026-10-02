import { useCallback, useLayoutEffect, useState } from "react";
import { applyStageMotion, applyTheme, isTheme, type Theme } from "../lib/theme";
import { isMobile } from "../lib/platform";
import { DEFAULT_BAR_COLORS, type GanttBarColors } from "../lib/ganttTypes";
import { MILESTONE_BARS, type MilestoneBar } from "../lib/milestoneStage";
import { NOTICE_CORNERS, type NoticeCorner } from "../lib/notices";

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
  branchStyle: BranchStyle;
  sidebarPosition: SidebarPosition;
  memoButton: MemoButtonPosition;
  motion: MotionLevel;
  /** テーマ（黒板・ホワイトボード・クエスト）。ボードと、その下の机もテーマのものになる */
  theme: Theme;
  /** ガントの帯の色 */
  ganttColors: GanttBarColors;
  /** マイルストーンのバー: テーマに合わせる（クエストは HP）・達成率（のびる）・HP（減る） */
  milestoneBar: MilestoneBar;
  /** おしらせの窓を出す角（off = 窓を出さず、アプリの中だけ）。PC だけ */
  noticeCorner: NoticeCorner;
  /** × を押したとき、インジケーター（タスクトレイ）に残す（はじめはこれ）か、終了する。PC だけ */
  closeToTray: boolean;
  /** 背景（テーマの粒: チョークの粉・花びら・雪 など）を動かす（はじめはこれ）。画面の動きが少なめ・スマホでは止める */
  stageMotion: boolean;
  /** マイルストーンを達成したときに、お祝いの音を鳴らす（はじめはこれ。#231） */
  celebrationSound: boolean;
}

const STORAGE_KEY = "display-settings";
const DEFAULTS: DisplaySettings = {
  branchStyle: "label",
  sidebarPosition: "left",
  // スマホは右下（親指が届き、中身の大事な左側にかぶらない。#205）
  memoButton: isMobile ? "bottom-right" : "bottom-left",
  motion: "normal",
  theme: "chalk",
  ganttColors: DEFAULT_BAR_COLORS,
  milestoneBar: "auto",
  noticeCorner: "top-right",
  closeToTray: true,
  stageMotion: true,
  celebrationSound: true,
};
// 前は、ボード・ガントの画面ごとに覚えていた（はじめて読むときは、その値を引き継ぐ。ボードの見た目は、そのままテーマになる）
const OLD_BOARD_LOOK_KEY = "board-look";
const OLD_GANTT_COLORS_KEY = "gantt-bar-colors";

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

/** 保存してある表示の設定（起動のはじめにテーマを当てるのにも使う） */
export function loadDisplaySettings(): DisplaySettings {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return {
      branchStyle: saved.branchStyle === "line" ? "line" : DEFAULTS.branchStyle,
      sidebarPosition: SIDEBAR_POSITIONS.includes(saved.sidebarPosition) ? saved.sidebarPosition : DEFAULTS.sidebarPosition,
      memoButton: MEMO_BUTTON_POSITIONS.includes(saved.memoButton) ? saved.memoButton : DEFAULTS.memoButton,
      motion: saved.motion === "reduced" ? "reduced" : DEFAULTS.motion,
      theme: [saved.theme, saved.boardLook, localStorage.getItem(OLD_BOARD_LOOK_KEY)].find(isTheme) ?? DEFAULTS.theme,
      ganttColors: loadGanttColors(saved.ganttColors),
      milestoneBar: MILESTONE_BARS.includes(saved.milestoneBar) ? saved.milestoneBar : DEFAULTS.milestoneBar,
      noticeCorner: NOTICE_CORNERS.includes(saved.noticeCorner) ? saved.noticeCorner : DEFAULTS.noticeCorner,
      closeToTray: typeof saved.closeToTray === "boolean" ? saved.closeToTray : DEFAULTS.closeToTray,
      stageMotion: typeof saved.stageMotion === "boolean" ? saved.stageMotion : DEFAULTS.stageMotion,
      celebrationSound: typeof saved.celebrationSound === "boolean" ? saved.celebrationSound : DEFAULTS.celebrationSound,
    };
  } catch {
    return DEFAULTS;
  }
}

/** 背景を動かすか（設定で止めた・画面の動きが少なめ・スマホ では止める） */
export function stageMoves(s: DisplaySettings): boolean {
  return s.stageMotion && s.motion === "normal" && !isMobile;
}

/** 表示の設定（この PC のこのアプリだけの好みなので、ブラウザの保存領域に置く） */
export function useDisplaySettings() {
  const [settings, setSettings] = useState<DisplaySettings>(loadDisplaySettings);

  // テーマを画面全体に当てる（描く前に当てて、前のテーマの色が一瞬出ないようにする）
  useLayoutEffect(() => {
    applyTheme(settings.theme);
  }, [settings.theme]);

  // 背景の動き（画面の動きが少なめ・スマホでは止める）
  useLayoutEffect(() => {
    applyStageMotion(stageMoves(settings));
  }, [settings]);

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
