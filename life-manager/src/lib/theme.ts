/** アプリのテーマ。ボードと、ボードの下の机もテーマのものになる（黒板 = 勉強机、ホワイトボード = オフィスのデスク、クエスト = ギルドの受付） */
export type Theme = "chalk" | "white" | "quest";

export const THEMES: { key: Theme; label: string; about: string }[] = [
  { key: "chalk", label: "黒板", about: "暗い色。ボードは黒板、机は勉強机。はじめはこれ" },
  { key: "white", label: "ホワイトボード", about: "明るい色。ボードはホワイトボード、机はオフィスのデスク" },
  { key: "quest", label: "クエスト", about: "木と羊皮紙の色。ボードはクエストボード（見積もりは報酬と難しさの星、自分の担当は「受注」の判）、机はギルドの受付" },
];

export function isTheme(v: unknown): v is Theme {
  return THEMES.some((t) => t.key === v);
}

/** 画面全体に当てる（App.css の :root[data-theme]。黒板は :root のまま） */
export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
}
