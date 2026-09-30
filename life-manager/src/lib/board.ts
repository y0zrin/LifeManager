import type { BoardColumn, BoardGenre } from "./types";

/** ボードの列（設定がないとき）。タスク一覧を「状態」でまとめるときの順番にも使う */
export const DEFAULT_COLUMNS: BoardColumn[] = [
  { key: "状態:未整理", title: "未整理", emoji: "📥" },
  { key: "状態:未着手", title: "未着手", emoji: "📋" },
  { key: "状態:進行中", title: "進行中", emoji: "🔥" },
  { key: "状態:チェック待ち", title: "チェック待ち", emoji: "👀" },
  { key: "状態:動作確認", title: "動作確認", emoji: "🧪" },
  { key: "状態:完了承認待ち", title: "完了承認待ち", emoji: "✅" },
  { key: "状態:いつか", title: "いつか", emoji: "💭" },
];

/** はじめから「未整理」ボードに置く区画（ほかは「着手済み」） */
const TRIAGE_KEYS = new Set(["状態:未整理", "状態:未着手", "状態:いつか", "none"]);

/** 区画を置くボード（設定がなければ、状態の名前から） */
export function genreOf(col: BoardColumn): BoardGenre {
  return col.genre ?? (TRIAGE_KEYS.has(col.key) ? "triage" : "doing");
}

/** ボードのジャンル（タブ）。区画をどちらに置くかの選び方にも使う */
export const BOARD_GENRES: { key: BoardGenre; label: string; icon: string; about: string }[] = [
  { key: "triage", label: "未整理", icon: "📥", about: "整理して、やることを決める" },
  { key: "doing", label: "着手済み", icon: "🔥", about: "やっていることを追う" },
];

