import { useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSession } from "./github/useSession";
import { useRepoMeta } from "./github/useRepoMeta";
import { useRepoSettings } from "./github/useRepoSettings";
import { useJournal } from "./github/useJournal";
import { useIssues } from "./github/useIssues";
import type { RepoScope } from "./github/shared";

/**
 * GitHub とやりとりする中央のフック。中身は分野ごとのフック（hooks/github/）に分けてあり、
 * ここでは組み合わせと、分野をまたぐこと（全部を読む・プロジェクトの切り替え・ログイン・ログアウト）だけを行う。
 * 画面に渡すもの（返す名前）は、分ける前と同じ
 */
export function useGitHub() {
  // つないでいるリポジトリ・ログイン・プロジェクト・自分
  const session = useSession();
  const { owner, repo, connected, needsReload, setStatus, friendlyError } = session;
  const scope: RepoScope = { owner, repo, setStatus, friendlyError };

  // ラベル・マイルストーン・コラボレーター
  const meta = useRepoMeta(scope);
  // リポジトリに置く設定（ルーチン・通知・リマインダー・ボード・保存した見方・見積もりの単位・イベント通知）と Discord
  const settings = useRepoSettings(scope);
  // 日誌
  const journal = useJournal(scope);
  // Issue とその操作（コメント・サブイシュー・テンプレート・変更の履歴・見積もり）
  const issueOps = useIssues(scope, {
    labels: meta.labels,
    milestones: meta.milestones,
    loadLabels: meta.loadLabels,
    currentUser: session.currentUser,
    eventNotice: settings.eventNotice,
    estimateUnit: settings.estimateUnit,
    // 手元の写しにない Issue を変えたとき（呼ばれるのは操作のあとなので、そのときの loadAll が使われる）
    reloadAll: () => loadAll(),
  });

  // --- 全部を読む ---

  const { loadIssues, loadClosedIssues } = issueOps;
  const { loadLabels, loadMilestones, loadCollaborators } = meta;
  const { loadRoutines, loadNotificationSchedules, loadReminders, loadBoardConfig, loadSavedViews, loadEstimateConfig, loadEventNotifConfig } = settings;
  const { loadCurrentUser } = session;

  const loadAll = useCallback(async () => {
    await Promise.all([loadIssues(), loadClosedIssues(), loadLabels(), loadMilestones(), loadRoutines(), loadNotificationSchedules(), loadReminders(), loadCollaborators(), loadBoardConfig(), loadSavedViews(), loadEstimateConfig(), loadEventNotifConfig(), loadCurrentUser()]);
  }, [loadIssues, loadClosedIssues, loadLabels, loadMilestones, loadRoutines, loadNotificationSchedules, loadReminders, loadCollaborators, loadBoardConfig, loadSavedViews, loadEstimateConfig, loadEventNotifConfig, loadCurrentUser]);

  // connected + owner/repo が揃ったらデータをロード（初期化時・プロジェクト切り替え時・アカウントの切り替え時）
  const { reloadNonce } = session;
  useEffect(() => {
    if (connected && owner && repo) {
      loadAll().then(() => {
        if (needsReload) {
          session.setNeedsReload(false);
          setStatus("プロジェクトを切り替えました");
        }
      });
    }
  }, [connected, owner, repo, loadAll, reloadNonce]);

  // --- プロジェクトの切り替え ---

  async function switchProject(projOwner: string, projRepo: string) {
    try {
      // 古いデータをクリア
      issueOps.clear();
      meta.clear();
      settings.clear();

      // バックエンドでトークン切り替え + repo設定を同時に行う
      await invoke("switch_project", { owner: projOwner, repo: projRepo });
      session.setOwner(projOwner);
      session.setRepo(projRepo);
      session.setNeedsReload(true);
      setStatus(`プロジェクトを切り替え中...`);
    } catch (e) {
      setStatus(friendlyError(e));
      throw e;
    }
  }

  // --- 認証 ---

  /** ログアウト（この PC からトークンを消す）。使うリポジトリの一覧は、今のアカウントの分としてしまう。最初のセットアップの画面に戻る */
  async function signOut() {
    await invoke("sign_out", { login: session.currentUser || null });
    session.setConnected(false);
    session.setCurrentUser("");
    issueOps.clear();
    setStatus("ログアウトしました");
  }

  /** アカウントを切り替えた・足したあと: 前のアカウントのデータを捨てて、今のアカウントのリポジトリを読み直す */
  async function reloadAccount() {
    issueOps.clear();
    meta.clear();
    settings.clear();
    // 開くリポジトリは、今のアカウントのものを読み直す（同じリポジトリでも、読み直すように一度空にする）
    session.setOwner("");
    session.setRepo("");
    session.setCurrentUser("");
    await session.loadToken();
    session.bumpReload();
  }

  async function setToken(token: string) {
    try {
      await invoke("set_token", { token });
      session.setConnected(true);
      setStatus("トークンを設定しました");
      await loadAll();
    } catch (e) {
      setStatus("エラー: " + e);
      throw e;
    }
  }

  return {
    // 状態
    issues: issueOps.issues, closedIssues: issueOps.closedIssues, labels: meta.labels, milestones: meta.milestones,
    connected, status: session.status, setStatus,
    customLabels: meta.customLabels,
    // コラボレーター
    collaborators: meta.collaborators, loadCollaborators,
    // ロード
    loadAll, loadIssues, loadClosedIssues, reloadCached: issueOps.reloadCached, loadLabels, loadMilestones, loadRoutines, loadToken: session.loadToken,
    // Issue操作
    closeIssue: issueOps.closeIssue, reopenIssue: issueOps.reopenIssue, promoteIssue: issueOps.promoteIssue,
    changeIssueStatus: issueOps.changeIssueStatus, assignToMe: issueOps.assignToMe, createIssue: issueOps.createIssue,
    createMemo: issueOps.createMemo, updateIssue: issueOps.updateIssue, updateIssueBody: issueOps.updateIssueBody,
    retrySending: issueOps.retrySending, discardSending: issueOps.discardSending,
    // マイルストーン操作
    createMilestone: meta.createMilestone, updateMilestone: meta.updateMilestone, closeMilestone: meta.closeMilestone, reopenMilestone: meta.reopenMilestone,
    // ルーチン操作
    routines: settings.routines, saveRoutines: settings.saveRoutines,
    // コメント
    listComments: issueOps.listComments, createComment: issueOps.createComment,
    // ジャーナル
    generateJournal: journal.generateJournal, getJournal: journal.getJournal, saveJournalNotes: journal.saveJournalNotes,
    // 認証・設定
    setToken, signOut, reloadAccount, setupLabels: meta.setupLabels, createLabel: meta.createLabel, updateLabel: meta.updateLabel, deleteLabel: meta.deleteLabel,
    // リポジトリ設定
    owner, repo, setRepoConfig: session.setRepoConfig,
    // 通知
    sendNotification: settings.sendNotification,
    notificationSchedules: settings.notificationSchedules, saveNotificationSchedules: settings.saveNotificationSchedules, loadNotificationSchedules,
    // リマインダー
    reminders: settings.reminders, addReminder: settings.addReminder, removeReminder: settings.removeReminder, loadReminders,
    // Discord Webhook
    setDiscordWebhook: settings.setDiscordWebhook, loadDiscordWebhook: settings.loadDiscordWebhook, testDiscordWebhook: settings.testDiscordWebhook,
    // ボード設定
    boardConfig: settings.boardConfig, saveBoardConfig: settings.saveBoardConfig, loadBoardConfig,
    // タスク一覧の保存した見方
    savedViews: settings.savedViews, saveSavedViews: settings.saveSavedViews, loadSavedViews,
    // 見積もり
    estimateUnit: settings.estimateUnit, saveEstimateUnit: settings.saveEstimateUnit, setEstimate: issueOps.setEstimate, ensureEstimateLabel: issueOps.ensureEstimateLabel,
    // イベント通知
    eventNotifConfig: settings.eventNotifConfig, saveEventNotifConfig: settings.saveEventNotifConfig, loadEventNotifConfig,
    // サブイシュー（親子）・変更の履歴
    listSubIssues: issueOps.listSubIssues, addSubIssue: issueOps.addSubIssue, createSubIssue: issueOps.createSubIssue,
    removeSubIssue: issueOps.removeSubIssue, listTimeline: issueOps.listTimeline,
    // Issue テンプレート
    listIssueTemplates: issueOps.listIssueTemplates, addIssueTemplates: issueOps.addIssueTemplates,
    // プロジェクト管理
    projects: session.projects, loadProjects: session.loadProjects, addProject: session.addProject, removeProject: session.removeProject,
    switchProject, setProjectToken: session.setProjectToken,
    // 現在のユーザー
    currentUser: session.currentUser,
  };
}
