import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { open } from "@tauri-apps/plugin-dialog";
import { isMobile } from "../../lib/platform";
import * as git from "../../lib/git";
import { PublishDialog } from "./PublishDialog";

interface AddProjectDialogProps {
  /** GitHub にログインしている人（手元のフォルダを上げるときの、持ち主の候補） */
  login: string;
  onAddProject: (owner: string, repo: string, name: string, token?: string) => Promise<void>;
  onSetLocalFolder: (owner: string, repo: string, path: string) => void;
  onClose: () => void;
  onNotify: (text: string) => void;
}

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

/** 画面の切り替えの動き（transform）の内側だと、重ねる画面がずれたり透けたりするので、アプリのいちばん外側に出す */
const onTop = (node: ReactNode) => createPortal(node, document.querySelector("main.app") ?? document.body);

/**
 * プロジェクトを追加：GitHub の URL を貼って登録する。「この PC にも持ってくる」ならクローンして作業フォルダにもする。
 * GitHub にまだ無いときは、下のリンクから「手元のフォルダを GitHub に上げる」手順へ
 */
export function AddProjectDialog({ login, onAddProject, onSetLocalFolder, onClose, onNotify }: AddProjectDialogProps) {
  const [url, setUrl] = useState("");
  const [clone, setClone] = useState(!isMobile);
  const [parent, setParent] = useState(loadParent);
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [showMore, setShowMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);

  const parsed = git.parseGitHub(url);
  const dest = parsed && parent ? `${parent.replace(/[\\/]+$/, "")}${sep(parent)}${parsed.repo}` : "";
  const cloneCommand = parsed
    ? git.displayCommand(["clone", `https://github.com/${parsed.owner}/${parsed.repo}.git`, dest || `（置き場所）${sep(parent || "\\")}${parsed.repo}`])
    : "";

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy && !publishing) onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, publishing, onClose]);

  async function pickParent() {
    const picked = await open({ directory: true, title: "クローンする置き場所を選ぶ（この中にフォルダを作ります）", defaultPath: parent || undefined });
    if (typeof picked === "string") {
      setParent(picked);
      saveParent(picked);
    }
  }

  async function submit() {
    if (!parsed) return;
    setBusy(true);
    setError(null);
    try {
      const label = name.trim() || `${parsed.owner}/${parsed.repo}`;
      if (clone) {
        const result = await git.cloneUrl(parent, `https://github.com/${parsed.owner}/${parsed.repo}`);
        await onAddProject(parsed.owner, parsed.repo, label, token.trim() || undefined);
        onSetLocalFolder(parsed.owner, parsed.repo, result.path);
        onNotify(`${result.path} にクローンして、プロジェクトに追加しました`);
      } else {
        await onAddProject(parsed.owner, parsed.repo, label, token.trim() || undefined);
        onNotify(`${label} をプロジェクトに追加しました`);
      }
      onClose();
    } catch (e) {
      setError(git.splitGitError(e).message);
    } finally {
      setBusy(false);
    }
  }

  if (publishing) {
    return onTop(
      <PublishDialog
        login={login}
        onBack={() => setPublishing(false)}
        onDone={async (owner, repo, path) => {
          await onAddProject(owner, repo, `${owner}/${repo}`);
          onSetLocalFolder(owner, repo, path);
          onNotify(`${owner}/${repo} を GitHub に上げて、プロジェクトに追加しました`);
          onClose();
        }}
      />
    );
  }

  return onTop(
    <div className="palette-overlay git-dialog-back" onClick={() => !busy && onClose()}>
      <div className="git-dialog add-project" role="dialog" aria-modal="true" aria-label="プロジェクトを追加" onClick={(e) => e.stopPropagation()}>
        <h3>プロジェクトを追加</h3>
        <label className="git-dialog-label">
          GitHub のリポジトリ（URL をそのまま貼れます）
          <input
            className="input-full"
            value={url}
            autoFocus
            spellCheck={false}
            placeholder="https://github.com/持ち主/名前"
            onChange={(e) => setUrl(e.target.value)}
            disabled={busy}
          />
        </label>
        {url.trim() &&
          (parsed ? (
            <p className="local-folder-message local-folder-message--ok">✔ {parsed.owner} / {parsed.repo}</p>
          ) : (
            <p className="local-folder-message">GitHub のリポジトリの URL（https://github.com/持ち主/名前）か、「持ち主/名前」を入れてください</p>
          ))}

        {!isMobile && (
          <>
            <label className="chk add-project-clone">
              <input type="checkbox" checked={clone} onChange={(e) => setClone(e.target.checked)} disabled={busy} />
              この PC にも持ってくる（クローン）
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
                {parsed && (
                  <div className="cmd-preview">
                    <span>実行するコマンド</span>
                    <code>{cloneCommand}</code>
                  </div>
                )}
                <p className="hint">
                  <b>クローン</b>は、GitHub のリポジトリを、これまでの記録ごと手元に複製することです。一度クローンすれば、あとは「プル」で新しい分だけ受け取れます。
                </p>
              </div>
            )}
          </>
        )}

        <button type="button" className="add-project-more" onClick={() => setShowMore((v) => !v)}>
          {showMore ? "▾" : "▸"} 表示名・このプロジェクト専用のトークン
        </button>
        {showMore && (
          <div className="add-project-indent">
            <label className="git-dialog-label">
              表示名（任意）
              <input className="input-full" value={name} placeholder="例：合同制作" onChange={(e) => setName(e.target.value)} disabled={busy} />
            </label>
            <label className="git-dialog-label">
              トークン（任意。入れなければ、いつものトークンを使います）
              <input className="input-full" type="password" value={token} placeholder="ghp_…" onChange={(e) => setToken(e.target.value)} disabled={busy} />
            </label>
          </div>
        )}

        {busy && (
          <p className="git-dialog-running">
            <i className="spinner" aria-hidden="true" /> {clone ? "クローンしています…（大きなリポジトリは時間がかかります）" : "追加しています…"}
          </p>
        )}
        {error && <p className="git-dialog-error">{error}</p>}

        <div className="git-dialog-actions add-project-actions">
          {!isMobile && (
            <button type="button" className="link-button" onClick={() => setPublishing(true)} disabled={busy}>
              GitHub にまだ無い → 手元のフォルダを GitHub に上げる
            </button>
          )}
          <button type="button" className="btn-sm" onClick={onClose} disabled={busy}>
            やめる
          </button>
          <button type="button" className="btn-primary" onClick={submit} disabled={busy || !parsed || (clone && !parent)}>
            {clone ? "クローンして追加する" : "追加する"}
          </button>
        </div>
      </div>
    </div>
  );
}
