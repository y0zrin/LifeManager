import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { checkToken } from "../../lib/auth";
import { isEnter, isEscape } from "../../lib/keys";
import { ago } from "../../lib/pulls";
import { repoCard, type RepoCard } from "../../lib/repoCard";
import type { Project } from "../../lib/types";
import { repoKey, useRepoFolderActions } from "../../hooks/useRepoFolderActions";
import { usePortalHost } from "../../hooks/usePortalHost";

interface RepoPickerProps {
  projects: Project[];
  /** 今のリポジトリ */
  owner: string;
  repo: string;
  /** 今のアカウント */
  login: string;
  /** この PC の作業フォルダ（キーは "owner/repo"） */
  folders: Record<string, string>;
  onSwitch: (owner: string, repo: string) => void | Promise<void>;
  /** 一覧から外す（GitHub のリポジトリやフォルダは消さない） */
  onRemove: (owner: string, repo: string) => Promise<void>;
  /** null なら、フォルダの設定を外す（フォルダそのものは消さない） */
  onSetFolder: (owner: string, repo: string, path: string | null) => Promise<void>;
  /** リポジトリを追加（ウィザード）を開く */
  onAdd: () => void;
  /** アカウントを選ぶ画面を開く */
  onOpenAccounts: () => void;
  onClose: () => void;
}

/** カード（読み込み中は undefined、読めなかったら error） */
type CardState = RepoCard | { error: string };

/** カードを読めなかったわけ（GitHub の答えの文をそのまま出さない） */
function cardErrorText(e: string): string {
  if (/\b404\b/.test(e)) return "GitHub で見つかりません（名前が変わった・消えた、または Life Manager にこのリポジトリを読む許可を出していない）";
  if (/\b40[13]\b/.test(e)) return "読む許可がありません（ログインし直すか、リポジトリの持ち主に招待してもらいます）";
  if (/network|dns|connect|timed? ?out|offline/i.test(e)) return "GitHub につながりません（つながったら、また読みます）";
  return e.length > 120 ? `${e.slice(0, 120)}…` : e;
}

/** 「クローンせずに開く」を選んだリポジトリ（次からは聞かない。この PC だけ） */
const NO_CLONE_KEY = "repo-picker-no-clone";

