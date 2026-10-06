import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "../../lib/invoke";
import { emitTo, listen } from "@tauri-apps/api/event";
import { loadDisplaySettings } from "../../hooks/useDisplaySettings";
import { applyTheme } from "../../lib/theme";
import { newNoticeId, type Notice } from "../../lib/notices";
import { NoticeToasts } from "./NoticeToasts";
import { tr } from "../../lib/i18n";

/** 一度に出す知らせの数（ほかは「ほか N 件」） */
const MAX_SHOWN = 3;
/** インジケーターに残ったことを、はじめの 1 回だけ知らせた印 */
const TRAY_HINT_KEY = "tray-hint-shown";

/**
 * おしらせの窓（アプリの窓の外。枠なし・透明・いつも手前）。メインの窓から届いた知らせを重ねて出し、
 * 中身の高さに合わせて窓を伸び縮みさせる（知らせがなければ隠れる）。「開く」でメインの窓を前に出して、その Issue などを開く
 */
export function NoticeApp() {
  const [notices, setNotices] = useState<Notice[]>([]);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const corner = useRef(loadDisplaySettings().noticeCorner);

  // 透明な窓（背景を塗らない）。テーマは、メインの窓と同じ設定から
  useLayoutEffect(() => {
    document.documentElement.classList.add("notice-window");
    applyTheme(loadDisplaySettings().theme);
    const onStorage = () => {
      const s = loadDisplaySettings();
      applyTheme(s.theme);
      corner.current = s.noticeCorner;
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    const offs: Promise<() => void>[] = [
      listen<Notice>("lm-notice", (e) => {
        corner.current = loadDisplaySettings().noticeCorner;
        setNotices((list) => [e.payload, ...list.filter((n) => n.key !== e.payload.key)]);
      }),
      // × でインジケーターに残ったとき（はじめの 1 回だけ）
      listen("lm-to-tray", () => {
        try {
          if (localStorage.getItem(TRAY_HINT_KEY)) return;
          localStorage.setItem(TRAY_HINT_KEY, "1");
        } catch {
          // 覚えられなければ、毎回出る
        }
        setNotices((list) => [
          {
            id: newNoticeId(),
            key: "tray-hint",
            kind: "summary",
            icon: "📌",
            tone: "",
            title: tr("Life Manager はインジケーター（画面の右下）に残っています"),
            body: tr("知らせはここに出します。終えるときはインジケーターのアイコンを右クリック →「終了する」。× で終えたいときは設定 → 通知 で変えられます"),
            at: new Date().toISOString(),
            repo: "",
          },
          ...list,
        ]);
      }),
    ];
    return () => {
      offs.forEach((p) => p.then((off) => off()).catch(() => {}));
    };
  }, []);

  // 中身の高さに合わせて、窓を伸び縮みさせる（0 なら隠す）
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const fit = () => void invoke("notice_fit", { height: notices.length ? Math.ceil(el.scrollHeight) + 2 : 0, corner: corner.current }).catch(() => {});
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [notices]);

  const close = useCallback((id: string) => setNotices((list) => list.filter((n) => n.id !== id)), []);
  const open = useCallback(
    (n: Notice) => {
      close(n.id);
      if (n.target) void emitTo("main", "lm-notice-open", n).catch(() => {});
      void invoke("focus_main").catch(() => {});
    },
    [close],
  );
  const openHistory = useCallback(() => {
    void emitTo("main", "lm-notice-history", null).catch(() => {});
    void invoke("focus_main").catch(() => {});
    setNotices([]);
  }, []);

  return (
    <div ref={boxRef} className={`nt-window c-${corner.current}`}>
      <NoticeToasts notices={notices.slice(0, MAX_SHOWN)} more={Math.max(0, notices.length - MAX_SHOWN)} onOpen={open} onClose={close} onOpenHistory={openHistory} />
    </div>
  );
}
