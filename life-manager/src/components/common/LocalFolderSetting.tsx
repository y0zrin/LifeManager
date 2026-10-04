import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { checkFolder, cloneRepo, gitVersion } from "../../lib/git";
import type { GitRun } from "../../lib/types";
import { tr, trx } from "../../lib/i18n";

interface LocalFolderSettingProps {
  owner: string;
  repo: string;
  /** 設定済みのフォルダ。未設定なら undefined */
  folder: string | undefined;
  /** null なら設定を外す */
  onSetFolder: (path: string | null) => Promise<void>;
  /** 使う準備（Git のインストール・コミットに使う名前）のダイアログを開く */
  onOpenSetup: () => void;
  /** 変わったら Git を確かめ直す（Git を入れたあとなど） */
  setupVersion: number;
  /** アプリのアカウント（クローンの URL に入れる。#245） */
  login?: string;
}

type Message = { kind: "ok" | "error"; text: string };

/** 区切り文字・末尾の区切り・大文字小文字の違いを無視して同じフォルダか比べる */
function samePath(a: string, b: string) {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

/** 今のリポジトリを git で操作するときの、この PC 上のフォルダを決める（PC のみ） */
export function LocalFolderSetting({ owner, repo, folder, onSetFolder, onOpenSetup, setupVersion, login }: LocalFolderSettingProps) {
  // git が使えるか。null は確認中
  const [git, setGit] = useState<{ version: string } | { error: string } | null>(null);
  const [busy, setBusy] = useState<"pick" | "clone" | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [lastRun, setLastRun] = useState<GitRun | null>(null);

  useEffect(() => {
    gitVersion()
      .then((v) => setGit({ version: v.replace(/^git version\s*/, "") }))
      .catch((e) => setGit({ error: String(e) }));
  }, [setupVersion]);

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
      const picked = await open({ directory: true, title: tr("{owner}/{repo} のフォルダを選ぶ", { owner, repo }), defaultPath: folder });
      if (typeof picked !== "string") return;
      setBusy("pick");
      const check = await checkFolder(picked, owner, repo);
      if (!check.is_repo) {
        setMessage({
          kind: "error",
          text: tr("選んだフォルダは git のリポジトリではありません。まだこの PC にない場合は「GitHub からクローン」を使ってください。"),
        });
      } else if (!check.matches_project) {
        setMessage({
          kind: "error",
          text: check.remote_url
            ? tr("このフォルダは別のリポジトリ（{remote_url}）です。{owner}/{repo} のフォルダを選んでください。", { remote_url: check.remote_url, owner, repo })
            : tr("このフォルダは GitHub のリポジトリにつながっていません（origin がありません）。{owner}/{repo} をクローンしたフォルダを選んでください。", { owner, repo }),
        });
      } else {
        await onSetFolder(check.top_level);
        setMessage({
          kind: "ok",
          text: samePath(picked, check.top_level)
            ? tr("作業フォルダを設定しました")
            : tr("作業フォルダを設定しました。選んだフォルダはリポジトリの中なので、いちばん上の {top_level} にしました", { top_level: check.top_level }),
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
      const parent = await open({ directory: true, title: tr("クローンする場所を選ぶ（この中に {repo} フォルダを作ります）", { repo }) });
      if (typeof parent !== "string") return;
      setBusy("clone");
      const result = await cloneRepo(parent, owner, repo, login);
      await onSetFolder(result.path);
      setLastRun(result.run);
      setMessage({ kind: "ok", text: tr("{path} にクローンして作業フォルダにしました", { path: result.path }) });
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
      <h3 className="settings-section-title">{tr("作業フォルダ（この PC）")}</h3>
      <p className="settings-hint" style={{ marginBottom: "var(--space-sm)" }}>
        {trx("{owner}/{repo} を git で操作するときに使う、この PC 上のフォルダです。", { owner, repo })}
      </p>

      <div className="local-folder-row">
        <span className={`local-folder-path${folder ? "" : " local-folder-path--empty"}`} title={folder}>
          {folder ?? tr("未設定")}
        </span>
        <button className="btn-sm" onClick={pickFolder} disabled={!gitReady || busy !== null}>
          {folder ? tr("変更…") : tr("フォルダを選ぶ…")}
        </button>
        {folder ? (
          <button className="btn-sm" onClick={clear} disabled={busy !== null} title={tr("フォルダそのものは消えません")}>
            {tr("設定を外す")}
          </button>
        ) : (
          <button className="btn-sm" onClick={clone} disabled={!gitReady || busy !== null}>
            {tr("GitHub からクローン…")}
          </button>
        )}
      </div>

      {busy === "clone" && (
        <p className="settings-hint">{tr("クローンしています…（大きなリポジトリは時間がかかります）")}</p>
      )}
      {message && (
        <p className={`local-folder-message local-folder-message--${message.kind}`}>{message.text}</p>
      )}
      {lastRun && (
        <div className="cmd-preview" style={{ marginTop: "var(--space-sm)" }}>
          {trx("<0>実行したコマンド</0><1>{command}</1>", { command: lastRun.command }, [<span />, <code />])}
        </div>
      )}

      {git === null && <p className="settings-hint">{tr("git を確認しています…")}</p>}
      {git && "version" in git && (
        <p className="settings-hint local-folder-git">
          {trx("使う git: {version}", { version: git.version })}
          <button type="button" className="sec-btn" onClick={onOpenSetup}>
            {tr("使う準備を確かめる")}
          </button>
        </p>
      )}
      {git && "error" in git && (
        <div className="local-folder-message local-folder-message--error">
          {tr("Git が見つかりません。「作業をする」「ブランチ」「全体図」を使うには、Git をインストールします。")}
          <div className="local-folder-actions">
            <button type="button" className="btn-primary" onClick={onOpenSetup}>
              {tr("Git をインストールする…")}
            </button>
            <button type="button" className="btn-sm" onClick={() => openUrl("https://git-scm.com/downloads")}>
              {tr("Git のページを開く")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
