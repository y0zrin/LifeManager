import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { checkToken, expiryOf, EXPIRY_WARN_DAYS, KIND_LABELS, listAccounts, SIGNED_OUT_STORE, type SavedAccount, type TokenReport } from "../../lib/auth";
import { isEscape } from "../../lib/keys";
import { THIS_DEVICE } from "../../lib/platform";
import { tr, trx } from "../../lib/i18n";

interface AccountMenuProps {
  /** ログインしている人の名前（トークンを読めない・つながっていないときは、これだけを出す） */
  login: string;
  /** 設定 → トークン を開く */
  onOpenTokens: () => void;
  /** ログアウト（今のアカウントだけ。ほかにしまってあるアカウントがあれば、そちらに切り替わる） */
  onSignOut: () => Promise<void>;
  /** アカウントを選ぶ画面を開く（切り替える・足す・この PC から外す） */
  onOpenAccounts: () => void;
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

/**
 * サイドバーの一番下の、ログインしているアカウント（Claude Desktop のように）。アイコン・名前・期限を出し、
 * 押すとメニュー: だれがどの方法で入っているか、アカウントを切り替える（アカウントを選ぶ画面を開く）、
 * 名前をコピー、GitHub のページ、ログインとトークン（設定 → トークン）、ログアウト（その場で確かめる）
 */
export function AccountMenu({ login, onOpenTokens, onSignOut, onOpenAccounts }: AccountMenuProps) {
  const [report, setReport] = useState<TokenReport | null>(null);
  const [open, setOpen] = useState(false);
  const [accounts, setAccounts] = useState<SavedAccount[] | null>(null);
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
    // 別の人に切り替わったら、前の人の名前・期限を残さない（読み直せるまでは、名前だけ出す）
    setReport((r) => (r && login && r.login.toLowerCase() !== login.toLowerCase() ? null : r));
    load();
  }, [load, login]);

  const loadAccounts = useCallback(async () => {
    try {
      setAccounts(await listAccounts());
    } catch {
      setAccounts([]);
    }
  }, []);

  // 外を押す・Esc で閉じる
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (isEscape(e)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

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
              {expiry.days < 0 ? tr("期限 {date}（切れています）", { date: shortDate }) : tr("期限 {date}（あと {days} 日）", { date: shortDate, days: expiry.days })}
            </span>
          )}
        </span>
        <span className="account-chev" aria-hidden="true">{open ? "⌄" : "⌃"}</span>
      </button>
      {open && (
        <div className="account-menu" role="menu" style={pos}>
          <div className="account-menu-head">
            <Avatar url={report?.avatar_url} name={name} />
            <div>
              <b>{name}</b>
              {report && <span className="token-kind">{KIND_LABELS[report.kind]}</span>}
              {report && (
                <div className={`account-menu-sub${warn ? " warn" : ""}`}>
                  {expiry
                    ? `${report.kind === "app" ? tr("{THIS_DEVICE}の期限", { THIS_DEVICE }) : tr("トークンの期限")} ${expiry.date}（${expiry.days < 0 ? tr("切れています") : tr("あと {days} 日", { days: expiry.days })}）`
                    : tr("期限なし")}
                </div>
              )}
            </div>
          </div>
          {/* 期限のすぐ下: アカウントを切り替える（押すと、アカウントを選ぶ画面） */}
          <button type="button" role="menuitem" className="account-item account-switch" onClick={() => { setOpen(false); onOpenAccounts(); }}>
            <span>{tr("⇄ アカウントを切り替える")}</span>
            <span className="account-switch-count">{others.length > 0 ? tr("ほかに {length}", { length: others.length }) : ""} ›</span>
          </button>
          <div className="account-sep" />
          <button type="button" role="menuitem" className="account-item" onClick={copyName} title={tr("チームのリーダーに伝えるときなどに")}>
            📋 {copied ? tr("✔ コピーしました") : tr("名前をコピー")}
          </button>
          <button type="button" role="menuitem" className="account-item"
            onClick={() => { openUrl(`https://github.com/${encodeURIComponent(name)}`).catch(() => {}); setOpen(false); }}>
            {tr("↗ GitHub のページを開く")}
          </button>
          <button type="button" role="menuitem" className="account-item" onClick={() => { setOpen(false); onOpenTokens(); }}>
            {tr("🔑 ログインとトークン…")}
          </button>
          <div className="account-sep" />
          {!confirmOut ? (
            <button type="button" role="menuitem" className="account-item account-out" onClick={() => setConfirmOut(true)}>
              {trx("⎋ {name} からログアウト", { name })}
            </button>
          ) : (
            <div className="account-confirm">
              <span>
                {trx("{THIS_DEVICE}から、{name} のログインの鍵を消します。", { THIS_DEVICE, name })}
                {others.length > 0 && tr("{login} に切り替わります。", { login: others[0].login })}
              </span>
              <span className="account-confirm-actions">
                <button type="button" className="btn-danger" disabled={busy} onClick={signOutNow}>
                  {busy ? tr("ログアウトしています…") : tr("ログアウトする")}
                </button>
                <button type="button" className="btn-sm" disabled={busy} onClick={() => setConfirmOut(false)}>{tr("やめる")}</button>
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
