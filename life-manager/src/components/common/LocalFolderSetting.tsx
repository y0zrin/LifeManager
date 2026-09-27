import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { checkFolder, cloneRepo, gitVersion } from "../../lib/git";
import type { GitRun } from "../../lib/types";

interface LocalFolderSettingProps {
  owner: string;
  repo: string;
  /** 設定済みのフォルダ。未設定なら undefined */
  folder: string | undefined;
  /** null なら設定を外す */
  onSetFolder: (path: string | null) => Promise<void>;
}

type Message = { kind: "ok" | "error"; text: string };

/** 区切り文字・末尾の区切り・大文字小文字の違いを無視して同じフォルダか比べる */
function samePath(a: string, b: string) {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

/** 今のリポジトリを git で操作するときの、この PC 上のフォルダを決める（PC のみ） */
export function LocalFolderSetting({ owner, repo, folder, onSetFolder }: LocalFolderSettingProps) {
  // git が使えるか。null は確認中
  const [git, setGit] = useState<{ version: string } | { error: string } | null>(null);
  const [busy, setBusy] = useState<"pick" | "clone" | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [lastRun, setLastRun] = useState<GitRun | null>(null);

  useEffect(() => {
    gitVersion()
      .then((v) => setGit({ version: v.replace(/^git version\s*/, "") }))
      .catch((e) => setGit({ error: String(e) }));
  }, []);

  // プロジェクトを切り替えたら、前のリポジトリの結果は消す
  useEffect(() => {
    setMessage(null);
    setLastRun(null);
  }, [owner, repo]);

  const gitReady = git !== null && "version" in git;

  async function pickFolder() {
    setMessage(null);
    setLastRun(null);
    try {
      const picked = await open({ directory: true, title: `${owner}/${repo} のフォルダを選ぶ`, defaultPath: folder });
      if (typeof picked !== "string") return;
      setBusy("pick");
      const check = await checkFolder(picked, owner, repo);
      if (!check.is_repo) {
        setMessage({
          kind: "error",
          text: "選んだフォルダは git のリポジトリではありません。まだこの PC にない場合は「GitHub からクローン」を使ってください。",
        });
      } else if (!check.matches_project) {
        setMessage({
          kind: "error",
          text: check.remote_url
            ? `このフォルダは別のリポジトリ（${check.remote_url}）です。${owner}/${repo} のフォルダを選んでください。`
            : `このフォルダは GitHub のリポジトリにつながっていません（origin がありません）。${owner}/${repo} をクローンしたフォルダを選んでください。`,
        });
      } else {
        await onSetFolder(check.top_level);
        setMessage({
          kind: "ok",
          text: samePath(picked, check.top_level)
            ? "作業フォルダを設定しました"
            : `作業フォルダを設定しました（選んだフォルダはリポジトリの中なので、いちばん上の ${check.top_level} にしました）`,
        });
      }
    } catch (e) {
      setMessage({ kind: "error", text: String(e) });
    } finally {
      setBusy(null);
    }
  }

  async function clone() {
    setMessage(null);
    setLastRun(null);
    try {
      const parent = await open({ directory: true, title: `クローンする場所を選ぶ（この中に ${repo} フォルダを作ります）` });
      if (typeof parent !== "string") return;
      setBusy("clone");
      const result = await cloneRepo(parent, owner, repo);
      await onSetFolder(result.path);
      setLastRun(result.run);
      setMessage({ kind: "ok", text: `${result.path} にクローンして、作業フォルダにしました` });
    } catch (e) {
      setMessage({ kind: "error", text: String(e) });
    } finally {
      setBusy(null);
    }
  }

  async function clear() {
    setMessage(null);
    setLastRun(null);
    try {
      await onSetFolder(null);
    } catch (e) {
      setMessage({ kind: "error", text: String(e) });
    }
  }

  return (
    <div className="form-card">
      <h3 className="settings-section-title">作業フォルダ（この PC）</h3>
      <p className="settings-hint" style={{ marginBottom: "var(--space-sm)" }}>
        {owner}/{repo} を git で操作するときに使う、この PC 上のフォルダです。
      </p>

      <div className="local-folder-row">
        <span className={`local-folder-path${folder ? "" : " local-folder-path--empty"}`} title={folder}>
          {folder ?? "未設定"}
        </span>
        <button className="btn-sm" onClick={pickFolder} disabled={!gitReady || busy !== null}>
          {folder ? "変更…" : "フォルダを選ぶ…"}
        </button>
        {folder ? (
          <button className="btn-sm" onClick={clear} disabled={busy !== null} title="フォルダそのものは消えません">
            設定を外す
          </button>
        ) : (
          <button className="btn-sm" onClick={clone} disabled={!gitReady || busy !== null}>
            GitHub からクローン…
          </button>
        )}
      </div>

      {busy === "clone" && (
        <p className="settings-hint">クローンしています…（大きなリポジトリは時間がかかります）</p>
      )}
      {message && (
        <p className={`local-folder-message local-folder-message--${message.kind}`}>{message.text}</p>
      )}
      {lastRun && (
        <div className="cmd-preview" style={{ marginTop: "var(--space-sm)" }}>
          <span>実行したコマンド</span>
          <code>{lastRun.command}</code>
        </div>
      )}

      {git === null && <p className="settings-hint">git を確認しています…</p>}
      {git && "version" in git && <p className="settings-hint">使う git: {git.version}</p>}
      {git && "error" in git && (
        <div className="local-folder-message local-folder-message--error">
          {git.error}
          <div style={{ marginTop: "var(--space-xs)" }}>
            <button className="btn-sm" onClick={() => openUrl("https://git-scm.com/")}>
              Git のサイトを開く
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
