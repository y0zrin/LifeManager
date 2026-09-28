import { useEffect, useMemo, useState } from "react";
import { showCommit, showGitHubCommit, splitGitError } from "../../lib/git";
import { shortWhen } from "../../lib/history";
import type { GitCommit, GitRun } from "../../lib/types";
import { DiffRows, parseDiff } from "./DiffView";
import { isEscape } from "../../lib/keys";

/** どこから読むか：この PC の作業フォルダ（git show）か、GitHub（作業フォルダのないとき・スマホ版） */
export type CommitSource = { folder: string } | { owner: string; repo: string };

interface CommitDetailProps {
  source: CommitSource;
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
export function CommitDetail({ source, commit, onClose }: CommitDetailProps) {
  const [run, setRun] = useState<GitRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sourceKey = "folder" in source ? source.folder : `${source.owner}/${source.repo}`;

  useEffect(() => {
    let alive = true;
    const load = "folder" in source ? showCommit(source.folder, commit.hash) : showGitHubCommit(source.owner, source.repo, commit.hash);
    load
      .then((r) => { if (alive) setRun(r); })
      .catch((e) => { if (alive) setError(splitGitError(e).message); });
    return () => { alive = false; };
    // source は毎回作り直されるので、中身（sourceKey）で読み直すかを決める
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey, commit.hash]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (isEscape(e)) onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const parts = useMemo(() => (run ? splitShow(run.output) : null), [run]);
  // Issue の履歴から開いたときは、題名が分からない（読み込んだ内容の 1 行目を題名にする）
  const subject = commit.subject || parts?.message.split("\n")[0] || "";
  const author = commit.author || (run ? run.output.split("\n")[1]?.replace(/\s*<[^>]*>\s*$/, "") ?? "" : "");
  const rows = useMemo(() => (parts ? parseDiff(parts.patch, true) : []), [parts]);

  return (
    <div className="palette-overlay git-dialog-back" onClick={onClose}>
      <div className="commit-detail" role="dialog" aria-modal="true" aria-label="コミットの内容" onClick={(e) => e.stopPropagation()}>
        <div className="cd-head">
          <div className="cd-title">{subject || "読み込んでいます…"}</div>
          <button type="button" className="git-notice-close" aria-label="閉じる" onClick={onClose}>
            ×
          </button>
          <div className="cd-meta">
            {author}{commit.date && ` · ${shortWhen(commit.date)}`} · <code>{commit.hash.slice(0, 7)}</code>
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
