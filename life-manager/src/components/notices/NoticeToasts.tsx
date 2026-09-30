import type { CSSProperties } from "react";
import { ago } from "../../lib/pulls";
import { NOTICE_COLORS, type Notice } from "../../lib/notices";

interface NoticeToastsProps {
  /** 出している知らせ（新しい順。3 つまで） */
  notices: Notice[];
  /** 出していない残りの数（「ほか N 件」） */
  more: number;
  onOpen: (n: Notice) => void;
  onClose: (id: string) => void;
  /** 「🔔 おしらせで見る」（りれきを開く） */
  onOpenHistory?: () => void;
}

/**
 * すべり込む知らせ（アプリの窓の外の、おしらせの窓。アプリの中に出すときも同じ形）。
 * × か、押して開くまで残る（StudentDB と同じ）。🆘 は赤く目立たせる
 */
export function NoticeToasts({ notices, more, onOpen, onClose, onOpenHistory }: NoticeToastsProps) {
  return (
    <div className="nt-toasts" role="log" aria-live="polite">
      {notices.map((n) => (
        <div key={n.id} className={`nt-toast k-${n.kind}`} style={{ "--k": NOTICE_COLORS[n.kind] } as CSSProperties}>
          <span className="nt-toast-ic" aria-hidden="true">{n.icon}</span>
          <div className="nt-toast-body">
            <button type="button" className="nt-toast-title" onClick={() => onOpen(n)} title="開く">{n.title}</button>
            {n.body && <div className="nt-toast-text">{n.body}</div>}
            <div className="nt-toast-actions">
              {n.target && <button type="button" className="btn-primary nt-toast-open" onClick={() => onOpen(n)}>開く</button>}
              {n.kind === "help" && <button type="button" className="btn-sm" onClick={() => onClose(n.id)}>あとで</button>}
              <span className="nt-toast-when">{ago(n.at)}</span>
            </div>
          </div>
          <button type="button" className="nt-toast-x" onClick={() => onClose(n.id)} aria-label="閉じる" title="閉じる">×</button>
        </div>
      ))}
      {more > 0 && (
        <button type="button" className="nt-toast-more" onClick={onOpenHistory}>
          ほか {more} 件 ・ 🔔 おしらせで見る
        </button>
      )}
    </div>
  );
}
