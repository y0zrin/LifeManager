import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { authPoll, authStart, loadLoginDays, LOGIN_PERIODS, storeLoginDays, type DeviceCode } from "../../lib/auth";

interface GitHubLoginProps {
  /** ログインできた（トークンはアプリの中にしまってある）。Promise を返すと、終わるまで「準備しています」を出す */
  onDone: () => void | Promise<unknown>;
  /** ボタンの文字（「GitHub でログイン」「ログインし直す」など） */
  label?: string;
  /** すぐに始める（アカウントを作ったあとの「作れた・ログインへ」で、もう一度押さなくてよいように） */
  autoStart?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 「GitHub でログイン」（デバイスフロー）。コードをコピーしてからブラウザで GitHub を開くので、
 * 貼って「Continue」→「Authorize」を押すだけ。許可されるまで、GitHub に数秒ごとに確かめに行く。
 * この PC で使う期限（30 日・90 日・半年）を選び、過ぎたらログインし直す
 */
export function GitHubLogin({ onDone, label = "GitHub でログイン", autoStart = false }: GitHubLoginProps) {
  const [days, setDays] = useState(loadLoginDays);
  const [code, setCode] = useState<DeviceCode | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [copied, setCopied] = useState(false);
  // 許可されたあと、呼んだ側の準備（アカウントを読むなど）が終わるまで。最初のボタンに戻して見せない（失敗に見える・もう一度押せてしまう）
  const [finishing, setFinishing] = useState(false);
  // 画面を離れたら、確かめに行くのをやめる
  const alive = useRef(true);
  const attempt = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  async function start() {
    setStarting(true);
    setMessage(null);
    const mine = ++attempt.current;
    try {
      const dc = await authStart();
      if (!alive.current || mine !== attempt.current) return;
      setCode(dc);
      // 貼るだけで済むよう、ブラウザを開く前にコードをコピーしておく
      setCopied(false);
      await navigator.clipboard
        .writeText(dc.user_code)
        .then(() => setCopied(true))
        .catch(() => {});
      openUrl(dc.verification_uri).catch(() => {});
      let interval = Math.max(dc.interval, 5);
      const deadline = Date.now() + dc.expires_in * 1000;
      while (alive.current && mine === attempt.current && Date.now() < deadline) {
        await sleep(interval * 1000);
        if (!alive.current || mine !== attempt.current) return;
        const r = await authPoll(dc.device_code, days);
        if (r.status === "pending") continue;
        if (r.status === "slow_down") {
          interval = Math.max(r.interval, interval + 5);
          continue;
        }
        setCode(null);
        if (r.status === "done") {
          setFinishing(true);
          try {
            await onDone();
          } finally {
            if (alive.current) setFinishing(false);
          }
        } else if (r.status === "expired") {
          setMessage("コードの期限（15 分）が切れました。もう一度「" + label + "」を押してください");
        } else if (r.status === "denied") {
          setMessage("GitHub の画面で、ログインをやめました。もう一度押すと、やり直せます");
        } else {
          setMessage(r.message);
        }
        return;
      }
      if (alive.current && mine === attempt.current) {
        setCode(null);
        setMessage("コードの期限（15 分）が切れました。もう一度「" + label + "」を押してください");
      }
    } catch (e) {
      if (alive.current && mine === attempt.current) {
        setCode(null);
        setMessage(String(e));
      }
    } finally {
      if (alive.current) setStarting(false);
    }
  }

  function cancel() {
    attempt.current++;
    setCode(null);
    setStarting(false);
  }

  async function copy() {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code.user_code);
      setCopied(true);
    } catch {
      // コピーできなくても、コードは画面に出ている
    }
  }

  // 「作れた・ログインへ」: 出したらすぐに始める（開発中の二重の呼び出しでも、1 回だけ）
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!autoStart || autoStarted.current) return;
    autoStarted.current = true;
    start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart]);

  if (finishing) {
    return (
      <div className="gh-login">
        <p className="gh-login-wait">
          <i className="spinner" aria-hidden="true" /> ログインできました。準備しています…
        </p>
      </div>
    );
  }

  if (code) {
    return (
      <div className="gh-login">
        <p className="gh-login-lead">
          ブラウザで GitHub が開きました。{copied ? "コードはコピーしてあるので、貼って（Ctrl+V）" : "次のコードを入れて"}「Continue」→「Authorize」を押してください。
        </p>
        <div className="gh-login-code">
          <b>{code.user_code}</b>
          <button type="button" className="btn-sm" onClick={copy}>
            {copied ? "✔ コピーしてあります（もう一度）" : "コピー"}
          </button>
        </div>
        <p className="gh-login-wait">
          <i className="spinner" aria-hidden="true" /> GitHub で許可されるのを待っています…（ブラウザが開かないとき：
          <button type="button" className="link-button" onClick={() => openUrl(code.verification_uri)}>
            {code.verification_uri.replace(/^https:\/\//, "")}
          </button>
          ）
        </p>
        <button type="button" className="link-button" onClick={cancel}>
          やめる
        </button>
      </div>
    );
  }

  return (
    <div className="gh-login">
      <label className="gh-login-period">
        この PC で使う期限
        <select className="select-sm" value={days} disabled={starting}
          onChange={(e) => { const d = Number(e.target.value); setDays(d); storeLoginDays(d); }}>
          {LOGIN_PERIODS.map((p) => (
            <option key={p.days} value={p.days}>{p.label}</option>
          ))}
        </select>
      </label>
      <button type="button" className="gh-login-button" disabled={starting} onClick={start}>
        {starting ? "GitHub に問い合わせています…" : label}
      </button>
      <p className="gh-login-note">
        アプリが触れるのは、Life Manager に選んだリポジトリだけです。鍵は 8 時間ごとに自動で新しくなり、期限が来たらログインし直します。
      </p>
      {message && <p className="gh-login-error">{message}</p>}
    </div>
  );
}
