// 仲間の変更の読み直し（#269）を、いっとき止める印。ボードで付箋をドラッグしているあいだなど
let paused = false;

export function pauseRemoteRefresh(on: boolean) {
  paused = on;
}

export function isRemoteRefreshPaused(): boolean {
  return paused;
}
