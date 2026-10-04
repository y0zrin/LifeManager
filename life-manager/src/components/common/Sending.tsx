import { createContext, useContext } from "react";
import type { GitHubIssue } from "../../lib/types";
import { Buncho } from "./Buncho";
import { tr } from "../../lib/i18n";

/** 送れなかった仮の Issue の「もう一度」「やめる」（App が渡す） */
export const SendingContext = createContext<{ retry: (n: number) => void; discard: (n: number) => void }>({
  retry: () => {},
  discard: () => {},
});

/** 「送っています…」（くるくる。文鳥のテーマでは、くるくるの代わりに文鳥が手紙を運ぶ） */
export function SendingChip({ label = tr("送っています…") }: { label?: string }) {
  return (
    <span className="sending-chip" role="status">
      <i className="sending-spin" aria-hidden="true" />
      <SendingBird />
      {label}
    </span>
  );
}

/** 手紙を運ぶ文鳥（文鳥のテーマのときだけ見える。App.css の .sending-bird） */
export function SendingBird() {
  return (
    <span className="sending-bird" aria-hidden="true">
      <Buncho letter flip />
    </span>
  );
}

/** 「⚠ 送れませんでした」 */
export function FailedChip() {
  return <span className="failed-chip">{tr("⚠ 送れませんでした")}</span>;
}

/** 仮の Issue（送っている・送れなかった）の印と、送れなかったときの「もう一度」「やめる」。ふつうの Issue なら何も出さない */
export function IssueSendState({ issue, actions = true }: { issue: GitHubIssue; actions?: boolean }) {
  const { retry, discard } = useContext(SendingContext);
  if (issue._sending) return <SendingChip />;
  if (!issue._failed) return null;
  return (
    <>
      <FailedChip />
      {actions && (
        <span className="failed-actions" onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
          <button type="button" className="btn-primary" onClick={() => retry(issue.number)}>
            {tr("もう一度")}
          </button>
          <button type="button" className="btn-sm" onClick={() => discard(issue.number)}>
            {tr("やめる")}
          </button>
          <small className="failed-why" title={issue._failed}>
            {issue._failed.length > 40 ? `${issue._failed.slice(0, 40)}…` : issue._failed}
          </small>
        </span>
      )}
    </>
  );
}

/** 仮の Issue（まだ番号がない）か。押しても詳細を開かない・動かせない */
export const isUnsent = (issue: GitHubIssue) => !!(issue._sending || issue._failed);
