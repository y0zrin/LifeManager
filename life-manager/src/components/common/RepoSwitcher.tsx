import { useEffect, useRef, useState, type CSSProperties } from "react";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { isMobile } from "../../lib/platform";
import { isEscape } from "../../lib/keys";
import type { Project } from "../../lib/types";
import { repoKey as keyOf, useRepoFolderActions } from "../../hooks/useRepoFolderActions";
import { tr } from "../../lib/i18n";

interface RepoSwitcherProps {
  projects: Project[];
  /** 今のリポジトリ */
  owner: string;
  repo: string;
  /** この PC の作業フォルダ（キーは "owner/repo"） */
  folders: Record<string, string>;
  onSwitch: (owner: string, repo: string) => void | Promise<void>;
  /** 一覧から外す（GitHub のリポジトリやフォルダは消さない） */
  onRemove: (owner: string, repo: string) => Promise<void>;
  /** null なら、フォルダの設定を外す（フォルダそのものは消さない） */
  onSetFolder: (owner: string, repo: string, path: string | null) => Promise<void>;
  /** リポジトリを追加（ウィザード）を開く */
  onAdd: () => void;
  /** あれば、押したときに一覧ではなく、リポジトリを選ぶ画面（大きな画面）を開く（PC） */
  onOpenPicker?: () => void;
  /** アプリのアカウント（クローンの URL に入れる。#245） */
  login?: string;
}

/** 一覧の幅（画面の端からはみ出さないように置くため。CSS の .repo-pop と同じ） */
const POP_WIDTH = 320;

/**
 * 左上のリポジトリ（GitHub Desktop のように）。PC では押すとリポジトリを選ぶ画面、スマホでは一覧が開き、選ぶと切り替える。
 * 各行の「⋯」で、この PC のフォルダ（選ぶ・変える・クローン・外す）、エクスプローラーで表示、GitHub で開く、一覧から外す。
 * 一番下の「＋ リポジトリを追加…」で、追加のウィザード（GitHub にある／この PC にある／新しく作る）
 */
