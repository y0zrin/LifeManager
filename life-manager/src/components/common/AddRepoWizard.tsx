import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import * as git from "../../lib/git";
import { isMobile } from "../../lib/platform";
import { isEscape } from "../../lib/keys";
import { checkToken, listUserRepos, type TokenReport, type UserRepo } from "../../lib/auth";
import type { Project } from "../../lib/types";
import { useLoginInfo } from "../../hooks/useLoginInfo";
import { CreateRepoFlow } from "./CreateRepoFlow";
import { PublishDialog } from "./PublishDialog";
import { RepoAccess } from "./RepoAccess";
import { TokenReportView } from "./TokenReportView";
import { tr, trx } from "../../lib/i18n";

interface AddRepoWizardProps {
  /** GitHub にログインしている人（新しく作る・手元のフォルダを上げるときの持ち主） */
  login: string;
  /** もう追加してあるリポジトリ（一覧で「追加済み」と出す） */
  projects: Project[];
  onAddProject: (owner: string, repo: string, name: string, token?: string) => Promise<void>;
  onSetLocalFolder: (owner: string, repo: string, path: string) => Promise<void>;
  /** 追加したリポジトリに切り替える */
  onSwitch: (owner: string, repo: string) => Promise<void>;
  onNotify: (text: string) => void;
  onClose: () => void;
}

type Step = "choose" | "remote" | "local" | "create";

/** クローンする置き場所（前に選んだところを覚えておく） */
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
const joinPath = (parent: string, name: string) => `${parent.replace(/[\\/]+$/, "")}${sep(parent)}${name}`;
const sameRepo = (a: { owner: string; repo: string }, b: { owner: string; repo: string }) =>
  a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase();

function ago(iso: string): string {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86400000);
  if (days <= 0) return tr("今日");
  if (days === 1) return tr("昨日");
  if (days < 30) return tr("{days} 日前", { days });
  return tr("{floor} か月前", { floor: Math.floor(days / 30) });
}

/** 画面の切り替えの動き（transform）の内側だと、重ねる画面がずれたり透けたりするので、アプリのいちばん外側に出す */
const onTop = (node: ReactNode) => createPortal(node, document.querySelector("main.app") ?? document.body);

/**
 * リポジトリを追加（左上のリポジトリの一覧の「＋ リポジトリを追加…」）。
 * GitHub にある（一覧から選ぶ・URL を貼る。この PC にクローンもできる）／この PC にある（フォルダを選ぶ。GitHub になければ上げる）／
 * 新しく作る（作る → Life Manager に許可 → この PC に。CreateRepoFlow）。追加したら、そのリポジトリに切り替える
 */
