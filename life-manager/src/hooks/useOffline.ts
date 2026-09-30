import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ConflictChoice, OfflineStatus, SyncResult } from "../lib/types";

// 送信待ちがあるあいだ・つながらないあいだに、もう一度送ってみる間隔
const RETRY_MS = 30_000;
// 送っている途中は知らせが続けて届くので、表示の更新はまとめる
const RELOAD_DELAY_MS = 300;

const EMPTY: OfflineStatus = { offline: false, pending: [], conflicts: [] };

interface Handlers {
  /** 送信待ちが変わった（手元の写しで表示を直す） */
  onChanged: () => void;
  /** 送れた・つながりなおした（GitHub から読み直す） */
  onSynced: () => void;
  /** 仮の番号の Issue が GitHub に作られた */
  onCreated: (temp: number, real: number) => void;
}

/**
 * オフラインのあいだの変更（送信待ち）の様子と、送る・ぶつかったものを片付ける操作。
 * つながらないあいだの変更はバックエンドが送信待ちに並べる。ここでは、つながったら送るきっかけを作る
 * （起動したとき・つながりなおしたとき・送信待ちがあるあいだは一定の間隔で・「今すぐ送る」）
 */
export function useOffline(owner: string, repo: string, connected: boolean, handlers: Handlers) {
  const [status, setStatus] = useState<OfflineStatus>(EMPTY);
  const [syncing, setSyncing] = useState(false);
  // 送るのを止めた理由（トークンが無効など）
  const [stopped, setStopped] = useState<string | null>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const statusRef = useRef(status);
  statusRef.current = status;
  const syncingRef = useRef(false);
  const ready = connected && !!owner && !!repo;

  const refresh = useCallback(async () => {
    if (!owner || !repo) {
      setStatus(EMPTY);
      return;
    }
    try {
      setStatus(await invoke<OfflineStatus>("offline_status", { owner, repo }));
    } catch (e) {
      console.error("送信待ちの様子を読めませんでした:", e);
    }
  }, [owner, repo]);

  const sync = useCallback(async () => {
    if (!ready || syncingRef.current) return;
    syncingRef.current = true;
    setSyncing(true);
    const wasOffline = statusRef.current.offline;
    try {
      const result = await invoke<SyncResult>("sync_outbox", { owner, repo });
      setStopped(result.stopped);
      if (result.sent > 0 || (wasOffline && !result.offline)) handlersRef.current.onSynced();
    } catch (e) {
      setStopped(String(e));
    } finally {
      syncingRef.current = false;
      setSyncing(false);
      await refresh();
    }
  }, [ready, owner, repo, refresh]);

  /** ぶつかったものを片付ける（GitHub の内容を残す / 自分の変更で上書き / 直した内容を送る） */
  const resolve = useCallback(
    async (id: number, choice: ConflictChoice, value?: string) => {
      await invoke("resolve_conflict", { owner, repo, id, choice, value: value ?? null });
      await refresh();
    },
    [owner, repo, refresh],
  );

  // リポジトリを開いたら、前に送れなかった変更があれば送る
  useEffect(() => {
    setStopped(null);
    refresh().then(() => {
      if (statusRef.current.pending.length > 0) sync();
    });
  }, [refresh, sync]);

  // バックエンドからの知らせ
  useEffect(() => {
    if (!owner || !repo) return;
    let timer: number | undefined;
    const unlisten = [
      listen<{ owner: string; repo: string; created?: { temp: number; real: number } }>("offline-changed", (e) => {
        if (e.payload.owner !== owner || e.payload.repo !== repo) return;
        if (e.payload.created) handlersRef.current.onCreated(e.payload.created.temp, e.payload.created.real);
        window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          refresh();
          handlersRef.current.onChanged();
        }, RELOAD_DELAY_MS);
      }),
      listen<{ offline: boolean }>("network-changed", (e) => {
        setStatus((s) => ({ ...s, offline: e.payload.offline }));
        // つながりなおしたら、送信待ちを送る
        if (!e.payload.offline && statusRef.current.pending.length > 0) sync();
      }),
    ];
    return () => {
      window.clearTimeout(timer);
      unlisten.forEach((p) => p.then((f) => f()).catch(() => {}));
    };
  }, [owner, repo, refresh, sync]);

  // OS がネットワークにつながったと知らせてきたら、送ってみる
  useEffect(() => {
    const onOnline = () => sync();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [sync]);

  // 送信待ちがあるあいだ・つながらないあいだは、一定の間隔で送ってみる（つながったかも確かめる）
  const waiting = status.pending.length > 0 || status.offline;
  useEffect(() => {
    if (!ready || !waiting) return;
    const id = window.setInterval(sync, RETRY_MS);
    return () => window.clearInterval(id);
  }, [ready, waiting, sync]);

  return { status, syncing, stopped, sync, resolve };
}
