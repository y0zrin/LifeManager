import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { resolveResource } from "@tauri-apps/api/path";
import type { GitHubLabel, NotificationSchedule, RoutineSchedule, Project, EventNotificationConfig, EventType } from "../../lib/types";
import { EVENT_TYPE_LABELS } from "../../lib/types";
import { LabelBadge } from "../common/LabelBadge";

interface SettingsViewProps {
  connected: boolean;
  labels: GitHubLabel[];
  owner: string;
  repo: string;
  onSetToken: (token: string) => Promise<void>;
  onSetupLabels: () => Promise<void>;
  onSetRepoConfig: (owner: string, repo: string) => Promise<void>;
  onUpdateLabel: (currentName: string, newName: string, color: string, description: string) => Promise<void>;
  onDeleteLabel: (name: string) => Promise<void>;
  onCreateLabel: (name: string, color: string, description: string) => Promise<void>;
  notificationSchedules: NotificationSchedule[];
  onSaveNotificationSchedules: (schedules: NotificationSchedule[]) => Promise<void>;
  onSetDiscordWebhook: (webhookUrl: string) => Promise<void>;
  onLoadDiscordWebhook: () => Promise<string>;
  onTestDiscordWebhook: (webhookUrl: string) => Promise<void>;
  projects: Project[];
  onAddProject: (owner: string, repo: string, name: string, token?: string) => Promise<void>;
  onRemoveProject: (owner: string, repo: string) => Promise<void>;
  onSetProjectToken: (owner: string, repo: string, token: string) => Promise<void>;
  eventNotifConfig: EventNotificationConfig | null;
  onSaveEventNotifConfig: (config: EventNotificationConfig) => Promise<void>;
}

const weekdays = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const weekdayLabels: Record<string, string> = {
  mon: "月", tue: "火", wed: "水", thu: "木", fri: "金", sat: "土", sun: "日",
};
const notifyTypes: Record<string, string> = {
  today_tasks: "今日のタスク一覧",
  overdue: "期限超過チェック",
  summary: "全体サマリー",
  custom: "カスタムメッセージ",
};

type SettingsPane = "connection" | "labels" | "notifications" | "other";
const PANES: { key: SettingsPane; label: string }[] = [
  { key: "connection", label: "接続" },
  { key: "labels", label: "ラベル" },
  { key: "notifications", label: "通知" },
  { key: "other", label: "その他" },
];

