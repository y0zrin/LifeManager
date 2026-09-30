import { useRef, useState } from "react";
import { celebrateDone } from "../../lib/celebrate";
import type { CloseReason, GitHubIssue } from "../../lib/types";
import { issueRef } from "../../lib/issueRef";
import { useDismiss } from "../../hooks/useDismiss";
import { findIssues } from "../../lib/issueSearch";

interface CloseMenuProps {
  issue: GitHubIssue;
  /** 「重複として閉じる」で、元の Issue を探す候補 */
  allIssues: GitHubIssue[];
  onClose: (reason: CloseReason, duplicateOf?: GitHubIssue) => Promise<void>;
}

/** 詳細の「クローズ ▾」。GitHub と同じく、完了として／予定なしとして／重複として（元の Issue を選ぶ）閉じる */
export function CloseMenu({ issue, allIssues, onClose }: CloseMenuProps) {
  const [open, setOpen] = useState(false);
  const [dup, setDup] = useState(false);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const reset = () => {
    setOpen(false);
    setDup(false);
    setQuery("");
  };
  useDismiss(ref, open, reset);

  // 元にできるのは、GitHub にある（id のある）ほかの Issue
  const candidates = dup ? findIssues(allIssues.filter((i) => i.number !== issue.number && !!i.id), query) : [];

  async function choose(reason: CloseReason, original?: GitHubIssue, from?: HTMLElement) {
    // 完了のお祝いは、押したところから（閉じたあとは、メニューがなくなるので先に場所を取っておく）
    const origin = from?.getBoundingClientRect();
    setBusy(true);
    try {
      await onClose(reason, original);
      if (reason === "completed") celebrateDone(`#${issue.number}`, origin);
      reset();
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="close-menu" ref={ref}>
      <button type="button" className="btn-sm" disabled={busy} onClick={() => (open ? reset() : setOpen(true))}>
        クローズ ▾
      </button>
      {open && (
        <div className="close-menu-pop" role="menu">
          {!dup ? (
            <>
              <button type="button" role="menuitem" disabled={busy} onClick={(e) => choose("completed", undefined, e.currentTarget)}>
                ✅ 完了として閉じる<small>やり終えた（いつもの閉じ方）</small>
              </button>
              <button type="button" role="menuitem" disabled={busy} onClick={() => choose("not_planned")}>
                ⊘ 予定なしとして閉じる<small>やらないことにした</small>
              </button>
              <button type="button" role="menuitem" disabled={busy} onClick={() => setDup(true)}>
                🔁 重複として閉じる…<small>同じ内容の Issue がある（元を選ぶ）</small>
              </button>
            </>
          ) : (
            <div className="close-menu-dup">
              <div className="close-menu-title">元の Issue を選ぶ（こちらを閉じて、元の Issue に「重複」と印が付きます）</div>
              <input
                className="input-full"
                autoFocus
                value={query}
                disabled={busy}
                placeholder="番号かタイトルで探す（例：#12）"
                onChange={(e) => setQuery(e.target.value)}
              />
              {candidates.map((c) => (
                <button key={c.number} type="button" className="suggestion-item" disabled={busy} onClick={() => choose("duplicate", c)}>
                  <span className={`suggestion-state suggestion-state--${c.state}`}>{c.state === "open" ? "●" : "○"}</span>
                  <span className="suggestion-number">{issueRef(c.number)}</span>
                  <span className="suggestion-title">{c.title}</span>
                </button>
              ))}
              <button type="button" className="link-button" disabled={busy} onClick={() => setDup(false)}>
                ← 戻る
              </button>
            </div>
          )}
        </div>
      )}
    </span>
  );
}

/** 閉じた理由の言い方 */
export function closeReasonText(reason: string | null | undefined): string {
  if (reason === "not_planned") return "予定なし";
  if (reason === "duplicate") return "重複";
  return "完了";
}
