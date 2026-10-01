/** スマホ版で動いているか。スマホ版は閲覧と作業管理だけで、git の操作はしない */
export const isMobile = /Android|iPhone|iPad/i.test(navigator.userAgent);

/** この端末の呼び名（「この PC で使う期限」「このスマホで使う期限」など） */
export const THIS_DEVICE = isMobile ? "このスマホ" : "この PC";
