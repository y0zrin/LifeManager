/**
 * 窓が前面にない・最小化・隠れているあいだ（＝だれも操作していない）は、くり返し動くアニメーション（くり返しが Infinity のもの。
 * 動く背景・文鳥・金魚・風鈴・くるくる など）を止める。一度だけ動くもの（知らせが出る・お祝い）は止めない（ほかの画面に並べて見ていても、途中で止まらないように）。
 * 前面にないか（blur）は、入力の場所が窓の中の iframe（PDF など）へ移ったときも起きるので、一呼吸おいて document.hasFocus() で確かめる。
 * html に is-idle を付ける。ほかの動き（文鳥が止まり木を移る・3D の見本を描く）は isIdle() を見て止まる
 */
const IDLE_CLASS = "is-idle";
/** 止まっているあいだに新しく始まったくり返しを、止め直す間隔 */
const RESCAN_MS = 3000;

let idle = false;
let rescan = 0;
/** こちらで止めたアニメーション（戻ったときに、これだけ動かし直す） */
const paused = new Set<Animation>();
const listeners = new Set<(idle: boolean) => void>();

function pauseLoops() {
  for (const a of document.getAnimations()) {
    if (a.playState !== "running") continue;
    if (a.effect?.getComputedTiming().iterations !== Infinity) continue;
    a.pause();
    paused.add(a);
  }
}

function resumeLoops() {
  for (const a of paused) {
    // 止めているあいだに CSS から外れた（消えた・背景の動きを止めた）ものは動かさない
    if (a.playState !== "paused") continue;
    try {
      a.play();
    } catch {
      // 要素が消えていれば何もしない
    }
  }
  paused.clear();
}

function apply(next: boolean) {
  if (next === idle) return;
  idle = next;
  document.documentElement.classList.toggle(IDLE_CLASS, idle);
  if (idle) {
    pauseLoops();
    rescan = window.setInterval(pauseLoops, RESCAN_MS);
  } else {
    window.clearInterval(rescan);
    resumeLoops();
  }
  listeners.forEach((f) => f(idle));
}

function check() {
  apply(document.hidden || !document.hasFocus());
}

/** 見張りを始める（メインの窓だけ。おしらせの窓は、いつも前面にないので使わない） */
export function startIdleWatch() {
  window.addEventListener("focus", check);
  window.addEventListener("blur", () => window.setTimeout(check, 120));
  document.addEventListener("visibilitychange", check);
  check();
}

/** だれも操作していない（前面にない・最小化・隠れている）か */
export const isIdle = () => idle;

/** 操作しているか・していないかが変わったら知らせる（やめるときは返り値を呼ぶ） */
export function onIdleChange(f: (idle: boolean) => void): () => void {
  listeners.add(f);
  return () => {
    listeners.delete(f);
  };
}