export function RepoSwitcher({ projects, owner, repo, folders, onSwitch, onRemove, onSetFolder, onAdd, onOpenPicker, login }: RepoSwitcherProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [pos, setPos] = useState<CSSProperties>({});
  const [query, setQuery] = useState("");
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const { busy, note, setNote, pickFolder, clone, clearFolder, remove } = useRepoFolderActions(folders, onSetFolder, onRemove, login);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // 外を押す・Esc で閉じる（フォルダを選んでいるあいだは閉じない）
  useEffect(() => {
    if (!isOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!busy && !rootRef.current?.contains(e.target as Node)) setIsOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (isEscape(e) && !busy) setIsOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [isOpen, busy]);

  function toggle() {
    if (onOpenPicker) {
      onOpenPicker();
      return;
    }
    if (isOpen) {
      setIsOpen(false);
      return;
    }
    // ボタンの下に開く（画面の下半分にあるとき＝サイドバーを下に置いたときは上に）
    const r = buttonRef.current?.getBoundingClientRect();
    if (r) {
      const width = Math.min(Math.max(r.width, POP_WIDTH), window.innerWidth - 16);
      const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
      setPos(r.top > window.innerHeight / 2 ? { left, width, bottom: window.innerHeight - r.top + 4 } : { left, width, top: r.bottom + 4 });
    }
    setQuery("");
    setMenuFor(null);
    setConfirmRemove(null);
    setNote(null);
    setIsOpen(true);
  }

  const currentKey = `${owner}/${repo}`;
  const current = projects.find((p) => keyOf(p) === currentKey);
  const label = current?.name || currentKey;
  const q = query.trim().toLowerCase();
  const shown = projects.filter((p) => !q || keyOf(p).toLowerCase().includes(q) || (p.name ?? "").toLowerCase().includes(q));

  async function choose(p: Project) {
    setIsOpen(false);
    if (keyOf(p) !== currentKey) await onSwitch(p.owner, p.repo);
  }

  // うまくいったら、メニューを閉じる
  const closeMenuIf = (ok: boolean) => {
    if (!ok) return;
    setMenuFor(null);
    setConfirmRemove(null);
  };

  return (
    <div className="repo-switcher" ref={rootRef}>
      <button type="button" ref={buttonRef} className={`repo-switch${isOpen ? " open" : ""}`} onClick={toggle}
        title={tr("リポジトリを切り替える・追加する")} aria-haspopup={onOpenPicker ? "dialog" : "menu"} aria-expanded={isOpen}>
        <span className="repo-switch-icon" aria-hidden="true">📦</span>
        <span className="repo-switch-name">{label}</span>
        <span className="repo-switch-chev" aria-hidden="true">▾</span>
      </button>
      {isOpen && (
        <div className="repo-pop" style={pos}>
          {projects.length > 4 && (
            <input className="input-full repo-pop-search" value={query} autoFocus placeholder={tr("リポジトリを探す")}
              onChange={(e) => setQuery(e.target.value)} />
          )}
          <div className="repo-pop-list">
            {shown.map((p) => {
              const k = keyOf(p);
              const folder = folders[k];
              const isCurrent = k === currentKey;
              return (
                <div key={k} className="repo-item">
                  <div className={`repo-row${isCurrent ? " on" : ""}`}>
                    <button type="button" className="repo-row-main" onClick={() => choose(p)} disabled={busy !== null}>
                      <span className="repo-row-check" aria-hidden="true">{isCurrent ? "✓" : ""}</span>
                      <span className="repo-row-body">
                        <span className="repo-row-name">{p.name || k}</span>
                        {p.name && p.name !== k && <span className="repo-row-sub">{k}</span>}
                        {!isMobile && (
                          <span className="repo-row-sub" title={folder}>{folder ? `📁 ${folder}` : tr("この PC にはありません")}</span>
                        )}
                      </span>
                    </button>
                    <button type="button" className={`repo-row-more${menuFor === k ? " on" : ""}`} aria-label={tr("{k} の操作", { k })}
                      disabled={busy !== null} onClick={() => { setMenuFor(menuFor === k ? null : k); setConfirmRemove(null); }}>
                      ⋯
                    </button>
                  </div>
                  {menuFor === k && (
                    <div className="repo-row-menu" role="menu">
                      {!isMobile &&
                        (folder ? (
                          <>
                            <button type="button" role="menuitem" onClick={async () => closeMenuIf(await pickFolder(p))}>{tr("📁 この PC のフォルダを変える…")}</button>
                            <button type="button" role="menuitem" onClick={() => revealItemInDir(folder).catch((e) => setNote({ key: k, kind: "error", text: String(e) }))}>
                              {tr("🗂 エクスプローラーで表示")}
                            </button>
                            <button type="button" role="menuitem" onClick={async () => closeMenuIf(await clearFolder(p))}>{tr("フォルダの設定を外す（フォルダは消えません）")}</button>
                          </>
                        ) : (
                          <>
                            <button type="button" role="menuitem" onClick={async () => closeMenuIf(await clone(p))}>{tr("⬇ この PC にクローンする…")}</button>
                            <button type="button" role="menuitem" onClick={async () => closeMenuIf(await pickFolder(p))}>{tr("📁 この PC のフォルダを選ぶ…")}</button>
                          </>
                        ))}
                      <button type="button" role="menuitem" onClick={() => openUrl(`https://github.com/${k}`).catch(() => {})}>{tr("↗ GitHub で開く")}</button>
                      {isCurrent ? (
                        <span className="repo-row-menu-note">{tr("今のリポジトリは一覧から外せません（ほかに切り替えてから）")}</span>
                      ) : confirmRemove === k ? (
                        <span className="repo-row-confirm">
                          {tr("一覧から外しますか？（GitHub のリポジトリやフォルダは消えません）")}
                          <span className="repo-row-confirm-actions">
                            <button type="button" className="btn-danger" onClick={async () => closeMenuIf(await remove(p))} disabled={busy !== null}>{tr("外す")}</button>
                            <button type="button" className="btn-sm" onClick={() => setConfirmRemove(null)}>{tr("やめる")}</button>
                          </span>
                        </span>
                      ) : (
                        <button type="button" role="menuitem" className="repo-row-menu-red" onClick={() => setConfirmRemove(k)}>{tr("一覧から外す")}</button>
                      )}
                    </div>
                  )}
                  {busy === k && (
                    <p className="repo-note">
                      <i className="spinner" aria-hidden="true" /> {" "}{tr("実行しています…（クローンは大きなリポジトリだと時間がかかります）")}
                    </p>
                  )}
                  {note?.key === k && (
                    <p className={`repo-note repo-note--${note.kind}`}>
                      {note.text}
                      {note.command && <code>{note.command}</code>}
                    </p>
                  )}
                </div>
              );
            })}
            {shown.length === 0 && <p className="repo-note">{projects.length === 0 ? tr("まだありません") : tr("見つかりません")}</p>}
          </div>
          <button type="button" className="repo-add" onClick={() => { setIsOpen(false); onAdd(); }} disabled={busy !== null}>
            {tr("＋ リポジトリを追加…")}
          </button>
        </div>
      )}
    </div>
  );
}
