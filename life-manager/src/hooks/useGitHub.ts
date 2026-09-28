import { useState, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { CloseReason, GitHubComment, GitHubIssue, GitHubLabel, GitHubMilestone, GitHubUser, NotificationSchedule, Reminder, Routine, BoardConfig, Project, EventNotificationConfig, EventNotice, EventType, JournalResult, TimelineEvent } from "../lib/types";
import { issueRef } from "../lib/issueRef";
import { adjustSummary, isSameRepo, issueApiUrl, parseIssueApiUrl } from "../lib/subIssues";

/** つながらないときの変更は送信待ちに並ぶ（結果に _pending が付く）。そのときに状態の表示に添える言葉 */
const PENDING_NOTE = "（未送信。つながったら GitHub に送ります）";

function isPending(result: unknown): boolean {
  try {
    return !!JSON.parse(result as string)?._pending;
  } catch {
    return false;
  }
}

/** 設定の保存の結果（バックエンドが返す言葉）が、送信待ちに並んだことを表しているか */
function pendingNote(result: unknown): string {
  return String(result).includes("未送信") ? PENDING_NOTE : "";
}

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

  const reloadCached = useCallback(async () => {
    if (!owner || !repo) return;
    try {
      const [open, closed] = await Promise.all([
        invoke("list_issues", { owner, repo, issueState: "open", cached: true }),
        invoke("list_issues", { owner, repo, issueState: "closed", cached: true }),
      ]);
      setIssues(JSON.parse(open as string));
      setClosedIssues(JSON.parse(closed as string));
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
      // リポジトリごとにトークンが違うことがあるので、どのリポジトリで使うかも渡す（つながらないときの写しに使う）
      const result = await invoke("get_current_user", { owner: owner || null, repo: repo || null });
      const user = JSON.parse(result as string);
      setCurrentUser(user.login || "");
    } catch { /* ignore */ }
  }, [owner, repo]);

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
      routine_created: { enabled: true, channels: ["os", "discord"] },
      issue_closed: { enabled: true, channels: ["discord"] },
      issue_reopened: { enabled: true, channels: ["discord"] },
      status_changed: { enabled: true, channels: ["discord"] },
      comment_added: { enabled: true, channels: ["discord"] },
      todo_toggled: { enabled: true, channels: ["discord"] },
      issue_promoted: { enabled: true, channels: ["discord"] },
      issue_updated: { enabled: true, channels: ["discord"] },
    },
  };

  /**
   * 操作と一緒にバックエンドへ渡すお知らせ（Discord・OS）。GitHub に送れたときに出る（つながらないときは、つながって送れたとき）。
   * message の「{issue}」は送れたあとの番号（#12）になり、Issue へのリンクが付く
   */
  function eventNotice(eventType: EventType, message: string): EventNotice | null {
    const config = eventNotifConfig ?? defaultEventNotifConfig;
    if (!config.enabled) return null;
    // 保存済み設定に未登録のイベントタイプはデフォルトにフォールバック
    const event = config.events?.[eventType] ?? defaultEventNotifConfig.events[eventType];
    if (!event?.enabled || !event.channels?.length) return null;
    // 自分の操作時はOS通知をスキップ（os_for_own_actionsがfalseの場合）
    const channels = event.channels.filter(ch => ch !== "os" || config.os_for_own_actions);
    return channels.length > 0 ? { message, channels } : null;
  }

  // --- Issue操作 ---

  /** Issue を閉じる。reason で閉じ方（完了・予定なし・重複）を選べる。重複なら、元の Issue も渡す */
  async function closeIssue(n: number, reason?: CloseReason, duplicateOf?: GitHubIssue) {
    try {
      const closedIssue = issues.find((i) => i.number === n);
      const issueTitle = closedIssue?.title || issueRef(n);
      if (reason === "duplicate" && !duplicateOf?.id) {
        throw new Error("元の Issue がまだ GitHub にないので、重複として閉じられません");
      }
      const how = reason === "not_planned" ? "を予定なしとして閉じました" : reason === "duplicate" ? `を ${issueRef(duplicateOf!.number)} の重複として閉じました` : "を完了";
      const result = await invoke("update_issue", {
        owner, repo, issueNumber: n,
        title: null, body: null, issueState: "closed", labels: null, milestone: null, assignees: null,
        stateReason: reason ?? null,
        duplicateIssueId: reason === "duplicate" ? duplicateOf!.id : null,
        notice: eventNotice("issue_closed", `✅ {issue} ${issueTitle} ${how}`),
      });
      const pending = isPending(result);
      setStatus(`${issueRef(n)} ${how === "を完了" ? "完了" : how.slice(1)}${pending ? PENDING_NOTE : ""}`);
      // 楽観的更新: openから除去し、closedに追加（副作用をupdater外に分離）
      setIssues((prev) => prev.filter((i) => i.number !== n));
      if (closedIssue) {
        setClosedIssues((prev) => [{ ...closedIssue, state: "closed", state_reason: reason ?? "completed" }, ...prev]);
      }
      adjustParentOf(closedIssue, 1);
    } catch (e) {
      setStatus("エラー: " + e);
      await loadIssues();
    }
  }

  async function reopenIssue(n: number) {
    try {
      const reopenedIssue = closedIssues.find((i) => i.number === n);
      const issueTitle = reopenedIssue?.title || issueRef(n);
      const result = await invoke("update_issue", {
        owner, repo, issueNumber: n,
        title: null, body: null, issueState: "open", labels: null, milestone: null, assignees: null,
        notice: eventNotice("issue_reopened", `🔄 {issue} ${issueTitle} を再開`),
      });
      const pending = isPending(result);
      setStatus(`${issueRef(n)} 再開${pending ? PENDING_NOTE : ""}`);
      // 楽観的更新: closedから除去し、openに追加（副作用をupdater外に分離）
      setClosedIssues((prev) => prev.filter((i) => i.number !== n));
      if (reopenedIssue) {
        setIssues((prev) => [{ ...reopenedIssue, state: "open" }, ...prev]);
      }
      adjustParentOf(reopenedIssue, -1);
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
      const result = await invoke("update_issue", {
        owner, repo, issueNumber: n,
        title: null, body: null, issueState: null, labels: newLabels, milestone: null, assignees: null,
        notice: eventNotice("issue_promoted", `⬆ {issue} ${issue.title} をイシューに昇華`),
      });
      const pending = isPending(result);
      setStatus(`${issueRef(n)} をイシューに昇華${pending ? PENDING_NOTE : ""}`);
      // 楽観的更新: ラベルをローカルで更新
      const updatedLabelObjs = issue.labels
        .filter((l) => l.name !== "種別:メモ")
        .concat([labels.find((l) => l.name === "種別:イシュー") || { name: "種別:イシュー", color: "0E8A16" }]);
      setIssues((prev) =>
        prev.map((i) => i.number === n ? { ...i, labels: updatedLabelObjs } : i)
      );
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
      const result = await invoke("update_issue", {
        owner, repo, issueNumber: n,
        title: null, body: null, issueState: null, labels: null, milestone: null, assignees: newAssignees,
      });
      setStatus(`${issueRef(n)} → 自分に担当割り当て${isPending(result) ? PENDING_NOTE : ""}`);
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
      const statusName = newStatusLabel ? newStatusLabel.split(":")[1] : "未分類";
      const result = await invoke("update_issue", {
        owner, repo, issueNumber: n,
        title: null, body: null, issueState: null, labels: newLabelNames, milestone: null, assignees: null,
        notice: eventNotice("status_changed", `🔀 {issue} ${issue.title} → ${statusName}`),
      });
      const pending = isPending(result);
      setStatus(`${issueRef(n)} → ${newStatusLabel}${pending ? PENDING_NOTE : ""}`);
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
        notice: eventNotice("issue_created", `📝 {issue} ${title} を作成`),
      });
      const pending = isPending(result);
      setStatus(`Issueを作成しました${pending ? PENDING_NOTE : ""}`);
      // 楽観的更新: APIレスポンスの Issue をリストに即追加（送信待ちなら仮の番号）
      let issueNumber = 0;
      try {
        const newIssue = JSON.parse(result as string) as GitHubIssue;
        issueNumber = newIssue.number;
        setIssues((prev) => [newIssue, ...prev.filter((i) => i.number !== newIssue.number)]);
      } catch {
        await loadIssues();
      }
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
        notice: eventNotice("issue_created", `📝 {issue} ${text} をメモ投入`),
      });
      const pending = isPending(result);
      setStatus(`メモを投入しました${pending ? PENDING_NOTE : ""}`);
      // 楽観的更新: APIレスポンスの Issue をリストに即追加（送信待ちなら仮の番号）
      try {
        const newIssue = JSON.parse(result as string) as GitHubIssue;
        setIssues((prev) => [newIssue, ...prev.filter((i) => i.number !== newIssue.number)]);
      } catch {
        await loadIssues();
      }
    } catch (e) {
      setStatus("エラー: " + e);
      throw e;
    }
  }

  // --- タスクトグル用の本文更新（ローカル即時反映） ---

  async function updateIssueBody(issueNumber: number, newBody: string) {
    try {
      // Todo進捗のお知らせ
      const todoDone = (newBody.match(/- \[x\]/g) || []).length;
      const todoTotal = (newBody.match(/- \[[ x]\]/g) || []).length;
      const issueTitle = [...issues, ...closedIssues].find((i) => i.number === issueNumber)?.title || issueRef(issueNumber);
      const result = await invoke("update_issue", {
        owner, repo, issueNumber,
        title: null, body: newBody, issueState: null, labels: null, milestone: null, assignees: null,
        notice: todoTotal > 0 ? eventNotice("todo_toggled", `☑ {issue} ${issueTitle} ${todoDone}/${todoTotal}完了`) : null,
      });
      const pending = isPending(result);
      if (pending) setStatus(`${issueRef(issueNumber)} の本文を変更しました${PENDING_NOTE}`);
      // ローカルのissue一覧も即座に更新して再レンダリングに反映
      setIssues((prev) =>
        prev.map((i) => i.number === issueNumber ? { ...i, body: newBody } : i)
      );
      setClosedIssues((prev) =>
        prev.map((i) => i.number === issueNumber ? { ...i, body: newBody } : i)
      );
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
      const current = [...issues, ...closedIssues].find((i) => i.number === n);
      const title = updates.title ?? current?.title ?? issueRef(n);
      const result = await invoke("update_issue", {
        owner, repo, issueNumber: n,
        title: updates.title ?? null,
        body: updates.body ?? null,
        issueState: null,
        labels: updates.labels ?? null,
        milestone: updates.milestone !== undefined ? (updates.milestone ?? 0) : null,
        assignees: updates.assignees ?? null,
        notice: eventNotice("issue_updated", `✏ {issue} ${title} を更新`),
      });
      const pending = isPending(result);
      setStatus(`${issueRef(n)} を更新しました${pending ? PENDING_NOTE : ""}`);
      // 楽観的更新: APIレスポンスでローカルを即反映
      try {
        const updated = JSON.parse(result as string) as GitHubIssue;
        // 手元の写しにない Issue を送信待ちにしたときは、中身のない結果が返るので読み直す
        if (typeof updated.title !== "string") throw new Error("Issue の内容がありません");
        setIssues((prev) =>
          prev.map((i) => i.number === n ? updated : i)
        );
        setClosedIssues((prev) =>
          prev.map((i) => i.number === n ? updated : i)
        );
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
      const issueTitle = [...issues, ...closedIssues].find((i) => i.number === issueNumber)?.title || issueRef(issueNumber);
      const result = await invoke("create_comment", {
        owner, repo, issueNumber, body,
        notice: eventNotice("comment_added", `💬 {issue} ${issueTitle} にコメント`),
      });
      setStatus(`${issueRef(issueNumber)} にコメントを追加${isPending(result) ? PENDING_NOTE : ""}`);
    } catch (e) {
      setStatus("エラー: " + e);
      throw e;
    }
  }

  // --- 変更の履歴（タイムライン）。つながっているときだけ ---

  async function listTimeline(issueNumber: number): Promise<TimelineEvent[]> {
    const result = await invoke("list_issue_timeline", { owner, repo, issueNumber });
    return JSON.parse(result as string);
  }

  // --- サブイシュー（親子）。つながっているときだけ使える ---

  /** 手元の一覧（開いている・閉じた）の Issue を書き換える */
  function patchIssue(n: number, change: (i: GitHubIssue) => GitHubIssue) {
    setIssues((prev) => prev.map((i) => (i.number === n ? change(i) : i)));
    setClosedIssues((prev) => prev.map((i) => (i.number === n ? change(i) : i)));
  }

  /** 子を閉じた・開き直したら、同じリポジトリの親の「完了した子の数」も合わせる */
  function adjustParentOf(child: GitHubIssue | undefined, completed: number) {
    const parent = parseIssueApiUrl(child?.parent_issue_url);
    if (parent && isSameRepo(parent, owner, repo)) {
      patchIssue(parent.number, (i) => ({ ...i, sub_issues_summary: adjustSummary(i.sub_issues_summary, 0, completed) }));
    }
  }

  async function listSubIssues(parent: number): Promise<GitHubIssue[]> {
    const result = await invoke("list_sub_issues", { owner, repo, issueNumber: parent });
    return JSON.parse(result as string);
  }

  /** 子にする（ほかの親の子なら、付け替える） */
  async function addSubIssue(parent: number, child: GitHubIssue) {
    if (!child.id || child.number <= 0) {
      throw new Error(`${issueRef(child.number)} はまだ GitHub に送っていないので、子にできません`);
    }
    const oldParent = parseIssueApiUrl(child.parent_issue_url);
    await invoke("add_sub_issue", { owner, repo, issueNumber: parent, subIssueId: child.id, replaceParent: !!oldParent });
    const done = child.state === "closed" ? 1 : 0;
    if (oldParent && isSameRepo(oldParent, owner, repo)) {
      patchIssue(oldParent.number, (i) => ({ ...i, sub_issues_summary: adjustSummary(i.sub_issues_summary, -1, -done) }));
    }
    patchIssue(parent, (i) => ({ ...i, sub_issues_summary: adjustSummary(i.sub_issues_summary, 1, done) }));
    patchIssue(child.number, (i) => ({ ...i, parent_issue_url: issueApiUrl(owner, repo, parent) }));
    setStatus(`${issueRef(child.number)} を ${issueRef(parent)} の子にしました`);
  }

  /** 子の Issue を作って、つなぐ。ラベルは「種別:イシュー」「状態:未整理」と親の「分野」、マイルストーンは親と同じ */
  async function createSubIssue(parent: GitHubIssue, title: string): Promise<GitHubIssue> {
    const labelNames = ["種別:イシュー", "状態:未整理", ...parent.labels.map((l) => l.name).filter((n) => n.startsWith("分野:"))];
    const result = await invoke("create_issue", {
      owner, repo,
      title, body: "",
      labels: labelNames,
      milestone: parent.milestone?.number ?? null,
      assignees: null,
      notice: eventNotice("issue_created", `📝 {issue} ${title} を作成`),
    });
    const created = JSON.parse(result as string) as GitHubIssue;
    setIssues((prev) => [created, ...prev.filter((i) => i.number !== created.number)]);
    if (isPending(result) || !created.id) {
      throw new Error(`${title} は作りましたが、まだ GitHub に送れていないので、子にはつなげていません。送れたあとで「既存の Issue をつなぐ」からつないでください`);
    }
    await addSubIssue(parent.number, created);
    return { ...created, parent_issue_url: issueApiUrl(owner, repo, parent.number) };
  }

  /** 子から外す（Issue は消えない） */
  async function removeSubIssue(parent: number, child: GitHubIssue) {
    if (!child.id) throw new Error(`${issueRef(child.number)} の id が分からないので、外せません`);
    await invoke("remove_sub_issue", { owner, repo, issueNumber: parent, subIssueId: child.id });
    patchIssue(parent, (i) => ({ ...i, sub_issues_summary: adjustSummary(i.sub_issues_summary, -1, child.state === "closed" ? -1 : 0) }));
    patchIssue(child.number, (i) => ({ ...i, parent_issue_url: null }));
    setStatus(`${issueRef(child.number)} を ${issueRef(parent)} の子から外しました`);
  }

  // --- ルーチン操作 ---

  async function saveRoutines(routinesList: Routine[]) {
    try {
      const json = JSON.stringify(routinesList);
      const result = await invoke("save_routines", { owner, repo, routines: json });
      setRoutines(routinesList);
      setStatus(result as string);
    } catch (e) {
      setStatus("エラー: " + e);
      throw e;
    }
  }

  // --- ジャーナル ---

  async function generateJournal(date: string): Promise<string> {
    try {
      const result = await invoke<JournalResult>("generate_journal", { owner, repo, date });
      setStatus(result.pending ? `つながっていないので、${date}のジャーナルはつながったら作ります` : `${date}のジャーナルを生成しました`);
      return result.content;
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
      const result = await invoke<JournalResult>("save_journal_notes", { owner, repo, date, notes });
      setStatus(`${date}のノートを保存しました${result.pending ? PENDING_NOTE : ""}`);
      return result.content;
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
      const result = await invoke("save_reminders", { owner, repo, reminders: json });
      await invoke("refresh_scheduler");
      setReminders(updated);
      setStatus(`${issueRef(issueNumber)} のリマインダーを設定しました${pendingNote(result)}`);
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
      const result = await invoke("save_reminders", { owner, repo, reminders: json });
      await invoke("refresh_scheduler");
      setReminders(updated);
      setStatus(`リマインダーを削除しました${pendingNote(result)}`);
    } catch (e) {
      setStatus("エラー: " + e);
      throw e;
    }
  }

  // --- 通知スケジュール ---

  async function saveNotificationSchedules(schedules: NotificationSchedule[]) {
    try {
      const json = JSON.stringify(schedules);
      const result = await invoke("save_notification_schedules", { owner, repo, schedules: json });
      setNotificationSchedules(schedules);
      setStatus(result as string);
    } catch (e) {
      setStatus("エラー: " + e);
      throw e;
    }
  }

  // --- イベント通知設定 ---

  async function saveEventNotifConfig(config: EventNotificationConfig) {
    try {
      const json = JSON.stringify(config);
      const result = await invoke("save_event_notification_config", { owner, repo, configJson: json });
      setEventNotifConfig(config);
      setStatus(result as string);
    } catch (e) {
      setStatus("エラー: " + e);
      throw e;
    }
  }

  // --- ボード設定 ---

  async function saveBoardConfig(config: BoardConfig) {
    try {
      const json = JSON.stringify(config);
      const result = await invoke("save_board_config", { owner, repo, config: json });
      setBoardConfig(config);
      setStatus(result as string);
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
    loadAll, loadIssues, loadClosedIssues, reloadCached, loadLabels, loadMilestones, loadRoutines, loadToken,
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
    // サブイシュー（親子）・変更の履歴
    listSubIssues, addSubIssue, createSubIssue, removeSubIssue, listTimeline,
    // プロジェクト管理
    projects, loadProjects, addProject, removeProject, switchProject, setProjectToken,
    // 現在のユーザー
    currentUser,
  };
}
