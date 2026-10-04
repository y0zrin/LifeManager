import type { BoardColumn, BoardConfig, BoardGenre } from "./types";
import { tr } from "./i18n";

/** ボードの列（設定がないとき）。タスク一覧を「状態」でまとめるときの順番にも使う */
export const DEFAULT_COLUMNS: BoardColumn[] = [
  { key: "状態:未整理", title: "未整理", emoji: "📥" },
  { key: "状態:未着手", title: "未着手", emoji: "📋" },
  { key: "状態:進行中", title: "進行中", emoji: "🔥" },
  { key: "状態:ブロック", title: "ブロック", emoji: "🚧" },
  { key: "状態:チェック待ち", title: "チェック待ち", emoji: "👀" },
  { key: "状態:動作確認", title: "動作確認", emoji: "🧪" },
  { key: "状態:完了承認待ち", title: "完了承認待ち", emoji: "✅" },
  { key: "状態:いつか", title: "いつか", emoji: "💭" },
];

/** はじめから「未整理」ボードに置く区画 */
const TRIAGE_KEYS = new Set(["状態:未整理", "状態:未着手", "状態:いつか", "none"]);
/** はじめから「確認待ち」ボードに置く区画（ほかは「着手済み」） */
const REVIEW_KEYS = new Set(["状態:チェック待ち", "状態:動作確認", "状態:完了承認待ち"]);

/** ボードの枚数（タブ）。保存した設定に書いておく */
export const BOARD_COUNT = 3;

/** 区画を置くボード（設定がなければ、状態の名前から） */
export function genreOf(col: BoardColumn): BoardGenre {
  return col.genre ?? (TRIAGE_KEYS.has(col.key) ? "triage" : REVIEW_KEYS.has(col.key) ? "review" : "doing");
}

/**
 * ボードの区画（設定がなければ、はじめの区画）。2 枚のとき（1.0 より前）に保存した設定では、
 * 確認の区画（チェック待ち・動作確認・完了承認待ち）は「着手済み」に置くしかなかったので、「確認待ち」に置き直して読む
 */
export function boardColumns(config: BoardConfig | null): BoardColumn[] {
  const columns = config?.columns || DEFAULT_COLUMNS;
  if (!config || (config.boards ?? 2) >= BOARD_COUNT) return columns;
  return columns.map((c) => (c.genre === "doing" && REVIEW_KEYS.has(c.key) ? { ...c, genre: "review" } : c));
}

/** ボードのジャンル（タブ）。区画をどれに置くかの選び方にも使う */
export const BOARD_GENRES: { key: BoardGenre; label: string; icon: string; about: string }[] = [
  { key: "triage", label: tr("未整理"), icon: "📥", about: tr("整理して、やることを決める") },
  { key: "doing", label: tr("着手済み"), icon: "🔥", about: tr("やっていることを追う") },
  { key: "review", label: tr("確認待ち"), icon: "🔍", about: tr("確かめて終わらせる") },
];
