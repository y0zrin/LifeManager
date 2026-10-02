import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { checkToken, expiryOf, listAccounts, type SavedAccount, type TokenReport } from "../../lib/auth";
import { isEnter, isEscape } from "../../lib/keys";
import { countOf } from "../../lib/count";
import { usePortalHost } from "../../hooks/usePortalHost";
import { THIS_DEVICE, isMobile } from "../../lib/platform";

interface AccountPickerProps {
  /** 今のアカウント */
  login: string;
  /** 今のアカウントで使うリポジトリの数（一覧にある数） */
  currentProjects: number;
  /** 起動したときに出した（「今のアカウント」を選ぶと、そのまま始まる） */
  startup?: boolean;
  onSwitch: (login: string, currentAvatar?: string | null) => Promise<void>;
  onAdd: (currentAvatar?: string | null) => Promise<void>;
  onForget: (login: string) => Promise<void>;
  onClose: () => void;
  /** 切り替えられない理由（送っていない変更があるなど） */
  switchBlocked?: string;
}

type Person =
  | { kind: "current"; login: string; avatar: string | null; projects: number; expiry: string | null }
  | { kind: "saved"; login: string; avatar: string | null; projects: number }
  | { kind: "add" };

/** 画像のない人の丸の色（名前で決まる。いつも同じ。色はテーマの --lane-0〜9） */
function faceColor(login: string): string {
  let h = 0;
  for (const ch of login) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `var(--lane-${h % 10})`;
}

function useClock(): string {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 15000);
    return () => window.clearInterval(id);
  }, []);
  return `${now.getHours()}:${String(now.getMinutes()).padStart(2, "0")}`;
}

/**
 * アカウントを選ぶ画面（PS5 のアカウントを選ぶ画面のように）。大きな丸を横に並べ、選んでいる人を大きく・輪で囲む。
 * ← → で選んで Enter（マウスでも）。いちばん右は「アカウントを追加」。選んでいる人の「この PC から外す…」。
 * この PC にアカウントが 2 つ以上あると、起動したときにも出す（学校の PC などを何人かで使うとき）。色はテーマのもの
 */
