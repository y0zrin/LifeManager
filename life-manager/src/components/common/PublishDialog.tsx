import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import * as git from "../../lib/git";
import { isEscape } from "../../lib/keys";
import { useLoginInfo } from "../../hooks/useLoginInfo";
import { AllowRepoStep } from "./AllowRepoStep";
import { tr, trx } from "../../lib/i18n";

interface PublishDialogProps {
  /** GitHub にログインしている人（リポジトリの持ち主の候補） */
  login: string;
  /** もう選んであるフォルダ（リポジトリを追加 → この PC にある、で選んだもの） */
  initialFolder?: string;
  /** 「プロジェクトを追加」に戻る */
  onBack: () => void;
  /** 上げ終わった（プロジェクトに登録し、作業フォルダにする） */
  onDone: (owner: string, repo: string, path: string) => Promise<void>;
}

const TEMPLATES: { value: git.GitignoreTemplate; label: string }[] = [
  { value: "visualstudio", label: "Visual Studio（C++）" },
  { value: "unity", label: "Unity" },
  { value: "unreal", label: "Unreal Engine" },
  { value: "none", label: tr("使わない") },
];

const STEPS = [tr("記録を始める"), tr("GitHub に場所を作る"), tr("つないで送る"), tr("できあがり")];
/** 「GitHub でログイン」のときは、上げたリポジトリを Life Manager に許可する手順を足す（しないと Issue が使えない） */
const STEPS_WITH_ALLOW = [tr("記録を始める"), tr("GitHub に場所を作る"), tr("つないで送る"), tr("Life Manager に許可"), tr("できあがり")];

/** フォルダの名前から、GitHub のリポジトリに使える名前を作る（使えない文字は - に） */
function repoNameOf(path: string): string {
  const base = path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  const name = base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  // 日本語だけの名前などで、英字が 1 つも残らなかったとき（「新しいゲーム 2」→「2」）は、ひな形の名前にする
  return name && (name === base || /[A-Za-z]/.test(name)) ? name : "my-project";
}

