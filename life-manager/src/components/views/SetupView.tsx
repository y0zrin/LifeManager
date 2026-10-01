import { useCallback, useEffect, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { GitHubLogin } from "../common/GitHubLogin";
import { TokenEntry } from "../common/TokenEntry";
import { TokenReportView } from "../common/TokenReportView";
import { RepoAccess } from "../common/RepoAccess";
import { CreateRepoFlow } from "../common/CreateRepoFlow";
import {
  APP_AUTHORIZATIONS_PAGE, authClientId, authInstallUrl, checkToken, expiryOf, listAccounts, listInstallations, listUserRepos, markSetupPending,
  setDefaultToken, SIGNED_OUT_STORE, takeLoginNotice, type Installation, type SavedAccount, type TokenReport, type UserRepo,
} from "../../lib/auth";
import { listMyInvitations, SIGNUP_URL } from "../../lib/team";
import { THIS_DEVICE } from "../../lib/platform";

interface SetupViewProps {
  /** 使うリポジトリが決まった（トークンはもうアプリの中にしまってある）。inviteNext なら、はじめたあと 設定 → 接続 を開く。
   * folder は、新しく作ってこの PC にクローンしたときの作業フォルダ */
  onDone: (owner: string, repo: string, inviteNext?: boolean, folder?: string) => Promise<void>;
  /** セットアップの途中で閉じて、開き直した。ログインが生きていれば 2.（使い方を選ぶ）から */
  resume?: boolean;
  /** 別のアカウントを足しているところ（足す前のアカウントの名前）。上に「やめる（…に戻る）」を出す */
  adding?: string | null;
  /** この PC にしまってあるアカウントに戻る（足すのをやめた・ほかのアカウントで続ける） */
  onRestoreAccount?: (login: string) => Promise<void>;
  /** ログインできた。前にこの PC で使っていたアカウントで、そのまま続けられるなら true（セットアップはここで終わる） */
  onLoggedIn?: (report: TokenReport) => Promise<boolean>;
  /** はじめに見た目を選んだ（手順の 1. に「見た目」を出し、押すと選び直せる） */
  onLook?: () => void;
}

/** ログインのあとに選ぶ使い方: チームを作る（リーダー）／招待を受ける（メンバー）／個人で使う */
type Path = "team" | "join" | "solo";

const PATHS: { id: Path; icon: string; label: string; desc: string }[] = [
  { id: "team", icon: "👥", label: "チームを作る", desc: "リーダー向け。リポジトリを用意してメンバーを招待します" },
  { id: "join", icon: "📨", label: "招待を受ける", desc: "メンバー向け。名前をリーダーに伝えて、届いた招待で参加します" },
  { id: "solo", icon: "👤", label: "個人で使う", desc: "自分だけのリポジトリで使います（あとからチームにもできます）" },
];

/** 新しく作るリポジトリの名前（手順 1 の欄に、はじめに入れておくもの） */
const NEW_NAMES: Record<Path, string> = { team: "team-project", join: "", solo: "my-tasks" };

/** 使い方を選ぶ画面で、届いている招待を確かめに行く間隔 */
const INVITE_POLL_MS = 30000;

/**
 * 招待を受ける画面で、参加したか（使えるリポジトリが増えたか）を確かめる間隔。はじめの 5 分は 5 秒ごと、そのあとは 30 秒ごと。
 * 「GitHub でログイン」の鍵では、参加する前のリポジトリの招待がアプリから見えない（GitHub の決まり）ので、
 * 招待はメールか招待のページで受けてもらい、使えるようになったことにアプリが気づく
 */
const JOIN_POLL_MS = 5000;
const JOIN_SLOW_POLL_MS = 30000;
const JOIN_FAST_MS = 5 * 60 * 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** アカウントを作る流れ: 作っていない → 登録のページを開いた → 作れたのでログインする */
type Signup = "none" | "opened" | "login";

/**
 * 最初のセットアップ。① GitHub にログイン（アカウントがなければ、ここで作ってからログイン。「トークンで入る」もできる）
 * → ② 使い方を選ぶ（チームを作る／招待を受ける／個人で使う。招待が届いていれば「招待を受ける」に印）
 * → ③ 選んだ道だけを出す。チームを作る・個人で使う:「使用するリポジトリを選ぶ」→ もうあるものか新しく作るかを決めて、はじめる。
 * 招待を受ける: 自分の GitHub の名前を大きく出す。招待はメール（か招待のページ）で受け、使えるようになったらアプリが気づいて
 * 「このリポジトリではじめる」を出す。どの道も、最後のボタンでそのままはじめる
 */
export function SetupView({ onDone, resume = false, adding = null, onRestoreAccount, onLoggedIn, onLook }: SetupViewProps) {
  const [step, setStep] = useState(0);
  const [path, setPath] = useState<Path | null>(null);
  const [clientId, setClientId] = useState<string | null>(null);
  const [useToken, setUseToken] = useState(false);
  const [signup, setSignup] = useState<Signup>("none");
  const [me, setMe] = useState<TokenReport | null>(null);
  const [repos, setRepos] = useState<UserRepo[] | null>(null);
  const [reposError, setReposError] = useState<string | null>(null);
  // チームを作る・個人で使う: もうあるリポジトリを使う／新しく作る（null は、まだ選んでいない）
  const [mode, setMode] = useState<"existing" | "new" | null>(null);
  const [picked, setPicked] = useState<{ owner: string; repo: string } | null>(null);
  const [check, setCheck] = useState<TokenReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nameCopied, setNameCopied] = useState(false);
  // 新しく作っているところ（作る → Life Manager に許可 → この PC に。CreateRepoFlow）
  const [createBusy, setCreateBusy] = useState(false);
  // Life Manager App を入れる画面（使用するリポジトリを選ぶ・リポジトリを追加する）と、入れてある先
  const [installUrl, setInstallUrl] = useState("");
  const [installations, setInstallations] = useState<Installation[] | null>(null);
  // 届いている招待の数（使い方を選ぶ画面で、「招待を受ける」に印をつける）
  const [inviteCount, setInviteCount] = useState(0);
  // 参加したリポジトリを使えるか確かめているところ
  const [joining, setJoining] = useState<string | null>(null);
  // 招待を受ける画面を開いたとき、もう参加していたリポジトリ（あとから増えたものを「参加しました」と出す）
  const [joinBaseline, setJoinBaseline] = useState<Set<string> | null>(null);
  // 招待に参加したが、まだ使えない（リーダーが Life Manager を入れていない）
  const [joinProblem, setJoinProblem] = useState<{ fullName: string; message: string } | null>(null);
  const [joinTextCopied, setJoinTextCopied] = useState(false);
  // 最初に出す知らせ（この PC の期限が来た・ログアウトした）
  const [notice, setNotice] = useState<{ kind: "expired" } | { kind: "signed-out"; login: boolean } | null>(null);
  // この PC にしまってあるアカウント（ログインの画面から、そのアカウントに戻れる）
  const [savedAccounts, setSavedAccounts] = useState<SavedAccount[]>([]);
  const [restoring, setRestoring] = useState<string | null>(null);

  useEffect(() => {
    // セットアップの途中という印（使うリポジトリを選ぶ前に閉じても、次は続きから）
    markSetupPending(true);
    authClientId()
      .then(setClientId)
      .catch(() => setClientId(""));
    authInstallUrl().then(setInstallUrl).catch(() => {});
    listAccounts().then(setSavedAccounts).catch(() => {});
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

  // ログインした人が変わったら、前の人の一覧は使わない
  function signedIn(report: TokenReport) {
    setMe(report);
    setRepos(null);
    setInstallations(null);
    setPath(null);
    setPicked(null);
    setStep(1);
  }

  // 続きから: ログインが生きていれば、だれかを出して 2. へ（切れていれば 1. のまま。知らせは出さない）
  useEffect(() => {
    if (!resume) return;
    let alive = true;
    checkToken({ repos: [] })
      .then((r) => {
        if (alive) signedIn(r);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [resume]);

  // ログインできた・トークンを入れた → だれのトークンかを出す（前にこの PC で使っていたアカウントなら、そのまま続きから）
  async function loggedIn() {
    setError(null);
    try {
      const report = await checkToken({ repos: [] });
      if (onLoggedIn && (await onLoggedIn(report))) return;
      signedIn(report);
    } catch (e) {
      setError(String(e));
    }
  }

  // しまってあるアカウントに戻る
  async function restore(login: string) {
    if (!onRestoreAccount) return;
    setRestoring(login);
    setError(null);
    try {
      await onRestoreAccount(login);
    } catch (e) {
      setError(String(e));
      setRestoring(null);
    }
  }

  // 使えるリポジトリを読む（2. に来たとき・招待に参加したとき・「読み直す」）。pick があれば、読んだあとそれを選ぶ
  const loadRepos = useCallback(async (pick?: string) => {
    try {
      const list = await listUserRepos();
      setRepos(list);
      setReposError(null);
      const found = pick ? list.find((r) => r.full_name.toLowerCase() === pick.toLowerCase()) : undefined;
      if (found) setPicked({ owner: found.owner.login, repo: found.name });
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
    if (step < 1 || repos !== null) return;
    loadRepos();
    if (byLogin) loadInstallations();
  }, [step, repos, loadRepos, byLogin, loadInstallations]);

  // 使い方を選ぶ画面: 届いている招待を数える（あいだに届いたときも気づけるよう、30 秒ごとに）
  useEffect(() => {
    if (step !== 1) return;
    let alive = true;
    const load = () =>
      listMyInvitations()
        .then((d) => {
          if (alive) setInviteCount(d.repos.filter((r) => !r.expired).length + d.orgs.length);
        })
        .catch(() => {});
    load();
    const timer = window.setInterval(load, INVITE_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [step]);

  // 自分のリポジトリ（管理者のもの。チームを作る・個人で使う）と、参加したリポジトリ（招待を受ける）
  const ownRepos = useMemo(
    () => (repos ?? []).filter((r) => r.owner.login.toLowerCase() === me?.login.toLowerCase() || r.permissions?.admin),
    [repos, me],
  );
  const joinedRepos = useMemo(() => (repos ?? []).filter((r) => r.owner.login.toLowerCase() !== me?.login.toLowerCase()), [repos, me]);
  // 招待を受ける画面を開いてから参加したもの（GitHub の画面で受けた）と、前から参加しているもの
  const newlyJoined = useMemo(
    () => (joinBaseline ? joinedRepos.filter((r) => !joinBaseline.has(r.full_name.toLowerCase())) : []),
    [joinedRepos, joinBaseline],
  );
  const otherJoined = useMemo(() => joinedRepos.filter((r) => !newlyJoined.includes(r)), [joinedRepos, newlyJoined]);

  // 招待を受ける: 開いたときに使えたリポジトリを覚えておく
  useEffect(() => {
    if (step !== 2 || path !== "join" || joinBaseline !== null || repos === null) return;
    setJoinBaseline(new Set(repos.map((r) => r.full_name.toLowerCase())));
  }, [step, path, joinBaseline, repos]);

  // 招待を受ける: GitHub の画面で参加すると使えるリポジトリが増えるので、確かめ続ける
  useEffect(() => {
    if (step !== 2 || path !== "join") return;
    const started = Date.now();
    let alive = true;
    let timer = 0;
    const tick = async () => {
      await loadRepos();
      if (alive) timer = window.setTimeout(tick, Date.now() - started < JOIN_FAST_MS ? JOIN_POLL_MS : JOIN_SLOW_POLL_MS);
    };
    timer = window.setTimeout(tick, JOIN_POLL_MS);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [step, path, loadRepos]);

  // もうあるリポジトリを使う: まだ選んでいなければ、いちばん最近のものを選んでおく
  useEffect(() => {
    if (step !== 2 || !path || path === "join" || mode !== "existing" || picked || repos === null) return;
    const first = ownRepos[0];
    if (first) setPicked({ owner: first.owner.login, repo: first.name });
  }, [step, path, mode, picked, repos, ownRepos]);

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

  const pickedOk = !!check && check.repos[0]?.ok;
  // 自分のアカウントに Life Manager App が入っているか（参加しているリポジトリの持ち主の分は数えない）
  const ownInstall = !!me && !!installations?.some((i) => i.account.login.toLowerCase() === me.login.toLowerCase());
  const startReady = mode === "existing" && !!picked && pickedOk;
  const team = path === "team";
  const startLabel = team ? "はじめて、メンバーを招待する" : "はじめる";

  function choose(p: Path) {
    setPath(p);
    setMode(null);
    setPicked(null);
    setError(null);
    setJoinProblem(null);
    setJoinBaseline(null);
    setStep(2);
  }

  function back() {
    setError(null);
    setJoinProblem(null);
    // チームを作る・個人で使う: もうある／新しく作る を選び直す
    if (step === 2 && mode !== null) {
      setMode(null);
      setPicked(null);
      return;
    }
    if (step === 2) setPath(null);
    setStep((s) => Math.max(0, s - 1));
  }

  async function copyName() {
    if (!me) return;
    try {
      await navigator.clipboard.writeText(me.login);
      setNameCopied(true);
    } catch {
      // コピーできなくても、名前は画面に出ている
    }
  }

  // もうあるリポジトリを使う: 選んだもので、はじめる（チームなら、はじめたあと 設定 → 接続 を開く）
  async function start() {
    if (!startReady || finishing || !picked) return;
    await startWith(picked.owner, picked.repo, team);
  }

  async function startWith(owner: string, repo: string, inviteNext = false, folder?: string) {
    setFinishing(true);
    setError(null);
    try {
      await onDone(owner, repo, inviteNext, folder);
    } catch (e) {
      setError(String(e));
      setFinishing(false);
    }
  }

  // このリポジトリではじめる: 参加したリポジトリを使えるのを確かめて、そのままはじめる。
  // 参加したばかりは使えるようになるまで少しかかることがあるので、何度か確かめる
  async function joinAndStart(fullName: string) {
    setJoinProblem(null);
    setJoining(fullName);
    const [owner, repo] = fullName.split("/");
    let message = "";
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const r = await checkToken({ repos: [{ owner, repo }] });
        if (r.repos[0]?.ok) {
          setJoining(null);
          await startWith(owner, repo);
          return;
        }
        message = r.repos[0]?.message ?? "";
      } catch (e) {
        message = String(e);
      }
      await sleep(2000);
    }
    setJoining(null);
    setJoinProblem({ fullName, message });
    await loadRepos();
  }

  async function copyJoinText() {
    if (!joinProblem) return;
    const [, repo] = joinProblem.fullName.split("/");
    const text = `${joinProblem.fullName} に参加しました。Life Manager で使えるように、このリポジトリに Life Manager App を入れてください。Life Manager の「使用するリポジトリを選ぶ」か「リポジトリを追加する」で ${repo} を選びます。`;
    try {
      await navigator.clipboard.writeText(text);
      setJoinTextCopied(true);
    } catch {
      // コピーできなくても、文は画面に出ている
    }
  }

  const steps = ["GitHub にログイン", "使い方を選ぶ", PATHS.find((p) => p.id === path)?.label ?? "準備する"];

  const signupTips = (
    <ul className="setup-tips">
      <li>メールに届く数字のコードを入れると、登録が終わります。届かないときは迷惑メールのフォルダも見てください。</li>
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
        <p className="setup-sub">タスク（GitHub の Issue）と git の作業をひとつの画面で。</p>
        <ol className="setup-steps">
          {onLook && (
            <li className="done">
              <button type="button" className="link-button setup-look" onClick={onLook} title="見た目を選び直す">
                1. 見た目
              </button>
            </li>
          )}
          {steps.map((s, i) => (
            <li key={s} className={i < step ? "done" : i === step ? "on" : ""}>
              {i + (onLook ? 2 : 1)}. {s}
            </li>
          ))}
        </ol>

        {/* 別のアカウントを足しているところ: ブラウザの GitHub を切り替えてからログインする。やめると前のアカウントに戻る */}
        {adding && (
          <div className="setup-adding">
            <div>
              <b>別のアカウントを追加しています</b>（{adding} はしまってあります）。
              {step === 0 && (
                <>
                  先に、<b>ブラウザの GitHub を、追加したいアカウントに切り替えて</b>ください（GitHub の右上のアイコン →「Switch account」か「Add account」）。
                  今のアカウントのままだと、同じアカウントが入ります。
                </>
              )}
            </div>
            <button type="button" className="btn-sm" disabled={restoring !== null} onClick={() => restore(adding)}>
              {restoring === adding ? "戻っています…" : `やめる（${adding} に戻る）`}
            </button>
          </div>
        )}

        {/* この PC にしまってあるアカウント（足している途中で閉じた・ログアウトしたあとなど）に戻れる */}
        {step === 0 && !adding && onRestoreAccount && savedAccounts.length > 0 && (
          <div className="setup-saved">
            <span>{THIS_DEVICE}でログインしたアカウントで続ける:</span>
            {savedAccounts.map((a) => (
              <button key={a.login} type="button" className="btn-sm setup-saved-account" disabled={restoring !== null} onClick={() => restore(a.login)}>
                {a.avatar_url ? <img src={a.avatar_url} alt="" /> : <span aria-hidden="true">👤</span>}
                {restoring === a.login ? "戻っています…" : a.login}
              </button>
            ))}
          </div>
        )}

        {step === 0 && notice && (
          <div className="setup-notice">
            {notice.kind === "expired" ? (
              <>{THIS_DEVICE}で使う期限が来たので、ログインの鍵を消しました。もう一度ログインしてください。</>
            ) : (
              <>
                ログアウトしました（{THIS_DEVICE}から鍵を消しました）。
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
                  <b>ログイン</b>すると、このアプリがあなたの代わりに読み書きできるようになります。読み書きできるのは、あなたが選んだリポジトリ（Life Manager を入れたリポジトリ）の Issue やファイルです。GitHub の設定（Applications）から、いつでも取り消せます。チームでは、リーダーがリポジトリに Life Manager を入れてメンバーを招待し、メンバーはそれぞれ自分のアカウントでログインします。
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
                  ログイン中：<b>{me.login}</b>
                </span>
                {meExpiry && <span className="setup-me-expiry">（期限 {meExpiry.date}）</span>}
              </div>
            )}
            <h2 className="setup-ask">どのように使いますか？</h2>
            <div className="setup-picks">
              {PATHS.map((p) => {
                const hot = p.id === "join" && inviteCount > 0;
                return (
                  <button key={p.id} type="button" className={`setup-pick${hot ? " setup-pick--hot" : ""}`} onClick={() => choose(p.id)}>
                    <span className="setup-pick-icon" aria-hidden="true">{p.icon}</span>
                    <span className="setup-pick-body">
                      <span className="setup-pick-title">
                        {p.label}
                        {hot && <span className="setup-pick-badge">{inviteCount} 件届いています</span>}
                      </span>
                      <span className="setup-pick-desc">{p.desc}</span>
                    </span>
                    <span className="setup-pick-go" aria-hidden="true">›</span>
                  </button>
                );
              })}
            </div>
          </>
        )}

        {step === 2 && path === "join" && (
          <>
            {me && (
              <>
                <div className="setup-name">
                  {me.avatar_url && <img src={me.avatar_url} alt="" />}
                  <div className="setup-name-body">
                    <div className="setup-name-k">あなたの GitHub の名前</div>
                    <div className="setup-name-v">{me.login}</div>
                  </div>
                  <button type="button" className="btn-sm" onClick={copyName} title="チームのリーダーに伝えて、リポジトリに招待してもらいます">
                    {nameCopied ? "✔ コピーしました" : "コピー"}
                  </button>
                </div>
              </>
            )}
            <ol className="setup-join-steps">
              <li>この名前をリーダーに伝える</li>
              <li>
                招待のメールが届いたら「<b>View invitation</b>」→「<b>Accept invitation</b>」（リーダーから届いたリンクを開いても同じ）
              </li>
              <li>参加するとアプリが自動で見つけます</li>
            </ol>
            {newlyJoined.length === 0 ? (
              <p className="setup-wait">
                <i className="spinner" aria-hidden="true" /> 参加を待っています…
              </p>
            ) : (
              newlyJoined.map((r) => (
                <div key={r.full_name} className="setup-joined-new">
                  <b>✔ {r.full_name} に参加しました</b>
                  <span className="setup-note">
                    {r.owner.type === "Organization" ? `組織 ${r.owner.login} のリポジトリ` : `${r.owner.login} さんのリポジトリ`}
                    {r.private ? "・非公開" : ""}
                  </span>
                  <button type="button" className="btn-primary" disabled={!!joining || finishing} onClick={() => joinAndStart(r.full_name)}>
                    このリポジトリではじめる
                  </button>
                </div>
              ))
            )}
            {joining && (
              <p className="setup-note">
                <i className="spinner" aria-hidden="true" /> {joining} を使えるか確かめています…
              </p>
            )}
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
            {otherJoined.length > 0 && (
              <div className="setup-joined">
                <p className="setup-note">ほかに参加しているリポジトリ</p>
                {otherJoined.map((r) => (
                  <div key={r.full_name} className="setup-joined-row">
                    {r.owner.avatar_url && <img src={r.owner.avatar_url} alt="" />}
                    <span className="setup-joined-name">{r.full_name}</span>
                    {r.private && <span className="setup-repo-badge">非公開</span>}
                    <button type="button" className="btn-sm" disabled={!!joining || finishing} onClick={() => joinAndStart(r.full_name)}>
                      はじめる
                    </button>
                  </div>
                ))}
              </div>
            )}
            <p className="setup-note">
              招待はアプリの中には出ません。参加する前のリポジトリは、GitHub の決まりでアプリから見えないためです。参加したのに、しばらくしても出てこないときは、リーダーに「そのリポジトリに Life Manager を入れて」と伝えてください。
            </p>
          </>
        )}

        {step === 2 && (path === "team" || path === "solo") && (
          <>
            <p className="setup-lead">{team ? "チームで使うリポジトリを用意して、メンバーを招待します。" : "自分だけのリポジトリでタスクを管理します。"}</p>
            {mode === null && (
              <div className="wizard-choices">
                <button type="button" className="wizard-choice" onClick={() => { setMode("existing"); setError(null); }}>
                  <span className="wizard-choice-icon" aria-hidden="true">📂</span>
                  <span className="wizard-choice-body">
                    <b>もうあるリポジトリを使う</b>
                    <span>GitHub にあるリポジトリを Life Manager に許可して使います</span>
                  </span>
                </button>
                <button type="button" className="wizard-choice" onClick={() => { setMode("new"); setError(null); }}>
                  <span className="wizard-choice-icon" aria-hidden="true">✨</span>
                  <span className="wizard-choice-body">
                    <b>新しく作る</b>
                    <span>作る → Life Manager に許可 → この PC に持ってくる、の順に進めます</span>
                  </span>
                </button>
              </div>
            )}

            {mode === "existing" && (
              <>
                <ol className="setup-path-steps">
                  {byLogin && me && installUrl && (
                    <li>
                      <b>Life Manager に許可する</b>（使うリポジトリだけを選びます）
                      <RepoAccess me={me} installUrl={installUrl} installations={installations} primary={!ownInstall}
                        onChanged={async (added) => {
                          await loadInstallations();
                          await loadRepos(added.length === 1 ? added[0] : undefined);
                        }} />
                    </li>
                  )}
                  <li>
                    <b>使うリポジトリを選ぶ</b>
                    <div className="setup-radio">
                      {ownRepos.length > 0 ? (
                        <select className="select-sm" value={picked ? `${picked.owner}/${picked.repo}` : ""}
                          onChange={(e) => {
                            const [owner, repo] = e.target.value.split("/");
                            if (owner && repo) setPicked({ owner, repo });
                          }}>
                          {!picked && <option value="">選ぶ</option>}
                          {ownRepos.map((r) => (
                            <option key={r.full_name} value={r.full_name}>
                              {r.full_name}{r.private ? "（非公開）" : ""}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="setup-note">{repos === null ? "読んでいます…" : byLogin ? "まだありません（上で許可するとここに出ます）" : "まだありません"}</span>
                      )}
                      <button type="button" className="link-button" onClick={() => { loadRepos(); if (byLogin) loadInstallations(); }}
                        title="GitHub で許可したあとなど、使えるリポジトリをもう一度読みます">
                        読み直す
                      </button>
                    </div>
                  </li>
                </ol>
                {checking && (
                  <p className="setup-note">
                    <i className="spinner" aria-hidden="true" /> 使えるか確かめています…
                  </p>
                )}
                {check && check.repos[0] && !check.repos[0].ok && <TokenReportView report={check} installUrl={installUrl} />}
                {check && check.repos[0]?.ok && check.repos[0].message && <p className="setup-note">⚠ {check.repos[0].message}</p>}
                {reposError && <p className="token-error">リポジトリの一覧を読めませんでした（{reposError}）</p>}
              </>
            )}

            {mode === "new" && (
              <CreateRepoFlow
                defaultName={NEW_NAMES[path]}
                finishLabel={() => startLabel}
                onFinish={(o, r, folder) => startWith(o, r, team, folder)}
                onBack={() => setMode(null)}
                onBusyChange={setCreateBusy}
              />
            )}

            {mode !== "new" && (
              <p className="setup-note">
                {team
                  ? "はじめると 設定 → 接続 が開きます。「参加の案内をコピー」してチャットなどに貼り、届いた名前を貼って招待します。"
                  : "あとから 設定 → 接続 でメンバーを招待すれば、チームで使えます。"}
              </p>
            )}
          </>
        )}

        {error && <p className="token-error">{error}</p>}

        {!(step === 2 && mode === "new") && (
          <div className="setup-actions">
            <button type="button" className="btn-sm" style={{ visibility: step > 0 ? "visible" : "hidden" }} disabled={finishing || createBusy}
              onClick={back}>
              ← 戻る
            </button>
            {step === 2 && mode === "existing" && (path === "team" || path === "solo") && (
              <button type="button" className="btn-primary" disabled={!startReady || finishing} onClick={start}>
                {finishing ? "準備しています…" : startLabel}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
