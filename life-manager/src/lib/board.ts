import type { BoardColumn } from "./types";

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
