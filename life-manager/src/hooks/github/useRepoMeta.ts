// リポジトリのラベル・マイルストーン・コラボレーター（使える人）
import { useState, useCallback, useMemo } from "react";
import { invoke } from "../../lib/invoke";
import type { GitHubLabel, GitHubMilestone, GitHubUser } from "../../lib/types";
import type { RepoScope } from "./shared";
import { visibleLabels } from "../../lib/labels";
import { tr } from "../../lib/i18n";

export function useRepoMeta({ owner, repo, setStatus }: RepoScope) {
  const [labels, setLabels] = useState<GitHubLabel[]>([]);
  const [milestones, setMilestones] = useState<GitHubMilestone[]>([]);
  const [collaborators, setCollaborators] = useState<GitHubUser[]>([]);

  // --- ロード ---

  const loadLabels = useCallback(async () => {
    try {
      const result = await invoke("list_labels", { owner, repo });
      setLabels(JSON.parse(result as string));
    } catch (e) {
      console.error(e);
    }
  }, [owner, repo]);

  const loadMilestones = useCallback(async () => {
    try {
      const result = await invoke("list_milestones", { owner, repo });
      setMilestones(JSON.parse(result as string));
    } catch (e) {
      console.error(e);
    }
  }, [owner, repo]);

  const loadCollaborators = useCallback(async () => {
    try {
      const result = await invoke("list_collaborators", { owner, repo });
      setCollaborators(JSON.parse(result as string));
    } catch (e) {
      console.error(e);
    }
  }, [owner, repo]);

  /** プロジェクトを切り替えるとき、前のリポジトリの内容を消す */
  function clear() {
    setLabels([]);
    setMilestones([]);
    setCollaborators([]);
  }

  // --- マイルストーン操作 ---

  /** マイルストーンを作る。作ったマイルストーンの番号を返す（見本の計画で、タスクを入れるのに使う。分からなければ null） */
  async function createMilestone(title: string, description: string, dueOn: string | null): Promise<number | null> {
    try {
      const result = await invoke<string>("create_milestone", {
        owner, repo,
        title, description, dueOn,
      });
      setStatus(tr("マイルストーンを作成しました"));
      await loadMilestones();
      try {
        return (JSON.parse(result) as { number?: number }).number ?? null;
      } catch {
        return null;
      }
    } catch (e) {
      setStatus(tr("エラー: ") + e);
      throw e;
    }
  }

  async function updateMilestone(milestoneNumber: number, updates: { title?: string; description?: string; dueOn?: string | null }) {
    try {
      await invoke("update_milestone", {
        owner, repo, milestoneNumber,
        title: updates.title ?? null,
        description: updates.description ?? null,
        dueOn: updates.dueOn !== undefined ? (updates.dueOn || "") : null,
        milestoneState: null,
      });
      setStatus(tr("マイルストーンを更新しました"));
      await loadMilestones();
    } catch (e) {
      setStatus(tr("エラー: ") + e);
      throw e;
    }
  }

  async function closeMilestone(milestoneNumber: number) {
    try {
      await invoke("update_milestone", {
        owner, repo, milestoneNumber,
        title: null, description: null, dueOn: null, milestoneState: "closed",
      });
      setMilestones((prev) => prev.filter((m) => m.number !== milestoneNumber));
      setStatus(tr("マイルストーンを完了しました"));
    } catch (e) {
      setStatus(tr("エラー: ") + e);
      throw e;
    }
  }

  async function reopenMilestone(milestoneNumber: number) {
    try {
      await invoke("update_milestone", {
        owner, repo, milestoneNumber,
        title: null, description: null, dueOn: null, milestoneState: "open",
      });
      setStatus(tr("マイルストーンを再開しました"));
      await loadMilestones();
    } catch (e) {
      setStatus(tr("エラー: ") + e);
      throw e;
    }
  }

  // --- ラベル操作 ---

  async function setupLabels() {
    try {
      const result = await invoke("setup_labels", { owner, repo });
      setStatus(result as string);
      await loadLabels();
    } catch (e) {
      setStatus(tr("エラー: ") + e);
    }
  }

  async function createLabel(name: string, color: string, description: string) {
    try {
      await invoke("create_label", { owner, repo, name, color, description });
      setStatus(tr("ラベル \"{name}\" を作成しました", { name }));
      await loadLabels();
    } catch (e) {
      setStatus(tr("エラー: ") + e);
      throw e;
    }
  }

  async function updateLabel(currentName: string, newName: string, color: string, description: string) {
    try {
      await invoke("update_label", { owner, repo, currentName, newName, color, description });
      setStatus(tr("ラベル \"{newName}\" を更新しました", { newName }));
      await loadLabels();
    } catch (e) {
      setStatus(tr("エラー: ") + e);
      throw e;
    }
  }

  async function deleteLabel(name: string) {
    try {
      await invoke("delete_label", { owner, repo, name });
      setStatus(tr("ラベル \"{name}\" を削除しました", { name }));
      await loadLabels();
    } catch (e) {
      setStatus(tr("エラー: ") + e);
      throw e;
    }
  }

  // --- 派生データ ---

  // 画面に出すラベル（チームが作ったものは名前の頭に関わらず出し、GitHub のはじめの 9 つは出さない。#268）
  const shownLabels = useMemo(() => visibleLabels(labels), [labels]);

  return {
    labels, milestones, collaborators, visibleLabels: shownLabels,
    loadLabels, loadMilestones, loadCollaborators, clear,
    createMilestone, updateMilestone, closeMilestone, reopenMilestone,
    setupLabels, createLabel, updateLabel, deleteLabel,
  };
}
