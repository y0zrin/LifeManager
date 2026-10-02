// スマホのメニュー（ホーム）: 上から、チームの仕事（これまでの合計）、小さなオーバービュー、あなたがすることの数、
// 全部の画面の絵の札（4 列 2 段）を並べる（#203・#212・#214）。
// 下のドックの「メニュー」で開き、ほかの画面で戻るボタンを押すとここへ戻る
import type { ReactNode } from "react";
import type { ViewType } from "../../lib/types";
import type { Todo } from "../../lib/activity";

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
  /** いちばん上: チームの仕事（ヒストリーの、これまでの合計） */
  team: ReactNode;
  /** その下: 小さなオーバービュー */
  overview: ReactNode;
  /** その下: あなたがすることの数 */
  todo: ReactNode;
}

/** メニューの「あなたがすること」: 数と、はじめの 2 つ。押すとヒストリーを開く（全部はそこに） */
export function MenuTodos({ todos, ready, onOpen }: { todos: Todo[]; ready: boolean; onOpen: () => void }) {
  const text = (t: Todo) => t.parts.map((p) => (typeof p === "string" ? p : `#${p.number}${p.title ? ` ${p.title}` : ""}`)).join("");
  return (
    <button type="button" className="mm-todo" onClick={onOpen}>
      <span className="mm-todo-head">
        <b>✅ あなたがすること</b>
        <span className={`mm-todo-n${todos.length ? " on" : ""}`}>{ready ? todos.length : "…"}</span>
        <span className="grow" />
        <span className="mm-todo-more">ヒストリー ›</span>
      </span>
      {!ready ? (
        <span className="mm-todo-line muted">読み込んでいます…</span>
      ) : todos.length === 0 ? (
        <span className="mm-todo-line muted">今はありません</span>
      ) : (
        todos.slice(0, 2).map((t) => (
          <span key={t.key} className="mm-todo-line">
            {t.icon} {text(t)}
          </span>
        ))
      )}
    </button>
  );
}

export function MobileMenu({ tiles, onOpen, team, overview, todo }: MobileMenuProps) {
  return (
    <div className="content mobile-menu">
      {team}
      {overview}
      {todo}
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
