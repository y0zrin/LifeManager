import { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { checkFolder, cloneRepo } from "../lib/git";
import type { Project } from "../lib/types";

export type RepoNote = { key: string; kind: "ok" | "error"; text: string; command?: string };

export const repoKey = (p: { owner: string; repo: string }) => `${p.owner}/${p.repo}`;

/**
 * リポジトリの、この PC のフォルダ（選ぶ・変える・クローン・外す）と、一覧から外す。
 * 左上のリポジトリの一覧（スマホ）と、リポジトリを選ぶ画面で使う。どれも、うまくいったら true
 */
export function useRepoFolderActions(
  folders: Record<string, string>,
  onSetFolder: (owner: string, repo: string, path: string | null) => Promise<void>,
  onRemove: (owner: string, repo: string) => Promise<void>,
  /** アプリのアカウント（クローンの URL に入れる。#245） */
  login?: string,
) {
  // 実行しているリポジトリ（"owner/repo"）
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<RepoNote | null>(null);

  // この PC のフォルダを選ぶ・変える（そのリポジトリをクローンしたフォルダか確かめる）
  async function pickFolder(p: Project): Promise<boolean> {
    const k = repoKey(p);
    setNote(null);
    const picked = await openDialog({ directory: true, title: `${k} のフォルダを選ぶ`, defaultPath: folders[k] });
    if (typeof picked !== "string") return false;
    setBusy(k);
    try {
      const check = await checkFolder(picked, p.owner, p.repo);
      if (!check.is_repo) {
        setNote({ key: k, kind: "error", text: "選んだフォルダは git のリポジトリではありません。まだこの PC にないときは「この PC にクローンする…」を使います。" });
        return false;
      }
      if (!check.matches_project) {
        setNote({
          key: k,
          kind: "error",
          text: check.remote_url
            ? `このフォルダは別のリポジトリ（${check.remote_url}）です。${k} のフォルダを選んでください。`
            : `このフォルダは GitHub のリポジトリにつながっていません（origin がありません）。${k} をクローンしたフォルダを選んでください。`,
        });
        return false;
      }
      await onSetFolder(p.owner, p.repo, check.top_level);
      setNote({ key: k, kind: "ok", text: `作業フォルダにしました（${check.top_level}）` });
      return true;
    } catch (e) {
      setNote({ key: k, kind: "error", text: String(e) });
      return false;
    } finally {
      setBusy(null);
    }
  }

  // この PC にクローンして、作業フォルダにする
  async function clone(p: Project): Promise<boolean> {
    const k = repoKey(p);
    setNote(null);
    const parent = await openDialog({ directory: true, title: `クローンする置き場所を選ぶ（この中に ${p.repo} フォルダを作ります）` });
    if (typeof parent !== "string") return false;
    setBusy(k);
    try {
      const result = await cloneRepo(parent, p.owner, p.repo, login);
      await onSetFolder(p.owner, p.repo, result.path);
      setNote({ key: k, kind: "ok", text: `${result.path} にクローンして作業フォルダにしました`, command: result.run.command });
      return true;
    } catch (e) {
      setNote({ key: k, kind: "error", text: String(e) });
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function clearFolder(p: Project): Promise<boolean> {
    const k = repoKey(p);
    try {
      await onSetFolder(p.owner, p.repo, null);
      setNote({ key: k, kind: "ok", text: "フォルダの設定を外しました（フォルダそのものは消えていません）" });
      return true;
    } catch (e) {
      setNote({ key: k, kind: "error", text: String(e) });
      return false;
    }
  }

  async function remove(p: Project): Promise<boolean> {
    const k = repoKey(p);
    setBusy(k);
    try {
      await onRemove(p.owner, p.repo);
      return true;
    } catch (e) {
      setNote({ key: k, kind: "error", text: String(e) });
      return false;
    } finally {
      setBusy(null);
    }
  }

  return { busy, note, setNote, pickFolder, clone, clearFolder, remove };
}
