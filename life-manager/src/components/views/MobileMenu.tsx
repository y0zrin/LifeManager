// スマホのメニュー（ホーム）: 全部の画面を絵の札で並べ、その下にオーバービューの中身を出す（#203）。
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
  groups: { title: string; tiles: MenuTile[] }[];
  onOpen: (view: ViewType) => void;
  /** 札の下に出すオーバービュー */
  overview: ReactNode;
}

export function MobileMenu({ groups, onOpen, overview }: MobileMenuProps) {
  return (
    <div className="content mobile-menu">
      {groups.map((g) => (
        <section key={g.title} className="mm-group">
          <h2 className="mm-group-title">{g.title}</h2>
          <div className="mm-grid">
            {g.tiles.map((t) => (
              <button key={t.key} type="button" className="mm-tile" onClick={() => onOpen(t.key)}>
                {t.badge ? <span className="mm-badge">{t.badge}</span> : null}
                <span className="mm-icon" aria-hidden="true">{t.icon}</span>
                <span className="mm-label">{t.label}</span>
                {t.note && <span className="mm-note">{t.note}</span>}
              </button>
            ))}
          </div>
        </section>
      ))}
      <section className="mm-group">
        <h2 className="mm-group-title">オーバービュー</h2>
        {overview}
      </section>
    </div>
  );
}
