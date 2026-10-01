/**
 * くり返し動くアニメーション（くり返しが Infinity のもの。動く背景・文鳥・金魚・風鈴・くるくる など）を、1 つの時計で 1 秒に 20 回まとめて進める。
 * ブラウザに任せると、なめらかに動くものが 1 つでもあるあいだ、画面の更新ごと（144Hz なら 1 秒に 144 回）全体を描き直して重い。
 * まとめて進めれば描き直しは 1 秒に 20 回まで（動きの具合〔イージング〕はそのまま）。一度だけ動くもの（知らせが出る・お祝い）は、ブラウザのままなめらかに。
 *
 * 窓が前面にない・最小化・隠れているあいだ（＝だれも操作していない）は、時計を止める（くり返しのアニメーションは止まったまま）。
 * 前面にないか（blur）は、入力の場所が窓の中の iframe（PDF など）へ移ったときも起きるので、一呼吸おいて document.hasFocus() で確かめる。
 * html に is-idle を付ける。ほかの動き（文鳥が止まり木を移る・3D の見本を描く）は isIdle() を見て止まる
 */
const IDLE_CLASS = "is-idle";
/** 1 秒に進める回数 */
const FPS = 20;
/** 新しく始まったくり返しを見つけて、時計に入れる間隔 */
const ADOPT_MS = 1000;

let idle = false;
let started = false;
let tick = 0;
let adopt = 0;
let last = 0;
/** 時計で進めているアニメーション（止めて、currentTime を進める） */
const driven = new Set<Animation>();
const listeners = new Set<(idle: boolean) => void>();

/** 時計に入れないもの: テーマのミニ画面（.tm）。CSS で「選んでいる・マウスを乗せたカードだけ動く」にしていて、時計で進めるとそれが効かなくなる */
const NATIVE = ".tm";

/** 動いているくり返しを止めて、時計に入れる */
function adoptLoops() {
  for (const a of document.getAnimations()) {
    if (driven.has(a) || a.playState !== "running") continue;
    if (a.effect?.getComputedTiming().iterations !== Infinity) continue;
    const target = (a.effect as KeyframeEffect | null)?.target;
    if (target instanceof Element && target.closest(NATIVE)) continue;
    a.pause();
    driven.add(a);
  }
}

/** 時計を 1 つ進める（前に進めてからの時間だけ） */
function step() {
  const now = performance.now();
  const dt = now - last;
  last = now;
  for (const a of driven) {
    // CSS から外れた（要素が消えた・背景の動きを止めた）ものは、時計から出す
    if (a.playState !== "paused") {
      driven.delete(a);
      continue;
    }
    a.currentTime = Number(a.currentTime ?? 0) + dt;
  }
}

function startClock() {
  last = performance.now();
  adoptLoops();
  tick = window.setInterval(step, 1000 / FPS);
  adopt = window.setInterval(adoptLoops, ADOPT_MS);
}

function stopClock() {
  window.clearInterval(tick);
  window.clearInterval(adopt);
  // 止まっているあいだに始まったくり返しも止めておく
  adoptLoops();
}

function apply(next: boolean) {
  if (started && next === idle) return;
  started = true;
  idle = next;
  document.documentElement.classList.toggle(IDLE_CLASS, idle);
  if (idle) stopClock();
  else startClock();
  listeners.forEach((f) => f(idle));
}

function check() {
  apply(document.hidden || !document.hasFocus());
}

/** 時計と見張りを始める（メインの窓だけ。おしらせの窓は、いつも前面にないので使わない） */
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
