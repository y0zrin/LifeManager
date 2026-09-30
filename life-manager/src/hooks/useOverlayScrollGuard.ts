import { useEffect } from "react";

/** その向きに、まだ動ける（スクロールできる）箱か */
function canScroll(el: Element, dx: number, dy: number): boolean {
  const style = getComputedStyle(el);
  if (dy !== 0 && /(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 1) {
    if (dy < 0 ? el.scrollTop > 0 : el.scrollTop + el.clientHeight < el.scrollHeight - 1) return true;
  }
  if (dx !== 0 && /(auto|scroll)/.test(style.overflowX) && el.scrollWidth > el.clientWidth + 1) {
    if (dx < 0 ? el.scrollLeft > 0 : el.scrollLeft + el.clientWidth < el.scrollWidth - 1) return true;
  }
  return false;
}

/**
 * 重ねて出す欄（Issue の詳細・ダイアログ。.palette-overlay）の上でホイールを回しても、後ろの画面は動かさない。
 * 欄の中に、その向きにまだ動ける箱があれば、そこだけが動く（端まで行っても、後ろへは伝えない）
 */
export function useOverlayScrollGuard() {
  useEffect(() => {
    function onWheel(e: WheelEvent) {
      if (e.ctrlKey) return; // 拡大・縮小はそのまま
      const target = e.target instanceof Element ? e.target : null;
      const overlay = target?.closest(".palette-overlay");
      if (!target || !overlay) return;
      // Shift＋ホイールは横に動かす
      const sideways = e.shiftKey && e.deltaX === 0;
      const dx = sideways ? e.deltaY : e.deltaX;
      const dy = sideways ? 0 : e.deltaY;
      for (let el: Element | null = target; el; el = el.parentElement) {
        if (canScroll(el, dx, dy)) return;
        if (el === overlay) break;
      }
      e.preventDefault();
    }
    document.addEventListener("wheel", onWheel, { passive: false, capture: true });
    return () => document.removeEventListener("wheel", onWheel, { capture: true });
  }, []);
}