function readNoClone(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(NO_CLONE_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function rememberNoClone(key: string) {
  try {
    localStorage.setItem(NO_CLONE_KEY, JSON.stringify([...new Set([...readNoClone(), key])]));
  } catch {
    // 覚えられなくても、次にまた聞くだけ
  }
}

/** まん中からいくつ離れているか（となりを左右に。3 つ以上なら、ぐるっと回る） */
function offsetOf(i: number, index: number, n: number): number {
  if (n < 3) return i - index;
  let d = (i - index + n) % n;
  if (d > n / 2) d -= n;
  return d;
}

function placeOf(d: number): string {
  if (d === 0) return "on";
  if (d === -1) return "side left";
  if (d === 1) return "side right";
  return d < 0 ? "far left" : "far right";
}

/**
 * リポジトリを選ぶ画面（ブランチ画面のように）。まん中に大きく、左右にとなりのリポジトリ。
 * カードに 開いている Issue・レビュー待ち・最後の更新・この PC のフォルダ。← → で選んで Enter で開く
 * （この PC にまだないときは、開くときに「クローンしますか？」。クローンせずに開くと、次からは聞かない）。
 * 下の帯で一覧・「＋ リポジトリを追加…」。右上の自分を押すと、アカウントを選ぶ画面へ。色はテーマのもの
 */
export function RepoPicker({ projects, owner, repo, login, folders, onSwitch, onRemove, onSetFolder, onAdd, onOpenAccounts, onClose }: RepoPickerProps) {
  const currentKey = `${owner}/${repo}`;
  const [index, setIndex] = useState(() => Math.max(0, projects.findIndex((p) => repoKey(p) === currentKey)));
  const [cards, setCards] = useState<Record<string, CardState>>({});
  const [avatar, setAvatar] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  // 開くときに「クローンしますか？」を出している
  const [askClone, setAskClone] = useState(false);
  const [noClone, setNoClone] = useState(readNoClone);
  const { busy, note, setNote, pickFolder, clone, clearFolder, remove } = useRepoFolderActions(folders, onSetFolder, onRemove);
  const stripRef = useRef<HTMLDivElement>(null);
  const host = usePortalHost();

  const n = projects.length;
  const at = Math.min(index, Math.max(0, n - 1));
  const focused: Project | undefined = projects[at];
  const focusedKey = focused ? repoKey(focused) : "";

  useEffect(() => {
    checkToken({ repos: [] }).then((r) => setAvatar(r.avatar_url)).catch(() => {});
  }, []);

  // 見ているカードを読む（← → を続けて押したときは、止まったところだけ）
  useEffect(() => {
    if (!focused || cards[focusedKey]) return;
    const timer = window.setTimeout(() => {
      repoCard(focused.owner, focused.repo)
        .then((c) => setCards((m) => ({ ...m, [focusedKey]: c })))
        .catch((e) => setCards((m) => ({ ...m, [focusedKey]: { error: String(e) } })));
    }, 160);
    return () => window.clearTimeout(timer);
  }, [focused, focusedKey, cards]);

  // 選んだものを、下の帯で見えるところに
  useEffect(() => {
    stripRef.current?.querySelector(".on")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [at]);

  const move = useCallback(
    (step: number) => {
      if (n === 0) return;
      setMenuOpen(false);
      setConfirmRemove(false);
      setAskClone(false);
      setNote(null);
      setIndex((i) => (Math.min(i, n - 1) + step + n) % n);
    },
    [n, setNote],
  );

  const openNow = useCallback(
    (p: Project) => {
      onClose();
      if (repoKey(p) !== currentKey) onSwitch(p.owner, p.repo);
    },
    [currentKey, onClose, onSwitch],
  );

  // 開く: この PC にまだなければ、先に「クローンしますか？」
  const open = useCallback(
    (p: Project) => {
      const k = repoKey(p);
      if (k !== currentKey && !folders[k] && !noClone.includes(k)) {
        setMenuOpen(false);
        setAskClone(true);
        return;
      }
      openNow(p);
    },
    [currentKey, folders, noClone, openNow],
  );

  async function cloneAndOpen(p: Project) {
    if (await clone(p)) openNow(p);
  }

  function openWithoutClone(p: Project) {
    rememberNoClone(repoKey(p));
    setNoClone(readNoClone());
    openNow(p);
  }

  function add() {
    onClose();
    onAdd();
  }

  // ← → で選ぶ・Enter で開く・Esc で閉じる（メニューを開いているときの Esc は、メニューを閉じる）
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      e.stopPropagation();
      if (busy) return;
      if (isEscape(e)) {
        e.preventDefault();
        if (menuOpen) setMenuOpen(false);
        else if (askClone) setAskClone(false);
        else onClose();
        return;
      }
      if (menuOpen || askClone) return;
      if (e.key === "ArrowRight") {
        e.preventDefault();
        move(1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        move(-1);
      } else if (isEnter(e) && focused && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault();
        open(focused);
      }
    }
    // 先に受けて、下の画面には渡さない（ボードの ← → や Ctrl+K などが動かないように）
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [busy, menuOpen, askClone, move, open, onClose, focused]);

  const quest = document.documentElement.dataset.theme === "quest";

  function renderFacts(card: CardState | undefined) {
    if (!card) {
      return (
        <div className="picker-facts loading" aria-busy="true">
          <div><b>…</b>開いている Issue</div><div><b>…</b>レビュー待ち</div><div><b>…</b>最後の更新</div>
        </div>
      );
    }
    if ("error" in card) return <p className="picker-card-error" title={card.error}>読めませんでした: {cardErrorText(card.error)}</p>;
    return (
      <div className="picker-facts">
        <div><b>{card.open_issues ?? "―"}</b>開いている Issue</div>
        <div><b>{card.review_waiting ?? "―"}</b>レビュー待ち</div>
        <div><b>{ago(card.pushed_at) || "―"}</b>最後の更新</div>
      </div>
    );
  }

  function badges(card: CardState | undefined) {
    if (!card || "error" in card) return null;
    const team = card.members === null ? (card.owner_type === "Organization" ? "組織" : null) : card.members > 1 ? `チーム ${card.members} 人` : "個人";
    return (
      <div className="picker-badges">
        <span className="picker-badge">{card.private ? "非公開" : "公開"}</span>
        {team && <span className="picker-badge">{team}</span>}
      </div>
    );
  }

  function renderMenu(p: Project) {
    const k = repoKey(p);
    const folder = folders[k];
    const isCurrent = k === currentKey;
    const closeIf = (ok: boolean) => {
      if (ok) setMenuOpen(false);
    };
    return (
      <div className="picker-menu" role="menu">
        {folder ? (
          <>
            <button type="button" role="menuitem" onClick={async () => closeIf(await pickFolder(p))}>📁 この PC のフォルダを変える…</button>
            <button type="button" role="menuitem" onClick={() => revealItemInDir(folder).catch((e) => setNote({ key: k, kind: "error", text: String(e) }))}>
              🗂 エクスプローラーで表示
            </button>
            <button type="button" role="menuitem" onClick={async () => closeIf(await clearFolder(p))}>フォルダの設定を外す（フォルダは消えません）</button>
          </>
        ) : (
          <>
            <button type="button" role="menuitem" onClick={async () => closeIf(await clone(p))}>⬇ この PC にクローンする…</button>
            <button type="button" role="menuitem" onClick={async () => closeIf(await pickFolder(p))}>📁 この PC のフォルダを選ぶ…</button>
          </>
        )}
        <button type="button" role="menuitem" onClick={() => openUrl(`https://github.com/${k}`).catch(() => {})}>↗ GitHub で開く</button>
        {isCurrent ? (
          <span className="picker-menu-note">今のリポジトリは一覧から外せません（ほかに切り替えてから）</span>
        ) : confirmRemove ? (
          <span className="picker-menu-confirm">
            一覧から外しますか？（GitHub のリポジトリやフォルダは消えません）
            <span className="picker-menu-actions">
              <button type="button" className="btn-danger" disabled={busy !== null}
                onClick={async () => {
                  if (await remove(p)) {
                    setMenuOpen(false);
                    setConfirmRemove(false);
                  }
                }}>
                外す
              </button>
              <button type="button" className="btn-sm" onClick={() => setConfirmRemove(false)}>やめる</button>
            </span>
          </span>
        ) : (
          <button type="button" role="menuitem" className="picker-menu-red" onClick={() => setConfirmRemove(true)}>一覧から外す</button>
        )}
      </div>
    );
  }

  if (!host) return null;
  return createPortal(
    <div className="picker" role="dialog" aria-label="リポジトリを選ぶ">
      <div className="picker-top">
        <span className="picker-logo" aria-hidden="true">L</span>
        <span>Life Manager</span>
        <span className="picker-grow" />
        <button type="button" className="picker-me" onClick={onOpenAccounts} title="アカウントを選ぶ画面を開く">
          {avatar ? <img className="picker-me-face" src={avatar} alt="" /> : <span className="picker-me-face" aria-hidden="true">{login.slice(0, 1).toUpperCase()}</span>}
          <span className="picker-me-who">
            {login}
            <small>アカウントを切り替える</small>
          </span>
        </button>
        <button type="button" className="picker-close" onClick={onClose} aria-label="閉じる" title="閉じる（Esc）">×</button>
      </div>
      <h2 className="picker-title small">{quest ? "どのリポジトリで冒険しますか？" : "どのリポジトリを開きますか？"}</h2>

      <div className="picker-deck">
        {n === 0 && (
          <div className="picker-card on empty">
            <p>まだリポジトリがありません。</p>
            <button type="button" className="picker-open" onClick={add}>＋ リポジトリを追加…</button>
          </div>
        )}
        {projects.map((p, i) => {
          const k = repoKey(p);
          const d = offsetOf(i, at, n);
          if (Math.abs(d) > 2) return null;
          const card = cards[k];
          const folder = folders[k];
          if (d !== 0) {
            // まん中と同じ要素のまま（位置が変わると、すべるように動く）
            return (
              <div key={k} className={`picker-card ${placeOf(d)}`} role="button" tabIndex={-1} aria-hidden={Math.abs(d) > 1 || undefined}
                onClick={() => move(d)} title={`${k} を選ぶ`}>
                <span className="picker-card-owner">{p.owner}</span>
                <span className="picker-card-name">{p.repo}</span>
              </div>
            );
          }
          const faces = card && !("error" in card) && (card.members ?? 0) > 1 ? card.faces ?? [] : [];
          return (
            <div key={k} className="picker-card on" aria-current={k === currentKey ? "true" : undefined}>
              {faces.length > 0 && (
                <span className="picker-team" aria-label={`チーム ${(card as RepoCard).members} 人`}>
                  {faces.map((f) => (f.avatar_url ? <img key={f.login} src={f.avatar_url} alt="" title={f.login} /> : <i key={f.login} title={f.login}>{f.login.slice(0, 1).toUpperCase()}</i>))}
                </span>
              )}
              <span className="picker-card-owner">
                {p.owner}
                {k === currentKey && <span className="picker-now">いま開いている</span>}
              </span>
              <span className="picker-card-name" title={card && !("error" in card) ? card.description ?? undefined : undefined}>{p.repo}</span>
              {badges(card)}
              {askClone ? (
                <div className="picker-ask">
                  <b>この PC にまだありません。クローンして開きますか？</b>
                  <span>クローンしておくと、この PC でコミット・プッシュ・プルができます。タスクだけなら、クローンしなくても使えます</span>
                </div>
              ) : (
                renderFacts(card)
              )}
              {askClone ? (
                <div className="picker-card-foot ask">
                  <span className="picker-card-actions">
                    <button type="button" className="picker-clone" disabled={busy !== null} onClick={() => openWithoutClone(p)}
                      title="クローンせずに開きます（次からは聞きません。あとで ⋯ からクローンできます）">
                      クローンせずに開く
                    </button>
                    <button type="button" className="picker-open" disabled={busy !== null} onClick={() => cloneAndOpen(p)} autoFocus
                      title="置き場所を選んで、この PC にクローンしてから開きます">
                      ⬇ クローンして開く…
                    </button>
                  </span>
                </div>
              ) : (
                <div className="picker-card-foot">
                  <span className="picker-here" title={folder}>
                    この PC: <b>{folder ?? "まだありません"}</b>
                    {!folder && !noClone.includes(k) && k !== currentKey && <small>（開くときにクローン）</small>}
                  </span>
                  <span className="picker-card-actions">
                    <button type="button" className={`picker-more${menuOpen ? " on" : ""}`} aria-label={`${k} の操作`} aria-expanded={menuOpen}
                      disabled={busy !== null} onClick={() => { setMenuOpen(!menuOpen); setConfirmRemove(false); }}>
                      ⋯
                    </button>
                    <button type="button" className="picker-open" disabled={busy !== null} onClick={() => open(p)} autoFocus>
                      {k === currentKey ? "戻る" : "開く"}
                    </button>
                  </span>
                </div>
              )}
              {menuOpen && renderMenu(p)}
              {busy === k && (
                <p className="picker-card-note">
                  <i className="spinner" aria-hidden="true" /> 実行しています…（クローンは、大きなリポジトリだと時間がかかります）
                </p>
              )}
              {note?.key === k && busy !== k && (
                <p className={`picker-card-note ${note.kind}`}>
                  {note.text}
                  {note.command && <code>{note.command}</code>}
                </p>
              )}
            </div>
          );
        })}
        {n > 1 && (
          <>
            <button type="button" className="picker-arrow left" onClick={() => move(-1)} aria-label="前のリポジトリ" tabIndex={-1}>‹</button>
            <button type="button" className="picker-arrow right" onClick={() => move(1)} aria-label="次のリポジトリ" tabIndex={-1}>›</button>
          </>
        )}
      </div>

      <div className="picker-strip" ref={stripRef}>
        {projects.map((p, i) => (
          <button key={repoKey(p)} type="button" className={i === at ? "on" : ""} onClick={() => move(offsetOf(i, at, n))}
            onDoubleClick={() => open(p)} title={`${repoKey(p)}（ダブルクリックで開く）`}>
            {p.repo}
          </button>
        ))}
        <button type="button" className="picker-strip-add" onClick={add}>＋ リポジトリを追加…</button>
      </div>
      <div className="picker-hint" aria-hidden="true">
        <span><b>← →</b>選ぶ</span>
        <span><b>Enter</b>開く</span>
        <span><b>Esc</b>閉じる</span>
      </div>
    </div>,
    host,
  );
}
