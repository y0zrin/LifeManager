import { useEffect, useState } from "react";
import { checkToken, expiryOf, EXPIRY_WARN_DAYS } from "../../lib/auth";
import { THIS_DEVICE } from "../../lib/platform";
import { tr, jaOf } from "../../lib/i18n";

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
        if (expiry && expiry.days < 0) setText(tr("{owner}/{repo} で使うトークンの期限が切れています（{login}）。", { owner, repo, login: report.login }));
        else if (expiry && expiry.days <= EXPIRY_WARN_DAYS) {
          setText(
            report.kind === "app"
              ? tr("{THIS_DEVICE}で使うログインの期限まであと {days} 日です（{login}）。「ログインし直す（期限を延ばす）」で延ばせます。", { THIS_DEVICE, days: expiry.days, login: report.login })
              : tr("{owner}/{repo} で使うトークンは、あと {days} 日で期限が切れます（{login}）。", { owner, repo, days: expiry.days, login: report.login }),
          );
        }
      })
      .catch((e) => {
        // つながらないだけのときは知らせない
        const message = String(e);
        if (alive && !jaOf(message).includes("通信できませんでした")) setText(tr("{owner}/{repo} で使うトークンが使えません（{message}）。", { owner, repo, message }));
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
        {tr("設定 → トークン を開く")}
      </button>
      <button type="button" className="btn-sm" onClick={() => setClosed(true)}>
        {tr("あとで")}
      </button>
    </div>
  );
}
