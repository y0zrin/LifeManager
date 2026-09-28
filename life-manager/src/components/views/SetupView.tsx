import { useCallback, useEffect, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { GitHubLogin } from "../common/GitHubLogin";
import { TokenEntry } from "../common/TokenEntry";
import { TokenReportView } from "../common/TokenReportView";
import { InvitesForMe } from "../common/InvitesForMe";
import { authClientId, checkToken, listUserRepos, orgApprovalUrl, setDefaultToken, type TokenReport, type UserRepo } from "../../lib/auth";
import { createMyRepo, SIGNUP_URL } from "../../lib/team";
import { parseGitHub } from "../../lib/git";
import { isEnter } from "../../lib/keys";

interface SetupViewProps {
  /** 使うリポジトリが決まった（トークンはもうアプリの中にしまってある）。inviteNext なら、はじめたあと 設定 → チーム を開く */
  onDone: (owner: string, repo: string, inviteNext?: boolean) => Promise<void>;
}

const STEPS = ["GitHub のアカウント", "チームに入る・選ぶ", "できあがり"];

/** アカウントを作る流れ: 作っていない → 登録のページを開いた → 作れたのでログインする */
type Signup = "none" | "opened" | "login";

function ago(iso: string): string {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86400000);
  if (days <= 0) return "今日";
  if (days === 1) return "昨日";
  if (days < 30) return `${days} 日前`;
  return `${Math.floor(days / 30)} か月前`;
}

/**
 * 最初のセットアップ。① GitHub のアカウント（持っている → ログイン、持っていない → 作ってからログイン。「トークンで入る」もできる）
 * → ② チームに入る・選ぶ（届いた招待に参加する・自分用のリポジトリを作る・一覧から選ぶ・URL を貼る）→ ③ できあがり
 */
