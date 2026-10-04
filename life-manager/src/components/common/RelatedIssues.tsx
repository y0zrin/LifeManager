import { useState } from "react";
import type { GitHubIssue } from "../../lib/types";
import { issueRef } from "../../lib/issueRef";
import { parseRelated, relatedOf, withRelated, type RelatedLink } from "../../lib/related";
import { isEnter } from "../../lib/keys";
import { findIssues } from "../../lib/issueSearch";
import { tr, trx } from "../../lib/i18n";

interface RelatedIssuesProps {
  issue: GitHubIssue;
  allIssues: GitHubIssue[];
  /** 本文を書き換える（関連は本文の見えない印に残す） */
  onUpdateBody: (n: number, body: string) => Promise<void>;
  onOpenIssue: (n: number) => void;
}

/** 詳細の「🔗 関連」。意味の近い Issue を結ぶ（相手の Issue の詳細にも出る）。ガントの「先行」とは別 */
export function RelatedIssues({ issue, allIssues, onUpdateBody, onOpenIssue }: RelatedIssuesProps) {
  const links = relatedOf(issue, allIssues);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);

  const candidates = adding
    ? findIssues(allIssues.filter((i) => i.number !== issue.number && !links.some((l) => l.issue.number === i.number)), query)
    : [];

  async function run(work: () => Promise<void>, done: string) {
    setBusy(true);
    setMessage(null);
    try {
      await work();
      setMessage({ text: done });
    } catch (e) {
      setMessage({ text: String(e), error: true });
    } finally {
      setBusy(false);
    }
  }

  function add(other: GitHubIssue) {
    run(async () => {
      await onUpdateBody(issue.number, withRelated(issue.body, [...parseRelated(issue.body), other.number]));
      setQuery("");
      setAdding(false);
    }, tr("{issueRef} を関連に足しました", { issueRef: issueRef(other.number) }));
  }

  // 書いてあるほうの本文から外す（相手の本文に書いてあれば、相手を書き換える）
  function remove(link: RelatedLink) {
    run(
      () =>
        link.storedIn === "self"
          ? onUpdateBody(issue.number, withRelated(issue.body, parseRelated(issue.body).filter((n) => n !== link.issue.number)))
          : onUpdateBody(link.issue.number, withRelated(link.issue.body, parseRelated(link.issue.body).filter((n) => n !== issue.number))),
      tr("{issueRef} との関連を外しました（Issue は消えません）", { issueRef: issueRef(link.issue.number) })
    );
  }

  return (
    <div className="related-issues">
      <div className="related-issues-head">{tr("🔗 関連")}</div>
      <div className="related-issues-chips">
        {links.map((link) => (
          <span key={link.issue.number} className={`related-chip${link.issue.state === "closed" ? " related-chip--closed" : ""}`}>
            <button type="button" className="related-chip-title" title={tr("この Issue を開く")} onClick={() => onOpenIssue(link.issue.number)}>
              <span className="related-chip-number">{issueRef(link.issue.number)}</span> {link.issue.title}
            </button>
            {link.storedIn === "other" && <span className="related-chip-note">{trx("（{issueRef} の側で結んだ）", { issueRef: issueRef(link.issue.number) })}</span>}
            <button type="button" className="related-chip-remove" disabled={busy} title={tr("関連を外す（Issue は消えません）")}
              aria-label={tr("{issueRef} との関連を外す", { issueRef: issueRef(link.issue.number) })} onClick={() => remove(link)}>
              ×
            </button>
          </span>
        ))}
        {!adding && (
          <button type="button" className="link-button" disabled={busy} onClick={() => setAdding(true)}>
            {tr("＋ 関連を足す")}
          </button>
        )}
      </div>
      {adding && (
        <div className="related-issues-add">
          <input
            className="input-full"
            autoFocus
            value={query}
            disabled={busy}
            placeholder={tr("番号かタイトルで探す（例：#12）")}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (isEnter(e) && candidates.length === 1) add(candidates[0]);
            }}
          />
          <button type="button" className="link-button" onClick={() => { setAdding(false); setQuery(""); }}>
            {tr("やめる")}
          </button>
          {candidates.length > 0 && (
            <div className="suggestion-dropdown">
              {candidates.map((c) => (
                <button key={c.number} type="button" className="suggestion-item" onMouseDown={(e) => e.preventDefault()} onClick={() => add(c)}>
                  <span className={`suggestion-state suggestion-state--${c.state}`}>{c.state === "open" ? "●" : "○"}</span>
                  <span className="suggestion-number">{issueRef(c.number)}</span>
                  <span className="suggestion-title">{c.title}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {message && <p className={`sub-issues-note${message.error ? " sub-issues-note--error" : " sub-issues-note--ok"}`}>{message.text}</p>}
    </div>
  );
}
