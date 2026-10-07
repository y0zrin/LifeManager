// 仲間の変更を読み直すきっかけ（#269）: 画面が見えているあいだは 1 分ごと、窓に戻ってきたとき（前に読んでから 30 秒より経っていれば）。
// ボードで付箋をドラッグしているあいだは読まない（lib/remoteRefresh）
import { useEffect, useRef } from "react";
import { isRemoteRefreshPaused } from "../lib/remoteRefresh";

const EVERY_MS = 60_000;
const AFTER_FOCUS_MS = 30_000;

interface Options {
  /** つながっていて、GitHub のプロジェクトを開いているとき */
  enabled: boolean;
  /** Issue を読み直す */
  onRefresh: () => Promise<void>;
  /** 窓に戻ってきたときだけ、ほかにも読み直すもの（ラベル・マイルストーン） */
  onFocus?: () => void;
}

export function useRemoteRefresh({ enabled, onRefresh, onFocus }: Options) {
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;
  const focusRef = useRef(onFocus);
  focusRef.current = onFocus;
  const lastAt = useRef(Date.now());
  const running = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    lastAt.current = Date.now();
    const run = async () => {
      if (running.current || isRemoteRefreshPaused()) return;
      running.current = true;
      lastAt.current = Date.now();
      try {
        await refreshRef.current();
      } catch {
        // 読めなかったときは、次のきっかけでもう一度
      } finally {
        running.current = false;
      }
    };
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void run();
    }, EVERY_MS);
    const onWindowFocus = () => {
      if (Date.now() - lastAt.current < AFTER_FOCUS_MS) return;
      focusRef.current?.();
      void run();
    };
    window.addEventListener("focus", onWindowFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onWindowFocus);
    };
  }, [enabled]);
}
