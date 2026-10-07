import { useLayoutEffect, type RefObject } from "react";
import { clearPop, revealList } from "../lib/popReveal";

/**
 * 一覧の画面（ブランチの履歴・ヒストリー）を開いたとき、box の中の selector のうち見えているものを、
 * 下（古いもの）から上へぽこぽこ出す（#293。動きは App.css の pop-in）。
 * when が true になったときに 1 回。skip が true のとき（全体図からコミットへ寄るときなど）は出さない。
 * 描く前に印を付けるので、いったん全部が出てから消えることはない
 */
export function usePopReveal(box: RefObject<HTMLElement | null>, selector: string, when: boolean, skip = false) {
  useLayoutEffect(() => {
    const el = box.current;
    if (!when || skip || !el) return;
    const items = [...el.querySelectorAll<HTMLElement>(selector)];
    const total = revealList(el, items);
    if (!total) return;
    const timer = window.setTimeout(() => clearPop(items), total + 200);
    return () => {
      window.clearTimeout(timer);
      clearPop(items);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [when]);
}
