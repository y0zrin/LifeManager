import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import * as git from "../../lib/git";
import { isMobile } from "../../lib/platform";
import { isEnter } from "../../lib/keys";
import { createMyRepo } from "../../lib/team";
import { useLoginInfo } from "../../hooks/useLoginInfo";
import { AllowRepoStep } from "./AllowRepoStep";

interface CreateRepoFlowProps {
  /** 名前の欄に最初に入れておくもの */
  defaultName?: string;
  /** 最後のボタンの文字（クローンするかで変える） */
  finishLabel: (clone: boolean) => string;
  /** 作り終えた（folder は、クローンしたときの作業フォルダ） */
  onFinish: (owner: string, repo: string, folder?: string) => Promise<void>;
  /** 手順 1 で「← 戻る」 */
  onBack: () => void;
  /** 動いているあいだ（外側の画面を閉じられないように） */
  onBusyChange?: (busy: boolean) => void;
}

/** クローンする置き場所（前に選んだところを覚えておく。リポジトリを追加と同じ） */
const PARENT_KEY = "clone-parent";

function loadParent(): string {
  try {
    return localStorage.getItem(PARENT_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveParent(path: string) {
  try {
    localStorage.setItem(PARENT_KEY, path);
  } catch {
    // 覚えられなくても、次に選び直せばよい
  }
}

const sep = (path: string) => (path.includes("\\") ? "\\" : "/");

const STEP_LABELS = ["作る", "Life Manager に許可", "この PC に"];

/**
 * 新しく作る: ① GitHub にリポジトリを作る → ② そのリポジトリだけを Life Manager に許可する → ③ この PC に持ってくる（クローン）。
 * 先に「Life Manager を入れて」とは言わない。自分のアカウントにもう入っている人（とトークンで入った人）は、① をアプリが行い、
 * ② は自動で済む（アプリで作ったリポジトリは、自動で許可に入る）。まだの人は ① を GitHub の画面で行い、② で許可する
 */
export function CreateRepoFlow({ defaultName = "", finishLabel, onFinish, onBack, onBusyChange }: CreateRepoFlowProps) {
  const { me, byLogin, installUrl, installations, reloadInstallations, ownInstallation } = useLoginInfo();
  const [step, setStep] = useState(0);
  const [name, setName] = useState(defaultName);
  const [isPrivate, setIsPrivate] = useState(true);
  const [openedNew, setOpenedNew] = useState(false);
  const [created, setCreated] = useState<{ owner: string; repo: string } | null>(null);
  const [clone, setClone] = useState(!isMobile);
  const [parent, setParent] = useState(loadParent);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  const owner = me?.login ?? "";
  const repoName = name.trim();
  const valid = /^[A-Za-z0-9._-]+$/.test(repoName);
  // アプリが作れる: トークンで入っている／自分のアカウントに Life Manager が入っている（作ったものは自動で許可に入る）
  const appCreates = !!me && (!byLogin || (installations !== null && !!ownInstallation));
  const ready = !!me && (!byLogin || installations !== null);
  const useClone = clone && !isMobile;
  const dest = created && parent ? `${parent.replace(/[\\/]+$/, "")}${sep(parent)}${created.repo}` : "";

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

  // ① アプリが作る（トークンで入った人・自分のアカウントに Life Manager が入っている人）
  function createByApp() {
    if (!valid) return;
    run(async () => {
      const made = await createMyRepo(repoName, isPrivate);
      setCreated({ owner: made.owner.login, repo: made.name });
      // トークンで入った人には「許可」はない
      setStep(byLogin ? 1 : 2);
    });
  }

  // ① GitHub の画面で作る（まだ Life Manager を入れていない人）
  function openNewPage() {
    if (!valid) return;
    openUrl(`https://github.com/new?name=${encodeURIComponent(repoName)}&visibility=${isPrivate ? "private" : "public"}`).catch(() => {});
    setOpenedNew(true);
  }

  function madeOnGitHub() {
    if (!valid) return;
    setError(null);
    setCreated({ owner, repo: repoName });
    setStep(1);
  }

  async function pickParent() {
    const chosen = await openDialog({ directory: true, title: "クローンする置き場所を選ぶ（この中にフォルダを作ります）", defaultPath: parent || undefined });
    if (typeof chosen === "string") {
      setParent(chosen);
      saveParent(chosen);
    }
  }

  // ③ この PC に持ってきて（クローンするなら）、終える
  function finish() {
    if (!created) return;
    const target = created;
    run(async () => {
      const folder = useClone ? (await git.cloneRepo(parent, target.owner, target.repo, me?.login)).path : undefined;
      await onFinish(target.owner, target.repo, folder);
    });
  }

  return (
    <div className="create-flow">
      <ol className="publish-steps">
        {STEP_LABELS.map((s, i) => (
          <li key={s} className={i < step ? "done" : i === step ? "on" : ""}>
            {s}
            {i === 1 && !byLogin && me && "（不要）"}
          </li>
        ))}
      </ol>

      {step === 0 && (
        <>
          <p className="git-dialog-message">GitHub にあなたのリポジトリを作ります。</p>
          <label className="git-dialog-label">
            名前（英数字・ハイフン・ドット・アンダースコア）
            <span className="add-project-row">
              <span className="setup-create-owner">{owner ? `${owner} /` : ""}</span>
              <input className="input-full" value={name} autoFocus spellCheck={false} placeholder="my-project"
                onChange={(e) => { setName(e.target.value); setOpenedNew(false); }}
                onKeyDown={(e) => { if (isEnter(e) && appCreates) createByApp(); }} disabled={busy} />
            </span>
          </label>
          {repoName && !valid && <p className="git-dialog-error">名前に使えない文字があります（英数字・ハイフン・ドット・アンダースコアだけ）</p>}
          <label className="chk">
            <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} disabled={busy} />
            非公開にする（学校の課題やチーム制作はこちら）
          </label>
          {!ready && (
            <p className="git-dialog-note">
              <i className="spinner" aria-hidden="true" /> 準備しています…
            </p>
          )}
          {ready && !appCreates && (
            <>
              <span>
                <button type="button" className={openedNew ? "btn-sm" : "btn-primary"} onClick={openNewPage} disabled={!valid || busy}>
                  GitHub で作る（ブラウザが開きます）
                </button>
              </span>
              <p className="allow-step-how">
                GitHub の画面で「<b>Add a README file</b>」にチェックを入れて「<b>Create repository</b>」を押したら、ここに戻って「作ったので次へ」を押します。
              </p>
            </>
          )}
          {ready && appCreates && byLogin && (
            <p className="git-dialog-note">あなたのアカウントには Life Manager が入っているので、アプリが作ります。作ったリポジトリはそのまま Life Manager で使えます。</p>
          )}
        </>
      )}

      {step === 1 && created && me && (
        <AllowRepoStep me={me} installUrl={installUrl} installations={installations} target={created}
          onAllowed={(r) => { setCreated(r); setStep(2); }} onInstallationsChanged={reloadInstallations} />
      )}

      {step === 2 && created && (
        <>
          <p className="local-folder-message local-folder-message--ok">
            ✔ {created.owner}/{created.repo} を作りました{byLogin ? "。Life Manager で使えます" : ""}
          </p>
          {!isMobile && (
            <>
              <label className="chk add-project-clone">
                <input type="checkbox" checked={clone} onChange={(e) => setClone(e.target.checked)} disabled={busy} />
                この PC にも持ってくる（クローン。git の作業をしないなら外してよい）
              </label>
              {clone && (
                <div className="add-project-indent">
                  <label className="git-dialog-label">
                    置き場所
                    <span className="add-project-row">
                      <input className="input-full" value={parent} readOnly placeholder="フォルダを選んでください" />
                      <button type="button" className="btn-sm" onClick={pickParent} disabled={busy}>
                        選ぶ…
                      </button>
                    </span>
                  </label>
                  {dest && <p className="git-dialog-note">→ <b>{dest}</b> ができ、作業フォルダになります</p>}
                  <div className="cmd-preview">
                    <span>実行するコマンド</span>
                    <code>{git.displayCommand(["clone", `https://github.com/${created.owner}/${created.repo}.git`, dest || `（置き場所）${sep(parent || "\\")}${created.repo}`])}</code>
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}

      {busy && (
        <p className="git-dialog-running">
          <i className="spinner" aria-hidden="true" /> {step === 2 && useClone ? "クローンしています…（大きなリポジトリは時間がかかります）" : "実行しています…"}
        </p>
      )}
      {error && <p className="git-dialog-error">{error}</p>}

      <div className="git-dialog-actions add-project-actions">
        {step === 0 && (
          <button type="button" className="link-button" onClick={onBack} disabled={busy}>← 戻る</button>
        )}
        {step === 1 && (
          <button type="button" className="link-button" onClick={() => setStep(0)} disabled={busy}>← 前へ</button>
        )}
        {step === 0 && ready && appCreates && (
          <button type="button" className="btn-primary" onClick={createByApp} disabled={!valid || busy}>作る</button>
        )}
        {step === 0 && ready && !appCreates && (
          <button type="button" className={openedNew ? "btn-primary" : "btn-sm"} onClick={madeOnGitHub} disabled={!valid || busy}>作ったので次へ</button>
        )}
        {step === 2 && (
          <button type="button" className="btn-primary" onClick={finish} disabled={busy || (useClone && !parent)}>
            {finishLabel(useClone)}
          </button>
        )}
      </div>
    </div>
  );
}
