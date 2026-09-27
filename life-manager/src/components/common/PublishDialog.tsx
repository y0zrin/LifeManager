import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import * as git from "../../lib/git";

interface PublishDialogProps {
  /** GitHub にログインしている人（リポジトリの持ち主の候補） */
  login: string;
  /** 「プロジェクトを追加」に戻る */
  onBack: () => void;
  /** 上げ終わった（プロジェクトに登録し、作業フォルダにする） */
  onDone: (owner: string, repo: string, path: string) => Promise<void>;
}

const TEMPLATES: { value: git.GitignoreTemplate; label: string }[] = [
  { value: "visualstudio", label: "Visual Studio（C++）" },
  { value: "unity", label: "Unity" },
  { value: "unreal", label: "Unreal Engine" },
  { value: "none", label: "使わない" },
];

const STEPS = ["記録を始める", "GitHub に場所を作る", "つないで送る", "できあがり"];

/** フォルダの名前から、GitHub のリポジトリに使える名前を作る（使えない文字は - に） */
function repoNameOf(path: string): string {
  const base = path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  const name = base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  // 日本語だけの名前などで、英字が 1 つも残らなかったとき（「新しいゲーム 2」→「2」）は、ひな形の名前にする
  return name && (name === base || /[A-Za-z]/.test(name)) ? name : "my-project";
}

