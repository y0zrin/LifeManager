import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { resolveResource } from "@tauri-apps/api/path";
import type { GitHubLabel, NotificationSchedule, RoutineSchedule, Project, EventNotificationConfig, EventType, BoardConfig } from "../../lib/types";
import { EVENT_TYPE_LABELS } from "../../lib/types";
import { isMobile } from "../../lib/platform";
import type { DisplaySettings, MemoButtonPosition, SidebarPosition } from "../../hooks/useDisplaySettings";
import { DAYS_PER_PERSON_MONTH, HOURS_PER_DAY, UNITS, UNIT_KEYS, formatEstimate, type EstimateUnit } from "../../lib/estimate";
import { LabelBadge } from "../common/LabelBadge";
import { GitInfoCard } from "../common/GitInfoCard";
import { TokenSettings } from "../common/TokenSettings";
import { TeamPane } from "../common/TeamPane";
import { BoardColumnsSetting } from "../common/BoardColumnsSetting";
import { THEMES, type Theme } from "../../lib/theme";
import { BAR_COLOR_LABELS, DEFAULT_BAR_COLORS, type GanttBarColors } from "../../lib/ganttTypes";
import { SETUP_ITEMS, loadSetupHidden, saveSetupHidden } from "../../lib/actions";
import { stepDirection, withTransition } from "../../lib/motion";

interface SettingsViewProps {
  labels: GitHubLabel[];
  owner: string;
  repo: string;
  onSetupLabels: () => Promise<void>;
  onUpdateLabel: (currentName: string, newName: string, color: string, description: string) => Promise<void>;
  onDeleteLabel: (name: string) => Promise<void>;
  onCreateLabel: (name: string, color: string, description: string) => Promise<void>;
  notificationSchedules: NotificationSchedule[];
  onSaveNotificationSchedules: (schedules: NotificationSchedule[]) => Promise<void>;
  onSetDiscordWebhook: (webhookUrl: string) => Promise<void>;
  onLoadDiscordWebhook: () => Promise<string>;
  onTestDiscordWebhook: (webhookUrl: string) => Promise<void>;
  projects: Project[];
  /** リポジトリを追加（左上のリポジトリの一覧と同じウィザード）を開く */
  onOpenAddRepo: () => void;
  /** トークンを変えたあと（今のプロジェクトを読み直す） */
  onTokensChanged: () => Promise<void>;
  /** ログアウト（この PC からトークンを消して、最初のセットアップに戻る） */
  onSignOut: () => Promise<void>;
  displaySettings: DisplaySettings;
  onChangeDisplaySettings: (patch: Partial<DisplaySettings>) => void;
  /** 見積もりの単位（config/estimate.yaml。チームで一つ） */
  estimateUnit: EstimateUnit;
  onSaveEstimateUnit: (unit: EstimateUnit) => Promise<void>;
  /** 使う準備（Git のインストール・コミットに使う名前）のダイアログを開く */
  onOpenSetup: () => void;
  setupVersion: number;
  eventNotifConfig: EventNotificationConfig | null;
  onSaveEventNotifConfig: (config: EventNotificationConfig) => Promise<void>;
  /** GitHub にログインしている人 */
  login: string;
  /** ボードの区画（config/board.yaml。チームで一つ） */
  boardConfig: BoardConfig | null;
  onSaveBoardConfig: (config: BoardConfig) => Promise<void>;
  /** 新しいバージョン（起動したときにも確かめる）。available は見つかった新しいバージョン */
  update: { available: { version: string } | null; updating: boolean };
  onCheckUpdate: () => Promise<UpdateCheck>;
  onRunUpdate: () => void;
  /** 開いたときに出すペイン（セットアップのあと「メンバーを招待する」で 接続 を、アカウントのメニューから トークン を開く） */
  initialPane?: SettingsPane;
  /** 開いたときに見せる区切り（ボードの「⚙ 区画の設定」・ガントの「⚙ 色の設定」から） */
  initialSection?: string;
}

/** 新しいバージョンを確かめた結果 */
export type UpdateCheck = "latest" | "available" | "error";

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