export function AccountPicker({ login, currentProjects, startup, onSwitch, onAdd, onForget, onClose, switchBlocked }: AccountPickerProps) {
  const [report, setReport] = useState<TokenReport | null>(null);
  const [accounts, setAccounts] = useState<SavedAccount[] | null>(null);
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [forgetting, setForgetting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const clock = useClock();
  const host = usePortalHost();
  const quest = document.documentElement.dataset.theme === "quest";

  const load = useCallback(async () => {
    setAccounts(await listAccounts().catch(() => []));
  }, []);
  useEffect(() => {
    checkToken({ repos: [] }).then(setReport).catch(() => {});
    load();
  }, [load]);

  const people = useMemo<Person[]>(() => {
    const expiry = report ? expiryOf(report) : null;
    const current: Person = {
      kind: "current",
      login: report?.login ?? login,
      avatar: report?.avatar_url ?? null,
      projects: currentProjects,
      expiry: expiry ? `期限 ${expiry.date.split("/").slice(1).join("/")}${expiry.days < 0 ? "（切れています）" : ""}` : null,
    };
    const saved: Person[] = (accounts ?? []).map((a) => ({ kind: "saved", login: a.login, avatar: a.avatar_url, projects: a.projects.length }));
    return [current, ...saved, { kind: "add" }];
  }, [report, accounts, login, currentProjects]);

  const focused = people[Math.min(index, people.length - 1)];

  const activate = useCallback(
    async (p: Person) => {
      if (busy) return;
      setError(null);
      if (p.kind === "current") {
        onClose();
        return;
      }
      if (switchBlocked) {
        setError(switchBlocked);
        return;
      }
      setBusy(p.kind === "add" ? "ログインの画面を開いています…" : `${p.login} に切り替えています…`);
      try {
        if (p.kind === "add") await onAdd(report?.avatar_url);
        else await onSwitch(p.login, report?.avatar_url);
        onClose();
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(null);
      }
    },
    [busy, onAdd, onClose, onSwitch, report, switchBlocked],
  );

  // ← → で選ぶ・Enter で決める・Esc で閉じる（起動したときは、今のアカウントで始める）
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      e.stopPropagation();
      if (forgetting) {
        if (isEscape(e)) setForgetting(null);
        return;
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        setIndex((i) => Math.min(people.length - 1, i + 1));
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        setIndex((i) => Math.max(0, i - 1));
      } else if (isEnter(e) && !(e.target instanceof HTMLButtonElement)) {
        // ボタン（「この PC から外す…」・× など）に移っているときは、そのボタンを押す（選んでいる人に切り替えない）
        e.preventDefault();
        activate(focused);
      } else if (isEscape(e) && !busy) {
        onClose();
      }
    }
    // 先に受けて、下の画面には渡さない（ボードの ← → や Ctrl+K などが動かないように）
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [people.length, focused, activate, busy, onClose, forgetting]);

  async function forget(target: string) {
    setBusy(`${target} を外しています…`);
    try {
      await onForget(target);
      setForgetting(null);
      setIndex(0);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  if (!host) return null;
  return createPortal(
    <div className="picker" role="dialog" aria-label="アカウントを選ぶ">
      <div className="picker-top">
        <span className="picker-logo" aria-hidden="true">L</span>
        <span>Life Manager</span>
        <span className="picker-grow" />
        <span className="picker-clock">{clock}</span>
        {!startup && (
          <button type="button" className="picker-close" onClick={onClose} aria-label="閉じる" title="閉じる（Esc）">×</button>
        )}
      </div>
      <h2 className="picker-title">{quest ? "だれが冒険しますか？" : "だれが使いますか？"}</h2>
      <div className="picker-people" role="listbox" aria-label="アカウント">
        {people.map((p, i) => {
          const on = i === index;
          const key = p.kind === "add" ? "+add" : p.login;
          return (
            <button key={key} type="button" role="option" aria-selected={on}
              className={`picker-person${on ? " on" : ""}${p.kind === "add" ? " picker-person-add" : ""}`}
              onMouseEnter={() => setIndex(i)} onFocus={() => setIndex(i)} onClick={() => activate(p)} disabled={!!busy}>
              {p.kind === "add" ? (
                <span className="picker-face" aria-hidden="true">＋</span>
              ) : p.avatar ? (
                <img className="picker-face" src={p.avatar} alt="" />
              ) : (
                <span className="picker-face" style={{ background: faceColor(p.login) }} aria-hidden="true">{p.login.slice(0, 1).toUpperCase()}</span>
              )}
              <span className="picker-name">{p.kind === "add" ? "アカウントを追加" : p.login}</span>
              {on && p.kind !== "add" && (
                <span className="picker-sub">
                  {p.kind === "current" && <>今のアカウント<br /></>}
                  {p.projects > 0 ? `使うリポジトリ ${countOf(p.projects, "件")}` : "リポジトリなし"}
                  {p.kind === "current" && p.expiry && <><br />{p.expiry}</>}
                </span>
              )}
              {on && p.kind === "add" && <span className="picker-sub">GitHub でログイン<br />（アカウントを作ることも）</span>}
            </button>
          );
        })}
      </div>
      {(busy || error) && (
        <p className={`picker-status${error ? " err" : ""}`}>
          {busy && <i className="spinner" aria-hidden="true" />} {busy ?? error}
        </p>
      )}
      {!isMobile && (<div className="picker-hint" aria-hidden="true">
        <span><b>← →</b>選ぶ</span>
        <span><b>Enter</b>{focused.kind === "current" ? "はじめる" : focused.kind === "add" ? "追加する" : "切り替える"}</span>
        {!startup && <span><b>Esc</b>閉じる</span>}
      </div>)}
      {focused.kind === "saved" && (
        forgetting === focused.login ? (
          <div className="picker-forget-confirm">
            {focused.login} を、{THIS_DEVICE}から外します（ログアウト）。もう一度ログインすれば、続きから使えます。
            <button type="button" className="btn-danger" onClick={() => forget(focused.login)} disabled={!!busy}>外す</button>
            <button type="button" className="btn-sm" onClick={() => setForgetting(null)}>やめる</button>
          </div>
        ) : (
          <button type="button" className="picker-forget" onClick={() => setForgetting(focused.login)} disabled={!!busy}>
            {focused.login} を{THIS_DEVICE}から外す…
          </button>
        )
      )}
    </div>,
    host,
  );
}
