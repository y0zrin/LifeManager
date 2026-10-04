import { tr } from "./i18n";
/** スマホ版で動いているか。スマホ版は閲覧と作業管理だけで、git の操作はしない */
export const isMobile = /Android|iPhone|iPad/i.test(navigator.userAgent);

/** キーボードの案内（「Ctrl+Enter で送信」など）。スマホではキーボードがないので出さない */
export function keyHint(text: string): string {
  return isMobile ? "" : text;
}

/** この端末の呼び名（「この PC で使う期限」「このスマホで使う期限」など） */
export const THIS_DEVICE = isMobile ? tr("このスマホ") : tr("この PC");
