import { useEffect, useMemo, useRef, useState } from "react";
import { issueRef } from "../../lib/issueRef";
import type { ConflictChoice, GitHubMilestone, MergeHunk, SyncConflict } from "../../lib/types";
import { isEnter, isEscape } from "../../lib/keys";
import { tr, trx } from "../../lib/i18n";

interface ConflictDialogProps {
  conflicts: SyncConflict[];
  milestones: GitHubMilestone[];
  onResolve: (id: number, choice: ConflictChoice, value?: string) => Promise<void>;
  onClose: () => void;
}

const FIELD_NAMES: Record<SyncConflict["field"], string> = {
  title: tr("タイトル"),
  body: tr("本文"),
  state: tr("開いている・閉じた"),
  milestone: tr("マイルストーン"),
  config: tr("設定"),
  journal: tr("ノート"),
  error: "",
};

// 印（git の競合と同じ書き方）。手で直すときに、まだ選んでいないところに入れる
const MARK_LOCAL = tr("<<<<<<< 自分の変更");
const MARK_SPLIT = "=======";
const MARK_REMOTE = ">>>>>>> GitHub";

type HunkChoice = "local" | "remote" | "both";

/** 選んだとおりにまとめた文章。markers なら、まだ選んでいないところに印を入れる（そうでなければ null） */
function compose(hunks: MergeHunk[], choices: Record<number, HunkChoice>, markers: boolean): string | null {
  const lines: string[] = [];
  for (let i = 0; i < hunks.length; i++) {
    const hunk = hunks[i];
    if (hunk.kind === "same") {
      lines.push(...hunk.lines);
      continue;
    }
    const choice = choices[i];
    if (choice === "local") lines.push(...hunk.local);
    else if (choice === "remote") lines.push(...hunk.remote);
    else if (choice === "both") lines.push(...hunk.local, ...hunk.remote);
    else if (markers) lines.push(MARK_LOCAL, ...hunk.local, MARK_SPLIT, ...hunk.remote, MARK_REMOTE);
    else return null;
  }
  return lines.join("\n");
}

/**
 * オフラインのあいだの変更を送るときに、GitHub 側でも同じところが変えられていたもの・送れなかったものを、
 * 1 件ずつ見せて、どうするか決めてもらう
 */
export function ConflictDialog({ conflicts, milestones, onResolve, onClose }: ConflictDialogProps) {
  const conflict = conflicts[0];

  useEffect(() => {
    if (!conflict) onClose();
  }, [conflict, onClose]);

  if (!conflict) return null;
  return (
    <ConflictView
      key={conflict.id}
      conflict={conflict}
      count={conflicts.length}
      milestones={milestones}
      onResolve={onResolve}
      onClose={onClose}
    />
  );
}

