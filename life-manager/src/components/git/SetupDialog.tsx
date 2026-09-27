import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import * as git from "../../lib/git";
import type { GitSetupStatus } from "../../lib/types";

interface SetupDialogProps {
  status: GitSetupStatus;
  /** 起動したときに自動で開いた（「次からは起動時に表示しない」を出す） */
  auto: boolean;
  onClose: (dontShowAgain: boolean) => void;
  /** Git を入れた・名前を決めたあと（画面の状態を読み直す） */
  onChanged: () => void;
  onNotify: (kind: "ok" | "error", text: string, command?: string) => void;
}

type Step = "git" | "installing" | "failed" | "identity" | "ready";

const INSTALL_COMMANDS: Record<string, string> = {
  winget: "winget install --id Git.Git -e --source winget",
  download: "（Git for Windows の公式のインストーラーを GitHub から取ってきて実行）",
  xcode: "xcode-select --install",
};

/** GitHub のアカウントから、コミットに使う名前と、メールアドレスを公開しない GitHub のアドレス（noreply）を作る */
async function suggestIdentity(): Promise<{ name: string; email: string }> {
  try {
    const user = JSON.parse((await invoke("get_current_user")) as string);
    return {
      name: user.name || user.login || "",
      email: user.id && user.login ? `${user.id}+${user.login}@users.noreply.github.com` : "",
    };
  } catch {
    return { name: "", email: "" };
  }
}