export function SettingsView({ connected, labels, owner, repo, onSetToken, onSetupLabels, onSetRepoConfig, onUpdateLabel, onDeleteLabel, onCreateLabel, notificationSchedules, onSaveNotificationSchedules, onSetDiscordWebhook, onLoadDiscordWebhook, onTestDiscordWebhook, projects, onAddProject, onRemoveProject, onSetProjectToken, eventNotifConfig, onSaveEventNotifConfig }: SettingsViewProps) {
  const [activePane, setActivePane] = useState<SettingsPane>("connection");
  const [appVersion, setAppVersion] = useState("");
  const [tokenInput, setTokenInput] = useState("");
  const [ownerInput, setOwnerInput] = useState(owner);
  const [repoInput, setRepoInput] = useState(repo);
  const [discordWebhookInput, setDiscordWebhookInput] = useState("");
  const [discordConfigured, setDiscordConfigured] = useState(false);
  const [discordTesting, setDiscordTesting] = useState(false);

  // ラベル管理
  const [editingLabel, setEditingLabel] = useState<string | null>(null);
  const [editLabelName, setEditLabelName] = useState("");
  const [editLabelColor, setEditLabelColor] = useState("#000000");
  const [editLabelDesc, setEditLabelDesc] = useState("");
  const [labelSaving, setLabelSaving] = useState(false);
  const [deletingLabel, setDeletingLabel] = useState<string | null>(null);
  // 新規ラベル作成
  const [showNewLabelForm, setShowNewLabelForm] = useState(false);
  const [newLabelName, setNewLabelName] = useState("");
  const [newLabelColor, setNewLabelColor] = useState("#0E8A16");
  const [newLabelDesc, setNewLabelDesc] = useState("");

  // プロジェクト管理
  const [showAddProject, setShowAddProject] = useState(false);
  const [newProjOwner, setNewProjOwner] = useState("");
  const [newProjRepo, setNewProjRepo] = useState("");
  const [newProjName, setNewProjName] = useState("");
  const [newProjToken, setNewProjToken] = useState("");
  const [editingTokenProject, setEditingTokenProject] = useState<string | null>(null);
  const [editTokenValue, setEditTokenValue] = useState("");

  useEffect(() => {
    invoke("get_app_version").then((v) => setAppVersion(v as string)).catch(() => {});
  }, []);

  // Discord Webhook URLの読み込み（プロジェクト切り替え時にも再取得）
  useEffect(() => {
    async function loadWebhook() {
      try {
        const url = await onLoadDiscordWebhook();
        if (url) {
          setDiscordWebhookInput(url);
          setDiscordConfigured(true);
        } else {
          setDiscordWebhookInput("");
          setDiscordConfigured(false);
        }
      } catch {
        setDiscordWebhookInput("");
        setDiscordConfigured(false);
      }
    }
    loadWebhook();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, repo]);

  // 通知スケジュール
  const [showNotifForm, setShowNotifForm] = useState(false);
  const [notifSaving, setNotifSaving] = useState(false);
  const [notifName, setNotifName] = useState("");
  const [notifTime, setNotifTime] = useState("09:00");
  const [notifFrequency, setNotifFrequency] = useState("daily");
  const [notifDays, setNotifDays] = useState<string[]>([]);
  const [notifDay, setNotifDay] = useState("");
  const [notifType, setNotifType] = useState("today_tasks");
  const [notifMessage, setNotifMessage] = useState("");
  const [notifChannels, setNotifChannels] = useState<string[]>(["os"]);

  // フィードバック
  const [feedbackCategory, setFeedbackCategory] = useState<"bug" | "feature" | "other">("bug");
  const [feedbackTitle, setFeedbackTitle] = useState("");
  const [feedbackBody, setFeedbackBody] = useState("");

  // イベント通知設定
  const ALL_EVENT_TYPES: EventType[] = [
    "issue_created", "routine_created", "issue_closed", "issue_reopened", "status_changed",
    "comment_added", "todo_toggled", "issue_promoted", "issue_updated",
  ];
  const defaultEventConfig: EventNotificationConfig = {
    enabled: true,
    os_for_own_actions: false,
    events: Object.fromEntries(ALL_EVENT_TYPES.map((t) => [t, { enabled: true, channels: ["discord"] }])),
  };
  const [editingEventConfig, setEditingEventConfig] = useState<EventNotificationConfig>(
    eventNotifConfig || defaultEventConfig
  );
  useEffect(() => {
    if (eventNotifConfig) setEditingEventConfig(eventNotifConfig);
  }, [eventNotifConfig]);
  const eventConfigHasChanges = JSON.stringify(editingEventConfig) !== JSON.stringify(eventNotifConfig);

  function handleToggleEventEnabled(eventType: EventType) {
    setEditingEventConfig((prev) => {
      const event = prev.events[eventType] || { enabled: false, channels: ["discord"] };
      return { ...prev, events: { ...prev.events, [eventType]: { ...event, enabled: !event.enabled } } };
    });
  }

  function handleToggleEventChannel(eventType: EventType, channel: string) {
    setEditingEventConfig((prev) => {
      const event = prev.events[eventType] || { enabled: true, channels: [] };
      const channels = event.channels.includes(channel)
        ? event.channels.filter((c) => c !== channel)
        : [...event.channels, channel];
      return { ...prev, events: { ...prev.events, [eventType]: { ...event, channels } } };
    });
  }

  async function handleAddNotif() {
    const schedule: RoutineSchedule = {
      frequency: notifFrequency,
      time: notifTime,
      ...(notifFrequency === "daily" && notifDays.length > 0 ? { days: notifDays } : {}),
      ...(notifFrequency === "weekly" ? { day: notifDay } : {}),
      ...(notifFrequency === "monthly" ? { day: parseInt(notifDay) } : {}),
    };
    const newNotif: NotificationSchedule = {
      name: notifName,
      schedule,
      type: notifType,
      ...(notifType === "custom" && notifMessage ? { message: notifMessage } : {}),
      channels: [...notifChannels],
    };
    setNotifSaving(true);
    try {
      await onSaveNotificationSchedules([...notificationSchedules, newNotif]);
      setNotifName(""); setNotifTime("09:00"); setNotifFrequency("daily");
      setNotifDays([]); setNotifDay(""); setNotifType("today_tasks");
      setNotifMessage(""); setNotifChannels(["os"]); setShowNotifForm(false);
    } finally {
      setNotifSaving(false);
    }
  }

  async function handleDeleteNotif(index: number) {
    setNotifSaving(true);
    try {
      await onSaveNotificationSchedules(notificationSchedules.filter((_, i) => i !== index));
    } finally {
      setNotifSaving(false);
    }
  }

  async function handleSendFeedback() {
    if (!feedbackTitle.trim()) return;
    const prefix = feedbackCategory === "bug" ? "[バグ]" : feedbackCategory === "feature" ? "[機能要望]" : "[フィードバック]";
    const subject = `${prefix} ${feedbackTitle.trim()}`;
    const body = feedbackBody
      ? `${feedbackBody}\n\n---\nLife Manager v${appVersion}`
      : `Life Manager v${appVersion}`;
    const mailto = `mailto:lifemanagerforgit@gmail.com?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(mailto);
    setFeedbackTitle("");
    setFeedbackBody("");
  }

  async function handleSetToken() {
    if (!tokenInput.trim()) return;
    await onSetToken(tokenInput);
    setTokenInput("");
  }

  async function handleSetRepoConfig() {
    if (!ownerInput.trim() || !repoInput.trim()) return;
    await onSetRepoConfig(ownerInput.trim(), repoInput.trim());
  }

  return (
    <div className="content">
      <h2 style={{ fontSize: "var(--font-xl)", marginBottom: "var(--space-md)" }}>設定</h2>

      {/* ペインタブ */}
      <div className="settings-pane-tabs">
        {PANES.map((p) => (
          <button key={p.key}
            className={`settings-pane-tab${activePane === p.key ? " settings-pane-tab--active" : ""}`}
            onClick={() => setActivePane(p.key)}>
            {p.label}
          </button>
        ))}
      </div>

      {/* === 接続ペイン === */}
      {activePane === "connection" && <>

      {/* GitHubトークン */}
      <div className="form-card">
        <h3 className="settings-section-title" style={{ marginBottom: "var(--space-sm)" }}>GitHubトークン</h3>
        <div className="flex-row">
          <input type="password" value={tokenInput} onChange={(e) => setTokenInput(e.target.value)}
            placeholder="ghp_xxxxxxxxxxxx" className="input-full" />
          <button onClick={handleSetToken} className="btn-primary">設定</button>
        </div>
        <p className="settings-hint">
          {connected ? "✅ トークン設定済み（Keychainに保存）" : "❌ 未設定"}
        </p>
      </div>

      {/* リポジトリ設定 */}
      <div className="form-card">
        <h3 className="settings-section-title" style={{ marginBottom: "var(--space-sm)" }}>リポジトリ設定</h3>
        <div className="flex-row">
          <input type="text" value={ownerInput} onChange={(e) => setOwnerInput(e.target.value)}
            placeholder="Owner" className="input-full" />
          <span style={{ color: "var(--text-muted)" }}>/</span>
          <input type="text" value={repoInput} onChange={(e) => setRepoInput(e.target.value)}
            placeholder="Repo" className="input-full" />
          <button onClick={handleSetRepoConfig} className="btn-primary">保存</button>
        </div>
        <p className="settings-hint">
          現在: {owner}/{repo}（Keychainに保存）
        </p>
      </div>

      {/* プロジェクト管理 */}
      <div className="form-card">
        <div className="settings-section-header">
          <h3 className="settings-section-title">プロジェクト管理</h3>
          <button onClick={() => setShowAddProject(!showAddProject)} className="btn-sm">
            {showAddProject ? "×" : "+ 追加"}
          </button>
        </div>
        <p className="settings-hint" style={{ marginBottom: "var(--space-sm)" }}>
          複数のリポジトリをプロジェクトとして登録し、ヘッダーから切り替えできます。
        </p>

        {/* プロジェクト追加フォーム */}
        {showAddProject && (
          <div className="settings-form-inner">
            <div className="flex-row">
              <input value={newProjOwner} onChange={(e) => setNewProjOwner(e.target.value)}
                placeholder="Owner" className="input-full" />
              <span style={{ color: "var(--text-muted)" }}>/</span>
              <input value={newProjRepo} onChange={(e) => setNewProjRepo(e.target.value)}
                placeholder="Repo" className="input-full" />
            </div>
            <input value={newProjName} onChange={(e) => setNewProjName(e.target.value)}
              placeholder="表示名（任意、例: メインプロジェクト）" className="input-full" />
            <input type="password" value={newProjToken} onChange={(e) => setNewProjToken(e.target.value)}
              placeholder="トークン (ghp_xxx...)" className="input-full" />
            <p className="settings-hint--subtle" style={{ marginTop: "-4px" }}>
              未入力の場合はグローバルトークンを使用
            </p>
            <button
              onClick={async () => {
                if (!newProjOwner.trim() || !newProjRepo.trim()) return;
                try {
                  await onAddProject(newProjOwner.trim(), newProjRepo.trim(), newProjName.trim() || `${newProjOwner.trim()}/${newProjRepo.trim()}`, newProjToken.trim() || undefined);
                  setNewProjOwner(""); setNewProjRepo(""); setNewProjName(""); setNewProjToken(""); setShowAddProject(false);
                } catch {
                  // エラーはuseGitHub側でsetStatusに反映
                }
              }}
              className="btn-primary"
              style={{ alignSelf: "flex-start" }}
              disabled={!newProjOwner.trim() || !newProjRepo.trim()}
            >
              追加
            </button>
          </div>
        )}

        {/* プロジェクト一覧 */}
        <div className="settings-list">
          {projects.map((p) => (
            <div key={`${p.owner}/${p.repo}`}>
              <div className="settings-list-item">
                <span style={{ flex: 1, fontSize: "var(--font-md)", color: "var(--text-primary)" }}>
                  {p.name || `${p.owner}/${p.repo}`}
                </span>
                <span className="settings-hint--subtle">
                  {p.owner}/{p.repo}
                </span>
                <button className="btn-sm" style={{ color: "var(--accent-red)", fontSize: "var(--font-xs)" }}
                  onClick={() => onRemoveProject(p.owner, p.repo)}>
                  削除
                </button>
                <button className="btn-sm" style={{ fontSize: "var(--font-xs)" }}
                  onClick={() => {
                    if (editingTokenProject === `${p.owner}/${p.repo}`) {
                      setEditingTokenProject(null);
                    } else {
                      setEditingTokenProject(`${p.owner}/${p.repo}`);
                      setEditTokenValue("");
                    }
                  }}>
                  🔑
                </button>
              </div>
              {editingTokenProject === `${p.owner}/${p.repo}` && (
                <div className="flex-row" style={{ padding: "var(--space-xs) var(--space-sm)", marginBottom: "var(--space-xs)" }}>
                  <input type="password" value={editTokenValue} onChange={(e) => setEditTokenValue(e.target.value)}
                    placeholder="新しいトークン" className="input-full" style={{ flex: 1 }} />
                  <button className="btn-primary" style={{ fontSize: "var(--font-xs)" }}
                    disabled={!editTokenValue.trim()}
                    onClick={async () => {
                      await onSetProjectToken(p.owner, p.repo, editTokenValue.trim());
                      setEditingTokenProject(null);
                      setEditTokenValue("");
                    }}>
                    保存
                  </button>
                  <button className="btn-sm" style={{ fontSize: "var(--font-xs)" }}
                    onClick={() => setEditingTokenProject(null)}>
                    ×
                  </button>
                </div>
              )}
            </div>
          ))}
          {projects.length === 0 && (
            <p className="settings-hint--subtle">プロジェクトが登録されていません</p>
          )}
        </div>
      </div>

      </>}

      {/* === ラベルペイン === */}
      {activePane === "labels" && <>

      {/* ラベル管理 */}
      <div className="form-card">
        <div className="settings-section-header">
          <h3 className="settings-section-title">ラベル管理</h3>
          <div className="flex-row" style={{ gap: "6px" }}>
            <button onClick={() => setShowNewLabelForm(!showNewLabelForm)} className="btn-sm">
              {showNewLabelForm ? "×" : "+ 新規ラベル"}
            </button>
            <button onClick={onSetupLabels} className="btn-sm">ラベル一括作成</button>
          </div>
        </div>

        {/* 新規ラベル作成フォーム */}
        {showNewLabelForm && (
          <div className="settings-form-inner">
            <div className="flex-row">
              <input type="color" value={newLabelColor} onChange={(e) => setNewLabelColor(e.target.value)}
                className="color-picker-input" />
              <input value={newLabelName} onChange={(e) => setNewLabelName(e.target.value)}
                placeholder="ラベル名（例: 分野:趣味）" className="input-full" />
            </div>
            <input value={newLabelDesc} onChange={(e) => setNewLabelDesc(e.target.value)}
              placeholder="説明（任意）" className="input-full" />
            <button
              onClick={async () => {
                if (!newLabelName.trim()) return;
                setLabelSaving(true);
                try {
                  const color = newLabelColor.replace("#", "");
                  await onCreateLabel(newLabelName.trim(), color, newLabelDesc.trim());
                  setNewLabelName(""); setNewLabelColor("#0E8A16"); setNewLabelDesc(""); setShowNewLabelForm(false);
                } catch {
                  // エラーはuseGitHub側でsetStatusに反映
                } finally {
                  setLabelSaving(false);
                }
              }}
              className="btn-primary"
              style={{ alignSelf: "flex-start" }}
              disabled={!newLabelName.trim() || labelSaving}
            >
              {labelSaving ? "作成中..." : "作成"}
            </button>
          </div>
        )}

        {/* ラベル一覧 */}
        <div className="settings-list">
          {labels.map((l) => {
            const isEditing = editingLabel === l.name;
            const isDeleting = deletingLabel === l.name;

            if (isEditing) {
              return (
                <div key={l.name} className="settings-list-item--editing">
                  <div className="flex-row">
                    <input type="color" value={editLabelColor} onChange={(e) => setEditLabelColor(e.target.value)}
                      className="color-picker-input" />
                    <input value={editLabelName} onChange={(e) => setEditLabelName(e.target.value)}
                      className="input-full" style={{ fontSize: "var(--font-md)" }} />
                  </div>
                  <input value={editLabelDesc} onChange={(e) => setEditLabelDesc(e.target.value)}
                    placeholder="説明（任意）" className="input-full" style={{ fontSize: "var(--font-sm)" }} />
                  <div className="flex-row" style={{ gap: "6px" }}>
                    <button
                      onClick={async () => {
                        if (!editLabelName.trim()) return;
                        setLabelSaving(true);
                        try {
                          const color = editLabelColor.replace("#", "");
                          await onUpdateLabel(l.name, editLabelName.trim(), color, editLabelDesc.trim());
                          setEditingLabel(null);
                        } catch {
                          // エラーはuseGitHub側でsetStatusに反映
                        } finally {
                          setLabelSaving(false);
                        }
                      }}
                      className="btn-primary"
                      style={{ fontSize: "var(--font-sm)" }}
                      disabled={labelSaving}
                    >
                      {labelSaving ? "保存中..." : "保存"}
                    </button>
                    <button onClick={() => setEditingLabel(null)} className="btn-sm"
                      style={{ fontSize: "var(--font-sm)" }}>
                      キャンセル
                    </button>
                  </div>
                </div>
              );
            }

            return (
              <div key={l.name} className="settings-list-item" style={{ justifyContent: "space-between" }}>
                <LabelBadge name={l.name} color={l.color} />
                <div className="flex-row" style={{ gap: "var(--space-xs)" }}>
                  {isDeleting ? (
                    <>
                      <span style={{ fontSize: "var(--font-xs)", color: "var(--accent-red)", marginRight: "var(--space-xs)" }}>削除しますか？</span>
                      <button
                        onClick={async () => {
                          setLabelSaving(true);
                          try {
                            await onDeleteLabel(l.name);
                            setDeletingLabel(null);
                          } catch {
                            // エラーはuseGitHub側でsetStatusに反映
                          } finally {
                            setLabelSaving(false);
                          }
                        }}
                        className="btn-sm"
                        style={{ color: "var(--accent-red)", fontSize: "var(--font-xs)" }}
                        disabled={labelSaving}
                      >
                        {labelSaving ? "..." : "はい"}
                      </button>
                      <button onClick={() => setDeletingLabel(null)} className="btn-sm"
                        style={{ fontSize: "var(--font-xs)" }}>
                        いいえ
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        onClick={() => {
                          setEditingLabel(l.name);
                          setEditLabelName(l.name);
                          setEditLabelColor("#" + l.color);
                          setEditLabelDesc(l.description || "");
                        }}
                        className="btn-sm"
                        style={{ fontSize: "var(--font-xs)" }}
                      >
                        編集
                      </button>
                      <button onClick={() => setDeletingLabel(l.name)} className="btn-sm"
                        style={{ color: "var(--accent-red)", fontSize: "var(--font-xs)" }}>
                        削除
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
          {labels.length === 0 && (
            <p className="settings-hint--subtle">ラベルがありません</p>
          )}
        </div>
      </div>

      </>}

      {/* === 通知ペイン === */}
      {activePane === "notifications" && <>

      {/* Discord Webhook */}
      <div className="form-card">
        <h3 className="settings-section-title" style={{ marginBottom: "var(--space-xs)" }}>Discord Webhook通知</h3>
        <p style={{ fontSize: "var(--font-sm)", color: "var(--accent-blue)", marginBottom: "10px" }}>
          対象: <strong>{owner}/{repo}</strong>
          <span style={{ color: "var(--text-faint)", marginLeft: "6px" }}>（プロジェクトごとに個別設定）</span>
        </p>

        {/* ステータス表示 */}
        <div className={`status-banner ${discordConfigured ? "status-banner--success" : "status-banner--warning"}`} style={{ marginBottom: "10px" }}>
          <span style={{ fontSize: "var(--font-xl)" }}>{discordConfigured ? "✅" : "⚠️"}</span>
          <span>
            {discordConfigured
              ? "Webhook設定済み — イベント通知がDiscordに送信されます"
              : "Webhook未設定 — Discord通知を使うにはWebhook URLを登録してください"}
          </span>
        </div>

        <div className="flex-row">
          <input type="text" value={discordWebhookInput} onChange={(e) => setDiscordWebhookInput(e.target.value)}
            placeholder="https://discord.com/api/webhooks/..." className="input-full" />
          <button
            onClick={async () => {
              try {
                await onSetDiscordWebhook(discordWebhookInput.trim());
                setDiscordConfigured(!!discordWebhookInput.trim());
              } catch {
                // エラーはuseGitHub側でsetStatusに反映
              }
            }}
            className="btn-primary"
          >
            {discordWebhookInput.trim() ? "保存" : "解除"}
          </button>
          <button
            onClick={async () => {
              if (!discordWebhookInput.trim()) return;
              setDiscordTesting(true);
              try {
                await onTestDiscordWebhook(discordWebhookInput.trim());
              } catch {
                // エラーはuseGitHub側でsetStatusに反映
              } finally {
                setDiscordTesting(false);
              }
            }}
            className="btn-sm"
            disabled={discordTesting || !discordWebhookInput.trim()}
          >
            {discordTesting ? "送信中..." : "テスト送信"}
          </button>
        </div>
        <details style={{ marginTop: "10px" }}>
          <summary style={{ fontSize: "var(--font-xs)", color: "var(--text-muted)", cursor: "pointer" }}>
            Webhook URLの取得方法
          </summary>
          <ol style={{ fontSize: "var(--font-xs)", color: "var(--text-muted)", lineHeight: 1.8, paddingLeft: "18px", marginTop: "6px" }}>
            <li>Discordでサーバーの「サーバー設定」を開く</li>
            <li>「連携サービス」→「ウェブフック」を選択</li>
            <li>「新しいウェブフック」を作成し、通知先チャンネルを選択</li>
            <li>「ウェブフックURLをコピー」してここに貼り付け</li>
          </ol>
        </details>
      </div>

      {/* 通知スケジュール */}
      <div className="form-card">
        <div className="settings-section-header">
          <h3 className="settings-section-title">通知スケジュール</h3>
          <button onClick={() => setShowNotifForm(!showNotifForm)} className="btn-sm">
            {showNotifForm ? "×" : "+ 追加"}
          </button>
        </div>

        {showNotifForm && (
          <div className="settings-form-inner">
            <input value={notifName} onChange={(e) => setNotifName(e.target.value)}
              placeholder="通知名（例: 朝のタスク確認）" className="input-full" />
            <div className="flex-row flex-wrap" style={{ gap: "6px" }}>
              <select value={notifFrequency} onChange={(e) => setNotifFrequency(e.target.value)} className="select-sm">
                <option value="daily">毎日</option>
                <option value="weekly">毎週</option>
                <option value="monthly">毎月</option>
              </select>
              <input type="time" value={notifTime} onChange={(e) => setNotifTime(e.target.value)}
                className="input-full" style={{ maxWidth: "120px" }} />
            </div>
            {notifFrequency === "daily" && (
              <div className="flex-row flex-wrap gap-xs">
                {weekdays.map((wd) => (
                  <label key={wd} style={{ fontSize: "var(--font-sm)", display: "flex", alignItems: "center", gap: "2px" }}>
                    <input type="checkbox" checked={notifDays.includes(wd)}
                      onChange={(e) => {
                        if (e.target.checked) setNotifDays([...notifDays, wd]);
                        else setNotifDays(notifDays.filter((d) => d !== wd));
                      }}
                    />
                    {weekdayLabels[wd]}
                  </label>
                ))}
                <span className="settings-hint--subtle">（未選択＝毎日）</span>
              </div>
            )}
            {notifFrequency === "weekly" && (
              <select value={notifDay} onChange={(e) => setNotifDay(e.target.value)} className="select-sm">
                <option value="">曜日を選択...</option>
                {weekdays.map((wd) => (
                  <option key={wd} value={wd}>{weekdayLabels[wd]}曜日</option>
                ))}
              </select>
            )}
            {notifFrequency === "monthly" && (
              <input type="number" value={notifDay} onChange={(e) => setNotifDay(e.target.value)}
                placeholder="日（1-31）" className="input-full" style={{ maxWidth: "120px" }} min="1" max="31" />
            )}
            <select value={notifType} onChange={(e) => setNotifType(e.target.value)} className="select-sm">
              {Object.entries(notifyTypes).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
            {notifType === "custom" && (
              <input value={notifMessage} onChange={(e) => setNotifMessage(e.target.value)}
                placeholder="通知メッセージ" className="input-full" />
            )}
            <div className="flex-row">
              <span style={{ fontSize: "var(--font-sm)", color: "var(--text-muted)" }}>通知先:</span>
              <label style={{ fontSize: "var(--font-sm)", display: "flex", alignItems: "center", gap: "2px" }}>
                <input type="checkbox" checked={notifChannels.includes("os")}
                  onChange={(e) => {
                    if (e.target.checked) setNotifChannels([...notifChannels, "os"]);
                    else setNotifChannels(notifChannels.filter((c) => c !== "os"));
                  }} />
                OS通知
              </label>
              <label style={{ fontSize: "var(--font-sm)", display: "flex", alignItems: "center", gap: "2px" }}>
                <input type="checkbox" checked={notifChannels.includes("discord")}
                  onChange={(e) => {
                    if (e.target.checked) setNotifChannels([...notifChannels, "discord"]);
                    else setNotifChannels(notifChannels.filter((c) => c !== "discord"));
                  }} />
                Discord
              </label>
            </div>
            <button onClick={handleAddNotif} className="btn-primary" style={{ alignSelf: "flex-start" }}
              disabled={!notifName || notifChannels.length === 0 || notifSaving}>
              {notifSaving ? "保存中..." : "追加"}
            </button>
          </div>
        )}

        {notificationSchedules.map((notif, index) => {
          const scheduleStr = notif.schedule.frequency === "daily"
            ? `毎日${notif.schedule.days ? ` (${notif.schedule.days.map((d) => weekdayLabels[d] || d).join("")})` : ""}`
            : notif.schedule.frequency === "weekly"
            ? `毎週${weekdayLabels[String(notif.schedule.day)] || notif.schedule.day}曜日`
            : `毎月${notif.schedule.day}日`;
          return (
            <div key={index} className="settings-list-item" style={{ justifyContent: "space-between", marginBottom: "6px" }}>
              <div>
                <strong style={{ fontSize: "var(--font-md)" }}>{notif.name}</strong>
                <span style={{ color: "var(--text-muted)", fontSize: "var(--font-xs)", marginLeft: "var(--space-sm)" }}>
                  {scheduleStr} {notif.schedule.time}
                </span>
                <span style={{ color: "var(--accent-blue)", fontSize: "var(--font-xs)", marginLeft: "var(--space-sm)" }}>
                  {notifyTypes[notif.type] || notif.type}
                </span>
                <span style={{ color: "var(--text-faint)", fontSize: "var(--font-xs)", marginLeft: "6px" }}>
                  [{notif.channels.join(", ")}]
                </span>
              </div>
              <button className="btn-sm" onClick={() => handleDeleteNotif(index)} disabled={notifSaving}
                style={{ color: "var(--accent-red)", fontSize: "var(--font-xs)" }}>削除</button>
            </div>
          );
        })}
        {notificationSchedules.length === 0 && !showNotifForm && (
          <p className="settings-hint--subtle">通知スケジュールが設定されていません</p>
        )}
      </div>

      {/* イベント通知設定 */}
      <div className="form-card">
        <div className="settings-section-header" style={{ marginBottom: "var(--space-md)" }}>
          <h3 className="settings-section-title">イベント通知</h3>
          <div className="flex-row">
            {eventConfigHasChanges && (
              <button onClick={() => onSaveEventNotifConfig(editingEventConfig)} className="btn-primary"
                style={{ fontSize: "var(--font-sm)" }}>
                保存
              </button>
            )}
            <label style={{ fontSize: "var(--font-sm)", color: "var(--text-muted)", display: "flex", alignItems: "center", gap: "var(--space-xs)" }}>
              <input
                type="checkbox"
                checked={editingEventConfig.enabled}
                onChange={() => setEditingEventConfig((prev) => ({ ...prev, enabled: !prev.enabled }))}
              />
              有効
            </label>
          </div>
        </div>

        {editingEventConfig.enabled && (
          <>
            {!discordConfigured && (
              <div className="status-banner status-banner--warning" style={{ marginBottom: "10px" }}>
                <span style={{ fontSize: "var(--font-lg)" }}>⚠️</span>
                <span style={{ fontSize: "var(--font-xs)" }}>
                  Discord Webhookが未設定のため、Discord通知は送信されません。上のセクションで設定してください。
                </span>
              </div>
            )}
            <label style={{ fontSize: "var(--font-sm)", color: "var(--text-muted)", display: "flex", alignItems: "center", gap: "var(--space-xs)", marginBottom: "10px" }}>
              <input
                type="checkbox"
                checked={editingEventConfig.os_for_own_actions}
                onChange={() => setEditingEventConfig((prev) => ({ ...prev, os_for_own_actions: !prev.os_for_own_actions }))}
              />
              自分の操作でもOS通知を送信
            </label>

            <div className="settings-list">
              {/* ヘッダー行 */}
              <div className="settings-event-header">
                <span className="settings-event-label">イベント</span>
                <span className="settings-event-cell">有効</span>
                <span className="settings-event-cell">OS</span>
                <span className="settings-event-cell--wide">Discord</span>
              </div>
              {ALL_EVENT_TYPES.map((eventType) => {
                const event = editingEventConfig.events[eventType] || { enabled: false, channels: [] };
                return (
                  <div key={eventType} className="settings-event-row"
                    style={{ opacity: event.enabled ? 1 : 0.5 }}>
                    <span className="settings-event-label">
                      {EVENT_TYPE_LABELS[eventType]}
                    </span>
                    <span className="settings-event-cell">
                      <input type="checkbox" checked={event.enabled} onChange={() => handleToggleEventEnabled(eventType)} />
                    </span>
                    <span className="settings-event-cell">
                      <input type="checkbox" checked={event.channels.includes("os")} onChange={() => handleToggleEventChannel(eventType, "os")}
                        disabled={!event.enabled} />
                    </span>
                    <span className="settings-event-cell--wide">
                      <input type="checkbox" checked={event.channels.includes("discord")} onChange={() => handleToggleEventChannel(eventType, "discord")}
                        disabled={!event.enabled} />
                    </span>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      </>}

      {/* === その他ペイン === */}
      {activePane === "other" && <>

      {/* フィードバック */}
      <div className="form-card">
          <div className="settings-section-header">
            <h3 className="settings-section-title">フィードバック</h3>
          </div>
          <p className="settings-hint" style={{ marginBottom: "var(--space-sm)" }}>
            バグ報告や機能要望をメールで送信できます。
          </p>
          <div className="flex-row" style={{ gap: "var(--space-xs)", marginBottom: "var(--space-sm)" }}>
            {(["bug", "feature", "other"] as const).map((cat) => {
              const catLabel = cat === "bug" ? "バグ報告" : cat === "feature" ? "機能要望" : "その他";
              return (
                <button key={cat} className={feedbackCategory === cat ? "btn-primary" : "btn-sm"}
                  onClick={() => setFeedbackCategory(cat)}
                  style={{ fontSize: "var(--font-sm)" }}>
                  {catLabel}
                </button>
              );
            })}
          </div>
          <input value={feedbackTitle} onChange={(e) => setFeedbackTitle(e.target.value)}
            placeholder="タイトル" className="input-full" style={{ marginBottom: "var(--space-xs)" }} />
          <textarea value={feedbackBody} onChange={(e) => setFeedbackBody(e.target.value)}
            placeholder="詳細（任意）" className="textarea-full" rows={3}
            style={{ marginBottom: "var(--space-sm)" }} />
          <button onClick={handleSendFeedback} className="btn-primary"
            disabled={!feedbackTitle.trim()}
            style={{ alignSelf: "flex-start" }}>
            メールで送信
          </button>
        </div>

      {/* バージョン・マニュアル */}
      <div style={{ textAlign: "center", marginTop: "var(--space-lg)" }}>
        <button
          className="btn-sm"
          onClick={async () => {
            try {
              const path = await resolveResource("resources/manual.pdf");
              await openPath(path);
            } catch {
              // PDFが見つからない場合はGitHubのREADMEを開く
              const { openUrl } = await import("@tauri-apps/plugin-opener");
              await openUrl("https://github.com/y0zrin/LifeManager/blob/main/README.md");
            }
          }}
          style={{ fontSize: "var(--font-xs)" }}
        >
          マニュアルを開く
        </button>
        {appVersion && (
          <p style={{ fontSize: "var(--font-xs)", color: "var(--text-faint)", marginTop: "var(--space-sm)" }}>
            Life Manager v{appVersion}
          </p>
        )}
      </div>

      </>}
    </div>
  );
}
