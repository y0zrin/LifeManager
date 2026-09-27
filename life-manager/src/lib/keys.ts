import type { KeyboardEvent as ReactKeyboardEvent } from "react";

type AnyKeyboardEvent = KeyboardEvent | ReactKeyboardEvent;

/**
 * 日本語などを変換しているあいだのキーか（変換を確定する Enter、取り消す Esc も含む）。
 * このあいだのキーでは、送る・閉じる・取り消すをしない（書きかけのまま送られたり、書いたものが消えたりするため）
 */
export function isComposing(e: AnyKeyboardEvent): boolean {
  const native = "nativeEvent" in e ? e.nativeEvent : e;
  // keyCode 229 は「変換中のキー」を表す（isComposing が付かないことがあるため、あわせて見る）
  return native.isComposing || native.keyCode === 229;
}

/** 変換の確定ではない Enter */
export function isEnter(e: AnyKeyboardEvent): boolean {
  return e.key === "Enter" && !isComposing(e);
}

/** 変換の取り消しではない Esc */
export function isEscape(e: AnyKeyboardEvent): boolean {
  return e.key === "Escape" && !isComposing(e);
}
