// スマホの戻るボタン（Android）。いちばん上に開いているものから閉じる（#202）
//
// 1. 画面に重ねて出ているもの（Issue の詳細・確かめる窓・吹き出し・下から出る板・メモ）は、Esc と同じに閉じる。
//    どれも Esc で閉じる作りなので、Esc を送る
// 2. 画面の中で開いている状態（ガントの固定など）は、useBackLayer で登録したものを、あとから登録したものから閉じる
// 3. 何も開いていなければ、呼んだ側がメニューへ戻す（メニューなら「もう一度押すと終わります」）
import { useEffect, useRef } from "react";

/** 画面に重ねて出ているもの（Esc で閉じる） */
const OVERLAYS = [
  ".palette-overlay",
  "[aria-modal='true']",
  "[role='dialog']",
  ".popover",
  ".memo-fab-wrap.open",
  ".notices-drawer",
  ".context-menu",
  ".m-sheet",
].join(", ");

const layers: { id: number; close: () => void }[] = [];
let nextId = 0;

/** 戻るボタンで閉じるものを登録する。返した関数で外す */
export function pushBackLayer(close: () => void): () => void {
  const id = ++nextId;
  layers.push({ id, close });
  return () => {
    const i = layers.findIndex((l) => l.id === id);
    if (i >= 0) layers.splice(i, 1);
  };
}

/** active のあいだ、戻るボタンで close を呼ぶ（いちばん上に開いているものとして） */
export function useBackLayer(active: boolean, close: () => void) {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!active) return;
    return pushBackLayer(() => closeRef.current());
  }, [active]);
}

/** いちばん上に開いているものを閉じる。閉じるものがなければ false */
export function closeTopLayer(): boolean {
  if (document.querySelector(OVERLAYS)) {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return true;
  }
  const top = layers.pop();
  if (top) {
    top.close();
    return true;
  }
  return false;
}