export type SettingsPane = "connection" | "tasks" | "notifications" | "display" | "tokens" | "other";
// 接続（チーム）がいちばん前。トークンは、ふだんは触らないので後ろのほう
const PANES: { key: SettingsPane; label: string }[] = [
  { key: "connection", label: "接続" },
  { key: "tasks", label: "タスク" },
  { key: "notifications", label: "通知" },
  { key: "display", label: "表示" },
  { key: "tokens", label: "トークン" },
  { key: "other", label: "その他" },
];

// サイドバーの位置の選択肢。bar は見本の絵で、帯を描く場所
const SIDEBAR_POSITION_OPTIONS: { value: SidebarPosition; label: string; note: string; bar: { x: number; y: number; width: number; height: number } }[] = [
  { value: "left", label: "左", note: "はじめはこれ", bar: { x: 5, y: 5, width: 9, height: 24 } },
  { value: "right", label: "右", note: "", bar: { x: 32, y: 5, width: 9, height: 24 } },
  { value: "top", label: "上", note: "横に並んだ帯になります", bar: { x: 5, y: 5, width: 36, height: 7 } },
  { value: "bottom", label: "下", note: "横に並んだ帯になります", bar: { x: 5, y: 22, width: 36, height: 7 } },
];

// テーマの見本の絵（画面・サイドバー・ボード・下の机の色は、そのテーマと同じ）
function ThemePreview({ theme }: { theme: Theme }) {
  return (
    <svg className={`display-preview pv-theme pv-theme-${theme}`} width="46" height="34" aria-hidden="true">
      <rect x="1" y="1" width="44" height="32" rx="4" className="pv-t-win" />
      <rect x="1" y="1" width="10" height="32" rx="2" className="pv-t-side" />
      <rect x="14" y="5" width="28" height="18" rx="1.5" className="pv-t-frame" />
      <rect x="16" y="7" width="24" height="14" className="pv-t-board" />
      <rect x="19" y="10" width="7" height="7" className="pv-t-note" transform="rotate(-5 22.5 13.5)" />
      <rect x="29" y="11" width="7" height="7" className="pv-t-note2" transform="rotate(4 32.5 14.5)" />
      <rect x="11" y="26" width="34" height="7" className="pv-t-desk" />
    </svg>
  );
}

// メモのボタン（📝）の場所。dot は見本の絵のボタンの位置（隠すときは出さない）
const MEMO_BUTTON_OPTIONS: { value: MemoButtonPosition; label: string; note: string; dot: { cx: number; cy: number } | null }[] = [
  { value: "top-right", label: "右上", note: "", dot: { cx: 36, cy: 10 } },
  { value: "bottom-right", label: "右下", note: "", dot: { cx: 36, cy: 24 } },
  { value: "top-left", label: "左上", note: "", dot: { cx: 10, cy: 10 } },
  { value: "bottom-left", label: "左下", note: "はじめはこれ", dot: { cx: 10, cy: 24 } },
  { value: "hidden", label: "隠す", note: "Ctrl+M だけで開きます", dot: null },
];

