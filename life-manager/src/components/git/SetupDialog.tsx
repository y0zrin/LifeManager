import { useEffect, useRef, useState } from "react";
import { invoke } from "../../lib/invoke";
import { openUrl } from "@tauri-apps/plugin-opener";
import * as git from "../../lib/git";
import type { GitSetupStatus } from "../../lib/types";
import { isEscape } from "../../lib/keys";
import { tr, trx } from "../../lib/i18n";

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
  download: tr("（Git for Windows の公式のインストーラーを GitHub から取ってきて実行）"),
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
      if (isEscape(e)) close();
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
        setInstalledNote(run.output || tr("インストールが終わったら、「もう一度確かめる」を押してください"));
        setStep("failed");
        return;
      }
      onNotify("ok", tr("Git {git} をインストールしました", { git: next.git }), run.command);
      setInstalledNote(tr("Git {git} をインストールしました。", { git: next.git }));
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
      setInstalledNote(tr("Git {git} が使えるようになりました。", { git: next.git }));
      setError(null);
      setStep(!next.user_name || !next.user_email ? "identity" : "ready");
    }
  }

  async function saveIdentity() {
    setSaving(true);
    setError(null);
    try {
      const run = await git.setIdentity(name, email);
      onNotify("ok", tr("コミットに使う名前とメールアドレスを決めました"), run.command);
      onChanged();
      onClose(false);
    } catch (e) {
      setError(git.splitGitError(e).message);
    } finally {
      setSaving(false);
    }
  }

  const identityCommand = `${git.displayCommand(["config", "--global", "user.name", name.trim() || tr("名前")])} && ${git.displayCommand([
    "config",
    "--global",
    "user.email",
    email.trim() || tr("メールアドレス"),
  ])}`;

  return (
    <div className="palette-overlay git-dialog-back" onClick={close}>
      <div className="git-dialog setup-dialog" role="dialog" aria-modal="true" aria-label={tr("使う準備")} onClick={(e) => e.stopPropagation()}>
        {(step === "git" || step === "installing" || step === "failed") && (
          <>
            <h3>{tr("Git をインストールしますか？")}</h3>
            <p className="git-dialog-message">
              {tr("Life Manager の「作業をする」「ブランチ」「全体図」では、Git（ギット）を使います。Git はファイルの変更を記録する道具です。いつ、だれが、何を変えたかが残ります。この PC には Git が入っていないようです。")}
            </p>
            {status.installer ? (
              <>
                <p className="git-dialog-note">
                  {tr("インストールには数分かかります。")}
                  {status.installer !== "xcode" && tr("途中で「このアプリがデバイスに変更を加えることを許可しますか？」と出たら「はい」を押してください。")}
                </p>
                <div className="cmd-preview">
                  {trx("<0>実行するコマンド</0><1>{INSTALL_COMMANDS}</1>", { INSTALL_COMMANDS: INSTALL_COMMANDS[status.installer] }, [<span />, <code />])}
                </div>
              </>
            ) : (
              <p className="git-dialog-note">{tr("この PC では自動でインストールできません。Git のページからインストールしてください。")}</p>
            )}
            {step === "installing" && <p className="git-dialog-running"><i className="spinner" aria-hidden="true" /> {" "}{tr("Git をインストールしています…")}</p>}
            {installedNote && step === "failed" && <p className="git-dialog-note">{installedNote}</p>}
            {error && <p className="git-dialog-error">{error}</p>}
            <div className="git-dialog-actions">
              {auto && step === "git" && (
                <label className="chk setup-dont-show">
                  <input type="checkbox" checked={dontShow} onChange={(e) => setDontShow(e.target.checked)} />
                  {tr("次からは起動時に表示しない")}
                </label>
              )}
              <button type="button" className="btn-sm" disabled={busy} onClick={close}>
                {tr("あとで")}
              </button>
              {(step === "failed" || !status.installer) && (
                <button type="button" className="btn-sm" onClick={() => openUrl("https://git-scm.com/downloads")}>
                  {tr("Git のページを開く")}
                </button>
              )}
              {step === "failed" && (
                <button type="button" className="btn-sm" onClick={recheck}>
                  {tr("もう一度確かめる")}
                </button>
              )}
              {status.installer && (
                <button type="button" className="btn-primary" ref={firstRef} disabled={busy} onClick={install}>
                  {step === "failed" ? tr("もう一度インストールする") : tr("インストールする")}
                </button>
              )}
            </div>
          </>
        )}

        {step === "identity" && (
          <>
            <h3>{tr("コミットに使う名前とメールアドレス")}</h3>
            {installedNote && <p className="local-folder-message local-folder-message--ok">{installedNote}</p>}
            <p className="git-dialog-message">
              {tr("だれが変更したかを残すため、コミットには名前とメールアドレスを付けます。この PC で一度決めれば、すべてのリポジトリで使われます。")}
            </p>
            <label className="git-dialog-label">
              {tr("名前")}
              <input className="input-full" value={name} autoComplete="off" onChange={(e) => setName(e.target.value)} disabled={saving} />
            </label>
            <label className="git-dialog-label">
              {tr("メールアドレス")}
              <input className="input-full" value={email} autoComplete="off" spellCheck={false} onChange={(e) => setEmail(e.target.value)} disabled={saving} />
            </label>
            <p className="git-dialog-note">
              {tr("はじめに入っているのは、GitHub が用意する公開用のアドレス（…@users.noreply.github.com）です。コミットは GitHub で公開されるので、ふだんのメールアドレスの代わりにこれを使うと、アドレスを知られずにすみます。")}
            </p>
            <div className="cmd-preview">
              {trx("<0>実行するコマンド</0><1>{identityCommand}</1>", { identityCommand }, [<span />, <code />])}
            </div>
            {error && <p className="git-dialog-error">{error}</p>}
            <div className="git-dialog-actions">
              {auto && !installedNote && (
                <label className="chk setup-dont-show">
                  <input type="checkbox" checked={dontShow} onChange={(e) => setDontShow(e.target.checked)} />
                  {tr("次からは起動時に表示しない")}
                </label>
              )}
              <button type="button" className="btn-sm" disabled={saving} onClick={close}>
                {tr("あとで")}
              </button>
              <button
                type="button"
                className="btn-primary"
                ref={firstRef}
                disabled={saving || !name.trim() || !email.trim()}
                onClick={saveIdentity}
              >
                {saving ? tr("設定しています…") : tr("設定する")}
              </button>
            </div>
          </>
        )}

        {step === "ready" && (
          <>
            <h3>{tr("使う準備はできています")}</h3>
            {installedNote && <p className="local-folder-message local-folder-message--ok">{installedNote}</p>}
            <dl className="setup-summary">
              <dt>Git</dt>
              <dd>{status.git}</dd>
              <dt>{tr("コミットに使う名前")}</dt>
              <dd>{status.user_name}</dd>
              <dt>{tr("メールアドレス")}</dt>
              <dd>{status.user_email}</dd>
            </dl>
            <div className="git-dialog-actions">
              <button type="button" className="btn-sm" onClick={() => setStep("identity")}>
                {tr("名前とメールアドレスを変える")}
              </button>
              <button type="button" className="btn-primary" ref={firstRef} onClick={close}>
                {tr("閉じる")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
