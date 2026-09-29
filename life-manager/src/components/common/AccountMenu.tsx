import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { checkToken, expiryOf, EXPIRY_WARN_DAYS, KIND_LABELS, listAccounts, SIGNED_OUT_STORE, type SavedAccount, type TokenReport } from "../../lib/auth";
import { isEscape } from "../../lib/keys";

interface AccountMenuProps {
  /** ログインしている人の名前（トークンを読めない・つながっていないときは、これだけを出す） */
  login: string;
  /** 設定 → トークン を開く */
  onOpenTokens: () => void;
  /** ログアウト（今のアカウントだけ。ほかにしまってあるアカウントがあれば、そちらに切り替わる） */
  onSignOut: () => Promise<void>;
  /** しまってあるアカウントに切り替える（今のアカウントのアイコンも渡して、一覧に出せるようにする） */
  onSwitchAccount: (login: string, currentAvatar?: string | null) => Promise<void>;
  /** 別のアカウントを足す（今のアカウントをしまって、ログインの画面へ） */
  onAddAccount: (currentAvatar?: string | null) => Promise<void>;
  /** しまってあるアカウントを、この PC から外す */
  onForgetAccount: (login: string) => Promise<void>;
  /** 切り替えられない理由（送っていない変更があるなど） */
  switchBlocked?: string;
}

/** メニューの幅（画面の端からはみ出さないように置くため。CSS の .account-menu と同じ） */
const MENU_WIDTH = 260;

function Avatar({ url, name }: { url?: string | null; name: string }) {
  return url ? (
    <img className="account-avatar" src={url} alt="" />
  ) : (
    <span className="account-avatar account-avatar--letter" aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>
  );
}

/** しまってあるアカウントの見出し（使うリポジトリ） */
function projectsText(a: SavedAccount): string {
  if (a.projects.length === 0) return "リポジトリなし";
  return a.projects.length === 1 ? a.projects[0] : `${a.projects[0]} など ${a.projects.length} 件`;
}

/**
 * サイドバーの一番下の、ログインしているアカウント（Claude Desktop のように）。アイコン・名前・期限を出し、
 * 押すとメニュー: だれがどの方法で入っているか、アカウントを切り替える（この PC でログインしたアカウント・別のアカウントを足す）、
 * 名前をコピー、GitHub のページ、ログインとトークン（設定 → トークン）、ログアウト（その場で確かめる）
 */
