// おしらせ（アプリの中の通知）: 「あなたがすること」に新しく出てきたものと、マイルストーンの達成を知らせ、りれきに残す。
// PC では、アプリの窓の外の「おしらせの窓」（選んだ角）に出す。出さない設定のときは、アプリの中の右上に出す
import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { Todo } from "../lib/activity";
import { MILESTONE_CLEAR_EVENT, type MilestoneClearDetail } from "../lib/celebrate";
import { isMobile } from "../lib/platform";
import {
  loadNotices,
  milestoneNotice,
  newNoticeId,
  noticeFromTodo,
  noticeStoreKey,
  planNotices,
  readNoticeStore,
  saveNotice,
  setNoticeUser,
  sendToNoticeWindow,
  summaryNotice,
  type Notice,
  type NoticeCorner,
} from "../lib/notices";

/** 知らせたものの鍵（この PC に。ログインとリポジトリごと） */
const NOTIFIED_KEEP = 500;
/** 読み込みが落ち着くのを待つ（プルリクの承認・チェックは、ヒストリーのあとから届く） */
const SETTLE_MS = 3000;

function loadNotified(repo: string): string[] {
  return readNoticeStore("notified", repo).filter((k): k is string => typeof k === "string");
}

function saveNotified(repo: string, keys: string[]) {
  try {
    localStorage.setItem(noticeStoreKey("notified", repo), JSON.stringify(keys.slice(-NOTIFIED_KEEP)));
  } catch {
    // 覚えられなければ、次に開いたときにまとめて知らせる
  }
}

export function useNotices(o: {
  /** owner/repo */
  repo: string;
  /** ログインしている人（りれき・知らせ済みを、人ごとに覚える） */
  me: string;
  /** 「あなたがすること」（ぜんぶ。まだ読めていなければ null） */
  todos: Todo[] | null;
  /** ヒストリーの「あなたがすること」に出ている数（見たものを除く。サイドバーの数と同じ。起動のときのまとめに出す） */
  shown: number;
  /** プルリクと、自分のプルリクの承認・修正の依頼まで読めたか（読めたときだけ、消えたレビュー・修正の依頼・承認の覚えを外す） */
  pullsSettled: boolean;
  enabled: boolean;
  corner: NoticeCorner;
  /** 知らせの「開く」（その Issue・プルリク・Actions・画面へ） */
  onOpen: (n: Notice) => void;
  /** おしらせの窓の「ほか N 件」（りれきを開く） */
  onOpenHistory: () => void;
}) {
  const { repo, todos, enabled, me, pullsSettled } = o;
  const shown = useRef(o.shown);
  shown.current = o.shown;
  // 覚える鍵に使う人（読み書きの前に決めておく）
  setNoticeUser(me);
  const [history, setHistory] = useState<Notice[]>(() => loadNotices(repo));
  // 新しい知らせが来たときだけ、🔔 に小さな点（未読の数は出さない）
  const [dot, setDot] = useState(false);
  // アプリの中に出している知らせ（おしらせの窓を出さない設定のとき）
  const [toasts, setToasts] = useState<Notice[]>([]);
  const corner = useRef(o.corner);
  corner.current = o.corner;
  const onOpen = useRef(o.onOpen);
  onOpen.current = o.onOpen;
  const onOpenHistory = useRef(o.onOpenHistory);
  onOpenHistory.current = o.onOpenHistory;
  // この起動で、そのリポジトリのはじめの知らせをしたか（はじめは、たまっていたものを 1 つにまとめる）
  const started = useRef(new Set<string>());

  useEffect(() => {
    setHistory(loadNotices(repo));
    setToasts([]);
    setDot(false);
  }, [repo, me]);

  /** 知らせる（りれきに残し、窓かアプリの中に出す）。popup = false なら、りれきと 🔔 の点だけ */
  const deliver = useCallback(async (n: Notice, popup = true) => {
    setHistory(saveNotice(n.repo, n));
    setDot(true);
    if (!popup) return;
    if (!isMobile && corner.current !== "off" && (await sendToNoticeWindow(n))) return;
    setToasts((list) => [n, ...list.filter((t) => t.key !== n.key)]);
  }, []);

  // 「あなたがすること」に新しく出てきたもの（落ち着くのを待ってから）
  useEffect(() => {
    if (!enabled || !todos || !repo || !me) return;
    const t = window.setTimeout(() => {
      const { fresh, store } = planNotices(todos, loadNotified(repo), pullsSettled);
      const first = !started.current.has(`${me}@${repo}`);
      started.current.add(`${me}@${repo}`);
      if (store) saveNotified(repo, store);
      if (fresh.length === 0) return;
      // 大事なもの（並びの上）が、いちばん上に来るよう、下から知らせる
      const helps = fresh.filter((todo) => todo.key.startsWith("help:"));
      const rest = fresh.filter((todo) => !todo.key.startsWith("help:"));
      if (first && rest.length > 1) {
        void deliver(summaryNotice(shown.current, fresh.length, repo));
      } else {
        for (const todo of [...rest].reverse()) void deliver(noticeFromTodo(todo, repo));
      }
      // 🆘 は、まとめずに 1 つずつ（いちばん上に）
      for (const todo of [...helps].reverse()) void deliver(noticeFromTodo(todo, repo));
    }, SETTLE_MS);
    return () => window.clearTimeout(t);
  }, [todos, enabled, repo, me, pullsSettled, deliver]);

  // マイルストーンの達成（アプリの中では大きく祝うので、窓を隠している・ほかの窓を使っているときだけ出す）
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<MilestoneClearDetail>).detail;
      if (!d || d.repoKey !== repo) return;
      void deliver(milestoneNotice(d, repo), document.hidden || !document.hasFocus());
    };
    window.addEventListener(MILESTONE_CLEAR_EVENT, on);
    return () => window.removeEventListener(MILESTONE_CLEAR_EVENT, on);
  }, [repo, deliver]);

  // おしらせの窓の「開く」「ほか N 件」
  useEffect(() => {
    if (isMobile) return;
    const offs = [
      listen<Notice>("lm-notice-open", (e) => onOpen.current(e.payload)),
      listen("lm-notice-history", () => onOpenHistory.current()),
    ];
    return () => {
      offs.forEach((p) => p.then((off) => off()).catch(() => {}));
    };
  }, []);

  const closeToast = useCallback((id: string) => setToasts((list) => list.filter((n) => n.id !== id)), []);
  // りれきを開いたら、アプリの中に出している知らせは片付ける（りれきに残っている）
  const clearToasts = useCallback(() => setToasts([]), []);

  /** 設定 → 通知 の「ためしに出す」（りれきには残さない） */
  const test = useCallback(async () => {
    const n: Notice = {
      id: newNoticeId(),
      key: `test:${Date.now()}`,
      kind: "summary",
      icon: "🔔",
      tone: "",
      title: "おしらせは、ここに出ます",
      body: "× か「開く」で消えます。出す角は、設定 → 通知 で変えられます",
      at: new Date().toISOString(),
      repo,
    };
    if (!isMobile && corner.current !== "off" && (await sendToNoticeWindow(n))) return;
    setToasts((list) => [n, ...list]);
  }, [repo]);

  return { history, dot, clearDot: useCallback(() => setDot(false), []), toasts, closeToast, clearToasts, test };
}
