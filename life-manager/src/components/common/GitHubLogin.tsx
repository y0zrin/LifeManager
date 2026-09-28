import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { authPoll, authStart, type DeviceCode } from "../../lib/auth";

interface GitHubLoginProps {
  /** ログインできた（トークンはアプリの中にしまってある） */
  onDone: () => void;
  /** ボタンの文字（「GitHub でログイン」「ログインし直す」など） */
  label?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 「GitHub でログイン」（デバイスフロー）。ブラウザで GitHub が開くので、画面のコードを入れて「Authorize」を押す。
 * 許可されるまで、GitHub に数秒ごとに確かめに行く
 */
export function GitHubLogin({ onDone, label = "GitHub でログイン" }: GitHubLoginProps) {
  const [code, setCode] = useState<DeviceCode | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [copied, setCopied] = useState(false);
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
      openUrl(dc.verification_uri).catch(() => {});
      let interval = Math.max(dc.interval, 5);
      const deadline = Date.now() + dc.expires_in * 1000;
      while (alive.current && mine === attempt.current && Date.now() < deadline) {
        await sleep(interval * 1000);
        if (!alive.current || mine !== attempt.current) return;
        const r = await authPoll(dc.device_code);
        if (r.status === "pending") continue;
        if (r.status === "slow_down") {
          interval = Math.max(r.interval, interval + 5);
          continue;
        }
        setCode(null);
        if (r.status === "done") {
          onDone();
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
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // コピーできなくても、コードは画面に出ている
    }
  }

  if (code) {
    return (
      <div className="gh-login">
        <p className="gh-login-lead">ブラウザで GitHub が開きました。次のコードを入れて「Continue」→「Authorize」を押してください。</p>
        <div className="gh-login-code">
          <b>{code.user_code}</b>
          <button type="button" className="btn-sm" onClick={copy}>
            {copied ? "コピーしました" : "コピー"}
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
      <button type="button" className="gh-login-button" disabled={starting} onClick={start}>
        {starting ? "GitHub に問い合わせています…" : label}
      </button>
      {message && <p className="gh-login-error">{message}</p>}
    </div>
  );
}
