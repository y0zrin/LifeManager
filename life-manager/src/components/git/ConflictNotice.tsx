import { useEffect, useState } from "react";
import * as git from "../../lib/git";
import { parseConflict, sideNames, type ConflictHunk } from "../../lib/conflict";
import type { GitStatus } from "../../lib/types";
import { OPERATION_NAMES } from "../../hooks/useGitActions";
import { isEscape } from "../../lib/keys";

interface ConflictNoticeProps {
  folder: string;
  status: GitStatus;
  /** 作業タブで直す */
  onFix: () => void;
  /** 途中の操作を中止する（確かめてから） */
  onAbort: () => void;
  onClose: () => void;
}

/**
 * 競合（コンフリクト）が起きたときに 1 回だけ出す知らせ。どの画面にいても出して、
 * 何が起きたか・どのファイルか・直し方（実際のファイルの印の見本つき）を伝え、作業タブのマージツールへ案内する
 */
export function ConflictNotice({ folder, status, onFix, onAbort, onClose }: ConflictNoticeProps) {
  const conflicted = status.files.filter((f) => f.staged === "U").map((f) => f.path);
  const merged = status.files.filter((f) => f.staged && f.staged !== "U").map((f) => f.path);
  const first = conflicted[0] ?? null;
  const [hunk, setHunk] = useState<ConflictHunk | null>(null);

  // 見本の印は、実際のファイルの最初の競合から作る
  useEffect(() => {
    if (!first) return;
    let alive = true;
    git.conflictFile(folder, first)
      .then((d) => {
        if (alive && !d.binary && !d.missing) setHunk(parseConflict(d.text).hunks[0] ?? null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [folder, first]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEscape(e)) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const names = sideNames(status.operation, status.branch, hunk);
  const op = status.operation;
  const branch = status.branch ?? "今のブランチ";
  const what =
    op === "merge"
      ? `${hunk?.theirsLabel || "ほかのブランチ"} を ${branch} に取り込もうとしましたが、`
      : op === "rebase"
        ? "コミットを付け替えている途中で、"
        : op === "cherry-pick"
          ? `コミット（${hunk?.theirsLabel || "…"}）を ${branch} に取り込もうとしましたが、`
          : op === "revert"
            ? "コミットを打ち消そうとしましたが、"
            : names.theirs === "退避していた変更"
              ? "退避していた変更を戻そうとしましたが、"
              : "";

  return (
    <div className="palette-overlay git-dialog-back" onClick={onClose}>
      <div className="conflict-notice" role="alertdialog" aria-label="競合（コンフリクト）が起きました" onClick={(e) => e.stopPropagation()}>
        <h3><span className="conflict-notice-mark">⚠</span> 競合（コンフリクト）が起きました</h3>
        <p>
          {what}<b>同じところが両方で変わっていた</b>ので、git が自動でまとめられませんでした。
          {op && <b>{OPERATION_NAMES[op]}の途中</b>}{op && "で止まっています。"}
        </p>
        <div className="conflict-notice-files">
          {conflicted.map((f) => (
            <div key={f}><span className="conflict-notice-u">競合</span><span>{f}</span><span className="conflict-notice-note">← 直すファイル</span></div>
          ))}
          {merged.map((f) => (
            <div key={f}><span className="conflict-notice-ok">✔ 自動でまとまった</span><span>{f}</span></div>
          ))}
        </div>
        <b>直し方</b>
        <ol>
          <li>作業タブで競合のファイルを選ぶと、右に「競合を直す」が出ます</li>
          <li>か所ごとに、<b>どちらを使うか</b>を選びます（両方を残す・自分で書く もできます）</li>
          <li>
            「直したのでステージする」を押し、
            {op === "merge" || !op ? "コミットすると終わります" : `「続ける」を押すと${OPERATION_NAMES[op]}の続きが進みます`}
          </li>
        </ol>
        {hunk && (
          <>
            <p className="conflict-notice-sub">ファイルの中にはこんな印が入っています（{first}）</p>
            <pre className="conflict-notice-sample">
              <span className="m">{"<<<<<<< "}{hunk.oursLabel}</span>{"\n"}
              {hunk.ours.join("\n")}{hunk.ours.length > 0 ? "\n" : ""}
              <span className="m">=======</span>{`      ← ここまでが${names.ours}`}{"\n"}
              {hunk.theirs.join("\n")}{hunk.theirs.length > 0 ? "\n" : ""}
              <span className="m">{">>>>>>> "}{hunk.theirsLabel}</span>{`      ← ここまでが${names.theirs}`}
            </pre>
          </>
        )}
        {op && (
          <p className="conflict-notice-sub">
            やめるときは「{OPERATION_NAMES[op]}を中止」で、始める前に戻ります（<code>git {op} --abort</code>）。
          </p>
        )}
        <div className="conflict-notice-actions">
          {op && (
            <button type="button" className="btn-sm conflict-notice-abort" onClick={onAbort}>
              {OPERATION_NAMES[op]}を中止…
            </button>
          )}
          <button type="button" className="btn-sm" onClick={onClose}>閉じる</button>
          <button type="button" className="btn-primary" onClick={onFix} autoFocus>作業タブで直す</button>
        </div>
      </div>
    </div>
  );
}
