import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { answerInvitation, listMyInvitations, orgInvitationUrl, type MyInvitations, type RepoInvitation } from "../../lib/team";

/** 自分宛ての招待を確かめに行く間隔 */
const POLL_MS = 30000;

function ago(iso: string): string {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86400000);
  return days <= 0 ? "今日" : days === 1 ? "昨日" : `${days} 日前`;
}

interface InvitesForMeProps {
  /** 参加した（「持ち主/名前」） */
  onJoined?: (fullName: string) => void;
  /** 組織への招待が減った（GitHub の画面で参加した）。使えるリポジトリを読み直すため */
  onOrgsChanged?: () => void;
  /** 30 秒ごとに確かめる（招待を待っているあいだ） */
  poll?: boolean;
  /** 招待がないときに出すもの（なければ何も出さない） */
  empty?: ReactNode;
}

/**
 * 自分宛ての招待。リポジトリへの招待は、メールを開かずにここで「参加する」。
 * 組織への招待は、アプリに組織の権限（write:org）がないので、GitHub の画面を開いて参加する
 */
export function InvitesForMe({ onJoined, onOrgsChanged, poll = false, empty }: InvitesForMeProps) {
  const [data, setData] = useState<MyInvitations | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [declining, setDeclining] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const orgCount = useRef<number | null>(null);
  const orgsChanged = useRef(onOrgsChanged);
  orgsChanged.current = onOrgsChanged;

  const load = useCallback(async () => {
    try {
      const next = await listMyInvitations();
      setData(next);
      setError(null);
      if (orgCount.current !== null && next.orgs.length < orgCount.current) orgsChanged.current?.();
      orgCount.current = next.orgs.length;
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    load();
    if (!poll) return;
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load, poll]);

  async function answer(inv: RepoInvitation, accept: boolean) {
    setBusy(inv.id);
    setDeclining(null);
    setError(null);
    try {
      await answerInvitation(inv.id, accept);
      setData((d) => d && { ...d, repos: d.repos.filter((r) => r.id !== inv.id) });
      if (accept) onJoined?.(inv.repository.full_name);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  const repos = (data?.repos ?? []).filter((r) => !r.expired);
  const orgs = data?.orgs ?? [];
  if (!error && repos.length === 0 && orgs.length === 0) return data && empty ? <>{empty}</> : null;

  return (
    <div className="invites">
      {repos.map((inv) => (
        <div key={inv.id} className="invite-row">
          <span className="invite-icon" aria-hidden="true">📨</span>
          <span className="invite-main">
            <b>{inv.repository.full_name}</b>
            <small>{inv.inviter ? `${inv.inviter.login} さんからの招待` : "リポジトリへの招待"}・{ago(inv.created_at)}</small>
          </span>
          {declining === inv.id ? (
            <>
              <span className="invite-ask">断りますか？（もう一度招待してもらうまで入れません）</span>
              <button type="button" className="btn-sm" disabled={busy !== null} onClick={() => answer(inv, false)}>断る</button>
              <button type="button" className="btn-sm" onClick={() => setDeclining(null)}>やめる</button>
            </>
          ) : (
            <>
              <button type="button" className="btn-primary" disabled={busy !== null} onClick={() => answer(inv, true)}>
                {busy === inv.id ? "参加しています…" : "参加する"}
              </button>
              <button type="button" className="btn-sm" disabled={busy !== null} onClick={() => setDeclining(inv.id)}>断る</button>
            </>
          )}
        </div>
      ))}
      {orgs.map((o) => (
        <div key={o.organization.login} className="invite-row">
          <span className="invite-icon" aria-hidden="true">🏫</span>
          <span className="invite-main">
            <b>組織 {o.organization.login}</b>
            <small>組織への招待（GitHub の画面で「Join」を押して参加します）</small>
          </span>
          <button type="button" className="btn-sm" onClick={() => openUrl(orgInvitationUrl(o.organization.login)).catch(() => {})}>
            GitHub で参加 ↗
          </button>
        </div>
      ))}
      {error && <p className="token-error">招待を読めませんでした（{error}）</p>}
    </div>
  );
}