/** 使う準備: Git が入っていなければ入れるかを聞き、コミットに使う名前とメールアドレスを決める */
export function SetupDialog({ status: initial, auto, onClose, onChanged, onNotify }: SetupDialogProps) {
  const [status, setStatus] = useState(initial);
  const [step, setStep] = useState<Step>(() => (!initial.git ? "git" : !initial.user_name || !initial.user_email ? "identity" : "ready"));
  const [error, setError] = useState<string | null>(null);
  const [installedNote, setInstalledNote] = useState<string | null>(null);
  const [name, setName] = useState(initial.user_name ?? "");
  const [email, setEmail] = useState(initial.user_email ?? "");
  const [saving, setSaving] = useState(false);
  const [dontShow, setDontShow] = useState(false);
  const firstRef = useRef<HTMLButtonElement>(null);

  // 名前・メールアドレスが決まっていなければ、GitHub のアカウントから候補を入れておく
  useEffect(() => {
    if (step !== "identity" || (name && email)) return;
    let alive = true;
    suggestIdentity().then((s) => {
      if (!alive) return;
      setName((n) => n || s.name);
      setEmail((e) => e || s.email);
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  useEffect(() => {
    firstRef.current?.focus();
  }, [step]);

  const busy = step === "installing" || saving;
  const close = () => { if (!busy) onClose(dontShow); };

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  async function install() {
    setStep("installing");
    setError(null);
    try {
      const run = await git.installGit();
      const next = await git.setupStatus();
      setStatus(next);
      onChanged();
      if (!next.git) {
        // macOS はインストールの画面が別に出る。終わってから確かめ直してもらう
        setInstalledNote(run.output || "インストールが終わったら、「もう一度確かめる」を押してください");
        setStep("failed");
        return;
      }
      onNotify("ok", `Git ${next.git} をインストールしました`, run.command);
      setInstalledNote(`Git ${next.git} をインストールしました。`);
      setName(next.user_name ?? "");
      setEmail(next.user_email ?? "");
      setStep(!next.user_name || !next.user_email ? "identity" : "ready");
    } catch (e) {
      setError(git.splitGitError(e).message);
      setStep("failed");
    }
  }

  async function recheck() {
    const next = await git.setupStatus();
    setStatus(next);
    if (next.git) {
      onChanged();
      setInstalledNote(`Git ${next.git} が使えるようになりました。`);
      setError(null);
      setStep(!next.user_name || !next.user_email ? "identity" : "ready");
    }
  }

  async function saveIdentity() {
    setSaving(true);
    setError(null);
    try {
      const run = await git.setIdentity(name, email);
      onNotify("ok", "コミットに使う名前とメールアドレスを決めました", run.command);
      onChanged();
      onClose(false);
    } catch (e) {
      setError(git.splitGitError(e).message);
    } finally {
      setSaving(false);
    }
  }

  const identityCommand = `${git.displayCommand(["config", "--global", "user.name", name.trim() || "名前"])} && ${git.displayCommand([
    "config",
    "--global",
    "user.email",
    email.trim() || "メールアドレス",
  ])}`;

  return (
    <div className="palette-overlay git-dialog-back" onClick={close}>
      <div className="git-dialog setup-dialog" role="dialog" aria-modal="true" aria-label="使う準備" onClick={(e) => e.stopPropagation()}>
        {(step === "git" || step === "installing" || step === "failed") && (
          <>
            <h3>Git をインストールしますか？</h3>
            <p className="git-dialog-message">
              LifeManager の「作業」「ブランチ」「全体図」では、Git（ギット）を使います。Git
              は、ファイルの変更を記録して、いつ・だれが・何を変えたかを残すための道具です。この PC には Git
              が入っていないようです。
            </p>
            {status.installer ? (
              <>
                <p className="git-dialog-note">
                  インストールには数分かかります。
                  {status.installer !== "xcode" && "途中で「このアプリがデバイスに変更を加えることを許可しますか？」と出たら「はい」を押してください。"}
                </p>
                <div className="cmd-preview">
                  <span>実行するコマンド</span>
                  <code>{INSTALL_COMMANDS[status.installer]}</code>
                </div>
              </>
            ) : (
              <p className="git-dialog-note">この PC では自動でインストールできません。Git のページからインストールしてください。</p>
            )}
            {step === "installing" && <p className="git-dialog-running"><i className="spinner" aria-hidden="true" /> Git をインストールしています…</p>}
            {installedNote && step === "failed" && <p className="git-dialog-note">{installedNote}</p>}
            {error && <p className="git-dialog-error">{error}</p>}
            <div className="git-dialog-actions">
              {auto && step === "git" && (
                <label className="chk setup-dont-show">
                  <input type="checkbox" checked={dontShow} onChange={(e) => setDontShow(e.target.checked)} />
                  次からは起動時に表示しない
                </label>
              )}
              <button type="button" className="btn-sm" disabled={busy} onClick={close}>
                あとで
              </button>
              {(step === "failed" || !status.installer) && (
                <button type="button" className="btn-sm" onClick={() => openUrl("https://git-scm.com/downloads")}>
                  Git のページを開く
                </button>
              )}
              {step === "failed" && (
                <button type="button" className="btn-sm" onClick={recheck}>
                  もう一度確かめる
                </button>
              )}
              {status.installer && (
                <button type="button" className="btn-primary" ref={firstRef} disabled={busy} onClick={install}>
                  {step === "failed" ? "もう一度インストールする" : "インストールする"}
                </button>
              )}
            </div>
          </>
        )}

        {step === "identity" && (
          <>
            <h3>コミットに使う名前とメールアドレス</h3>
            {installedNote && <p className="local-folder-message local-folder-message--ok">{installedNote}</p>}
            <p className="git-dialog-message">
              コミットには、だれが変更したかを残すため、名前とメールアドレスを付けます。この PC
              で一度決めれば、すべてのリポジトリで使われます。
            </p>
            <label className="git-dialog-label">
              名前
              <input className="input-full" value={name} autoComplete="off" onChange={(e) => setName(e.target.value)} disabled={saving} />
            </label>
            <label className="git-dialog-label">
              メールアドレス
              <input className="input-full" value={email} autoComplete="off" spellCheck={false} onChange={(e) => setEmail(e.target.value)} disabled={saving} />
            </label>
            <p className="git-dialog-note">
              はじめに入っているのは、GitHub が用意する公開用のアドレス（…@users.noreply.github.com）です。コミットは GitHub
              で公開されるので、ふだんのメールアドレスの代わりにこれを使うと、アドレスを知られずにすみます。
            </p>
            <div className="cmd-preview">
              <span>実行するコマンド</span>
              <code>{identityCommand}</code>
            </div>
            {error && <p className="git-dialog-error">{error}</p>}
            <div className="git-dialog-actions">
              {auto && !installedNote && (
                <label className="chk setup-dont-show">
                  <input type="checkbox" checked={dontShow} onChange={(e) => setDontShow(e.target.checked)} />
                  次からは起動時に表示しない
                </label>
              )}
              <button type="button" className="btn-sm" disabled={saving} onClick={close}>
                あとで
              </button>
              <button
                type="button"
                className="btn-primary"
                ref={firstRef}
                disabled={saving || !name.trim() || !email.trim()}
                onClick={saveIdentity}
              >
                {saving ? "設定しています…" : "設定する"}
              </button>
            </div>
          </>
        )}

        {step === "ready" && (
          <>
            <h3>使う準備はできています</h3>
            {installedNote && <p className="local-folder-message local-folder-message--ok">{installedNote}</p>}
            <dl className="setup-summary">
              <dt>Git</dt>
              <dd>{status.git}</dd>
              <dt>コミットに使う名前</dt>
              <dd>{status.user_name}</dd>
              <dt>メールアドレス</dt>
              <dd>{status.user_email}</dd>
            </dl>
            <div className="git-dialog-actions">
              <button type="button" className="btn-sm" onClick={() => setStep("identity")}>
                名前とメールアドレスを変える
              </button>
              <button type="button" className="btn-primary" ref={firstRef} onClick={close}>
                閉じる
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
