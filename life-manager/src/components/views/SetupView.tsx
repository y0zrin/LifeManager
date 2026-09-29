import { useCallback, useEffect, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { GitHubLogin } from "../common/GitHubLogin";
import { TokenEntry } from "../common/TokenEntry";
import { TokenReportView } from "../common/TokenReportView";
import { InvitesForMe } from "../common/InvitesForMe";
import { RepoAccess } from "../common/RepoAccess";
import {
  APP_AUTHORIZATIONS_PAGE, authClientId, authInstallUrl, checkToken, expiryOf, listInstallations, listUserRepos, setDefaultToken,
  SIGNED_OUT_STORE, takeLoginNotice, type Installation, type TokenReport, type UserRepo,
} from "../../lib/auth";
import { createMyRepo, SIGNUP_URL } from "../../lib/team";
import { parseGitHub } from "../../lib/git";
import { isEnter } from "../../lib/keys";

interface SetupViewProps {
  /** 使うリポジトリが決まった（トークンはもうアプリの中にしまってある）。inviteNext なら、はじめたあと 設定 → チーム を開く */
  onDone: (owner: string, repo: string, inviteNext?: boolean) => Promise<void>;
}

const STEPS = ["GitHub にログイン", "チームに入る・作る", "できあがり"];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
 * 最初のセットアップ。① GitHub にログイン（アカウントがなければ、ここで作ってからログイン。「トークンで入る」もできる）
 * → ② チームに入る・作る（自分の GitHub の名前を大きく出す。メンバーは届いた招待で「参加してはじめる」、
 * リーダー・1 人で使う人は「使用するリポジトリを選ぶ」→「作ってはじめる」。一覧から選ぶ・URL を貼るもできる）→ ③ できあがり
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
  const [newName, setNewName] = useState("my-tasks");
  const [newPrivate, setNewPrivate] = useState(true);
  const [createBusy, setCreateBusy] = useState(false);
  // Life Manager App を入れる画面（使用するリポジトリを選ぶ・リポジトリを追加する）と、入れてある先
  const [installUrl, setInstallUrl] = useState("");
  const [installations, setInstallations] = useState<Installation[] | null>(null);
  // 招待に参加したが、まだ使えない（リーダーが Life Manager を入れていない）
  const [joinProblem, setJoinProblem] = useState<{ fullName: string; message: string } | null>(null);
  const [joinTextCopied, setJoinTextCopied] = useState(false);
  // 最初に出す知らせ（この PC の期限が来た・ログアウトした）
  const [notice, setNotice] = useState<{ kind: "expired" } | { kind: "signed-out"; login: boolean } | null>(null);

  useEffect(() => {
    authClientId()
      .then(setClientId)
      .catch(() => setClientId(""));
    authInstallUrl().then(setInstallUrl).catch(() => {});
    takeLoginNotice()
      .then((expired) => {
        if (expired) setNotice({ kind: "expired" });
      })
      .catch(() => {});
    try {
      const out = sessionStorage.getItem(SIGNED_OUT_STORE);
      if (out) {
        sessionStorage.removeItem(SIGNED_OUT_STORE);
        setNotice({ kind: "signed-out", login: out === "app" || out === "oauth" });
      }
    } catch {
      // 知らせを出せなくても、ログインはできる
    }
  }, []);
  const canLogin = !!clientId;
  const byLogin = me?.kind === "app";
  const meExpiry = me && byLogin ? expiryOf(me) : null;

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

  // Life Manager App を入れてある先（ログインのときだけ。初回は「使用するリポジトリを選ぶ」、あれば「リポジトリを追加する」）
  const loadInstallations = useCallback(async () => {
    try {
      setInstallations(await listInstallations());
    } catch {
      setInstallations([]);
    }
  }, []);

  useEffect(() => {
    if (step !== 1 || repos !== null) return;
    loadRepos();
    if (byLogin) loadInstallations();
  }, [step, repos, loadRepos, byLogin, loadInstallations]);

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

  // 作ってはじめる（作ったリポジトリで、そのままはじめる）
  async function createRepo() {
    if (!newName.trim() || createBusy) return;
    setCreateBusy(true);
    setError(null);
    try {
      const repo = await createMyRepo(newName.trim(), newPrivate);
      await startWith(repo.owner.login, repo.name);
    } catch (e) {
      setError(String(e));
    } finally {
      setCreateBusy(false);
    }
  }

  async function finish(inviteNext = false) {
    if (!picked) return;
    await startWith(picked.owner, picked.repo, inviteNext);
  }

  async function startWith(owner: string, repo: string, inviteNext = false) {
    setFinishing(true);
    setError(null);
    try {
      await onDone(owner, repo, inviteNext);
    } catch (e) {
      setError(String(e));
      setFinishing(false);
    }
  }

  // 参加してはじめる: 招待を受けたら、使えるのを確かめて、そのままはじめる。
  // 参加したばかりは使えるようになるまで少しかかることがあるので、何度か確かめる
  async function joinAndStart(fullName: string) {
    setJoinProblem(null);
    const [owner, repo] = fullName.split("/");
    let message = "";
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const r = await checkToken({ repos: [{ owner, repo }] });
        if (r.repos[0]?.ok) {
          await startWith(owner, repo);
          return;
        }
        message = r.repos[0]?.message ?? "";
      } catch (e) {
        message = String(e);
      }
      await sleep(2000);
    }
    setJoinProblem({ fullName, message });
    await loadRepos(fullName);
  }

  async function copyJoinText() {
    if (!joinProblem) return;
    const [, repo] = joinProblem.fullName.split("/");
    const text = `${joinProblem.fullName} に参加しました。Life Manager で使えるように、このリポジトリに Life Manager App を入れてください（Life Manager の「使用するリポジトリを選ぶ」か「リポジトリを追加する」で ${repo} を選びます）。`;
    try {
      await navigator.clipboard.writeText(text);
      setJoinTextCopied(true);
    } catch {
      // コピーできなくても、文は画面に出ている
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

        {step === 0 && notice && (
          <div className="setup-notice">
            {notice.kind === "expired" ? (
              <>この PC で使う期限が来たので、ログインの鍵を消しました。もう一度ログインしてください。</>
            ) : (
              <>
                ログアウトしました（この PC から鍵を消しました）。
                {notice.login && (
                  <>
                    GitHub での Life Manager の許可も取り消すときは{" "}
                    <button type="button" className="link-button" onClick={() => openUrl(APP_AUTHORIZATIONS_PAGE).catch(() => {})}>
                      GitHub の画面を開く
                    </button>
                    （Life Manager App の Revoke を押します）。
                  </>
                )}
              </>
            )}
          </div>
        )}

        {step === 0 && (
          <>
            {(useToken || clientId === "") && (
              <>
                <TokenEntry repos={[]} saveLabel="このトークンで入る" onSave={async (t) => { await setDefaultToken(t); await loggedIn(); }}
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
                  <b>ログイン</b>すると、このアプリが、あなたが選んだリポジトリ（Life Manager を入れたリポジトリ）の Issue やファイルを、あなたの代わりに読み書きできるようになります。
                  GitHub の設定（Applications）から、いつでも取り消せます。チームでは、リーダーがリポジトリに Life Manager を入れてメンバーを招待し、メンバーはそれぞれ自分のアカウントでログインします。
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
              <>
                <div className="setup-name">
                  {me.avatar_url && <img src={me.avatar_url} alt="" />}
                  <div className="setup-name-body">
                    <div className="setup-name-k">あなたの GitHub の名前</div>
                    <div className="setup-name-v">{me.login}</div>
                  </div>
                  {meExpiry && <span className="setup-me-expiry">期限 {meExpiry.date}（あと {meExpiry.days} 日）</span>}
                  <button type="button" className="btn-sm" onClick={copyName} title="チームのリーダーに伝えて、リポジトリに招待してもらいます">
                    {nameCopied ? "✔ コピーしました" : "コピー"}
                  </button>
                </div>
                <p className="setup-name-hint">チームに入るときは、この名前をリーダーに伝えてください。</p>
              </>
            )}

            <div className="setup-paths">
              <section className="setup-path">
                <h3>チームに入る</h3>
                <InvitesForMe poll joinLabel="参加してはじめる" onJoined={(fullName) => joinAndStart(fullName)} onOrgsChanged={() => loadRepos()}
                  empty={
                    <p className="setup-note">
                      招待が届くと、ここに出ます（30 秒ごとに確かめます）。<br />
                      <i className="spinner" aria-hidden="true" /> 招待を待っています…
                    </p>
                  } />
                {joinProblem && (
                  <div className="setup-note setup-note--warn">
                    <b>{joinProblem.fullName} に参加しましたが、まだ使えません。</b>
                    {joinProblem.message && <div>{joinProblem.message}</div>}
                    <div className="setup-install">
                      <button type="button" className="btn-sm" onClick={copyJoinText}>{joinTextCopied ? "✔ コピーしました" : "リーダーに送る文をコピー"}</button>
                      <button type="button" className="link-button" onClick={() => joinAndStart(joinProblem.fullName)}>もう一度確かめる</button>
                    </div>
                  </div>
                )}
              </section>

              <section className="setup-path">
                <h3>チームを作る・1 人で使う</h3>
                <ol className="setup-path-steps">
                  {byLogin && me && installUrl && (
                    <li>
                      <RepoAccess me={me} installUrl={installUrl} installations={installations} primary={!installations?.length}
                        onChanged={async (added) => { await loadInstallations(); await loadRepos(added.length === 1 ? added[0] : undefined); }} />
                    </li>
                  )}
                  <li>
                    <div className="setup-create">
                      <span className="setup-create-label">リポジトリを作る</span>
                      <span className="setup-create-owner">{me?.login ?? ""} /</span>
                      <input className="setup-create-name" value={newName} onChange={(e) => setNewName(e.target.value)}
                        onKeyDown={(e) => { if (isEnter(e)) createRepo(); }} disabled={createBusy || (byLogin && !installations?.length)} aria-label="リポジトリの名前" />
                      <label className="chk">
                        <input type="checkbox" checked={newPrivate} onChange={(e) => setNewPrivate(e.target.checked)} disabled={createBusy} />
                        非公開
                      </label>
                      <button type="button" className="btn-primary" onClick={createRepo}
                        disabled={!newName.trim() || createBusy || finishing || (byLogin && !installations?.length)}>
                        {createBusy ? "作っています…" : "作ってはじめる"}
                      </button>
                    </div>
                    {byLogin && installations !== null && installations.length === 0 && (
                      <p className="setup-note">先に「使用するリポジトリを選ぶ」で、Life Manager を入れてください。</p>
                    )}
                    <p className="setup-note">もうあるリポジトリを使うときは、下の一覧から選びます（手元のフォルダを上げるときは、あとで 設定 → 接続 → プロジェクト管理 → ＋ 追加 から）。</p>
                  </li>
                </ol>
              </section>
            </div>

            <h4 className="setup-list-h">使えるリポジトリ{repos && repos.length > 0 ? `（${repos.length}）` : ""}</h4>
            <div className="setup-search">
              <input
                className="input-full"
                value={query}
                placeholder="名前で探す、または URL を貼る（https://github.com/持ち主/名前）"
                onChange={(e) => setQuery(e.target.value)}
              />
              <button type="button" className="btn-sm" onClick={() => { loadRepos(); if (byLogin) loadInstallations(); }} title="招待を受けたあとなど、使えるリポジトリをもう一度読みます">
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
            {repos !== null && repos.length === 0 && !pasted && (
              <p className="setup-note">
                {byLogin ? "まだありません。チームに入るか、上の「チームを作る・1 人で使う」から始めます。" : "まだありません。チームに入るか、リポジトリを作ります。"}
              </p>
            )}
            {reposError && <p className="token-error">リポジトリの一覧を読めませんでした（{reposError}）。URL を貼って選んでください</p>}
            {checking && (
              <p className="setup-note">
                <i className="spinner" aria-hidden="true" /> 使えるか確かめています…
              </p>
            )}
            {check && check.repos[0] && !check.repos[0].ok && <TokenReportView report={{ ...check, repos: check.repos }} installUrl={installUrl} />}
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
