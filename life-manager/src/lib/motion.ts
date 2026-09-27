// 画面の動き（イージング付きのスクロール）。CSS の --ease-standard と同じ曲線を使う

/** cubic-bezier(x1, y1, x2, y2) の値を返す関数を作る（CSS のイージングと同じ計算） */
function cubicBezier(x1: number, y1: number, x2: number, y2: number) {
  const a = (a1: number, a2: number) => 1 - 3 * a2 + 3 * a1;
  const b = (a1: number, a2: number) => 3 * a2 - 6 * a1;
  const c = (a1: number) => 3 * a1;
  const at = (t: number, a1: number, a2: number) => ((a(a1, a2) * t + b(a1, a2)) * t + c(a1)) * t;
  const slope = (t: number, a1: number, a2: number) => 3 * a(a1, a2) * t * t + 2 * b(a1, a2) * t + c(a1);
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    // x から t をニュートン法で求める
    let t = x;
    for (let i = 0; i < 8; i++) {
      const dx = at(t, x1, x2) - x;
      const d = slope(t, x1, x2);
      if (Math.abs(dx) < 1e-5 || d === 0) break;
      t -= dx / d;
    }
    return at(Math.min(1, Math.max(0, t)), y1, y2);
  };
}

export const easeStandard = cubicBezier(0.2, 0, 0, 1);

export const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/**
 * 要素をイージング付きでスクロールする。スクロールスナップはその間だけ止める（途中で吸い付かないように）。
 * 戻り値の関数を呼ぶと止める
 */
export function easeScrollTo(el: HTMLElement, to: { left?: number; top?: number }, duration = 420): () => void {
  const fromLeft = el.scrollLeft;
  const fromTop = el.scrollTop;
  const toLeft = to.left ?? fromLeft;
  const toTop = to.top ?? fromTop;
  if (prefersReducedMotion() || duration <= 0) {
    el.scrollTo({ left: toLeft, top: toTop });
    return () => undefined;
  }
  const snap = el.style.scrollSnapType;
  el.style.scrollSnapType = "none";
  const start = performance.now();
  let frame = 0;
  let stopped = false;
  const finish = () => {
    stopped = true;
    cancelAnimationFrame(frame);
    el.style.scrollSnapType = snap;
  };
  const step = (now: number) => {
    if (stopped) return;
    const p = Math.min(1, (now - start) / duration);
    const k = easeStandard(p);
    el.scrollLeft = fromLeft + (toLeft - fromLeft) * k;
    el.scrollTop = fromTop + (toTop - fromTop) * k;
    if (p < 1) frame = requestAnimationFrame(step);
    else finish();
  };
  frame = requestAnimationFrame(step);
  return finish;
}
