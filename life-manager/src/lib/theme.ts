/**
 * アプリのテーマ。ボードと、ボードの下の机もテーマのものになる（黒板 = 勉強机、ホワイトボード = オフィスのデスク、クエスト = ギルドの受付、
 * ナイト = 夜の机、デイタイム = カフェのテーブル、スプリング = 春の机、ウィンター = こたつ）
 */
export type Theme = "chalk" | "white" | "quest" | "night" | "day" | "spring" | "winter" | "kingyo";

export const THEMES: { key: Theme; label: string; about: string }[] = [
  { key: "chalk", label: "黒板", about: "暗い色。ボードは黒板、机は勉強机。はじめはこれ" },
  { key: "white", label: "ホワイトボード", about: "明るい色。ボードはホワイトボード、机はオフィスのデスク" },
  { key: "quest", label: "クエスト", about: "木と羊皮紙の色。ボードはクエストボード（見積もりは報酬と難しさの星、自分の担当は「受注」の判）、机はギルドの受付。マイルストーンはボス" },
  { key: "night", label: "ナイト", about: "夜空と月あかりの暗い色。ボードは夜空の掲示板（星と三日月）、机はランプの灯る夜の机" },
  { key: "day", label: "デイタイム", about: "日の当たる部屋の明るい色。ボードは日ざしの入るコルクボード（画びょう）、机はカフェのテーブル" },
  { key: "spring", label: "スプリング", about: "桜と若葉の明るい色。ボードは桜の掲示板（花びら・和紙のテープ）、机は春の机" },
  { key: "winter", label: "ウィンター", about: "雪の青と白。ボードは雪の窓の掲示板（すりガラスに雪の結晶）、机はこたつ" },
  { key: "kingyo", label: "金魚", about: "白と赤の夏まつり。ボードは金魚の泳ぐ水そう、机は風鈴のゆれる縁側。タスクを終えると「すくえた！」" },
];

export function isTheme(v: unknown): v is Theme {
  return THEMES.some((t) => t.key === v);
}

/** 画面全体に当てる（App.css の :root[data-theme]。黒板は :root のまま） */
export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
}

/** 背景（テーマの粒）を動かすか。止めるときは html に stage-still（粒は残して、動きだけ止める） */
export function applyStageMotion(on: boolean) {
  document.documentElement.classList.toggle("stage-still", !on);
}