function ConflictView({
  conflict,
  count,
  milestones,
  onResolve,
  onClose,
}: {
  conflict: SyncConflict;
  count: number;
  milestones: GitHubMilestone[];
  onResolve: ConflictDialogProps["onResolve"];
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 本文・ノート: ぶつかったところごとに選ぶ（choose）か、文章を手で直す（edit）
  const [mode, setMode] = useState<"choose" | "edit">("choose");
  const [choices, setChoices] = useState<Record<number, HunkChoice>>({});
  const [draft, setDraft] = useState("");
  const firstRef = useRef<HTMLButtonElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  const isError = conflict.field === "error";
  const isText = conflict.field === "body" || conflict.field === "journal";
  // 何行もある値（本文・ノート・設定）は、違う行に印を付けて見比べる
  const multiline = isText || conflict.field === "config";
  const canEdit = isText || conflict.field === "title";
  const hunks = conflict.hunks;
  const conflictIndexes = useMemo(
    () => (hunks ?? []).flatMap((h, i) => (h.kind === "conflict" ? [i] : [])),
    [hunks],
  );
  const remaining = conflictIndexes.filter((i) => !choices[i]).length;

  useEffect(() => {
    firstRef.current?.focus();
  }, []);

  useEffect(() => {
    if (mode === "edit") (textRef.current ?? titleRef.current)?.focus();
  }, [mode]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (isEscape(e) && !busy) {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose]);

  function show(value: string): string {
    if (conflict.field === "state") return value === "closed" ? tr("閉じた") : tr("開いている");
    if (conflict.field === "milestone") {
      const n = Number(value);
      if (!n) return tr("なし");
      return milestones.find((m) => m.number === n)?.title ?? `#${n}`;
    }
    if (conflict.field === "config") {
      try {
        return JSON.stringify(JSON.parse(value), null, 2);
      } catch {
        return value;
      }
    }
    return value || tr("（空）");
  }

  async function resolve(choice: ConflictChoice, value?: string) {
    setBusy(true);
    setError(null);
    try {
      await onResolve(conflict.id, choice, value);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function startEdit() {
    const composed = hunks ? compose(hunks, choices, true) : null;
    setDraft(composed ?? conflict.local);
    setMode("edit");
    setError(null);
  }

  function sendDraft() {
    if (isText && [MARK_LOCAL, MARK_SPLIT, MARK_REMOTE].some((m) => draft.split("\n").includes(m))) {
      setError(tr("印（<<<<<<< ・ ======= ・ >>>>>>>）が残っています。どちらを残すか決めて印の行を消してください"));
      return;
    }
    if (conflict.field === "title" && !draft.trim()) {
      setError(tr("タイトルを入れてください"));
      return;
    }
    resolve("custom", conflict.field === "title" ? draft.trim() : draft);
  }

  const title = conflict.number !== 0 ? `${issueRef(conflict.number)} ${conflict.title}` : conflict.title;
  const heading = isError ? tr("送れなかった変更があります") : tr("GitHub 側でも変えられていました");

  return (
    <div className="palette-overlay git-dialog-back" onClick={() => { if (!busy) onClose(); }}>
      <div
        className={`git-dialog conflict-dialog${isText ? " conflict-dialog--wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={heading}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>
          {heading}
          {count > 1 && <span className="conflict-count">1 / {count}</span>}
        </h3>
        <p className="conflict-issue">{title}</p>

        {isError ? (
          <p className="git-dialog-message conflict-message">{conflict.message}</p>
        ) : (
          <p className="git-dialog-note">
            {conflict.number !== 0
              ? tr("オフラインのあいだに、この Issue の「{field}」が GitHub 側でも変えられていました。", { field: FIELD_NAMES[conflict.field] })
              : tr("オフラインのあいだに、この「{field}」が GitHub 側でも変えられていました。", { field: FIELD_NAMES[conflict.field] })}
            {isText && hunks && conflictIndexes.length > 0
              ? tr("別々のところの変更はまとめてあります。ぶつかった {length} か所だけ、どちらを残すか選んでください。", { length: conflictIndexes.length })
              : tr("どちらを残すか選んでください。")}
          </p>
        )}

        {!isError && mode === "edit" && (
          conflict.field === "title" ? (
            <input
              ref={titleRef}
              className="input-full"
              value={draft}
              onChange={(e) => { setDraft(e.target.value); setError(null); }}
              onKeyDown={(e) => { if (isEnter(e)) sendDraft(); }}
            />
          ) : (
            <textarea
              ref={textRef}
              className="textarea-full merge-edit"
              value={draft}
              spellCheck={false}
              onChange={(e) => { setDraft(e.target.value); setError(null); }}
            />
          )
        )}

        {!isError && mode === "choose" && isText && hunks && conflictIndexes.length > 0 && (
          <div className="merge-view">
            {hunks.map((hunk, i) =>
              hunk.kind === "same" ? (
                <SameLines key={i} lines={hunk.lines} />
              ) : (
                <div key={i} className={`merge-conflict${choices[i] ? " is-chosen" : ""}`}>
                  <div className="merge-sides">
                    <section>
                      <h4>{tr("自分の変更")}</h4>
                      <pre>{hunk.local.join("\n") || tr("（消した）")}</pre>
                    </section>
                    <section>
                      <h4>GitHub</h4>
                      <pre>{hunk.remote.join("\n") || tr("（消した）")}</pre>
                    </section>
                  </div>
                  <div className="merge-choices" role="group" aria-label={tr("残す方")}>
                    {(["local", "remote", "both"] as const).map((c) => (
                      <button
                        key={c}
                        type="button"
                        className={`btn-sm${choices[i] === c ? " is-selected" : ""}`}
                        aria-pressed={choices[i] === c}
                        disabled={busy}
                        onClick={() => setChoices((prev) => ({ ...prev, [i]: c }))}
                      >
                        {c === "local" ? tr("自分の変更") : c === "remote" ? "GitHub" : tr("両方")}
                      </button>
                    ))}
                  </div>
                </div>
              ),
            )}
          </div>
        )}

        {!isError && mode === "choose" && !(isText && hunks && conflictIndexes.length > 0) && (
          <div className="conflict-compare">
            <section>
              <h4>{tr("自分の変更")}</h4>
              {multiline ? (
                <div className="conflict-value conflict-value--body">
                  <Lines text={show(conflict.local)} other={show(conflict.remote)} />
                </div>
              ) : (
                <div className="conflict-value">{show(conflict.local)}</div>
              )}
            </section>
            <section>
              <h4>{tr("GitHub の今の内容")}</h4>
              {multiline ? (
                <div className="conflict-value conflict-value--body">
                  <Lines text={show(conflict.remote)} other={show(conflict.local)} />
                </div>
              ) : (
                <div className="conflict-value">{show(conflict.remote)}</div>
              )}
            </section>
            {conflict.base !== "" && !isText && conflict.field !== "config" && (
              <p className="conflict-base">{trx("変える前: {show}", { show: show(conflict.base) })}</p>
            )}
          </div>
        )}

        {error && <p className="git-dialog-error">{error}</p>}

        <div className="git-dialog-actions">
          <button type="button" className="btn-sm conflict-later" disabled={busy} onClick={onClose}>
            {tr("あとで")}
          </button>
          {isError ? (
            <button ref={firstRef} type="button" className="btn-primary" disabled={busy} onClick={() => resolve("remote")}>
              {tr("分かった")}
            </button>
          ) : mode === "edit" ? (
            <>
              <button type="button" className="btn-sm" disabled={busy} onClick={() => { setMode("choose"); setError(null); }}>
                {tr("戻る")}
              </button>
              <button type="button" className="btn-primary" disabled={busy} onClick={sendDraft}>
                {tr("この内容で送る")}
              </button>
            </>
          ) : (
            <>
              <button ref={firstRef} type="button" className="btn-sm" disabled={busy} onClick={() => resolve("remote")}>
                {tr("GitHub の内容を残す")}
              </button>
              <button type="button" className="btn-sm" disabled={busy} onClick={() => resolve("local")}>
                {tr("自分の変更で上書き")}
              </button>
              {canEdit && (
                <button type="button" className="btn-sm" disabled={busy} onClick={startEdit}>
                  {tr("手で直す…")}
                </button>
              )}
              {isText && hunks && conflictIndexes.length > 0 && (
                <button
                  type="button"
                  className="btn-primary"
                  disabled={busy || remaining > 0}
                  title={remaining > 0 ? tr("あと {remaining} か所選んでください", { remaining }) : undefined}
                  onClick={() => resolve("custom", compose(hunks, choices, false) ?? "")}
                >
                  {remaining > 0 ? tr("選んだ内容で送る（あと {remaining}）", { remaining }) : tr("選んだ内容で送る")}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** 行ごとに並べ、もう片方と違う行に印を付ける（同じ形の設定などを見比べやすくする） */
function Lines({ text, other }: { text: string; other: string }) {
  const others = other.split("\n");
  return (
    <>
      {text.split("\n").map((line, i) => (
        <span key={i} className={`conflict-line${line !== others[i] ? " is-different" : ""}`}>
          {line || " "}
        </span>
      ))}
    </>
  );
}

/** 変わっていない行（長いときは前後だけ見せる） */
function SameLines({ lines }: { lines: string[] }) {
  if (lines.length <= 5) return <pre className="merge-same">{lines.join("\n")}</pre>;
  return (
    <pre className="merge-same">
      {lines.slice(0, 2).join("\n")}
      {"\n"}
      <span className="merge-fold">{tr("…（変わっていない {n} 行）…", { n: lines.length - 4 })}</span>
      {"\n"}
      {lines.slice(-2).join("\n")}
    </pre>
  );
}
