import { useState, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { GitHubComment, GitHubIssue, GitHubLabel, GitHubMilestone, GitHubUser, NotificationSchedule, Reminder, Routine, BoardConfig, Project, EventNotificationConfig, EventType } from "../lib/types";

export function useGitHub() {
  const [issues, setIssues] = useState<GitHubIssue[]>([]);
  const [closedIssues, setClosedIssues] = useState<GitHubIssue[]>([]);
  const [labels, setLabels] = useState<GitHubLabel[]>([]);
  const [milestones, setMilestones] = useState<GitHubMilestone[]>([]);
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState("");
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [owner, setOwner] = useState("");
  const [repo, setRepo] = useState("");
  const [notificationSchedules, setNotificationSchedules] = useState<NotificationSchedule[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [collaborators, setCollaborators] = useState<GitHubUser[]>([]);
  const [boardConfig, setBoardConfig] = useState<BoardConfig | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [needsReload, setNeedsReload] = useState(false);
  const [eventNotifConfig, setEventNotifConfig] = useState<EventNotificationConfig | null>(null);
  const [currentUser, setCurrentUser] = useState("");

  // --- エラーメッセージ変換 ---

  function friendlyError(e: unknown): string {
    const msg = String(e);
    if (msg.includes("404")) return `リポジトリ ${owner}/${repo} が見つかりません。リポジトリ名を確認するか、トークンの権限を確認してください。`;
    if (msg.includes("401")) return "認証エラー: トークンが無効または期限切れです。設定画面でトークンを再設定してください。";
    if (msg.includes("403")) return "アクセス拒否: このリポジトリへの権限がありません。トークンのスコープを確認してください。";
    return String(e);
  }

  // --- ロード ---

  const loadIssues = useCallback(async () => {
    try {
      const result = await invoke("list_issues", { owner, repo, issueState: "open" });
      setIssues(JSON.parse(result as string));
    } catch (e) {
      setStatus(friendlyError(e));
    }
  }, [owner, repo]);

  const loadClosedIssues = useCallback(async () => {
    try {
      const result = await invoke("list_issues", { owner, repo, issueState: "closed" });
      setClosedIssues(JSON.parse(result as string));
    } catch (e) {
      console.error(e);
    }
  }, [owner, repo]);

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

  const loadRoutines = useCallback(async () => {
    try {
      const result = await invoke("get_routines", { owner, repo });
      setRoutines(JSON.parse(result as string));
    } catch (e) {
      console.error(e);
    }
  }, [owner, repo]);

  const loadNotificationSchedules = useCallback(async () => {
    try {
      const result = await invoke("get_notification_schedules", { owner, repo });
      setNotificationSchedules(JSON.parse(result as string));
    } catch (e) {
      console.error(e);
    }
  }, [owner, repo]);

  const loadReminders = useCallback(async () => {
    try {
      const result = await invoke("get_reminders", { owner, repo });
      setReminders(JSON.parse(result as string));
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

  const loadBoardConfig = useCallback(async () => {
    try {
      const result = await invoke("get_board_config", { owner, repo });
      const parsed = JSON.parse(result as string);
      if (parsed) {
        setBoardConfig(parsed);
      }
    } catch (e) {
      console.error(e);
    }
  }, [owner, repo]);

  const loadEventNotifConfig = useCallback(async () => {
    try {
      const result = await invoke("get_event_notification_config", { owner, repo });
      const parsed = JSON.parse(result as string);
      if (parsed) {
        // 保存済み設定に不足しているイベントタイプをデフォルトで補完
        const merged: EventNotificationConfig = {
          ...defaultEventNotifConfig,
          ...parsed,
          events: { ...defaultEventNotifConfig.events, ...parsed.events },
        };
        setEventNotifConfig(merged);
      } else {
        setEventNotifConfig(null);
      }
    } catch (e) {
      console.error(e);
    }
  }, [owner, repo]);

  const loadCurrentUser = useCallback(async () => {
    try {
      const result = await invoke("get_current_user");
      const user = JSON.parse(result as string);
      setCurrentUser(user.login || "");
    } catch { /* ignore */ }
  }, []);

  const loadAll = useCallback(async () => {
    await Promise.all([loadIssues(), loadClosedIssues(), loadLabels(), loadMilestones(), loadRoutines(), loadNotificationSchedules(), loadReminders(), loadCollaborators(), loadBoardConfig(), loadEventNotifConfig(), loadCurrentUser()]);
  }, [loadIssues, loadClosedIssues, loadLabels, loadMilestones, loadRoutines, loadNotificationSchedules, loadReminders, loadCollaborators, loadBoardConfig, loadEventNotifConfig, loadCurrentUser]);

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
      setStatus("エラー: " + e);
      throw e;
    }
  }

  async function removeProject(projOwner: string, projRepo: string) {
    try {
      const result = await invoke("remove_project", { owner: projOwner, repo: projRepo });
      setProjects(JSON.parse(result as string));
      setStatus("プロジェクトを削除しました");
    } catch (e) {
      setStatus("エラー: " + e);
      throw e;
    }
  }

  async function switchProject(projOwner: string, projRepo: string) {
    try {
      // 古いデータをクリア
      setIssues([]);
      setClosedIssues([]);
      setLabels([]);
      setMilestones([]);
      setRoutines([]);
      setNotificationSchedules([]);
      setReminders([]);
      setCollaborators([]);
      setBoardConfig(null);

      // バックエンドでトークン切り替え + repo設定を同時に行う
      await invoke("switch_project", { owner: projOwner, repo: projRepo });
      setOwner(projOwner);
      setRepo(projRepo);
      setNeedsReload(true);
      setStatus(`プロジェクトを切り替え中...`);
    } catch (e) {
      setStatus(friendlyError(e));
      throw e;
    }
  }

  async function setProjectToken(projOwner: string, projRepo: string, token: string) {
    try {
      await invoke("set_project_token", { owner: projOwner, repo: projRepo, token });
      setStatus(`${projOwner}/${projRepo} のトークンを更新しました`);
    } catch (e) {
      setStatus("エラー: " + e);
      throw e;
    }
  }

  // connected + owner/repo が揃ったらデータをロード（初期化時・プロジェクト切り替え時共通）
  useEffect(() => {
    if (connected && owner && repo) {
      loadAll().then(() => {
        if (needsReload) {
          setNeedsReload(false);
          setStatus("プロジェクトを切り替えました");
        }
      });
    }
  }, [connected, owner, repo, loadAll]);

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
      setStatus("リポジトリ設定を保存しました");
    } catch (e) {
      setStatus("エラー: " + e);
      throw e;
    }
  }

  async function loadToken() {
    await invoke("load_token");
    await loadRepoConfig();
    await loadProjects();
    setConnected(true);
    setStatus("接続済み");
  }

  async function setToken(token: string) {
    try {
      await invoke("set_token", { token });
      setConnected(true);
      setStatus("トークンを設定しました");
      await loadAll();
    } catch (e) {
      setStatus("エラー: " + e);
      throw e;
    }
  }

  // --- イベント通知ヘルパー ---

  // 設定未保存時のデフォルト: 全イベントDiscordのみ有効
  const defaultEventNotifConfig: EventNotificationConfig = {
    enabled: true,
    os_for_own_actions: false,
    events: {
      issue_created: { enabled: true, channels: ["discord"] },
      issue_closed: { enabled: true, channels: ["discord"] },
      issue_reopened: { enabled: true, channels: ["discord"] },
      status_changed: { enabled: true, channels: ["discord"] },
      comment_added: { enabled: true, channels: ["discord"] },
      todo_toggled: { enabled: true, channels: ["discord"] },
      issue_promoted: { enabled: true, channels: ["discord"] },
      issue_updated: { enabled: true, channels: ["discord"] },
    },
  };

  async function notifyEvent(eventType: EventType, message: string, issueNumber?: number) {
    const config = eventNotifConfig ?? defaultEventNotifConfig;
    if (!config.enabled) return;
    // 保存済み設定に未登録のイベントタイプはデフォルトにフォールバック
    const event = config.events?.[eventType] ?? defaultEventNotifConfig.events[eventType];
    if (!event?.enabled || !event.channels?.length) return;
    // 自分の操作時はOS通知をスキップ（os_for_own_actionsがfalseの場合）
    const channels = event.channels.filter(ch => ch !== "os" || config.os_for_own_actions);
    if (channels.length === 0) return;
    // イシューリンクを付与
    const fullMessage = issueNumber
      ? `${message}\nhttps://github.com/${owner}/${repo}/issues/${issueNumber}`
      : message;
    try {
      await invoke("send_event_notification", { owner, repo, message: fullMessage, channels });
    } catch (e) {
      console.error("イベント通知送信エラー:", e);
    }
  }

  // --- Issue操作 ---

  async function closeIssue(n: number) {
    try {
      await invoke("update_issue", {
        owner, repo, issueNumber: n,
        title: null, body: null, issueState: "closed", labels: null, milestone: null, assignees: null,
      });
      const closedIssue = issues.find((i) => i.number === n);
      const issueTitle = closedIssue?.title || `#${n}`;
      setStatus(`#${n} 完了`);
      // 楽観的更新: openから除去し、closedに追加（副作用をupdater外に分離）
      setIssues((prev) => prev.filter((i) => i.number !== n));
      if (closedIssue) {
        setClosedIssues((prev) => [{ ...closedIssue, state: "closed" }, ...prev]);
      }
      await notifyEvent("issue_closed", `✅ #${n} ${issueTitle} を完了`, n);
    } catch (e) {
      setStatus("エラー: " + e);
      await loadIssues();
    }
  }

  async function reopenIssue(n: number) {
    try {
      await invoke("update_issue", {
        owner, repo, issueNumber: n,
        title: null, body: null, issueState: "open", labels: null, milestone: null, assignees: null,
      });
      const reopenedIssue = closedIssues.find((i) => i.number === n);
      const issueTitle = reopenedIssue?.title || `#${n}`;
      setStatus(`#${n} 再開`);
      // 楽観的更新: closedから除去し、openに追加（副作用をupdater外に分離）
      setClosedIssues((prev) => prev.filter((i) => i.number !== n));
      if (reopenedIssue) {
        setIssues((prev) => [{ ...reopenedIssue, state: "open" }, ...prev]);
      }
      await notifyEvent("issue_reopened", `🔄 #${n} ${issueTitle} を再開`, n);
    } catch (e) {
      setStatus("エラー: " + e);
      await loadIssues();
    }
  }

  async function promoteIssue(n: number) {
    try {
      const issue = issues.find((i) => i.number === n);
      if (!issue) return;
      const newLabels = issue.labels
        .map((l) => l.name)
        .filter((name) => name !== "種別:メモ")
        .concat(["種別:イシュー"]);
      await invoke("update_issue", {
        owner, repo, issueNumber: n,
        title: null, body: null, issueState: null, labels: newLabels, milestone: null, assignees: null,
      });
      setStatus(`#${n} をイシューに昇華`);
      // 楽観的更新: ラベルをローカルで更新
      const updatedLabelObjs = issue.labels
        .filter((l) => l.name !== "種別:メモ")
        .concat([labels.find((l) => l.name === "種別:イシュー") || { name: "種別:イシュー", color: "0E8A16" }]);
      setIssues((prev) =>
        prev.map((i) => i.number === n ? { ...i, labels: updatedLabelObjs } : i)
      );
      await notifyEvent("issue_promoted", `⬆ #${n} ${issue.title} をイシューに昇華`, n);
    } catch (e) {
      setStatus("エラー: " + e);
      await loadIssues();
    }
  }

  async function assignToMe(n: number) {
    if (!currentUser) return;
    try {
      const issue = issues.find((i) => i.number === n);
      if (!issue) return;
      const currentAssignees = issue.assignees?.map((a) => a.login) || [];
      if (currentAssignees.includes(currentUser)) {
        return; // 既に担当者
      }
      const newAssignees = [...currentAssignees, currentUser];
      // 楽観的更新
      setIssues((prev) =>
        prev.map((i) =>
          i.number === n
            ? { ...i, assignees: [...(i.assignees || []), { login: currentUser, avatar_url: "" }] }
            : i
        )
      );
      await invoke("update_issue", {
        owner, repo, issueNumber: n,
        title: null, body: null, issueState: null, labels: null, milestone: null, assignees: newAssignees,
      });
      setStatus(`#${n} → 自分に担当割り当て`);
    } catch (e) {
      setStatus("エラー: " + e);
      await loadIssues();
    }
  }

  async function changeIssueStatus(n: number, newStatusLabel: string) {
    try {
      const issue = issues.find((i) => i.number === n);
      if (!issue) return;
      const newLabelNames = issue.labels
        .map((l) => l.name)
        .filter((name) => !name.startsWith("状態:"));
      if (newStatusLabel) {
        newLabelNames.push(newStatusLabel);
      }
      // 楽観的更新: 先にローカルを更新してから API を呼ぶ
      const newLabelObjs = issue.labels.filter((l) => !l.name.startsWith("状態:"));
      if (newStatusLabel) {
        const statusLabelObj = labels.find((l) => l.name === newStatusLabel);
        newLabelObjs.push(statusLabelObj || { name: newStatusLabel, color: "cccccc" });
      }
      setIssues((prev) =>
        prev.map((i) => i.number === n ? { ...i, labels: newLabelObjs } : i)
      );
      await invoke("update_issue", {
        owner, repo, issueNumber: n,
        title: null, body: null, issueState: null, labels: newLabelNames, milestone: null, assignees: null,
      });
      const statusName = newStatusLabel ? newStatusLabel.split(":")[1] : "未分類";
      setStatus(`#${n} → ${newStatusLabel}`);
      await notifyEvent("status_changed", `🔀 #${n} ${issue.title} → ${statusName}`, n);
    } catch (e) {
      setStatus("エラー: " + e);
      await loadIssues();
    }
  }

  async function createIssue(title: string, body: string, labelList: string[], milestone: number | null, assignees?: string[]): Promise<number> {
    try {
      const result = await invoke("create_issue", {
        owner, repo,
        title, body,
        labels: labelList,
        milestone,
        assignees: assignees ?? null,
      });
      setStatus("Issueを作成しました");
      // 楽観的更新: APIレスポンスの Issue をリストに即追加
      let issueNumber = 0;
      try {
        const newIssue = JSON.parse(result as string) as GitHubIssue;
        issueNumber = newIssue.number;
        setIssues((prev) => [newIssue, ...prev]);
      } catch {
        await loadIssues();
      }
      await notifyEvent("issue_created", `📝 #${issueNumber || "?"} ${title} を作成`, issueNumber);
      return issueNumber;
    } catch (e) {
      setStatus("エラー: " + e);
      throw e;
    }
  }

  async function createMemo(text: string, theme: string) {
    try {
      const result = await invoke("create_issue", {
        owner, repo,
        title: text, body: "",
        labels: ["種別:メモ", "状態:未整理", theme],
        milestone: null,
        assignees: currentUser ? [currentUser] : null,
      });
      setStatus("メモを投入しました");
      // 楽観的更新: APIレスポンスの Issue をリストに即追加
      let issueNumber = 0;
      try {
        const newIssue = JSON.parse(result as string) as GitHubIssue;
        issueNumber = newIssue.number;
        setIssues((prev) => [newIssue, ...prev]);
      } catch {
        await loadIssues();
      }
      await notifyEvent("issue_created", `📝 #${issueNumber || "?"} ${text} をメモ投入`, issueNumber);
    } catch (e) {
      setStatus("エラー: " + e);
      throw e;
    }
  }

  // --- タスクトグル用の本文更新（ローカル即時反映） ---

  async function updateIssueBody(issueNumber: number, newBody: string) {
    try {
      await invoke("update_issue", {
        owner, repo, issueNumber,
        title: null, body: newBody, issueState: null, labels: null, milestone: null, assignees: null,
      });
      // ローカルのissue一覧も即座に更新して再レンダリングに反映
      setIssues((prev) =>
        prev.map((i) => i.number === issueNumber ? { ...i, body: newBody } : i)
      );
      setClosedIssues((prev) =>
        prev.map((i) => i.number === issueNumber ? { ...i, body: newBody } : i)
      );
      // Todo進捗通知
      const todoDone = (newBody.match(/- \[x\]/g) || []).length;
      const todoTotal = (newBody.match(/- \[[ x]\]/g) || []).length;
      if (todoTotal > 0) {
        const issueTitle = issues.find((i) => i.number === issueNumber)?.title || `#${issueNumber}`;
        await notifyEvent("todo_toggled", `☑ #${issueNumber} ${issueTitle} ${todoDone}/${todoTotal}完了`, issueNumber);
      }
    } catch (e) {
      setStatus("タスク更新エラー: " + e);
      throw e;
    }
  }

  // --- Issue編集 ---

  async function updateIssue(
    n: number,
    updates: { title?: string; body?: string; labels?: string[]; assignees?: string[]; milestone?: number | null }
  ) {
    try {
      const result = await invoke("update_issue", {
        owner, repo, issueNumber: n,
        title: updates.title ?? null,
        body: updates.body ?? null,
        issueState: null,
        labels: updates.labels ?? null,
        milestone: updates.milestone !== undefined ? updates.milestone : null,
        assignees: updates.assignees ?? null,
      });
      setStatus(`#${n} を更新しました`);
      // 楽観的更新: APIレスポンスでローカルを即反映
      try {
        const updated = JSON.parse(result as string) as GitHubIssue;
        setIssues((prev) =>
          prev.map((i) => i.number === n ? updated : i)
        );
        setClosedIssues((prev) =>
          prev.map((i) => i.number === n ? updated : i)
        );
        await notifyEvent("issue_updated", `✏ #${n} ${updated.title} を更新`, n);
      } catch {
        await loadAll();
      }
    } catch (e) {
      setStatus("エラー: " + e);
    }
  }

  // --- マイルストーン操作 ---

  async function createMilestone(title: string, description: string, dueOn: string | null) {
    try {
      await invoke("create_milestone", {
        owner, repo,
        title, description, dueOn,
      });
      setStatus("マイルストーンを作成しました");
      await loadMilestones();
    } catch (e) {
      setStatus("エラー: " + e);
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
      setStatus("マイルストーンを更新しました");
      await loadMilestones();
    } catch (e) {
      setStatus("エラー: " + e);
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
      setStatus("マイルストーンを完了しました");
    } catch (e) {
      setStatus("エラー: " + e);
      throw e;
    }
  }

  async function reopenMilestone(milestoneNumber: number) {
    try {
      await invoke("update_milestone", {
        owner, repo, milestoneNumber,
        title: null, description: null, dueOn: null, milestoneState: "open",
      });
      setStatus("マイルストーンを再開しました");
      await loadMilestones();
    } catch (e) {
      setStatus("エラー: " + e);
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
      setStatus("エラー: " + e);
    }
  }

  async function createLabel(name: string, color: string, description: string) {
    try {
      await invoke("create_label", { owner, repo, name, color, description });
      setStatus(`ラベル "${name}" を作成しました`);
      await loadLabels();
    } catch (e) {
      setStatus("エラー: " + e);
      throw e;
    }
  }

  async function updateLabel(currentName: string, newName: string, color: string, description: string) {
    try {
      await invoke("update_label", { owner, repo, currentName, newName, color, description });
      setStatus(`ラベル "${newName}" を更新しました`);
      await loadLabels();
    } catch (e) {
      setStatus("エラー: " + e);
      throw e;
    }
  }

  async function deleteLabel(name: string) {
    try {
      await invoke("delete_label", { owner, repo, name });
      setStatus(`ラベル "${name}" を削除しました`);
      await loadLabels();
    } catch (e) {
      setStatus("エラー: " + e);
      throw e;
    }
  }

  // --- コメント ---

  async function listComments(issueNumber: number): Promise<GitHubComment[]> {
    try {
      const result = await invoke("list_comments", { owner, repo, issueNumber });
      return JSON.parse(result as string);
    } catch (e) {
      setStatus("コメント取得エラー: " + e);
      return [];
    }
  }

  async function createComment(issueNumber: number, body: string) {
    try {
      await invoke("create_comment", { owner, repo, issueNumber, body });
      setStatus(`#${issueNumber} にコメントを追加`);
      const issueTitle = issues.find((i) => i.number === issueNumber)?.title || `#${issueNumber}`;
      await notifyEvent("comment_added", `💬 #${issueNumber} ${issueTitle} にコメント`, issueNumber);
    } catch (e) {
      setStatus("エラー: " + e);
      throw e;
    }
  }

  // --- ルーチン操作 ---

  async function saveRoutines(routinesList: Routine[]) {
    try {
      const json = JSON.stringify(routinesList);
      await invoke("save_routines", { owner, repo, routines: json });
      setRoutines(routinesList);
      setStatus("ルーチン設定を保存しました");
    } catch (e) {
      setStatus("エラー: " + e);
      throw e;
    }
  }

  // --- ジャーナル ---

  async function generateJournal(date: string): Promise<string> {
    try {
      const result = await invoke("generate_journal", { owner, repo, date });
      setStatus(`${date}のジャーナルを生成しました`);
      return result as string;
    } catch (e) {
      setStatus("ジャーナル生成エラー: " + e);
      throw e;
    }
  }

  async function getJournal(date: string): Promise<string> {
    try {
      const result = await invoke("get_journal", { owner, repo, date });
      return result as string;
    } catch (e) {
      // ジャーナルが見つからない場合は空文字を返す
      return "";
    }
  }

  async function saveJournalNotes(date: string, notes: string): Promise<string> {
    try {
      const result = await invoke("save_journal_notes", { owner, repo, date, notes });
      setStatus(`${date}のノートを保存しました`);
      return result as string;
    } catch (e) {
      setStatus("ノート保存エラー: " + e);
      throw e;
    }
  }

  // --- 通知 ---

  async function sendNotification(title: string, body: string) {
    try {
      await invoke("send_notification", { title, body });
      setStatus("通知を送信しました");
    } catch (e) {
      setStatus("通知エラー: " + e);
    }
  }

  // --- リマインダー ---

  async function addReminder(issueNumber: number, title: string, datetime: string, channels: string[]) {
    try {
      const newReminder: Reminder = { issue_number: issueNumber, title, datetime, channels };
      const updated = [...reminders, newReminder];
      const json = JSON.stringify(updated);
      await invoke("save_reminders", { owner, repo, reminders: json });
      await invoke("refresh_scheduler");
      setReminders(updated);
      setStatus(`#${issueNumber} のリマインダーを設定しました`);
    } catch (e) {
      setStatus("エラー: " + e);
      throw e;
    }
  }

  async function removeReminder(issueNumber: number, datetime: string) {
    try {
      const updated = reminders.filter(
        (r) => !(r.issue_number === issueNumber && r.datetime === datetime)
      );
      const json = JSON.stringify(updated);
      await invoke("save_reminders", { owner, repo, reminders: json });
      await invoke("refresh_scheduler");
      setReminders(updated);
      setStatus("リマインダーを削除しました");
    } catch (e) {
      setStatus("エラー: " + e);
      throw e;
    }
  }

  // --- 通知スケジュール ---

  async function saveNotificationSchedules(schedules: NotificationSchedule[]) {
    try {
      const json = JSON.stringify(schedules);
      await invoke("save_notification_schedules", { owner, repo, schedules: json });
      setNotificationSchedules(schedules);
      setStatus("通知スケジュールを保存しました");
    } catch (e) {
      setStatus("エラー: " + e);
      throw e;
    }
  }

  // --- イベント通知設定 ---

  async function saveEventNotifConfig(config: EventNotificationConfig) {
    try {
      const json = JSON.stringify(config);
      await invoke("save_event_notification_config", { owner, repo, configJson: json });
      setEventNotifConfig(config);
      setStatus("イベント通知設定を保存しました");
    } catch (e) {
      setStatus("エラー: " + e);
      throw e;
    }
  }

  // --- ボード設定 ---

  async function saveBoardConfig(config: BoardConfig) {
    try {
      const json = JSON.stringify(config);
      await invoke("save_board_config", { owner, repo, config: json });
      setBoardConfig(config);
      setStatus("ボード設定を保存しました");
    } catch (e) {
      setStatus("エラー: " + e);
      throw e;
    }
  }

  // --- Discord Webhook ---

  async function setDiscordWebhook(webhookUrl: string) {
    try {
      const result = await invoke("set_discord_webhook", { owner, repo, webhookUrl });
      setStatus(result as string);
    } catch (e) {
      setStatus("エラー: " + e);
      throw e;
    }
  }

  async function loadDiscordWebhook(): Promise<string> {
    try {
      const result = await invoke("load_discord_webhook", { owner, repo });
      return result as string;
    } catch (e) {
      console.error("Discord Webhook読み込みエラー:", e);
      return "";
    }
  }

  async function testDiscordWebhook(webhookUrl: string) {
    try {
      const result = await invoke("test_discord_webhook", { webhookUrl });
      setStatus(result as string);
    } catch (e) {
      setStatus("Discordテスト送信エラー: " + e);
      throw e;
    }
  }

  // --- 派生データ ---

  const customLabels = labels.filter(
    (l) => l.name.startsWith("種別:") || l.name.startsWith("分野:") ||
           l.name.startsWith("状態:") || l.name.startsWith("優先:")
  );

  return {
    // 状態
    issues, closedIssues, labels, milestones, connected, status, setStatus,
    customLabels,
    // コラボレーター
    collaborators, loadCollaborators,
    // ロード
    loadAll, loadIssues, loadClosedIssues, loadLabels, loadMilestones, loadRoutines, loadToken,
    // Issue操作
    closeIssue, reopenIssue, promoteIssue, changeIssueStatus, assignToMe, createIssue, createMemo, updateIssue, updateIssueBody,
    // マイルストーン操作
    createMilestone, updateMilestone, closeMilestone, reopenMilestone,
    // ルーチン操作
    routines, saveRoutines,
    // コメント
    listComments, createComment,
    // ジャーナル
    generateJournal, getJournal, saveJournalNotes,
    // 認証・設定
    setToken, setupLabels, createLabel, updateLabel, deleteLabel,
    // リポジトリ設定
    owner, repo, setRepoConfig,
    // 通知
    sendNotification,
    notificationSchedules, saveNotificationSchedules, loadNotificationSchedules,
    // リマインダー
    reminders, addReminder, removeReminder, loadReminders,
    // Discord Webhook
    setDiscordWebhook, loadDiscordWebhook, testDiscordWebhook,
    // ボード設定
    boardConfig, saveBoardConfig, loadBoardConfig,
    // イベント通知
    eventNotifConfig, saveEventNotifConfig, loadEventNotifConfig,
    // プロジェクト管理
    projects, loadProjects, addProject, removeProject, switchProject, setProjectToken,
    // 現在のユーザー
    currentUser,
  };
}
