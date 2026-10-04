// つないでいるリポジトリ・ログイン・プロジェクト（リポジトリ）の一覧・自分
import { useState, useCallback } from "react";
import { invoke } from "../../lib/invoke";
import type { Project } from "../../lib/types";
import { tr } from "../../lib/i18n";

export function useSession() {
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState("");
  const [owner, setOwner] = useState("");
  const [repo, setRepo] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [needsReload, setNeedsReload] = useState(false);
  const [currentUser, setCurrentUser] = useState("");
  // 読み直しの合図（アカウントを切り替えたとき。開くリポジトリが前と同じでも、全部を読み直す）
  const [reloadNonce, setReloadNonce] = useState(0);
  const bumpReload = useCallback(() => setReloadNonce((n) => n + 1), []);

  // --- エラーメッセージ変換 ---

  function friendlyError(e: unknown): string {
    const msg = String(e);
    if (msg.includes("404")) return tr("リポジトリ {owner}/{repo} が見つかりません。リポジトリ名を確認するか、トークンの権限を確認してください。", { owner, repo });
    if (msg.includes("401")) return tr("認証エラー: トークンが無効または期限切れです。設定画面でトークンを再設定してください。");
    if (msg.includes("403")) return tr("アクセス拒否: このリポジトリへの権限がありません。トークンのスコープを確認してください。");
    return String(e);
  }

  const loadCurrentUser = useCallback(async () => {
    try {
      // リポジトリごとにトークンが違うことがあるので、どのリポジトリで使うかも渡す（つながらないときの写しに使う）
      const result = await invoke("get_current_user", { owner: owner || null, repo: repo || null });
      const user = JSON.parse(result as string);
      setCurrentUser(user.login || "");
    } catch { /* ignore */ }
  }, [owner, repo]);

  // --- プロジェクト管理 ---

  async function loadProjects() {
    try {
      const result = await invoke("list_projects");
      setProjects(JSON.parse(result as string));
    } catch (e) {
      console.error(e);
    }
  }

  async function addProject(projOwner: string, projRepo: string, projName: string, token?: string) {
    try {
      const result = await invoke("add_project", { owner: projOwner, repo: projRepo, name: projName, token: token ?? null });
      setProjects(JSON.parse(result as string));
    } catch (e) {
      setStatus(tr("エラー: ") + e);
      throw e;
    }
  }

  async function removeProject(projOwner: string, projRepo: string) {
    try {
      const result = await invoke("remove_project", { owner: projOwner, repo: projRepo });
      setProjects(JSON.parse(result as string));
      setStatus(tr("プロジェクトを削除しました"));
    } catch (e) {
      setStatus(tr("エラー: ") + e);
      throw e;
    }
  }

  async function setProjectToken(projOwner: string, projRepo: string, token: string) {
    try {
      await invoke("set_project_token", { owner: projOwner, repo: projRepo, token });
      setStatus(tr("{projOwner}/{projRepo} のトークンを更新しました", { projOwner, projRepo }));
    } catch (e) {
      setStatus(tr("エラー: ") + e);
      throw e;
    }
  }

  // --- 認証 ---

  async function loadRepoConfig() {
    try {
      const result = await invoke("load_repo_config");
      const config = JSON.parse(result as string);
      // キーチェーンに値がある場合のみ上書き
      if (config.owner) setOwner(config.owner);
      if (config.repo) setRepo(config.repo);
    } catch (e) {
      console.error("リポジトリ設定の読み込みに失敗:", e);
    }
  }

  async function setRepoConfig(newOwner: string, newRepo: string) {
    try {
      await invoke("set_repo_config", { owner: newOwner, repo: newRepo });
      setOwner(newOwner);
      setRepo(newRepo);
      setStatus(tr("リポジトリ設定を保存しました"));
    } catch (e) {
      setStatus(tr("エラー: ") + e);
      throw e;
    }
  }

  async function loadToken() {
    await invoke("load_token");
    await loadRepoConfig();
    await loadProjects();
    setConnected(true);
    setStatus(tr("接続済み"));
  }

  return {
    connected, setConnected, status, setStatus, owner, setOwner, repo, setRepo,
    projects, needsReload, setNeedsReload, currentUser, setCurrentUser, reloadNonce, bumpReload,
    friendlyError, loadCurrentUser, loadProjects, addProject, removeProject, setProjectToken,
    setRepoConfig, loadToken,
  };
}