export function AccountMenu({ login, onOpenTokens, onSignOut, onSwitchAccount, onAddAccount, onForgetAccount, switchBlocked }: AccountMenuProps) {
  const [report, setReport] = useState<TokenReport | null>(null);
  const [open, setOpen] = useState(false);
  // メニューの中身: いつもの項目か、アカウントの一覧か
  const [pane, setPane] = useState<"main" | "accounts">("main");
  const [accounts, setAccounts] = useState<SavedAccount[] | null>(null);
  // 外すのを確かめているアカウント
  const [forgetting, setForgetting] = useState<string | null>(null);
  const [pos, setPos] = useState<CSSProperties>({});
  const [confirmOut, setConfirmOut] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // だれのトークンか（アイコン・期限）。ログインし直したときのため、名前が変わったときと、メニューを開いたときにも読み直す
  const load = useCallback(async () => {
    try {
      setReport(await checkToken({ repos: [] }));
    } catch {
      // つながっていないときは、名前だけ出す
    }
  }, []);
  useEffect(() => {
    load();
  }, [load, login]);

  const loadAccounts = useCallback(async () => {
    try {
      setAccounts(await listAccounts());
    } catch {
      setAccounts([]);
    }
  }, []);

  // 外を押す・Esc で閉じる（アカウントの一覧を出しているときの Esc は、いつもの項目に戻る）
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (!isEscape(e)) return;
      if (pane === "accounts") setPane("main");
      else setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, pane]);

  function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    // 画面の下半分にあれば上に、上半分にあれば下に開く（サイドバーを上・下に置いたときも、はみ出さないように）
    const r = buttonRef.current?.getBoundingClientRect();
    if (r) {
      const left = Math.max(8, Math.min(r.left, window.innerWidth - MENU_WIDTH - 8));
      setPos(r.top > window.innerHeight / 2 ? { left, bottom: window.innerHeight - r.top + 6 } : { left, top: r.bottom + 6 });
    }
    setPane("main");
    setForgetting(null);
    setConfirmOut(false);
    setCopied(false);
    setOpen(true);
    load();
    loadAccounts();
  }

  const name = report?.login ?? login;
  const expiry = report ? expiryOf(report) : null;
  const warn = !!expiry && expiry.days <= EXPIRY_WARN_DAYS;
  const shortDate = expiry ? expiry.date.split("/").slice(1).join("/") : "";

  async function copyName() {
    try {
      await navigator.clipboard.writeText(name);
      setCopied(true);
    } catch {
      // コピーできなくても、名前は出ている
    }
  }

  async function signOutNow() {
    setBusy(true);
    try {
      try {
        // 最初の画面で、GitHub での許可の取り消し方を出すため
        sessionStorage.setItem(SIGNED_OUT_STORE, report?.kind ?? "token");
      } catch {
        // 出せなくても、ログアウトはできる
      }
      await onSignOut();
    } finally {
      setBusy(false);
    }
  }

  // 切り替える・足す・外す（押したらメニューは閉じる。外すは、その場で一覧を読み直す）
  async function run(action: () => Promise<void>, close = true) {
    setBusy(true);
    try {
      await action();
      if (close) setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  if (!name) return null;

  const others = accounts ?? [];

  return (
    <div className="account" ref={rootRef}>
      <button type="button" ref={buttonRef} className={`account-button${open ? " open" : ""}`} onClick={toggle}
        title={report ? `${name}（${KIND_LABELS[report.kind]}）` : name} aria-haspopup="menu" aria-expanded={open}>
        <Avatar url={report?.avatar_url} name={name} />
        <span className="account-who">
          <span className="account-name">{name}</span>
          {expiry && (
            <span className={`account-sub${warn ? " warn" : ""}`}>
              期限 {shortDate}（{expiry.days < 0 ? "切れています" : `あと ${expiry.days} 日`}）
            </span>
          )}
        </span>
        <span className="account-chev" aria-hidden="true">{open ? "⌄" : "⌃"}</span>
      </button>
      {open && pane === "main" && (
        <div className="account-menu" role="menu" style={pos}>
          <div className="account-menu-head">
            <Avatar url={report?.avatar_url} name={name} />
            <div>
              <b>{name}</b>
              {report && <span className="token-kind">{KIND_LABELS[report.kind]}</span>}
              {report && (
                <div className={`account-menu-sub${warn ? " warn" : ""}`}>
                  {expiry
                    ? `${report.kind === "app" ? "この PC の期限" : "トークンの期限"} ${expiry.date}（${expiry.days < 0 ? "切れています" : `あと ${expiry.days} 日`}）`
                    : "期限なし"}
                </div>
              )}
            </div>
          </div>
          {/* 期限のすぐ下: アカウントを切り替える（押すと、この PC でログインしたアカウントの一覧） */}
          <button type="button" role="menuitem" className="account-item account-switch" onClick={() => { setForgetting(null); setPane("accounts"); }}>
            <span>⇄ アカウントを切り替える</span>
            <span className="account-switch-count">{others.length > 0 ? `ほかに ${others.length}` : ""} ›</span>
          </button>
          <div className="account-sep" />
          <button type="button" role="menuitem" className="account-item" onClick={copyName} title="チームのリーダーに伝えるときなどに">
            📋 {copied ? "✔ コピーしました" : "名前をコピー"}
          </button>
          <button type="button" role="menuitem" className="account-item"
            onClick={() => { openUrl(`https://github.com/${encodeURIComponent(name)}`).catch(() => {}); setOpen(false); }}>
            ↗ GitHub のページを開く
          </button>
          <button type="button" role="menuitem" className="account-item" onClick={() => { setOpen(false); onOpenTokens(); }}>
            🔑 ログインとトークン…
          </button>
          <div className="account-sep" />
          {!confirmOut ? (
            <button type="button" role="menuitem" className="account-item account-out" onClick={() => setConfirmOut(true)}>
              ⎋ {name} からログアウト
            </button>
          ) : (
            <div className="account-confirm">
              <span>
                この PC から、{name} のログインの鍵を消します。
                {others.length > 0 && `${others[0].login} に切り替わります。`}
              </span>
              <span className="account-confirm-actions">
                <button type="button" className="btn-danger" disabled={busy} onClick={signOutNow}>
                  {busy ? "ログアウトしています…" : "ログアウトする"}
                </button>
                <button type="button" className="btn-sm" disabled={busy} onClick={() => setConfirmOut(false)}>やめる</button>
              </span>
            </div>
          )}
        </div>
      )}
      {open && pane === "accounts" && (
        <div className="account-menu" role="menu" style={pos}>
          <div className="account-pane-head">
            <button type="button" className="account-back" onClick={() => setPane("main")} aria-label="戻る">‹</button>
            <b>アカウントを切り替える</b>
          </div>
          {switchBlocked && <p className="account-blocked">⚠ {switchBlocked}</p>}
          <div className="account-row current" aria-current="true">
            <Avatar url={report?.avatar_url} name={name} />
            <span className="account-row-who">
              <b>{name}</b>
              <small>今のアカウント</small>
            </span>
            <span className="account-row-mark" aria-hidden="true">✓</span>
          </div>
          {accounts === null && <p className="account-row-note">読み込んでいます…</p>}
          {others.map((a) => (
            forgetting === a.login ? (
              <div key={a.login} className="account-confirm">
                <span>{a.login} を、この PC から外します（ログアウト）。使うリポジトリの一覧は残るので、もう一度ログインすれば続きから使えます。</span>
                <span className="account-confirm-actions">
                  <button type="button" className="btn-danger" disabled={busy}
                    onClick={() => run(async () => { await onForgetAccount(a.login); setForgetting(null); await loadAccounts(); }, false)}>
                    外す
                  </button>
                  <button type="button" className="btn-sm" disabled={busy} onClick={() => setForgetting(null)}>やめる</button>
                </span>
              </div>
            ) : (
              <div key={a.login} className="account-row">
                <button type="button" role="menuitem" className="account-row-main" disabled={busy || !!switchBlocked}
                  onClick={() => run(() => onSwitchAccount(a.login, report?.avatar_url))} title={`${a.login} に切り替える`}>
                  <Avatar url={a.avatar_url} name={a.login} />
                  <span className="account-row-who">
                    <b>{a.login}</b>
                    <small>{projectsText(a)}</small>
                  </span>
                </button>
                <button type="button" className="account-row-forget" disabled={busy} onClick={() => setForgetting(a.login)}
                  title={`${a.login} を、この PC から外す（ログアウト）`}>
                  外す
                </button>
              </div>
            )
          ))}
          <button type="button" role="menuitem" className="account-item account-add" disabled={busy || !!switchBlocked}
            onClick={() => run(() => onAddAccount(report?.avatar_url))}>
            ＋ 別のアカウントを追加…
          </button>
          <p className="account-row-note">
            アカウントごとに、使うリポジトリの一覧を覚えます。今のアカウントはログアウトしないので、いつでもここから戻れます。
          </p>
        </div>
      )}
    </div>
  );
}
