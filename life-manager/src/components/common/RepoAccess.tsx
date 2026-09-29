import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { listUserRepos, repoAccessUrl, type Installation } from "../../lib/auth";

/** GitHub の画面で選んでいるあいだ、確かめに行く間隔と、あきらめるまで */
const WATCH_MS = 3000;
const WATCH_LIMIT_MS = 10 * 60 * 1000;

interface RepoAccessProps {
  /** ログインしている人（アカウントの番号で、GitHub の画面をその人を選んだ状態で開く） */
  me: { login: string; id: number };
  /** Life Manager App を入れる画面の URL（auth_install_url） */
  installUrl: string;
  /** 入れてある先（まだ読んでいなければ null） */
  installations: Installation[] | null;
  /** 使えるリポジトリが変わった（GitHub の画面で入れた・足した）。追加されたリポジトリ（持ち主/名前）。入れてある先も読み直してもらう */
  onChanged: (added: string[]) => void;
  /** 目立たせる（初回のセットアップ） */
  primary?: boolean;
}

/**
 * 初回は「使用するリポジトリを選ぶ」、2 つ目からは「リポジトリを追加する」。
 * GitHub の画面（自分のアカウントを選んだ状態）を開き、Install（2 回目からは Save）が押されたら、自分で気づいて知らせる
 */
export function RepoAccess({ me, installUrl, installations, onChanged, primary = false }: RepoAccessProps) {
  const [watching, setWatching] = useState(false);
  const [done, setDone] = useState<string[] | null>(null);
  const timer = useRef<number | null>(null);
  const changed = useRef(onChanged);
  changed.current = onChanged;

  // 画面を離れたら、確かめに行くのをやめる
  useEffect(() => {
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, []);

  const first = installations !== null && installations.length === 0;
  const mine = installations?.find((i) => i.account.login.toLowerCase() === me.login.toLowerCase());
  const label = first || !mine ? "使用するリポジトリを選ぶ" : "リポジトリを追加する";

  async function open() {
    setDone(null);
    // 押す前に使えたリポジトリ（増えたら、GitHub の画面で入れた・足したと分かる）
    let before: Set<string>;
    try {
      before = new Set((await listUserRepos()).map((r) => r.full_name.toLowerCase()));
    } catch {
      before = new Set();
    }
    openUrl(repoAccessUrl(installUrl, me, installations ?? [])).catch(() => {});
    setWatching(true);
    const until = Date.now() + WATCH_LIMIT_MS;
    const tick = async () => {
      try {
        const now = await listUserRepos();
        const added = now.map((r) => r.full_name).filter((n) => !before.has(n.toLowerCase()));
        if (added.length > 0) {
          setWatching(false);
          setDone(added);
          changed.current(added);
          return;
        }
      } catch {
        // つながらない・まだ入っていないときは、もう少し待つ
      }
      if (Date.now() < until) timer.current = window.setTimeout(tick, WATCH_MS);
      else setWatching(false);
    };
    timer.current = window.setTimeout(tick, WATCH_MS);
  }

  function stop() {
    if (timer.current) window.clearTimeout(timer.current);
    setWatching(false);
  }

  return (
    <div className="repo-access">
      {mine && (
        <p className="repo-access-state">
          ✔ Life Manager が入っています（{mine.repository_selection === "all" ? "すべてのリポジトリ" : "選んだリポジトリ"}）
        </p>
      )}
      {!(mine && mine.repository_selection === "all") && (
        <button type="button" className={primary ? "btn-primary" : "btn-sm"} disabled={watching || installations === null} onClick={open}>
          {label}
        </button>
      )}
      {watching && (
        <p className="repo-access-wait">
          <i className="spinner" aria-hidden="true" /> GitHub の画面で、使うリポジトリを選んで {mine ? "Save" : "Install"} を押してください。押すと、ここに出ます…
          <button type="button" className="link-button" onClick={stop}>やめる</button>
        </p>
      )}
      {done && <p className="repo-access-done">✔ 使えるようになりました: {done.join("、")}</p>}
      {!watching && !done && !(mine && mine.repository_selection === "all") && (
        <p className="repo-access-note">
          {mine
            ? "GitHub の画面で、Life Manager に使わせるリポジトリを足します（Save）。"
            : "GitHub の画面が、あなたのアカウントを選んだ状態で開きます。「すべて」か、使うリポジトリを選んで Install を押します。"}
          {!mine && (
            <>
              {" "}組織（Organization）に入れるときは{" "}
              <button type="button" className="link-button" onClick={() => openUrl(installUrl).catch(() => {})}>こちら</button>
              （組織の持ち主が入れます）。
            </>
          )}
        </p>
      )}
    </div>
  );
}
