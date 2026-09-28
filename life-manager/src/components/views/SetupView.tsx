import { useEffect, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { GitHubLogin } from "../common/GitHubLogin";
import { TokenEntry } from "../common/TokenEntry";
import { TokenReportView } from "../common/TokenReportView";
import { authClientId, checkToken, listUserRepos, orgApprovalUrl, setDefaultToken, type TokenReport, type UserRepo } from "../../lib/auth";
import { parseGitHub } from "../../lib/git";

interface SetupViewProps {
  /** 使うリポジトリが決まった（トークンはもうアプリの中にしまってある） */
  onDone: (owner: string, repo: string) => Promise<void>;
}

const STEPS = ["GitHub にログイン", "使うリポジトリを選ぶ", "できあがり"];

function ago(iso: string): string {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86400000);
  if (days <= 0) return "今日";
  if (days === 1) return "昨日";
  if (days < 30) return `${days} 日前`;
  return `${Math.floor(days / 30)} か月前`;
}

/**
 * 最初のセットアップ。① GitHub でログイン（トークンを作らなくてよい。「トークンで入る」もできる）
 * → ② 使うリポジトリを一覧から選ぶ（URL を貼ってもよい）→ ③ できあがり
 */
export function SetupView({ onDone }: SetupViewProps) {
  const [step, setStep] = useState(0);
  const [clientId, setClientId] = useState<string | null>(null);
  const [useToken, setUseToken] = useState(false);
  const [me, setMe] = useState<TokenReport | null>(null);
  const [repos, setRepos] = useState<UserRepo[] | null>(null);
  const [reposError, setReposError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<{ owner: string; repo: string } | null>(null);
  const [check, setCheck] = useState<TokenReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    authClientId()
      .then(setClientId)
      .catch(() => setClientId(""));
  }, []);
  const canLogin = !!clientId;

  // ログインできた・トークンを入れた → だれのトークンかを出す
  async function loggedIn() {
    setError(null);
    try {
      setMe(await checkToken({ repos: [] }));
      setStep(1);
    } catch (e) {
      setError(String(e));
    }
  }

  // ② に来たら、使えるリポジトリを読む
  useEffect(() => {
    if (step !== 1 || repos !== null) return;
    listUserRepos()
      .then(setRepos)
      .catch((e) => {
        setRepos([]);
        setReposError(String(e));
      });
  }, [step, repos]);

  // 選んだリポジトリを使えるか確かめる
  useEffect(() => {
    setCheck(null);
    if (!picked) return;
    let alive = true;
    setChecking(true);
    checkToken({ repos: [picked] })
      .then((r) => alive && setCheck(r))
      .catch((e) => alive && setError(String(e)))
      .finally(() => alive && setChecking(false));
    return () => {
      alive = false;
    };
  }, [picked]);

  const q = query.trim().toLowerCase();
  const pasted = parseGitHub(query);
  const shown = useMemo(() => (repos ?? []).filter((r) => !q || r.full_name.toLowerCase().includes(q)), [repos, q]);
  const pickedOk = !!check && check.repos[0]?.ok;

  async function finish() {
    if (!picked) return;
    setFinishing(true);
    setError(null);
    try {
      await onDone(picked.owner, picked.repo);
    } catch (e) {
      setError(String(e));
      setFinishing(false);
    }
  }

  return (
    <div className="setup-view">
      <div className="setup-card">
        <h1 className="setup-title">Life Manager へようこそ</h1>
        <p className="setup-sub">タスク（GitHub の Issue）と git の作業を、ひとつの画面で。</p>
        <ol className="setup-steps">
          {STEPS.map((s, i) => (
            <li key={s} className={i < step ? "done" : i === step ? "on" : ""}>
              {i + 1}. {s}
            </li>
          ))}
        </ol>

        {step === 0 && (
          <>
            {canLogin && !useToken && <GitHubLogin onDone={loggedIn} />}
            {(useToken || clientId === "") && (
              <TokenEntry repos={[]} clientId={clientId ?? ""} saveLabel="このトークンで入る" onSave={async (t) => { await setDefaultToken(t); await loggedIn(); }}
                onCancel={canLogin ? () => setUseToken(false) : undefined} />
            )}
            {canLogin && !useToken && (
              <>
                <p className="hint">
                  <b>ログイン</b>すると、このアプリがあなたの代わりに GitHub の Issue やファイルを読み書きできるようになります。パスワードはアプリに渡りません。あとで
                  GitHub の設定（Applications）から、いつでも取り消せます。チームでは、リーダーはメンバーをリポジトリに招待するだけ。メンバーはそれぞれ自分のアカウントでログインします。
                </p>
                <p className="setup-alt">
                  学校から「トークンを使って」と言われたとき：
                  <button type="button" className="link-button" onClick={() => setUseToken(true)}>
                    トークンで入る
                  </button>
                </p>
              </>
            )}
          </>
        )}

        {step === 1 && (
          <>
            {me && (
              <div className="setup-me">
                {me.avatar_url && <img src={me.avatar_url} alt="" />}
                <span>
                  <b>{me.login}</b> としてログインしています
                </span>
              </div>
            )}
            <input
              className="input-full"
              value={query}
              autoFocus
              placeholder="名前で探す、または URL を貼る（https://github.com/持ち主/名前）"
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="setup-repos">
              {repos === null && (
                <p className="setup-note">
                  <i className="spinner" aria-hidden="true" /> 使えるリポジトリを読んでいます…
                </p>
              )}
              {pasted && !shown.some((r) => r.full_name.toLowerCase() === `${pasted.owner}/${pasted.repo}`.toLowerCase()) && (
                <button type="button" className={`setup-repo${picked?.owner === pasted.owner && picked.repo === pasted.repo ? " on" : ""}`}
                  onClick={() => setPicked(pasted)}>
                  <span className="setup-repo-name">{pasted.owner}/{pasted.repo}</span>
                  <span className="setup-repo-badge">貼った URL</span>
                </button>
              )}
              {shown.map((r) => (
                <button key={r.full_name} type="button"
                  className={`setup-repo${picked?.owner === r.owner.login && picked.repo === r.name ? " on" : ""}`}
                  onClick={() => setPicked({ owner: r.owner.login, repo: r.name })}>
                  {r.owner.avatar_url && <img src={r.owner.avatar_url} alt="" />}
                  <span className="setup-repo-name">{r.full_name}</span>
                  <span className="setup-repo-badge">{r.owner.type === "Organization" ? "チーム" : r.owner.login === me?.login ? "自分" : "招待"}</span>
                  {r.private && <span className="setup-repo-badge">非公開</span>}
                  <span className="setup-repo-when">{ago(r.updated_at)}</span>
                </button>
              ))}
              {repos !== null && shown.length === 0 && !pasted && <p className="setup-note">見つかりません。URL を貼っても選べます。</p>}
            </div>
            {reposError && <p className="token-error">リポジトリの一覧を読めませんでした（{reposError}）。URL を貼って選んでください</p>}
            <p className="setup-note">
              チームのリポジトリが出てこないときは、招待を受けていないか、組織がまだ Life Manager を許可していないかもしれません。
              {canLogin && (
                <button type="button" className="link-button" onClick={() => openUrl(orgApprovalUrl(clientId!))}>
                  組織に許可をお願いする
                </button>
              )}
            </p>
            {checking && (
              <p className="setup-note">
                <i className="spinner" aria-hidden="true" /> 使えるか確かめています…
              </p>
            )}
            {check && check.repos[0] && !check.repos[0].ok && <TokenReportView report={{ ...check, repos: check.repos }} clientId={clientId ?? ""} />}
            {check && check.repos[0]?.ok && check.repos[0].message && <p className="setup-note">⚠ {check.repos[0].message}</p>}
            <p className="setup-note">リポジトリがまだ無いときは、あとで「設定 → 接続 → プロジェクト管理 → ＋ 追加 → 手元のフォルダを GitHub に上げる」で作れます。</p>
          </>
        )}

        {step === 2 && picked && (
          <>
            <ul className="setup-done">
              <li>
                ✔ <b>{me?.login}</b> としてログイン
              </li>
              <li>
                ✔ <b>{picked.owner}/{picked.repo}</b> を使う
              </li>
            </ul>
            <p className="setup-note">
              このあと、git を使う準備（Git のインストール・コミットに使う名前）の案内が出ます。ラベル（状態・優先など）は、設定 → ラベル でまとめて作れます。
            </p>
          </>
        )}

        {error && <p className="token-error">{error}</p>}

        <div className="setup-actions">
          <button type="button" className="btn-sm" style={{ visibility: step > 0 ? "visible" : "hidden" }} disabled={finishing}
            onClick={() => setStep((s) => Math.max(0, s - 1))}>
            ← 戻る
          </button>
          {step === 1 && (
            <button type="button" className="btn-primary" disabled={!pickedOk} onClick={() => setStep(2)}>
              次へ
            </button>
          )}
          {step === 2 && (
            <button type="button" className="btn-primary" disabled={finishing} onClick={finish}>
              {finishing ? "準備しています…" : "はじめる"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
