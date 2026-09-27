import type { GitNotice } from "../../hooks/useGit";

interface GitNoticesProps {
  notices: GitNotice[];
  onDismiss: (id: number) => void;
}

/** git の操作の結果（右下）。実行したコマンドを添えて、何が起きたのかを見せる */
export function GitNotices({ notices, onDismiss }: GitNoticesProps) {
  return (
    <div className="git-notices" aria-live="polite">
      {notices.map((n) => (
        <div key={n.id} className={`git-notice git-notice--${n.kind}`}>
          <div className="git-notice-text">{n.text}</div>
          {n.command && <code>$ {n.command}</code>}
          <button type="button" className="git-notice-close" aria-label="閉じる" onClick={() => onDismiss(n.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
