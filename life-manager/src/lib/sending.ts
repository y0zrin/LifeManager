import { useSyncExternalStore } from "react";
import { invoke, type InvokeArgs } from "@tauri-apps/api/core";
import type { GitHubComment } from "./types";

// --- GitHub へ送っているあいだの数（上のバーの「送っています N」） ---

let count = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribeCount(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** 送るもの（Issue を作る・直す・コメントなど）を数えながら待つ */
export function trackSending<T>(p: Promise<T>): Promise<T> {
  count++;
  emit();
  return p.finally(() => {
    count--;
    emit();
  });
}

/** GitHub へ書き込むコマンド（数えながら） */
export function invokeWrite<T>(cmd: string, args?: InvokeArgs): Promise<T> {
  return trackSending(invoke<T>(cmd, args));
}

/** 今、送っている数 */
export function useSendingCount(): number {
  return useSyncExternalStore(subscribeCount, () => count);
}

// --- 手元のコメント（送っている・送れなかった）。Issue の詳細を閉じても残り、開き直すとまた出る。キーは「owner/repo#番号」 ---

const localComments = new Map<string, GitHubComment[]>();
const commentListeners = new Set<() => void>();
const NONE: GitHubComment[] = [];

function emitComments() {
  for (const l of commentListeners) l();
}

function subscribeComments(l: () => void) {
  commentListeners.add(l);
  return () => {
    commentListeners.delete(l);
  };
}

/** 手元のコメントを置く（同じ id なら入れ替える） */
export function putLocalComment(key: string, c: GitHubComment) {
  const list = localComments.get(key) ?? NONE;
  localComments.set(key, [...list.filter((x) => x.id !== c.id), c]);
  emitComments();
}

/** 手元のコメントを外す（送れた・書く欄に戻した） */
export function dropLocalComment(key: string, id: number) {
  const list = localComments.get(key);
  if (!list) return;
  const next = list.filter((x) => x.id !== id);
  if (next.length > 0) localComments.set(key, next);
  else localComments.delete(key);
  emitComments();
}

/** この Issue の手元のコメント */
export function useLocalComments(key: string): GitHubComment[] {
  return useSyncExternalStore(subscribeComments, () => localComments.get(key) ?? NONE);
}
