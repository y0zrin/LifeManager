import { useEffect, useState, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { authInstallUrl, TOKENS_PAGE } from "../../lib/auth";
import { hasPermission, installationPermissions, type InstallationInfo, type NeededPermission } from "../../lib/actions";

// 同じアカウントの権限は、開き直すまで覚えておく（画面ごとに読み直さない）
const cache = new Map<string, InstallationInfo>();

interface PermissionPromptProps {
  owner: string;
  currentUser: string;
  need: NeededPermission[];
  /** GitHub が断ったときの説明（そのまま小さく出す） */
  message?: string | null;
  onRetry?: () => void;
  /** 小さく（Actions の山の中の、セキュリティの行など） */
  compact?: boolean;
}

/** 権限が足りないときに、どこで何をすればよいかを促す（承認の画面を開く・リーダーに送る文をコピー・トークンの画面を開く） */
export function PermissionPrompt({ owner, currentUser, need, message, onRetry, compact }: PermissionPromptProps) {
  const [info, setInfo] = useState<InstallationInfo | null>(cache.get(owner) ?? null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    installationPermissions(owner)
      .then((i) => {
        cache.set(owner, i);
        if (alive) setInfo(i);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [owner]);

  const names = need.map((p) => `${p.name}（${p.access === "write" ? "Read and write" : "Read-only"}）`).join("・");
  const missing = info?.kind === "app" && info.installed ? need.filter((p) => !hasPermission(info.permissions, p)) : [];
  const mine = owner.toLowerCase() === currentUser.toLowerCase();
  const leaderText = `Life Manager で使えるように、GitHub の Settings → Applications → Installed GitHub Apps → Life Manager App（Configure）で、権限の更新（${need.map((p) => p.name).join("・")}）を承認してください。`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(leaderText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // 写せなくても、文は画面に出ている
    }
  }

  let body: ReactNode;
  if (!info) {
    body = <p className="muted">Life Manager の権限を確かめています…</p>;
  } else if (info.kind === "token") {
    body = (
      <>
        <p>
          今のトークン（自分で作ったトークン）に、<b>{names}</b> の権限を足します。GitHub のトークンの画面で、このトークンを選んで Edit → Repository permissions。
        </p>
        <div className="ac-setup-actions">
          <button type="button" className="btn-sm primary" onClick={() => openUrl(TOKENS_PAGE).catch(() => {})}>
            トークンの画面を開く ↗
          </button>
        </div>
      </>
    );
  } else if (!info.installed) {
    body = (
      <>
        <p>
          <b>{owner}</b> に Life Manager が入っていません。{mine ? "入れて、このリポジトリを選ぶと使えます。" : `持ち主（${owner}）が入れると使えます。`}
        </p>
        {mine && (
          <div className="ac-setup-actions">
            <button type="button" className="btn-sm primary" onClick={() => authInstallUrl().then((u) => openUrl(u)).catch(() => {})}>
              Life Manager を入れる画面を開く ↗
            </button>
          </div>
        )}
      </>
    );
  } else if (missing.length > 0) {
    body = (
      <>
        <p>
          まだ承認されていない権限: <b>{missing.map((p) => p.name).join("・")}</b>。
          {mine ? "開いた画面の上の「Review request」（権限の更新）から承認します。" : `持ち主（${owner}）が GitHub で承認します。`}
        </p>
        <div className="ac-setup-actions">
          {mine && info.html_url && (
            <button type="button" className="btn-sm primary" onClick={() => openUrl(info.html_url!).catch(() => {})}>
              GitHub で承認する ↗
            </button>
          )}
          {!mine && (
            <button type="button" className="btn-sm primary" onClick={copy}>
              {copied ? "✔ コピーしました" : "持ち主に送る文をコピー"}
            </button>
          )}
        </div>
        <p className="muted">承認の知らせが届いていないときは、Life Manager の作り手が権限を足したあとに届きます。</p>
      </>
    );
  } else {
    body = (
      <>
        <p>権限はそろっています。このリポジトリが、Life Manager を使うリポジトリに選ばれていないかもしれません。</p>
        {info.html_url && (
          <div className="ac-setup-actions">
            <button type="button" className="btn-sm primary" onClick={() => openUrl(info.html_url!).catch(() => {})}>
              使うリポジトリを選ぶ画面を開く ↗
            </button>
          </div>
        )}
      </>
    );
  }

  return (
    <div className={`ac-setup${compact ? " compact" : ""}`}>
      {!compact && <b className="ac-setup-title">🔑 Life Manager の権限を足すと使えます</b>}
      {body}
      {message && !compact && <p className="ac-setup-message">{message}</p>}
      {onRetry && (
        <div className="ac-setup-actions">
          <button type="button" className="btn-sm" onClick={onRetry}>
            承認したので、もう一度読み込む
          </button>
        </div>
      )}
    </div>
  );
}
