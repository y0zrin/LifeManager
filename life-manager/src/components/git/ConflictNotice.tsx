import { useEffect, useState } from "react";
import * as git from "../../lib/git";
import { parseConflict, sideNames, type ConflictHunk } from "../../lib/conflict";
import type { GitStatus } from "../../lib/types";
import { OPERATION_NAMES } from "../../hooks/useGitActions";
import { isEscape } from "../../lib/keys";
import { tr, trx } from "../../lib/i18n";

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
  const branch = status.branch ?? tr("今のブランチ");
  // 何をしていて競合したか（操作ごとに丸ごとの文。<0> は太字）
  const cause =
    op === "merge"
      ? trx("{v} を {branch} に取り込もうとしましたが、<0>同じところが両方で変わっていた</0>ので、git が自動でまとめられませんでした。", { v: hunk?.theirsLabel || tr("ほかのブランチ"), branch }, [<b />])
      : op === "rebase"
        ? trx("コミットを付け替えている途中で、<0>同じところが両方で変わっていた</0>ので、git が自動でまとめられませんでした。", undefined, [<b />])
        : op === "cherry-pick"
          ? trx("コミット（{v}）を {branch} に取り込もうとしましたが、<0>同じところが両方で変わっていた</0>ので、git が自動でまとめられませんでした。", { v: hunk?.theirsLabel || "…", branch }, [<b />])
          : op === "revert"
            ? trx("コミットを打ち消そうとしましたが、<0>同じところが両方で変わっていた</0>ので、git が自動でまとめられませんでした。", undefined, [<b />])
            : names.theirs === tr("退避していた変更")
              ? trx("退避していた変更を戻そうとしましたが、<0>同じところが両方で変わっていた</0>ので、git が自動でまとめられませんでした。", undefined, [<b />])
              : trx("<0>同じところが両方で変わっていた</0>ので、git が自動でまとめられませんでした。", undefined, [<b />]);

  return (
    <div className="palette-overlay git-dialog-back" onClick={onClose}>
      <div className="conflict-notice" role="alertdialog" aria-label={tr("競合（コンフリクト）が起きました")} onClick={(e) => e.stopPropagation()}>
        <h3>{trx("<0>⚠</0> 競合（コンフリクト）が起きました", undefined, [<span className="conflict-notice-mark" />])}</h3>
        <p>
          {cause}
          {op && trx("<0>{name}の途中</0>で止まっています。", { name: OPERATION_NAMES[op] }, [<b />])}
        </p>
        <div className="conflict-notice-files">
          {conflicted.map((f) => (
            <div key={f}>{trx("<0>競合</0><1>{f}</1><2>← 直すファイル</2>", { f }, [<span className="conflict-notice-u" />, <span />, <span className="conflict-notice-note" />])}</div>
          ))}
          {merged.map((f) => (
            <div key={f}>{trx("<0>✔ 自動でまとまった</0><1>{f}</1>", { f }, [<span className="conflict-notice-ok" />, <span />])}</div>
          ))}
        </div>
        <b>{tr("直し方")}</b>
        <ol>
          <li>{tr("「作業をする」の ③ で競合のファイルを選ぶと、右に「競合を直す」が出ます")}</li>
          <li>{trx("か所ごとに、<0>どちらを使うか</0>を選びます（両方を残す・自分で書く もできます）", undefined, [<b />])}</li>
          <li>
            {op === "merge" || !op
              ? tr("「直したのでステージする」を押し、コミットすると終わります")
              : tr("「直したのでステージする」を押し、「続ける」を押すと{name}の続きが進みます", { name: OPERATION_NAMES[op] })}
          </li>
        </ol>
        {hunk && (
          <>
            <p className="conflict-notice-sub">{trx("ファイルの中にはこんな印が入っています（{first}）", { first })}</p>
            <pre className="conflict-notice-sample">
              <span className="m">{"<<<<<<< "}{hunk.oursLabel}</span>{"\n"}
              {hunk.ours.join("\n")}{hunk.ours.length > 0 ? "\n" : ""}
              <span className="m">=======</span>{tr("      ← ここまでが{ours}", { ours: names.ours })}{"\n"}
              {hunk.theirs.join("\n")}{hunk.theirs.length > 0 ? "\n" : ""}
              <span className="m">{">>>>>>> "}{hunk.theirsLabel}</span>{tr("      ← ここまでが{theirs}", { theirs: names.theirs })}
            </pre>
          </>
        )}
        {op && (
          <p className="conflict-notice-sub">
            {trx("やめるときは「{OPERATION_NAMES}を中止」で、始める前に戻ります（<0>git {op} --abort</0>）。", { OPERATION_NAMES: OPERATION_NAMES[op], op }, [<code />])}
          </p>
        )}
        <div className="conflict-notice-actions">
          {op && (
            <button type="button" className="btn-sm conflict-notice-abort" onClick={onAbort}>
              {trx("{OPERATION_NAMES}を中止…", { OPERATION_NAMES: OPERATION_NAMES[op] })}
            </button>
          )}
          <button type="button" className="btn-sm" onClick={onClose}>{tr("閉じる")}</button>
          <button type="button" className="btn-primary" onClick={onFix} autoFocus>{tr("「作業をする」で直す")}</button>
        </div>
      </div>
    </div>
  );
}
