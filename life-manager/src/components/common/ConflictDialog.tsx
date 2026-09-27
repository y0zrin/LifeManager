import { useEffect, useRef, useState } from "react";
import { issueRef } from "../../lib/issueRef";
import type { GitHubMilestone, SyncConflict } from "../../lib/types";

interface ConflictDialogProps {
  conflicts: SyncConflict[];
  milestones: GitHubMilestone[];
  onResolve: (id: number, keepLocal: boolean) => Promise<void>;
  onClose: () => void;
}

const FIELD_NAMES: Record<SyncConflict["field"], string> = {
  title: "タイトル",
  body: "本文",
  state: "開いている・閉じた",
  milestone: "マイルストーン",
  error: "",
};

/**
 * オフラインのあいだの変更を送るときに、GitHub 側でも同じところが変えられていたもの・送れなかったものを、
 * 1 件ずつ見せて、どちらを残すか決めてもらう
 */
export function ConflictDialog({ conflicts, milestones, onResolve, onClose }: ConflictDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstRef = useRef<HTMLButtonElement>(null);
  const conflict = conflicts[0];

  useEffect(() => {
    if (!conflict) onClose();
  }, [conflict, onClose]);

  useEffect(() => {
    firstRef.current?.focus();
  }, [conflict?.id]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose]);

  if (!conflict) return null;

  function show(value: string): string {
    if (conflict.field === "state") return value === "closed" ? "閉じた" : "開いている";
    if (conflict.field === "milestone") {
      const n = Number(value);
      if (!n) return "なし";
      return milestones.find((m) => m.number === n)?.title ?? `#${n}`;
    }
    return value || "（空）";
  }

  async function resolve(keepLocal: boolean) {
    setBusy(true);
    setError(null);
    try {
      await onResolve(conflict.id, keepLocal);
    } catch (e) {
      setError(String(e));
    }
    setBusy(false);
  }

  const isError = conflict.field === "error";
  const title = `${issueRef(conflict.number)} ${conflict.title}`.trim();

  return (
    <div className="palette-overlay git-dialog-back" onClick={() => { if (!busy) onClose(); }}>
      <div
        className="git-dialog conflict-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={isError ? "送れなかった変更" : "GitHub 側でも変えられていました"}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>
          {isError ? "送れなかった変更があります" : "GitHub 側でも変えられていました"}
          {conflicts.length > 1 && <span className="conflict-count">1 / {conflicts.length}</span>}
        </h3>
        <p className="conflict-issue">{title}</p>

        {isError ? (
          <p className="git-dialog-message conflict-message">{conflict.message}</p>
        ) : (
          <>
            <p className="git-dialog-note">
              オフラインのあいだに、この Issue の「{FIELD_NAMES[conflict.field]}」が GitHub 側でも変えられていました。
              どちらを残すか選んでください。
            </p>
            <div className="conflict-compare">
              <section>
                <h4>自分の変更</h4>
                <div className={`conflict-value${conflict.field === "body" ? " conflict-value--body" : ""}`}>
                  {show(conflict.local)}
                </div>
              </section>
              <section>
                <h4>GitHub の今の内容</h4>
                <div className={`conflict-value${conflict.field === "body" ? " conflict-value--body" : ""}`}>
                  {show(conflict.remote)}
                </div>
              </section>
            </div>
          </>
        )}

        {error && <p className="git-dialog-error">{error}</p>}

        <div className="git-dialog-actions">
          <button type="button" className="btn-sm conflict-later" disabled={busy} onClick={onClose}>
            あとで
          </button>
          {isError ? (
            <button ref={firstRef} type="button" className="btn-primary" disabled={busy} onClick={() => resolve(false)}>
              分かった
            </button>
          ) : (
            <>
              <button ref={firstRef} type="button" className="btn-sm" disabled={busy} onClick={() => resolve(false)}>
                GitHub の内容を残す
              </button>
              <button type="button" className="btn-primary" disabled={busy} onClick={() => resolve(true)}>
                自分の変更で上書き
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
