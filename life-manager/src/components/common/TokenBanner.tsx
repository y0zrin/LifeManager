import { useEffect, useState } from "react";
import { checkToken, expiryOf, EXPIRY_WARN_DAYS } from "../../lib/auth";
import { THIS_DEVICE } from "../../lib/platform";

interface TokenBannerProps {
  owner: string;
  repo: string;
  onOpenSettings: () => void;
}

/** 今のプロジェクトで使うトークンの期限が近い・切れた・使えないときに、画面の上で知らせる（プロジェクトを開いたときに一度確かめる） */
export function TokenBanner({ owner, repo, onOpenSettings }: TokenBannerProps) {
  const [text, setText] = useState<string | null>(null);
  const [closed, setClosed] = useState(false);

  useEffect(() => {
    setText(null);
    setClosed(false);
    if (!owner || !repo) return;
    let alive = true;
    checkToken({ owner, repo, repos: [] })
      .then((report) => {
        if (!alive) return;
        const expiry = expiryOf(report);
        if (expiry && expiry.days < 0) setText(`${owner}/${repo} で使うトークンの期限が切れています（${report.login}）。`);
        else if (expiry && expiry.days <= EXPIRY_WARN_DAYS) {
          setText(
            report.kind === "app"
              ? `${THIS_DEVICE}で使うログインの期限まで、あと ${expiry.days} 日です（${report.login}）。「ログインし直す（期限を延ばす）」で延ばせます。`
              : `${owner}/${repo} で使うトークンは、あと ${expiry.days} 日で期限が切れます（${report.login}）。`,
          );
        }
      })
      .catch((e) => {
        // つながらないだけのときは知らせない
        const message = String(e);
        if (alive && !message.includes("通信できませんでした")) setText(`${owner}/${repo} で使うトークンが使えません（${message}）。`);
      });
    return () => {
      alive = false;
    };
  }, [owner, repo]);

  if (!text || closed) return null;
  return (
    <div className="token-banner" role="status">
      <span>⚠ {text}</span>
      <button type="button" className="btn-sm" onClick={onOpenSettings}>
        設定 → トークン を開く
      </button>
      <button type="button" className="btn-sm" onClick={() => setClosed(true)}>
        あとで
      </button>
    </div>
  );
}