export function SettingsView({ labels, owner, repo, onSetupLabels, onUpdateLabel, onDeleteLabel, onCreateLabel, notificationSchedules, onSaveNotificationSchedules, onSetDiscordWebhook, onLoadDiscordWebhook, onTestDiscordWebhook, projects, onOpenAddRepo, onTokensChanged, onSignOut, displaySettings, onChangeDisplaySettings, estimateUnit, onSaveEstimateUnit, onOpenSetup, setupVersion, eventNotifConfig, onSaveEventNotifConfig, login, boardConfig, onSaveBoardConfig, update, onCheckUpdate, onRunUpdate, initialPane, initialSection }: SettingsViewProps) {
  const [activePane, setActivePane] = useState<SettingsPane>(initialPane ?? "connection");
  // 区分を切り替える（横に並んだタブなので、右の区分へは右から・左へは左から入れ替わる）
  function changePane(next: SettingsPane) {
    if (next === activePane) return;
    const dir = stepDirection(PANES.map((p) => p.key), activePane, next, "horizontal");
    withTransition(() => setActivePane(next), ["vt-tab", dir]);
  }
  const [appVersion, setAppVersion] = useState("");
  // Actions の「はじめる準備」で隠したもの（今のリポジトリ・この PC）
  const [setupHidden, setSetupHidden] = useState<string[]>(() => loadSetupHidden(owner, repo));
  useEffect(() => setSetupHidden(loadSetupHidden(owner, repo)), [owner, repo]);
  function toggleSetupItem(key: string, show: boolean) {
    const next = show ? setupHidden.filter((k) => k !== key) : [...setupHidden, key];
    setSetupHidden(next);
    saveSetupHidden(owner, repo, next);
  }
  // 新しいバージョンを確かめる
  const [updateCheck, setUpdateCheck] = useState<UpdateCheck | "checking" | null>(null);
  async function checkUpdate() {
    setUpdateCheck("checking");
    setUpdateCheck(await onCheckUpdate());
  }
  // ボード・ガントから開いたときは、その区切りまで動かして、少しのあいだ光らせる
  useEffect(() => {
    if (!initialSection) return;
    const el = document.getElementById(initialSection);
    if (!el) return;
    el.scrollIntoView({ block: "start" });
    el.classList.add("settings-flash");
    const t = window.setTimeout(() => el.classList.remove("settings-flash"), 1600);
    return () => window.clearTimeout(t);
  }, [initialSection]);
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
    await openUrl(mailto);
    setFeedbackTitle("");
    setFeedbackBody("");
  }


  return (
    <div className="content">
      <h2 className="settings-title" style={{ fontSize: "var(--font-xl)", marginBottom: "var(--space-md)" }}>設定</h2>

      {/* ペインタブ */}
      <div className="settings-pane-tabs">
        {PANES.map((p) => (
          <button key={p.key}
            className={`settings-pane-tab${activePane === p.key ? " settings-pane-tab--active" : ""}`}
            onClick={() => changePane(p.key)}>
            {p.label}
            {activePane === p.key && <span className="tab-active-bar" aria-hidden="true" />}
          </button>
        ))}
      </div>

      {/* 区分の中身（切り替えると横にすべる） */}
      <div className="settings-pane-body">

      {/* === 接続ペイン（チーム。リポジトリの追加・切り替え・この PC のフォルダは左上のリポジトリから） === */}
      {activePane === "connection" && <>
      <div className="settings-repo-note">
        <span>
          リポジトリの追加・切り替え・この PC のフォルダは、左上の <b>{owner && repo ? `${owner}/${repo}` : "リポジトリ"}</b> から行います。
        </span>
        <button type="button" className="btn-sm" onClick={onOpenAddRepo}>＋ リポジトリを追加…</button>
      </div>
      <TeamPane owner={owner} repo={repo} login={login} />
      </>}

      {/* === トークンペイン（いつものトークン・プロジェクトごとのトークン・ログアウト） === */}
      {activePane === "tokens" && <TokenSettings projects={projects} onChanged={onTokensChanged} onSignOut={onSignOut} />}

      {/* === タスクペイン（見積もりの単位・ボードの区画・ラベル。どれもチームで一つ） === */}
      {activePane === "tasks" && <>

      {/* 見積もりの単位（ラベル「見積:3pt」などの単位。チームで一つ） */}
      <div className="form-card">
        <h3 className="settings-section-title" style={{ marginBottom: "var(--space-sm)" }}>見積もりの単位</h3>
        <div className="display-opts">
          {UNIT_KEYS.map((key) => (
            <label key={key} className="display-opt">
              <input type="radio" name="estimate-unit" checked={estimateUnit === key}
                onChange={() => { onSaveEstimateUnit(key).catch(() => undefined); }} />
              <span>
                <b>{UNITS[key].name}<span className="est-unit-values">{UNITS[key].values.map((v) => formatEstimate(v, key)).join("・")}</span></b>
                <small>{UNITS[key].guide}</small>
              </span>
            </label>
          ))}
        </div>
        <p className="settings-hint" style={{ marginTop: "var(--space-sm)" }}>
          チームで一つの単位を使います（リポジトリの <code>config/estimate.yaml</code> に置き、GitHub に送ります）。
          単位を変えても、付けてある見積もりのラベルはそのままです。時間・日・人月どうしは 1 日＝{HOURS_PER_DAY} 時間、1 人月＝{DAYS_PER_PERSON_MONTH} 日で換算して合計し、
          ポイントと時間の単位は換算しません。
        </p>
      </div>

      {/* ボードの区画（config/board.yaml） */}
      <BoardColumnsSetting boardConfig={boardConfig} labels={labels} onSave={onSaveBoardConfig} />

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

      {/* === 表示ペイン === */}
      {activePane === "display" && <>

      <div className="form-card" id="settings-theme">
        <h3 className="settings-section-title" style={{ marginBottom: "var(--space-sm)" }}>テーマ</h3>
        <div className="display-opts">
          {THEMES.map((t) => (
            <label key={t.key} className="display-opt">
              <input type="radio" name="theme" checked={displaySettings.theme === t.key}
                onChange={() => onChangeDisplaySettings({ theme: t.key })} />
              <ThemePreview theme={t.key} />
              <span>
                <b>{t.label}</b>
                <small>{t.about}</small>
              </span>
            </label>
          ))}
        </div>
        <p className="settings-hint" style={{ marginTop: "var(--space-sm)" }}>
          アプリ全体の色が変わります。ボードと、ボードの下の机も、テーマのものになります。
        </p>
      </div>

      {/* 学習の補助（git の解説）・全体図は PC だけ（スマホは git の操作をしない） */}
      {!isMobile && <>
      <div className="form-card">
        <h3 className="settings-section-title" style={{ marginBottom: "var(--space-sm)" }}>学習の補助</h3>
        <label className="display-opt">
          <input type="checkbox" checked={displaySettings.hints}
            onChange={(e) => onChangeDisplaySettings({ hints: e.target.checked })} />
          <span>
            <b>解説を表示する</b>
            <small>ステージ・コミット・退避などの意味と、対応する git のコマンドを画面に添えます</small>
          </span>
        </label>
      </div>

      <div className="form-card">
        <h3 className="settings-section-title" style={{ marginBottom: "var(--space-sm)" }}>全体図でのブランチの見せ方</h3>
        <div className="display-opts">
          <label className="display-opt">
            <input type="radio" name="branch-style" checked={displaySettings.branchStyle === "label"}
              onChange={() => onChangeDisplaySettings({ branchStyle: "label" })} />
            <svg className="display-preview" width="46" height="34" aria-hidden="true">
              <path d="M10,4 V30" className="pv-line pv-main" />
              <circle cx="10" cy="24" r="3" className="pv-node" />
              <circle cx="10" cy="14" r="3" className="pv-node" />
              <rect x="18" y="10" width="22" height="8" rx="4" className="pv-label" />
              <rect x="18" y="20" width="16" height="8" rx="4" className="pv-label" />
            </svg>
            <span>
              <b>ラベル</b>
              <small>Sourcetree と同じ。ブランチ名はコミットの横に付きます</small>
            </span>
          </label>
          <label className="display-opt">
            <input type="radio" name="branch-style" checked={displaySettings.branchStyle === "line"}
              onChange={() => onChangeDisplaySettings({ branchStyle: "line" })} />
            <svg className="display-preview" width="46" height="34" aria-hidden="true">
              <path d="M10,4 V30" className="pv-line pv-main" />
              <path d="M10,24 C10,20 24,20 24,16 V4" className="pv-line pv-sub1" />
              <path d="M10,14 C10,10 38,10 38,6 V4" className="pv-line pv-sub2" />
              <circle cx="10" cy="24" r="3" className="pv-node" />
              <circle cx="10" cy="14" r="3" className="pv-node" />
            </svg>
            <span>
              <b>線</b>
              <small>ブランチごとに 1 本の線。いつ切られたかが一目で分かります</small>
            </span>
          </label>
        </div>
      </div>
      </>}

      <div className="form-card" id="settings-gantt-colors">
        <div className="settings-section-header">
          <h3 className="settings-section-title">ガントの帯の色</h3>
          <button type="button" className="btn-sm"
            disabled={JSON.stringify(displaySettings.ganttColors) === JSON.stringify(DEFAULT_BAR_COLORS)}
            onClick={() => onChangeDisplaySettings({ ganttColors: DEFAULT_BAR_COLORS })}>
            はじめの色に戻す
          </button>
        </div>
        <div className="gantt-colors">
          {(Object.keys(BAR_COLOR_LABELS) as (keyof GanttBarColors)[]).map((key) => (
            <label key={key} className="gantt-color">
              <input type="color" value={displaySettings.ganttColors[key]}
                onChange={(e) => onChangeDisplaySettings({ ganttColors: { ...displaySettings.ganttColors, [key]: e.target.value } })} />
              <span>{BAR_COLOR_LABELS[key]}</span>
            </label>
          ))}
        </div>
        <p className="settings-hint" style={{ marginTop: "var(--space-sm)" }}>
          完了・クリティカルパス（遅れると全体が遅れるタスク）・優先:高・状態（進行中・ブロック）の順に効きます。どれでもない帯は デフォルト の色です。
        </p>
      </div>

      {/* サイドバーは PC だけ（スマホは下のナビ） */}
      {!isMobile && (
      <div className="form-card">
        <h3 className="settings-section-title" style={{ marginBottom: "var(--space-sm)" }}>サイドバーの位置</h3>
        <div className="display-opts pos-opts">
          {SIDEBAR_POSITION_OPTIONS.map((opt) => (
            <label key={opt.value} className="display-opt">
              <input type="radio" name="sidebar-position" checked={displaySettings.sidebarPosition === opt.value}
                onChange={() => onChangeDisplaySettings({ sidebarPosition: opt.value })} />
              <svg className="display-preview" width="46" height="34" aria-hidden="true">
                <rect x="2" y="2" width="42" height="30" rx="4" className="pv-win" />
                <rect {...opt.bar} rx="1.5" className="pv-bar" />
              </svg>
              <span>
                <b>{opt.label}</b>
                {opt.note && <small>{opt.note}</small>}
              </span>
            </label>
          ))}
        </div>
        <p className="settings-hint" style={{ marginTop: "var(--space-sm)" }}>
          サイドバーの「たたむ」（Ctrl+B）で隠すと、その端にマウスを寄せたときだけ出てきます。
        </p>
      </div>
      )}

      <div className="form-card">
        <h3 className="settings-section-title" style={{ marginBottom: "var(--space-sm)" }}>メモのボタン（📝）</h3>
        <div className="display-opts pos-opts">
          {MEMO_BUTTON_OPTIONS.map((opt) => (
            <label key={opt.value} className="display-opt">
              <input type="radio" name="memo-button" checked={displaySettings.memoButton === opt.value}
                onChange={() => onChangeDisplaySettings({ memoButton: opt.value })} />
              <svg className="display-preview" width="46" height="34" aria-hidden="true">
                <rect x="2" y="2" width="42" height="30" rx="4" className="pv-win" />
                {opt.dot ? <circle {...opt.dot} r="4.5" className="pv-fab" /> : <text x="23" y="21" className="pv-key">Ctrl+M</text>}
              </svg>
              <span>
                <b>{opt.label}</b>
                {opt.note && <small>{opt.note}</small>}
              </span>
            </label>
          ))}
        </div>
        <p className="settings-hint" style={{ marginTop: "var(--space-sm)" }}>
          どの場所でも、Ctrl+M でメモの欄が開きます。ボタンはサイドバーや上のバーにかぶらない所に出ます。
        </p>
      </div>

      <div className="form-card">
        <h3 className="settings-section-title" style={{ marginBottom: "var(--space-sm)" }}>画面の動き</h3>
        <div className="display-opts">
          <label className="display-opt">
            <input type="radio" name="motion" checked={displaySettings.motion === "normal"}
              onChange={() => onChangeDisplaySettings({ motion: "normal" })} />
            <span>
              <b>ふつう（はじめはこれ）</b>
              <small>動いた向きで動きが変わります。縦に並んだものは上下、横に並んだもの（タブ・横の帯）は左右、作業 ⇄ ブランチ ⇄ 全体図 とカード ⇄ 詳細 は寄る・引く</small>
            </span>
          </label>
          <label className="display-opt">
            <input type="radio" name="motion" checked={displaySettings.motion === "reduced"}
              onChange={() => onChangeDisplaySettings({ motion: "reduced" })} />
            <span>
              <b>少なめ</b>
              <small>画面はうすく出るだけ。OS で「視差効果を減らす」（アニメーションを減らす）にしているときも、動きは少なくなります</small>
            </span>
          </label>
        </div>
      </div>

      </>}

      {/* === その他ペイン === */}
      {activePane === "other" && <>

      {/* この PC の git（PC のみ） */}
      {!isMobile && <GitInfoCard onOpenSetup={onOpenSetup} setupVersion={setupVersion} />}

      {/* Actions の「はじめる準備」に出すもの（今のリポジトリ・この PC） */}
      {owner && repo && (
        <div className="form-card" id="settings-actions-setup">
          <h3 className="settings-section-title" style={{ marginBottom: "var(--space-xs)" }}>Actions の「はじめる準備」に出すもの</h3>
          <p className="settings-hint" style={{ marginBottom: "var(--space-sm)" }}>
            {owner}/{repo} の Actions の画面に出す勧めです。そこで「今は使わない」を押すと、ここのチェックが外れます。チェックしてあっても、要るときだけ出ます。
          </p>
          <div className="display-opts">
            {SETUP_ITEMS.map((item) => (
              <label key={item.key} className="display-opt">
                <input type="checkbox" checked={!setupHidden.includes(item.key)}
                  onChange={(e) => toggleSetupItem(item.key, e.target.checked)} />
                <span>
                  <b>{item.label}</b>
                  <small>{item.about}</small>
                </span>
              </label>
            ))}
          </div>
        </div>
      )}

      {/* バージョン（新しいバージョンを確かめる。PC のみ） */}
      {!isMobile && (
        <div className="form-card" id="settings-update">
          <h3 className="settings-section-title" style={{ marginBottom: "var(--space-sm)" }}>バージョン</h3>
          <div className="update-row">
            <span>Life Manager <b>{appVersion ? `v${appVersion}` : "…"}</b></span>
            <button type="button" className="btn-sm" onClick={checkUpdate} disabled={updateCheck === "checking" || update.updating}>
              {updateCheck === "checking" ? "確かめています…" : "新しいバージョンを確かめる"}
            </button>
          </div>
          {update.available ? (
            <div className="update-result update-result--new">
              <span>新しいバージョン <b>v{update.available.version}</b> があります</span>
              <button type="button" className="btn-primary" onClick={onRunUpdate} disabled={update.updating}>
                {update.updating ? "更新しています…" : "今すぐ更新"}
              </button>
            </div>
          ) : updateCheck === "latest" ? (
            <p className="update-result">✔ 今のバージョンが最新です</p>
          ) : updateCheck === "error" ? (
            <p className="update-result update-result--error">確かめられませんでした。インターネットにつながっているか確かめて、もう一度押してください</p>
          ) : null}
          <p className="settings-hint" style={{ marginTop: "var(--space-sm)" }}>
            起動したときにも確かめます。新しいバージョンがあると、画面の上にお知らせが出ます。
          </p>
        </div>
      )}

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
            // HTML のマニュアル（ブラウザで開く）。開けなければ GitHub の README
            try {
              await openPath(await resolveResource("resources/manual.html"));
              return;
            } catch {
              // README へ
            }
            await openUrl("https://github.com/y0zrin/LifeManager/blob/main/README.md");
          }}
          style={{ fontSize: "var(--font-xs)" }}
        >
          マニュアルを開く
        </button>
        {appVersion && isMobile && (
          <p style={{ fontSize: "var(--font-xs)", color: "var(--text-faint)", marginTop: "var(--space-sm)" }}>
            Life Manager v{appVersion}
          </p>
        )}
      </div>

      </>}
      </div>
    </div>
  );
}
