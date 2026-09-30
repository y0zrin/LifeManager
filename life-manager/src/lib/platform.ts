/** スマホ版で動いているか。スマホ版は閲覧と作業管理だけで、git の操作はしない */
export const isMobile = /Android|iPhone|iPad/i.test(navigator.userAgent);