export function SetupView({ onDone }: SetupViewProps) {
  const [step, setStep] = useState(0);
  const [clientId, setClientId] = useState<string | null>(null);
  const [useToken, setUseToken] = useState(false);
  const [signup, setSignup] = useState<Signup>("none");
  const [me, setMe] = useState<TokenReport | null>(null);
  const [repos, setRepos] = useState<UserRepo[] | null>(null);
  const [reposError, setReposError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<{ owner: string; repo: string } | null>(null);
  const [check, setCheck] = useState<TokenReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nameCopied, setNameCopied] = useState(false);
  // 自分用のリポジトリを作る
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("my-tasks");
  const [newPrivate, setNewPrivate] = useState(true);
  const [createBusy, setCreateBusy] = useState(false);

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

  // 使えるリポジトリを読む（② に来たとき・招待に参加したとき・「読み直す」）。pick があれば、読んだあとそれを選ぶ
  const loadRepos = useCallback(async (pick?: string) => {
    try {
      const list = await listUserRepos();
      setRepos(list);
      setReposError(null);
      const found = pick ? list.find((r) => r.full_name.toLowerCase() === pick.toLowerCase()) : undefined;
      if (found) setPicked({ owner: found.owner.login, repo: found.name });
      else if (pick) {
        // 参加したばかりで一覧にまだ出ないときも、名前から選ぶ
        const [owner, repo] = pick.split("/");
        if (owner && repo) setPicked({ owner, repo });
      }
    } catch (e) {
      setRepos((prev) => prev ?? []);
      setReposError(String(e));
    }
  }, []);

  useEffect(() => {
    if (step !== 1 || repos !== null) return;
    loadRepos();
  }, [step, repos, loadRepos]);

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

  async function copyName() {
    if (!me) return;
    try {
      await navigator.clipboard.writeText(me.login);
      setNameCopied(true);
    } catch {
      // コピーできなくても、名前は画面に出ている
    }
  }

  async function createRepo() {
    if (!newName.trim() || createBusy) return;
    setCreateBusy(true);
    setError(null);
    try {
      const repo = await createMyRepo(newName.trim(), newPrivate);
      setCreating(false);
      await loadRepos(repo.full_name);
    } catch (e) {
      setError(String(e));
    } finally {
      setCreateBusy(false);
    }
  }

  async function finish(inviteNext = false) {
    if (!picked) return;
    setFinishing(true);
    setError(null);
    try {
      await onDone(picked.owner, picked.repo, inviteNext);
    } catch (e) {
      setError(String(e));
      setFinishing(false);
    }
  }

  const signupTips = (
    <ul className="setup-tips">
      <li>メールに届く数字のコードを入れると、登録が終わります。届かないときは、迷惑メールのフォルダも見てください。</li>
      <li>使い方などの質問が出たら、飛ばして（Skip）かまいません。</li>
      <li>
        ブラウザが開かないとき:{" "}
        <button type="button" className="link-button" onClick={() => openUrl(SIGNUP_URL).catch(() => {})}>
          github.com/signup
        </button>
      </li>
    </ul>
  );

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
            {(useToken || clientId === "") && (
              <>
                <TokenEntry repos={[]} clientId={clientId ?? ""} saveLabel="このトークンで入る" onSave={async (t) => { await setDefaultToken(t); await loggedIn(); }}
                  onCancel={canLogin ? () => setUseToken(false) : undefined} />
                {clientId === "" && (
                  <p className="setup-alt">
                    GitHub のアカウントがないとき:
                    <button type="button" className="link-button" onClick={() => openUrl(SIGNUP_URL).catch(() => {})}>
                      GitHub で作る ↗
                    </button>
                    （作ったら、上のボタンからトークンを作ります）
                  </p>
                )}
              </>
            )}

            {canLogin && !useToken && signup === "none" && (
              <>
                <div className="setup-choices">
                  <div className="setup-choice">
                    <h3>アカウントを持っている</h3>
                    <ul>
                      <li>自分の GitHub のアカウントで入ります</li>
                      <li>パスワードはアプリに渡りません</li>
                    </ul>
                    <GitHubLogin onDone={loggedIn} />
                  </div>
                  <div className="setup-choice setup-choice--new">
                    <h3>持っていない（5 分ほど）</h3>
                    <ul>
                      <li><b>メールアドレス</b>: 今すぐ受け取れるもの（途中で数字のコードが届きます）</li>
                      <li><b>パスワード</b>: 15 文字以上か、8 文字以上で数字と英小文字を入れる</li>
                      <li><b>ユーザー名</b>: 英数字とハイフン。チームに伝える名前で、公開されます</li>
                    </ul>
                    <button type="button" className="btn-sm setup-signup" onClick={() => { openUrl(SIGNUP_URL).catch(() => {}); setSignup("opened"); }}>
                      GitHub で作る ↗
                    </button>
                  </div>
                </div>
                <p className="hint">
                  <b>ログイン</b>すると、このアプリがあなたの代わりに GitHub の Issue やファイルを読み書きできるようになります。あとで
                  GitHub の設定（Applications）から、いつでも取り消せます。チームでは、リーダーがメンバーをリポジトリに招待し、メンバーはそれぞれ自分のアカウントでログインします。
                </p>
                <p className="setup-alt">
                  学校から「トークンを使って」と言われたとき：
                  <button type="button" className="link-button" onClick={() => setUseToken(true)}>
                    トークンで入る
                  </button>
                </p>
              </>
            )}

            {canLogin && !useToken && signup === "opened" && (
              <div className="setup-signup-wait">
                <p className="setup-lead">ブラウザで GitHub の登録のページを開きました。登録を終えたら、ここに戻って押してください。</p>
                <button type="button" className="gh-login-button" onClick={() => setSignup("login")}>
                  作れた・ログインへ
                </button>
                {signupTips}
                <button type="button" className="link-button" onClick={() => setSignup("none")}>
                  ← 最初の画面に戻る
                </button>
              </div>
            )}

            {canLogin && !useToken && signup === "login" && (
              <div className="setup-signup-wait">
                <GitHubLogin onDone={loggedIn} autoStart label="作れた・ログインへ" />
                <button type="button" className="link-button" onClick={() => setSignup("opened")}>
                  ← 登録がまだ終わっていない
                </button>
              </div>
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
                <button type="button" className="btn-sm" onClick={copyName} title="チームのリーダーに伝えて、リポジトリに招待してもらいます">
                  {nameCopied ? "✔ 名前をコピーしました" : "名前をコピー"}
                </button>
              </div>
            )}
            <InvitesForMe poll onJoined={(fullName) => loadRepos(fullName)} onOrgsChanged={() => loadRepos()} />
            {repos !== null && repos.length === 0 && !reposError && (
              <div className="setup-join">
                <p className="setup-lead">まだ使えるリポジトリがありません。</p>
                <ul>
                  <li>
                    <b>チームで使う</b>: 上の名前をリーダーに伝えて、リポジトリに招待してもらいます。招待が届くと、ここに出ます（30 秒ごとに確かめます）。
                  </li>
                  <li>
                    <b>1 人で使う</b>: 自分用のリポジトリを作ります（下の「自分用のリポジトリを作る」）。
                  </li>
                </ul>
                <p className="setup-note">
                  <i className="spinner" aria-hidden="true" /> 招待を待っています…
                </p>
              </div>
            )}
            <div className="setup-search">
              <input
                className="input-full"
                value={query}
                autoFocus
                placeholder="名前で探す、または URL を貼る（https://github.com/持ち主/名前）"
                onChange={(e) => setQuery(e.target.value)}
              />
              <button type="button" className="btn-sm" onClick={() => loadRepos()} title="招待を受けたあとなど、使えるリポジトリをもう一度読みます">
                読み直す
              </button>
            </div>
            {(repos === null || repos.length > 0 || pasted) && (
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
              {repos !== null && repos.length > 0 && shown.length === 0 && !pasted && <p className="setup-note">見つかりません。URL を貼っても選べます。</p>}
            </div>
            )}
            {reposError && <p className="token-error">リポジトリの一覧を読めませんでした（{reposError}）。URL を貼って選んでください</p>}

            {creating ? (
              <div className="setup-create">
                <span className="setup-create-label">自分用のリポジトリ</span>
                <span className="setup-create-owner">{me?.login ?? ""} /</span>
                <input className="setup-create-name" value={newName} onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => { if (isEnter(e)) createRepo(); }} disabled={createBusy} aria-label="リポジトリの名前" />
                <label className="chk">
                  <input type="checkbox" checked={newPrivate} onChange={(e) => setNewPrivate(e.target.checked)} disabled={createBusy} />
                  非公開
                </label>
                <button type="button" className="btn-primary" onClick={createRepo} disabled={!newName.trim() || createBusy}>
                  {createBusy ? "作っています…" : "作る"}
                </button>
                <button type="button" className="link-button" onClick={() => setCreating(false)} disabled={createBusy}>
                  やめる
                </button>
              </div>
            ) : (
              <p className="setup-note">
                1 人で使う:{" "}
                <button type="button" className="link-button" onClick={() => setCreating(true)}>
                  自分用のリポジトリを作る
                </button>
                （手元のフォルダを上げるときは、あとで 設定 → 接続 → プロジェクト管理 → ＋ 追加 から）
              </p>
            )}

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
              チームで使うときは、設定 → チーム でメンバーを招待できます（招待できるのは、リポジトリの管理者です）。
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
            <span className="setup-actions-right">
              <button type="button" className="btn-sm" disabled={finishing} onClick={() => finish(true)}
                title="はじめたあと、設定 → チーム を開きます">
                はじめて、メンバーを招待する
              </button>
              <button type="button" className="btn-primary" disabled={finishing} onClick={() => finish()}>
                {finishing ? "準備しています…" : "はじめる"}
              </button>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