/** 手元のフォルダを GitHub に上げる（記録を始める → GitHub に空のリポジトリを作る → つないで送る） */
export function PublishDialog({ login, onBack, onDone }: PublishDialogProps) {
  const [step, setStep] = useState(0);
  const [folder, setFolder] = useState("");
  const [state, setState] = useState<git.FolderState | null>(null);
  const [template, setTemplate] = useState<git.GitignoreTemplate>("visualstudio");
  const [message, setMessage] = useState("最初のコミット");
  const [owner, setOwner] = useState(login);
  const [name, setName] = useState("");
  const [isPrivate, setIsPrivate] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const url = `https://github.com/${owner.trim()}/${name.trim()}.git`;
  const branch = state?.branch || "main";

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) onBack();
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

  async function pickFolder() {
    const picked = await open({ directory: true, title: "GitHub に上げるフォルダを選ぶ" });
    if (typeof picked !== "string") return;
    setFolder(picked);
    setName(repoNameOf(picked));
    setDone(null);
    await run(async () => setState(await git.folderState(picked)));
  }

  // 1 つ目の手順で実行するコマンド（フォルダの様子で変わる）
  const prepareCommands: string[] = [];
  if (state && !state.inside) {
    if (!state.is_repo) prepareCommands.push("git init -b main");
    if (state.commits === 0) {
      if (!state.has_gitignore && template !== "none") prepareCommands.push("（.gitignore を作る）");
      prepareCommands.push("git add .", git.displayCommand(["commit", "-m", message.trim() || "最初のコミット"]));
    }
  }

  async function next() {
    if (step === 0) {
      await run(async () => {
        const r = await git.publishPrepare(folder, template, message);
        setDone(r.command ? `実行しました：${r.command}` : null);
        setState(await git.folderState(folder));
        setStep(1);
      });
    } else if (step === 1) {
      await run(async () => {
        if (!(await git.remoteExists(url))) {
          throw new Error(`GitHub に ${owner.trim()}/${name.trim()} が見つかりません。作れたか、名前と持ち主が合っているかを確かめてください`);
        }
        setDone(null);
        setStep(2);
      });
    } else if (step === 2) {
      await run(async () => {
        const r = await git.publishPush(folder, url);
        setDone(`実行しました：${r.command}`);
        setStep(3);
      });
    } else {
      await run(() => onDone(owner.trim(), name.trim(), folder));
    }
  }

  const canNext =
    !busy &&
    (step === 0
      ? !!state && !state.inside
      : step === 1
        ? /^[A-Za-z0-9._-]+$/.test(owner.trim()) && /^[A-Za-z0-9._-]+$/.test(name.trim())
        : true);
  const nextLabel =
    step === 1
      ? "作ったので次へ"
      : step === 3
        ? "プロジェクトに追加して閉じる"
        : step === 0 && state && prepareCommands.length === 0
          ? "次へ"
          : "実行して次へ";

  return (
    <div className="palette-overlay git-dialog-back" onClick={() => !busy && onBack()}>
      <div className="git-dialog publish-dialog" role="dialog" aria-modal="true" aria-label="手元のフォルダを GitHub に上げる" onClick={(e) => e.stopPropagation()}>
        <h3>
          手元のフォルダを GitHub に上げる <span className="publish-count">{step + 1} / {STEPS.length}</span>
        </h3>
        <ol className="publish-steps">
          {STEPS.map((s, i) => (
            <li key={s} className={i < step ? "done" : i === step ? "on" : ""}>
              {s}
            </li>
          ))}
        </ol>

        {step === 0 && (
          <>
            <label className="git-dialog-label">
              上げるフォルダ
              <span className="add-project-row">
                <input className="input-full" value={folder} readOnly placeholder="フォルダを選んでください" />
                <button type="button" className="btn-sm" onClick={pickFolder} disabled={busy}>
                  選ぶ…
                </button>
              </span>
            </label>
            {state?.inside && (
              <p className="git-dialog-error">
                このフォルダは、ほかのリポジトリ（{state.inside}）の中にあります。リポジトリの中に、別のリポジトリは作れません。
              </p>
            )}
            {state && !state.inside && (
              <p className="local-folder-message local-folder-message--ok">
                ✔ {state.files.toLocaleString()} 個のファイル
                {state.is_repo ? `（記録は ${state.commits} 件あります）` : "（まだ Git の記録はありません）"}
                {state.origin && `。いまは ${state.origin} につながっています（次の手順で付け替えます）`}
              </p>
            )}
            {state && !state.inside && state.commits === 0 && !state.has_gitignore && (
              <label className="git-dialog-label">
                記録しないもの（.gitignore のひな形）
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
                最初のコミットのメッセージ
                <input className="input-full" value={message} onChange={(e) => setMessage(e.target.value)} disabled={busy} />
              </label>
            )}
            {prepareCommands.length > 0 ? (
              <div className="cmd-preview">
                <span>実行するコマンド</span>
                <code>{prepareCommands.join("\n")}</code>
              </div>
            ) : (
              state && !state.inside && <p className="git-dialog-note">もう記録があるので、この手順では何もしません。</p>
            )}
            {(!state || prepareCommands.length > 0) && (
              <p className="hint">
                このフォルダで記録を始め（<code>git init</code>）、今の中身を最初の記録にします。ビルドで毎回作られるもの（x64 や .vs
                など）は、<code>.gitignore</code> に書いて記録しないようにします。
              </p>
            )}
          </>
        )}

        {step === 1 && (
          <>
            <p className="git-dialog-message">GitHub に、空のリポジトリを作ります。</p>
            <label className="git-dialog-label">
              名前
              <input className="input-full" value={name} spellCheck={false} onChange={(e) => setName(e.target.value)} disabled={busy} />
            </label>
            <label className="git-dialog-label">
              持ち主（ふつうは自分。組織に作るときは組織の名前）
              <input className="input-full" value={owner} spellCheck={false} onChange={(e) => setOwner(e.target.value)} disabled={busy} />
            </label>
            <label className="chk">
              <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} disabled={busy} />
              非公開にする（学校の課題やチーム制作は、こちら）
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
                GitHub で作る（ブラウザが開きます）
              </button>
            </div>
            <p className="git-dialog-note">
              GitHub の画面では、README や .gitignore は付けずに「Create repository」を押してください（手元にあるため）。押したら、ここに戻ってきて「作ったので次へ」を押します。
            </p>
          </>
        )}

        {step === 2 && (
          <>
            <p className="local-folder-message local-folder-message--ok">
              ✔ GitHub に {owner.trim()}/{name.trim()} がありました。つないで送ります。
            </p>
            <div className="cmd-preview">
              <span>実行するコマンド</span>
              <code>
                {`${state?.origin ? git.displayCommand(["remote", "set-url", "origin", url]) : git.displayCommand(["remote", "add", "origin", url])}\n${git.displayCommand(["push", "-u", "origin", branch])}`}
              </code>
            </div>
            <p className="hint">
              <code>origin</code> は、GitHub の置き場所につける名前です。<code>-u</code> を付けると、次からは「プッシュ」だけで同じ所へ送れます。初めてのときは、ブラウザで
              GitHub へのログインを求められることがあります。
            </p>
          </>
        )}

        {step === 3 && (
          <>
            <p className="local-folder-message local-folder-message--ok">✔ GitHub に上げました。</p>
            <p className="git-dialog-message">
              「プロジェクトに追加して閉じる」で、{owner.trim()}/{name.trim()} をプロジェクトに登録し、このフォルダを作業フォルダにします。
            </p>
            <p className="git-dialog-note">
              Issue やタスクも使うときは、トークンがこのリポジトリを使えるようにしてください（設定 → 接続）。
            </p>
            <div className="publish-open">
              <button type="button" className="btn-sm" onClick={() => openUrl(`https://github.com/${owner.trim()}/${name.trim()}`)}>
                GitHub で開く
              </button>
            </div>
          </>
        )}

        {done && <p className="git-dialog-note publish-done">{done}</p>}
        {busy && (
          <p className="git-dialog-running">
            <i className="spinner" aria-hidden="true" /> {step === 2 ? "送っています…" : step === 1 ? "GitHub を確かめています…" : "実行しています…"}
          </p>
        )}
        {error && <p className="git-dialog-error">{error}</p>}

        <div className="git-dialog-actions add-project-actions">
          {step < 3 && (
            <button type="button" className="link-button" disabled={busy} onClick={() => (step === 0 ? onBack() : setStep(step - 1))}>
              {step === 0 ? "← 追加の画面に戻る" : "← 前へ"}
            </button>
          )}
          <button type="button" className="btn-primary" disabled={!canNext} onClick={next}>
            {nextLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
