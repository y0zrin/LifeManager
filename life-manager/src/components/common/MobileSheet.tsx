// スマホの、下から出る板（#207）。絞り込み・並び・見せ方など、PC ではツールバーに並べているものをまとめて出す。
// 外を押す・Esc・戻るボタン（src/lib/back.ts が .m-sheet を見て Esc を送る）で閉じる
import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { isEscape } from "../../lib/keys";
import { tr } from "../../lib/i18n";

interface MobileSheetProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** 下の段（「すべて外す」「閉じる」など） */
  footer?: ReactNode;
}

export function MobileSheet({ open, title, onClose, children, footer }: MobileSheetProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (isEscape(e)) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  // 画面のいちばん外側に出す（画面の枠の中に置くと、下の帯やメモのボタンの下にもぐる）
  return createPortal(
    <div className="m-sheet-dim" onClick={onClose}>
      <div className="m-sheet" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="m-sheet-grip" aria-hidden="true" />
        <div className="m-sheet-head">
          <h3>{title}</h3>
          <button type="button" className="btn-sm" onClick={onClose}>{tr("閉じる")}</button>
        </div>
        <div className="m-sheet-body">{children}</div>
        {footer && <div className="m-sheet-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/** 板の中の 1 項目（見出しと中身） */
export function SheetRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="m-sheet-row">
      <div className="m-sheet-label">{label}</div>
      <div className="m-sheet-ctrl">{children}</div>
    </div>
  );
}
