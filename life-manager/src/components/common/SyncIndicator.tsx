import { useCallback, useRef, useState } from "react";
import { useDismiss } from "../../hooks/useDismiss";
import { issueRef } from "../../lib/issueRef";
import type { OfflineStatus } from "../../lib/types";

interface SyncIndicatorProps {
  status: OfflineStatus;
  syncing: boolean;
  /** 送るのを止めた理由（トークンが無効など） */
  stopped: string | null;
  onSync: () => void;
  onOpenConflicts: () => void;
}

/**
 * GitHub に送っていない変更の様子（上のバー）。オフライン・送信待ち・確認が必要なものがあるときだけ出す。
 * 押すと、送信待ちの一覧と「今すぐ送る」を出す
 */
export function SyncIndicator({ status, syncing, stopped, onSync, onOpenConflicts }: SyncIndicatorProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);

  const pending = status.pending.length;
  const conflicts = status.conflicts.length;
  if (!status.offline && pending === 0 && conflicts === 0) return null;

  const tone = conflicts > 0 ? "warn" : status.offline ? "offline" : "pending";
  const label = [
    status.offline ? "オフライン" : null,
    pending > 0 ? `未送信 ${pending}` : null,
    conflicts > 0 ? `確認 ${conflicts}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const heading = status.offline
    ? "GitHub につながっていません"
    : pending > 0
      ? "GitHub に送る変更があります"
      : "確かめてほしい変更があります";

  return (
    <div className="sync-indicator" ref={ref}>
      <button
        type="button"
        className={`sync-chip sync-chip--${tone}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title="GitHub に送っていない変更"
      >
        <span className={`sync-dot${syncing ? " sync-dot--busy" : ""}`} aria-hidden="true" />
        {label}
      </button>
      {open && (
        <div className="sync-panel popover" role="dialog" aria-label="GitHub に送っていない変更">
          <strong className="sync-panel-title">{heading}</strong>
          {stopped && <p className="sync-panel-error">送れませんでした: {stopped}</p>}
          {pending > 0 && (
            <ol className="sync-list">
              {status.pending.map((p, i) => (
                <li key={i}>
                  <span className="sync-list-num">{p.kind === "issue" ? issueRef(p.number) : p.kind === "config" ? "設定" : "日誌"}</span>
                  <span className="sync-list-title">{p.title || "（タイトルなし）"}</span>
                  <span className="sync-list-action">{p.action}</span>
                </li>
              ))}
            </ol>
          )}
          <div className="sync-panel-actions">
            {conflicts > 0 && (
              <button type="button" className="btn-sm" onClick={() => { close(); onOpenConflicts(); }}>
                確認が必要な変更（{conflicts}）
              </button>
            )}
            {(pending > 0 || status.offline) && (
              <button type="button" className="btn-primary" disabled={syncing} onClick={onSync}>
                {syncing ? "送っています…" : pending > 0 ? "今すぐ送る" : "つながったか確かめる"}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