/** 手元のフォルダを GitHub に上げる（記録を始める → GitHub に空のリポジトリを作る → つないで送る →（ログインなら）Life Manager に許可） */
export function PublishDialog({ login, initialFolder, onBack, onDone }: PublishDialogProps) {
  const [step, setStep] = useState(0);
  const [folder, setFolder] = useState("");
  const [state, setState] = useState<git.FolderState | null>(null);
  const [template, setTemplate] = useState<git.GitignoreTemplate>("visualstudio");
  const [message, setMessage] = useState(tr("最初のコミット"));
  const [owner, setOwner] = useState(login);
  const [name, setName] = useState("");
  const [isPrivate, setIsPrivate] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const { me, byLogin, installUrl, installations, reloadInstallations } = useLoginInfo();
  const steps = byLogin ? STEPS_WITH_ALLOW : STEPS;
  const allowStep = byLogin ? 3 : -1;
  const lastStep = steps.length - 1;

  const url = `https://github.com/${owner.trim()}/${name.trim()}.git`;
  const branch = state?.branch || "main";

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (isEscape(e) && !busy) onBack();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onBack]);

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(git.splitGitError(e).message);
    } finally {
      setBusy(false);
    }
  }

  async function useFolder(path: string) {
    setFolder(path);
    setName(repoNameOf(path));
    setDone(null);
    await run(async () => setState(await git.folderState(path)));
  }

  async function pickFolder() {
    const picked = await open({ directory: true, title: tr("GitHub に上げるフォルダを選ぶ") });
    if (typeof picked === "string") await useFolder(picked);
  }

  // 選んであるフォルダがあれば、そこから始める
  useEffect(() => {
    if (initialFolder) useFolder(initialFolder);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialFolder]);

  // 1 つ目の手順で実行するコマンド（フォルダの様子で変わる）
  const prepareCommands: string[] = [];
  if (state && !state.inside) {
    if (!state.is_repo) prepareCommands.push("git init -b main");
    if (state.commits === 0) {
      if (!state.has_gitignore && template !== "none") prepareCommands.push(tr("（.gitignore を作る）"));
      prepareCommands.push("git add .", git.displayCommand(["commit", "-m", message.trim() || tr("最初のコミット")]));
    }
  }

  async function next() {
    if (step === 0) {
      await run(async () => {
        const r = await git.publishPrepare(folder, template, message);
        setDone(r.command ? tr("実行しました：{command}", { command: r.command }) : null);
        setState(await git.folderState(folder));
        setStep(1);
      });
    } else if (step === 1) {
      await run(async () => {
        if (!(await git.remoteExists(url))) {
          throw new Error(tr("GitHub に {trim}/{trim2} が見つかりません。作れたか、名前と持ち主が合っているかを確かめてください", { trim: owner.trim(), trim2: name.trim() }));
        }
        setDone(null);
        setStep(2);
      });
    } else if (step === 2) {
      await run(async () => {
        const r = await git.publishPush(folder, url, login);
        setDone(tr("実行しました：{command}", { command: r.command }));
        setStep(3);
      });
    } else if (step === lastStep) {
      await run(() => onDone(owner.trim(), name.trim(), folder));
    }
  }

  const canNext =
    !busy &&
    step !== allowStep &&
    (step === 0
      ? !!state && !state.inside
      : step === 1
        ? /^[A-Za-z0-9._-]+$/.test(owner.trim()) && /^[A-Za-z0-9._-]+$/.test(name.trim())
        : true);
  const nextLabel =
    step === 1
      ? tr("作ったので次へ")
      : step === lastStep
        ? tr("プロジェクトに追加して閉じる")
        : step === 0 && state && prepareCommands.length === 0
          ? tr("次へ")
          : tr("実行して次へ");

  return (
    <div className="palette-overlay git-dialog-back" onClick={() => !busy && onBack()}>
      <div className="git-dialog publish-dialog" role="dialog" aria-modal="true" aria-label={tr("手元のフォルダを GitHub に上げる")} onClick={(e) => e.stopPropagation()}>
        <h3>
          {tr("手元のフォルダを GitHub に上げる")}{" "} <span className="publish-count">{step + 1} / {steps.length}</span>
        </h3>
        <ol className="publish-steps">
          {steps.map((s, i) => (
            <li key={s} className={i < step ? "done" : i === step ? "on" : ""}>
              {s}
            </li>
          ))}
        </ol>

        {step === 0 && (
          <>
            <label className="git-dialog-label">
              {tr("上げるフォルダ")}
              <span className="add-project-row">
                <input className="input-full" value={folder} readOnly placeholder={tr("フォルダを選んでください")} />
                <button type="button" className="btn-sm" onClick={pickFolder} disabled={busy}>
                  {tr("選ぶ…")}
                </button>
              </span>
            </label>
            {state?.inside && (
              <p className="git-dialog-error">
                {trx("このフォルダは、ほかのリポジトリ（{inside}）の中にあります。リポジトリの中に別のリポジトリは作れません。", { inside: state.inside })}
              </p>
            )}
            {state && !state.inside && (
              <p className="local-folder-message local-folder-message--ok">
                {trx("✔ {toLocaleString} 個のファイル", { toLocaleString: state.files.toLocaleString() })}
                {state.is_repo ? tr("（記録は {commits} 件あります）", { commits: state.commits }) : tr("（まだ Git の記録はありません）")}
                {state.origin && tr("。いまは {origin} につながっています（次の手順で付け替えます）", { origin: state.origin })}
              </p>
            )}
            {state && !state.inside && state.commits === 0 && !state.has_gitignore && (
              <label className="git-dialog-label">
                {tr("記録しないもの（.gitignore のひな形）")}
                <select className="input-full" value={template} onChange={(e) => setTemplate(e.target.value as git.GitignoreTemplate)} disabled={busy}>
                  {TEMPLATES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {state && !state.inside && state.commits === 0 && (
              <label className="git-dialog-label">
                {tr("最初のコミットのメッセージ")}
                <input className="input-full" value={message} onChange={(e) => setMessage(e.target.value)} disabled={busy} />
              </label>
            )}
            {prepareCommands.length > 0 ? (
              <div
                className="cmd-preview"
                title={tr("このフォルダで記録を始め（git init）、今の中身を最初の記録にします。ビルドで毎回作られるもの（x64 や .vs など）は、.gitignore に書いて記録しないようにします。")}
              >
                {trx("<0>実行するコマンド</0><1>{join}</1>", { join: prepareCommands.join("\n") }, [<span />, <code />])}
              </div>
            ) : (
              state && !state.inside && <p className="git-dialog-note">{tr("もう記録があるので、この手順では何もしません。")}</p>
            )}
          </>
        )}

        {step === 1 && (
          <>
            <p className="git-dialog-message">{tr("GitHub に空のリポジトリを作ります。")}</p>
            <label className="git-dialog-label">
              {tr("名前")}
              <input className="input-full" value={name} spellCheck={false} onChange={(e) => setName(e.target.value)} disabled={busy} />
            </label>
            <label className="git-dialog-label">
              {tr("持ち主（ふつうは自分。組織に作るときは組織の名前）")}
              <input className="input-full" value={owner} spellCheck={false} onChange={(e) => setOwner(e.target.value)} disabled={busy} />
            </label>
            <label className="chk">
              <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} disabled={busy} />
              {tr("非公開にする（学校の課題やチーム制作はこちら）")}
            </label>
            <div className="publish-open">
              <button
                type="button"
                className="btn-sm"
                disabled={!name.trim()}
                onClick={() =>
                  openUrl(`https://github.com/new?name=${encodeURIComponent(name.trim())}&visibility=${isPrivate ? "private" : "public"}`)
                }
              >
                {tr("GitHub で作る（ブラウザが開きます）")}
              </button>
            </div>
            <p className="git-dialog-note">
              {tr("GitHub の画面では、README や .gitignore は付けずに「Create repository」を押してください（手元にあるため）。押したら、ここに戻ってきて「作ったので次へ」を押します。")}
            </p>
          </>
        )}

        {step === 2 && (
          <>
            <p className="local-folder-message local-folder-message--ok">
              {trx("✔ GitHub に {trim}/{trim2} がありました。つないで送ります。", { trim: owner.trim(), trim2: name.trim() })}
            </p>
            <div className="cmd-preview" title={tr("origin は GitHub の置き場所につける名前です。-u を付けると、次からは「プッシュ」だけで同じ所へ送れます。")}>
              {trx("<0>実行するコマンド</0><1>{v}</1>", { v: `${state?.origin ? git.displayCommand(["remote", "set-url", "origin", url]) : git.displayCommand(["remote", "add", "origin", url])}\n${git.displayCommand(["push", "-u", "origin", branch])}` }, [<span />, <code />])}
            </div>
            <p className="git-dialog-note">{tr("初めてのときはブラウザで GitHub へのログインを求められることがあります。")}</p>
          </>
        )}

        {step === allowStep && me && (
          <>
            <p className="local-folder-message local-folder-message--ok">{tr("✔ GitHub に上げました。")}</p>
            <AllowRepoStep me={me} installUrl={installUrl} installations={installations} target={{ owner: owner.trim(), repo: name.trim() }}
              onAllowed={(r) => { setOwner(r.owner); setName(r.repo); setDone(null); setStep(lastStep); }} onInstallationsChanged={reloadInstallations} />
          </>
        )}

        {step === lastStep && (
          <>
            <p className="local-folder-message local-folder-message--ok">{tr("✔ GitHub に上げました")}{byLogin ? tr("。Life Manager で使えます") : ""}。</p>
            <p className="git-dialog-message">
              {trx("「プロジェクトに追加して閉じる」で、{trim}/{trim2} をプロジェクトに登録し、このフォルダを作業フォルダにします。", { trim: owner.trim(), trim2: name.trim() })}
            </p>
            {!byLogin && (
              <p className="git-dialog-note">
                {tr("Issue やタスクも使うときは、トークンがこのリポジトリを使えるようにしてください（設定 → トークン）。")}
              </p>
            )}
            <div className="publish-open">
              <button type="button" className="btn-sm" onClick={() => openUrl(`https://github.com/${owner.trim()}/${name.trim()}`)}>
                {tr("GitHub で開く")}
              </button>
            </div>
          </>
        )}

        {done && <p className="git-dialog-note publish-done">{done}</p>}
        {busy && (
          <p className="git-dialog-running">
            <i className="spinner" aria-hidden="true" /> {step === 2 ? tr("送っています…") : step === 1 ? tr("GitHub を確かめています…") : tr("実行しています…")}
          </p>
        )}
        {error && <p className="git-dialog-error">{error}</p>}

        <div className="git-dialog-actions add-project-actions">
          {step <= 2 && (
            <button type="button" className="link-button" disabled={busy} onClick={() => (step === 0 ? onBack() : setStep(step - 1))}>
              {step === 0 ? tr("← 追加の画面に戻る") : tr("← 前へ")}
            </button>
          )}
          {step !== allowStep && (
            <button type="button" className="btn-primary" disabled={!canNext} onClick={next}>
              {nextLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
