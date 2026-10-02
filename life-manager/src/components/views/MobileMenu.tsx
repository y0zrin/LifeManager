// スマホのメニュー（ホーム）: 上に小さなオーバービュー、その下に全部の画面の絵の札（4 列 2 段）を並べ、1 画面に収める（#203・#212）。
// 下の帯の「メニュー」で開き、ほかの画面で戻るボタンを押すとここへ戻る
import type { ReactNode } from "react";
import type { ViewType } from "../../lib/types";

export interface MenuTile {
  key: ViewType;
  icon: string;
  label: string;
  /** 札の下に小さく出すこと（今のマイルストーンなど） */
  note?: string;
  /** 右上の数（ヒストリーのすることなど） */
  badge?: number;
}

interface MobileMenuProps {
  tiles: MenuTile[];
  onOpen: (view: ViewType) => void;
  /** 札の上に出す、小さなオーバービュー */
  overview: ReactNode;
}

export function MobileMenu({ tiles, onOpen, overview }: MobileMenuProps) {
  return (
    <div className="content mobile-menu">
      {overview}
      <nav className="mm-grid" aria-label="画面">
        {tiles.map((t) => (
          <button key={t.key} type="button" className="mm-tile" onClick={() => onOpen(t.key)}>
            {t.badge ? <span className="mm-badge">{t.badge}</span> : null}
            <span className="mm-icon" aria-hidden="true">{t.icon}</span>
            <span className="mm-label">{t.label}</span>
            {t.note && <span className="mm-note">{t.note}</span>}
          </button>
        ))}
      </nav>
    </div>
  );
}
