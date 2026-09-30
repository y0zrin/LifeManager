import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { listUserRepos, repoAccessUrl, type Installation, type UserRepo } from "../../lib/auth";

/** GitHub の画面で許可しているあいだ、確かめに行く間隔と、あきらめるまで */
const WATCH_MS = 3000;
const WATCH_LIMIT_MS = 10 * 60 * 1000;

type Repo = { owner: string; repo: string };

interface AllowRepoStepProps {
  /** ログインしている人（GitHub の画面を、この人を選んだ状態で開く） */
  me: { login: string; id: number };
  /** Life Manager App を入れる画面の URL */
  installUrl: string;
  /** 入れてある先（まだ読んでいなければ null） */
  installations: Installation[] | null;
  /** 使わせたいリポジトリ */
  target: Repo;
  /** 使えるようになった（別の名前のリポジトリを許可したときは、そのリポジトリ） */
  onAllowed: (repo: Repo) => void;
  /** 入れてある先が変わったかもしれない（読み直してもらう） */
  onInstallationsChanged?: () => void;
}

const same = (r: UserRepo, t: Repo) => r.owner.login.toLowerCase() === t.owner.toLowerCase() && r.name.toLowerCase() === t.repo.toLowerCase();

/**
 * 手順「Life Manager に許可」。作った・上げたリポジトリ「だけ」を、Life Manager に使わせる。
 * もう使えるとき（すべてのリポジトリに入れてある・アプリで作ったので自動で入った）は、確かめてそのまま次へ。
 * まだなら GitHub の画面（自分のアカウントを選んだ状態）を開き、許可されたことに自分で気づいて次へ進む
 */
export function AllowRepoStep({ me, installUrl, installations, target, onAllowed, onInstallationsChanged }: AllowRepoStepProps) {
  const [state, setState] = useState<"checking" | "idle" | "watching" | "other">("checking");
  const [other, setOther] = useState<Repo | null>(null);
  const timer = useRef<number | null>(null);
  const allowed = useRef(onAllowed);
  allowed.current = onAllowed;
  const changed = useRef(onInstallationsChanged);
  changed.current = onInstallationsChanged;

  // もう使えるなら、そのまま次へ
  useEffect(() => {
    let alive = true;
    listUserRepos()
      .then((list) => {
        if (!alive) return;
        if (list.some((r) => same(r, target))) allowed.current(target);
        else setState("idle");
      })
      .catch(() => alive && setState("idle"));
    return () => {
      alive = false;
      if (timer.current) window.clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.owner, target.repo]);

  const isOrg = target.owner.toLowerCase() !== me.login.toLowerCase();
  const mine = installations?.find((i) => i.account.login.toLowerCase() === me.login.toLowerCase());

  async function open() {
    // 押す前に使えたリポジトリ（増えたら、GitHub の画面で許可したと分かる）
    let before: Set<string>;
    try {
      before = new Set((await listUserRepos()).map((r) => r.full_name.toLowerCase()));
    } catch {
      before = new Set();
    }
    // 組織のリポジトリは、組織を選ぶ画面から（自分のアカウントを選んだ状態では開かない）
    openUrl(isOrg ? installUrl : repoAccessUrl(installUrl, me, installations ?? [])).catch(() => {});
    setOther(null);
    setState("watching");
    const until = Date.now() + WATCH_LIMIT_MS;
    const tick = async () => {
      try {
        const list = await listUserRepos();
        if (list.some((r) => same(r, target))) {
          changed.current?.();
          allowed.current(target);
          return;
        }
        const added = list.filter((r) => !before.has(r.full_name.toLowerCase()));
        if (added.length > 0) {
          changed.current?.();
          setOther({ owner: added[0].owner.login, repo: added[0].name });
          setState("other");
          return;
        }
      } catch {
        // つながらない・まだ許可されていないときは、もう少し待つ
      }
      if (Date.now() < until) timer.current = window.setTimeout(tick, WATCH_MS);
      else setState("idle");
    };
    timer.current = window.setTimeout(tick, WATCH_MS);
  }

  function stop() {
    if (timer.current) window.clearTimeout(timer.current);
    setState("idle");
  }

  const full = `${target.owner}/${target.repo}`;

  return (
    <div className="allow-step">
      <p className="git-dialog-message">
        Life Manager に <b>{full}</b> を使わせます。あなたのほかのリポジトリには触れません。
      </p>
      {state === "checking" && (
        <p className="git-dialog-note">
          <i className="spinner" aria-hidden="true" /> もう使えるか確かめています…
        </p>
      )}
      {(state === "idle" || state === "watching") && (
        <>
          <span>
            <button type="button" className={state === "watching" ? "btn-sm" : "btn-primary"} onClick={open}>
              {state === "watching" ? "許可する画面をもう一度開く" : "許可する画面を開く（GitHub）"}
            </button>
          </span>
          <p className="allow-step-how">
            {isOrg ? (
              <>GitHub の画面で組織 <b>{target.owner}</b> を選び、<b>{target.repo}</b> を選んで「Install」（または「Save」）を押します。組織のリポジトリは、組織の持ち主が許可します。</>
            ) : mine ? (
              <>GitHub の画面で <b>{target.repo}</b> にチェックを入れて（足して）「Save」を押します。</>
            ) : (
              <>GitHub の画面で「<b>Only select repositories</b>」→ <b>{target.repo}</b> を選んで「Install」を押します。</>
            )}
          </p>
        </>
      )}
      {state === "watching" && (
        <p className="setup-wait">
          <i className="spinner" aria-hidden="true" /> 許可を待っています…（許可すると、自分で気づいて次へ進みます）
          <button type="button" className="link-button" onClick={stop}>やめる</button>
        </p>
      )}
      {state === "other" && other && (
        <div className="wizard-case wizard-case--warn">
          <b>✔ {other.owner}/{other.repo} を使えるようになりました</b>
          <span className="git-dialog-note">{full} とは名前が違います（GitHub で別の名前にしましたか？）。</span>
          <span className="allow-step-actions">
            <button type="button" className="btn-primary" onClick={() => onAllowed(other)}>このリポジトリで続ける</button>
            <button type="button" className="btn-sm" onClick={open}>もう一度開く</button>
          </span>
        </div>
      )}
    </div>
  );
}
