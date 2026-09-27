import { useEffect, useMemo, useState } from "react";
import { showCommit, splitGitError } from "../../lib/git";
import { shortWhen } from "../../lib/history";
import type { GitCommit, GitRun } from "../../lib/types";
import { DiffRows, parseDiff } from "./DiffView";

interface CommitDetailProps {
  folder: string;
  commit: GitCommit;
  onClose: () => void;
}

/** git show の出力を、メッセージ・変更したファイルの一覧・差分に分ける */
function splitShow(output: string) {
  const at = output.indexOf("\ndiff --git ");
  const head = (at >= 0 ? output.slice(0, at) : output).split("\n");
  const patch = at >= 0 ? output.slice(at + 1) : "";
  // 1〜3 行目はハッシュ・作者・日時、4 行目は空行。そのあとにメッセージ、最後に --stat の一覧
  const summary = head.findIndex((l) => /^ \d+ files? changed/.test(l));
  let statStart = summary;
  while (statStart > 4 && head[statStart - 1].includes("|")) statStart--;
  // git はメッセージと変更したファイルの一覧のあいだに「---」を入れるので、それは除く
  const message = head
    .slice(4, summary >= 0 ? statStart : head.length)
    .join("\n")
    .replace(/\n---\s*$/, "")
    .trim();
  const stat = summary >= 0 ? head.slice(statStart, summary) : [];
  return { message, stat, summary: summary >= 0 ? head[summary].trim() : "", patch };
}

/** 「変更内容を見る」: 1 つのコミットで何が変わったか */
export function CommitDetail({ folder, commit, onClose }: CommitDetailProps) {
  const [run, setRun] = useState<GitRun | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    showCommit(folder, commit.hash)
      .then((r) => { if (alive) setRun(r); })
      .catch((e) => { if (alive) setError(splitGitError(e).message); });
    return () => { alive = false; };
  }, [folder, commit.hash]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const parts = useMemo(() => (run ? splitShow(run.output) : null), [run]);
  const rows = useMemo(() => (parts ? parseDiff(parts.patch, true) : []), [parts]);

  return (
    <div className="palette-overlay git-dialog-back" onClick={onClose}>
      <div className="commit-detail" role="dialog" aria-modal="true" aria-label="コミットの内容" onClick={(e) => e.stopPropagation()}>
        <div className="cd-head">
          <div className="cd-title">{commit.subject}</div>
          <button type="button" className="git-notice-close" aria-label="閉じる" onClick={onClose}>
            ×
          </button>
          <div className="cd-meta">
            {commit.author} · {shortWhen(commit.date)} · <code>{commit.hash.slice(0, 7)}</code>
            {run && <code className="cd-cmd">{run.command}</code>}
          </div>
        </div>
        <div className="cd-body">
          {error && <p className="git-dialog-error">{error}</p>}
          {!run && !error && <p className="git-dialog-running">読み込んでいます…</p>}
          {parts && (
            <>
              {parts.message.split("\n").slice(1).join("\n").trim() && (
                <pre className="cd-message">{parts.message.split("\n").slice(1).join("\n").trim()}</pre>
              )}
              {parts.stat.length > 0 && (
                <div className="cd-stat">
                  <div className="cd-summary">{parts.summary}</div>
                  {parts.stat.map((l, i) => (
                    <div key={i} className="cd-stat-row">{l}</div>
                  ))}
                </div>
              )}
              {rows.length > 0 ? (
                <div className="dr-diff cd-diff">
                  <DiffRows rows={rows} />
                </div>
              ) : (
                <p className="git-dialog-running">ファイルの変更はありません（空コミット、またはマージのコミットです）</p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