export function AddRepoWizard({ login, projects, onAddProject, onSetLocalFolder, onSwitch, onNotify, onClose }: AddRepoWizardProps) {
  const [step, setStep] = useState<Step>("choose");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // だれで入っているか（GitHub でログインなら、Life Manager に許可する案内を出す）
  const { me, byLogin, installUrl, installations, reloadInstallations } = useLoginInfo();
  // GitHub にある
  const [repos, setRepos] = useState<UserRepo[] | null>(null);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<{ owner: string; repo: string } | null>(null);
  const [check, setCheck] = useState<TokenReport | null>(null);
  const [showMore, setShowMore] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [token, setToken] = useState("");
  // この PC にもクローンする（GitHub にある）
  const [clone, setClone] = useState(!isMobile);
  const [parent, setParent] = useState(loadParent);
  // この PC にある
  const [localFolder, setLocalFolder] = useState("");
  const [localFound, setLocalFound] = useState<{ owner: string; repo: string; top: string } | null>(null);
  const [localOther, setLocalOther] = useState<string | null>(null);
  // フォルダを調べ終わった（調べられなかったときは「まだ GitHub にありません」を出さない）
  const [localChecked, setLocalChecked] = useState(false);
  const [publishing, setPublishing] = useState(false);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (isEscape(e) && !busy && !publishing) onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, publishing, onClose]);

  const loadRepos = async () => {
    try {
      setRepos(await listUserRepos());
    } catch (e) {
      setRepos([]);
      setError(tr("使えるリポジトリを読めませんでした（{String}）。URL を貼っても選べます", { String: String(e) }));
    }
  };
  useEffect(() => {
    loadRepos();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isAdded = (r: { owner: string; repo: string }) => projects.some((p) => sameRepo(p, r));
  const q = query.trim().toLowerCase();
  const pasted = git.parseGitHub(query);
  const shown = useMemo(() => (repos ?? []).filter((r) => !q || r.full_name.toLowerCase().includes(q)), [repos, q]);

  // 貼った URL など、一覧にないリポジトリを選んだら、今のトークンで使えるか確かめる
  useEffect(() => {
    setCheck(null);
    if (!picked || (repos ?? []).some((r) => sameRepo({ owner: r.owner.login, repo: r.name }, picked))) return;
    let alive = true;
    checkToken({ repos: [picked] })
      .then((r) => alive && setCheck(r))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [picked, repos]);

  async function pickParent() {
    const chosen = await openDialog({ directory: true, title: tr("クローンする置き場所を選ぶ（この中にフォルダを作ります）"), defaultPath: parent || undefined });
    if (typeof chosen === "string") {
      setParent(chosen);
      saveParent(chosen);
    }
  }

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

  // 追加して、そのリポジトリに切り替える（folder があれば作業フォルダにする）
  async function finish(owner: string, repo: string, label: string, folder?: string, projectToken?: string) {
    await onAddProject(owner, repo, label, projectToken);
    if (folder) await onSetLocalFolder(owner, repo, folder);
    await onSwitch(owner, repo);
    onNotify(folder ? tr("{owner}/{repo} を追加しました（作業フォルダ: {folder}）", { owner, repo, folder }) : tr("{owner}/{repo} を追加しました", { owner, repo }));
    onClose();
  }

  // --- GitHub にある ---
  const remoteDest = picked && parent ? joinPath(parent, picked.repo) : "";
  const cloneCommand = picked
    ? git.displayCommand(["clone", `https://github.com/${picked.owner}/${picked.repo}.git`, remoteDest || tr("（置き場所）{sep}{repo}", { sep: sep(parent || "\\"), repo: picked.repo })])
    : "";
  const useClone = clone && !isMobile;

  function addRemote() {
    if (!picked) return;
    const target = picked;
    run(async () => {
      const label = displayName.trim() || `${target.owner}/${target.repo}`;
      let folder: string | undefined;
      if (useClone) {
        const result = await git.cloneUrl(parent, `https://github.com/${target.owner}/${target.repo}`, login);
        folder = result.path;
      }
      await finish(target.owner, target.repo, label, folder, token.trim() || undefined);
    });
  }

  // --- この PC にある ---
  async function pickLocal() {
    const chosen = await openDialog({ directory: true, title: tr("追加するフォルダを選ぶ") });
    if (typeof chosen !== "string") return;
    setLocalFolder(chosen);
    setLocalFound(null);
    setLocalOther(null);
    setLocalChecked(false);
    setCheck(null);
    run(async () => {
      const c = await git.checkFolder(chosen, "", "");
      const gh = c.is_repo && c.remote_url ? git.parseGitHub(c.remote_url) : null;
      if (gh) {
        setLocalFound({ ...gh, top: c.top_level });
        setCheck(await checkToken({ repos: [gh] }).catch(() => null));
      } else if (c.is_repo && c.remote_url) {
        setLocalOther(c.remote_url);
      }
      setLocalChecked(true);
    });
  }

  if (publishing) {
    return onTop(
      <PublishDialog
        login={login}
        initialFolder={localFolder || undefined}
        onBack={() => setPublishing(false)}
        onDone={async (o, r, path) => {
          await finish(o, r, `${o}/${r}`, path);
        }}
      />,
    );
  }

  const repoAccess = byLogin && me && installUrl && (
    <RepoAccess me={me} installUrl={installUrl} installations={installations}
      onChanged={async (added) => {
        await reloadInstallations();
        await loadRepos();
        if (added.length === 1) {
          const got = git.parseGitHub(added[0]);
          if (got) setPicked(got);
        }
      }} />
  );

  const cloneOptions = (dest: string, command: string) =>
    !isMobile && (
      <>
        <label className="chk add-project-clone">
          <input type="checkbox" checked={clone} onChange={(e) => setClone(e.target.checked)} disabled={busy} />
          {tr("この PC にも持ってくる（クローン）")}
        </label>
        {clone && (
          <div className="add-project-indent">
            <label className="git-dialog-label">
              {tr("置き場所")}
              <span className="add-project-row">
                <input className="input-full" value={parent} readOnly placeholder={tr("フォルダを選んでください")} />
                <button type="button" className="btn-sm" onClick={pickParent} disabled={busy}>
                  {tr("選ぶ…")}
                </button>
              </span>
            </label>
            {dest && <p className="git-dialog-note">{trx("→ <0>{dest}</0> ができ、作業フォルダになります", { dest }, [<b />])}</p>}
            {command && (
              <div className="cmd-preview">
                {trx("<0>実行するコマンド</0><1>{command}</1>", { command }, [<span />, <code />])}
              </div>
            )}
          </div>
        )}
      </>
    );

  return onTop(
    <div className="palette-overlay git-dialog-back" onClick={() => !busy && onClose()}>
      <div className="git-dialog add-repo" role="dialog" aria-modal="true" aria-label={tr("リポジトリを追加")} onClick={(e) => e.stopPropagation()}>
        {step === "choose" && (
          <>
            <h3>{tr("リポジトリを追加")}</h3>
            <p className="git-dialog-message">{tr("どこにあるリポジトリですか？")}</p>
            <div className="wizard-choices">
              <button type="button" className="wizard-choice" onClick={() => setStep("remote")}>
                <span className="wizard-choice-icon" aria-hidden="true">🌐</span>
                <span className="wizard-choice-body">
                  <b>{tr("GitHub にある（リモート）")}</b>
                  <span>{tr("チームのリポジトリや GitHub で作ったもの。")}{isMobile ? "" : tr("この PC に持ってくる（クローン）こともできます")}</span>
                </span>
              </button>
              {!isMobile && (
                <button type="button" className="wizard-choice" onClick={() => setStep("local")}>
                  <span className="wizard-choice-icon" aria-hidden="true">💻</span>
                  <span className="wizard-choice-body">
                    {trx("<0>この PC にある（ローカル）</0><1>手元のフォルダ。GitHub にまだなければ、GitHub に上げます</1>", undefined, [<b />, <span />])}
                  </span>
                </button>
              )}
              <button type="button" className="wizard-choice" onClick={() => setStep("create")}>
                <span className="wizard-choice-icon" aria-hidden="true">✨</span>
                <span className="wizard-choice-body">
                  <b>{tr("新しく作る")}</b>
                  <span>{tr("GitHub に空のリポジトリ（README つき）を作ります。")}{isMobile ? "" : tr("この PC にも持ってこられます")}</span>
                </span>
              </button>
            </div>
            <div className="git-dialog-actions">
              <button type="button" className="btn-sm" onClick={onClose}>{tr("やめる")}</button>
            </div>
          </>
        )}

        {step === "remote" && (
          <>
            <h3>{tr("GitHub のリポジトリを選ぶ")}</h3>
            <input className="input-full" value={query} autoFocus spellCheck={false}
              placeholder={tr("名前で探す、または URL を貼る（https://github.com/持ち主/名前）")}
              onChange={(e) => { setQuery(e.target.value); const p = git.parseGitHub(e.target.value); if (p) setPicked(p); }} disabled={busy} />
            <div className="wizard-list">
              {repos === null && (
                <p className="git-dialog-note"><i className="spinner" aria-hidden="true" /> {" "}{tr("使えるリポジトリを読んでいます…")}</p>
              )}
              {pasted && !shown.some((r) => sameRepo({ owner: r.owner.login, repo: r.name }, pasted)) && (
                <button type="button" className={`wizard-item${picked && sameRepo(picked, pasted) ? " on" : ""}`} onClick={() => setPicked(pasted)} disabled={busy}>
                  {trx("<0>{owner}/{repo}</0><1>貼った URL</1>", { owner: pasted.owner, repo: pasted.repo }, [<span className="wizard-item-name" />, <span className="setup-repo-badge" />])}
                  {isAdded(pasted) && <span className="setup-repo-badge">{tr("追加済み")}</span>}
                </button>
              )}
              {shown.map((r) => {
                const it = { owner: r.owner.login, repo: r.name };
                const added = isAdded(it);
                return (
                  <button key={r.full_name} type="button" className={`wizard-item${picked && sameRepo(picked, it) ? " on" : ""}`}
                    onClick={() => setPicked(it)} disabled={busy || added} title={added ? tr("もう一覧にあります（左上のリポジトリから切り替えます）") : undefined}>
                    <span className="wizard-item-name">{r.full_name}</span>
                    {r.private && <span className="setup-repo-badge">{tr("非公開")}</span>}
                    {r.owner.type === "Organization" && <span className="setup-repo-badge">{tr("チーム")}</span>}
                    {added && <span className="setup-repo-badge">{tr("追加済み")}</span>}
                    <span className="wizard-item-when">{ago(r.updated_at)}</span>
                  </button>
                );
              })}
              {repos !== null && repos.length > 0 && shown.length === 0 && !pasted && <p className="git-dialog-note">{tr("見つかりません。URL を貼っても選べます。")}</p>}
              {repos !== null && repos.length === 0 && !pasted && <p className="git-dialog-note">{tr("まだありません。URL を貼るか、下から追加・作成します。")}</p>}
            </div>
            {check && check.repos[0] && !check.repos[0].ok && <TokenReportView report={check} installUrl={installUrl} />}
            <div className="wizard-more">
              {trx("<0>一覧にないとき：</0>{repoAccess}", { repoAccess }, [<span className="git-dialog-note" />])}
              <button type="button" className="link-button" onClick={() => setStep("create")} disabled={busy}>{tr("GitHub に新しく作る")}</button>
            </div>
            {cloneOptions(remoteDest, cloneCommand)}
            <button type="button" className="add-project-more" onClick={() => setShowMore((v) => !v)}>
              {showMore ? "▾" : "▸"} {" "}{tr("表示名・このプロジェクト専用のトークン")}
            </button>
            {showMore && (
              <div className="add-project-indent">
                <label className="git-dialog-label">
                  {tr("表示名（任意）")}
                  <input className="input-full" value={displayName} placeholder={tr("例：合同制作")} onChange={(e) => setDisplayName(e.target.value)} disabled={busy} />
                </label>
                <label className="git-dialog-label">
                  {tr("トークン（任意。入れなければ、いつものトークンを使います）")}
                  <input className="input-full" type="password" value={token} placeholder="github_pat_…" onChange={(e) => setToken(e.target.value)} disabled={busy} />
                </label>
              </div>
            )}
          </>
        )}

        {step === "local" && (
          <>
            <h3>{tr("この PC のフォルダを選ぶ")}</h3>
            <label className="git-dialog-label">
              {tr("追加するフォルダ")}
              <span className="add-project-row">
                <input className="input-full" value={localFolder} readOnly placeholder={tr("フォルダを選んでください")} />
                <button
                  type="button"
                  className="btn-sm"
                  onClick={pickLocal}
                  disabled={busy}
                  title={tr("GitHub からクローンしたフォルダを選ぶと、そのまま追加します。GitHub にまだないフォルダ（課題のプロジェクトなど）は、GitHub に上げてから追加します。")}
                >
                  {tr("選ぶ…")}
                </button>
              </span>
            </label>
            {localFound && (
              <div className="wizard-case wizard-case--ok">
                <b>{trx("✔ GitHub の {owner}/{repo} のフォルダです", { owner: localFound.owner, repo: localFound.repo })}</b>
                <span className="git-dialog-note">
                  {isAdded(localFound) ? tr("もう一覧にあります。このフォルダを作業フォルダにして切り替えます。") : tr("追加して、このフォルダを作業フォルダにします。")}
                  {localFound.top.replace(/[\\/]+$/, "") !== localFolder.replace(/[\\/]+$/, "") && tr("（選んだフォルダはリポジトリの中なので、いちばん上の {top} にします）", { top: localFound.top })}
                </span>
              </div>
            )}
            {localFound && check && check.repos[0] && !check.repos[0].ok && <TokenReportView report={check} installUrl={installUrl} />}
            {localChecked && !localFound && (
              <div className="wizard-case wizard-case--warn">
                <b>{tr("⚠ まだ GitHub にありません")}</b>
                <span className="git-dialog-note">
                  {localOther ? tr("このフォルダは GitHub 以外（{localOther}）につながっています。", { localOther }) : ""}
                  {tr("git の記録を始めて（git init）、GitHub にリポジトリを作って上げます。実行するコマンドを見せながら進めます。")}
                </span>
                <span>
                  <button type="button" className="btn-primary" onClick={() => setPublishing(true)}>{tr("GitHub に上げる…")}</button>
                </span>
              </div>
            )}
          </>
        )}

        {step === "create" && (
          <>
            <h3>{tr("新しく作る")}</h3>
            <CreateRepoFlow
              finishLabel={(c) => (c ? tr("クローンして追加する") : tr("追加する"))}
              onFinish={(o, r, folder) => finish(o, r, `${o}/${r}`, folder)}
              onBack={() => { setStep("choose"); setError(null); }}
              onBusyChange={setBusy}
            />
          </>
        )}

        {busy && step !== "create" && (
          <p className="git-dialog-running">
            <i className="spinner" aria-hidden="true" /> {useClone && step === "remote" ? tr("クローンしています…（大きなリポジトリは時間がかかります）") : tr("実行しています…")}
          </p>
        )}
        {error && step !== "create" && <p className="git-dialog-error">{error}</p>}

        {(step === "remote" || step === "local") && (
          <div className="git-dialog-actions add-project-actions">
            <button type="button" className="link-button" onClick={() => { setStep("choose"); setError(null); }} disabled={busy}>
              {tr("← 戻る")}
            </button>
            <button type="button" className="btn-sm" onClick={onClose} disabled={busy}>{tr("やめる")}</button>
            {step === "remote" && (
              <button type="button" className="btn-primary" onClick={addRemote} disabled={busy || !picked || (useClone && !parent)}>
                {useClone ? tr("クローンして追加する") : tr("追加する")}
              </button>
            )}
            {step === "local" && localFound && (
              <button type="button" className="btn-primary" disabled={busy}
                onClick={() => run(() => finish(localFound.owner, localFound.repo, `${localFound.owner}/${localFound.repo}`, localFound.top))}>
                {isAdded(localFound) ? tr("作業フォルダにして切り替える") : tr("追加する")}
              </button>
            )}
          </div>
        )}
      </div>
    </div>,
  );
}
