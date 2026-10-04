import { useState, useEffect } from "react";
import { invoke } from "../../lib/invoke";
import { openUrl } from "@tauri-apps/plugin-opener";
import { openManual } from "../../lib/manual";
import type { GitHubLabel, NotificationSchedule, RoutineSchedule, Project, EventNotificationConfig, EventType, BoardConfig } from "../../lib/types";
import { EVENT_TYPE_LABELS } from "../../lib/types";
import { useBackLayer } from "../../lib/back";
import { isMobile } from "../../lib/platform";
import type { DisplaySettings, MemoButtonPosition, SidebarPosition } from "../../hooks/useDisplaySettings";
import { DAYS_PER_PERSON_MONTH, HOURS_PER_DAY, UNITS, UNIT_KEYS, formatEstimate, type EstimateUnit } from "../../lib/estimate";
import { LabelBadge } from "../common/LabelBadge";
import { GitInfoCard } from "../common/GitInfoCard";
import { TokenSettings } from "../common/TokenSettings";
import { TeamPane } from "../common/TeamPane";
import { BoardColumnsSetting } from "../common/BoardColumnsSetting";
import { THEMES } from "../../lib/theme";
import { ThemeMini } from "../common/ThemeMini";
import { SetupChecklist } from "../common/SetupChecklist";
import { BAR_COLOR_LABELS, DEFAULT_BAR_COLORS, type GanttBarColors } from "../../lib/ganttTypes";
import { SETUP_ITEMS, loadSetupHidden, saveSetupHidden } from "../../lib/actions";
import { stepDirection, withTransition } from "../../lib/motion";
import type { MilestoneBar } from "../../lib/milestoneStage";
import type { NoticeCorner } from "../../lib/notices";
import { tr, trx } from "../../lib/i18n";
import { LanguageSelect } from "../common/LanguageSelect";

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
  /** この PC の作業フォルダ（準備のチェックリスト。スマホは undefined） */
  localFolder?: string;
  /** 作業フォルダを決めるところ（作業をする）を開く */
  onOpenWork: () => void;
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
  /** 通知 の「ためしに出す」（おしらせを 1 つ出す） */
  onTestNotice?: () => void;
}

/** 新しいバージョンを確かめた結果 */
export type UpdateCheck = "latest" | "available" | "error";

const weekdays = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const weekdayLabels: Record<string, string> = {
  mon: tr("月"), tue: tr("火"), wed: tr("水"), thu: tr("木"), fri: tr("金"), sat: tr("土"), sun: tr("日"),
};
const notifyTypes: Record<string, string> = {
  today_tasks: tr("今日のタスク一覧"),
  overdue: tr("期限超過チェック"),
  summary: tr("全体サマリー"),
  custom: tr("カスタムメッセージ"),
};

export type SettingsPane = "connection" | "tasks" | "notifications" | "display" | "tokens" | "other";
// 接続（チーム）がいちばん前。トークンは、ふだんは触らないので後ろのほう
const PANES: { key: SettingsPane; label: string; icon: string; about: string }[] = [
  { key: "connection", label: tr("接続"), icon: "🔗", about: tr("チームのメンバー・招待、リポジトリの追加") },
  { key: "tasks", label: tr("タスク"), icon: "📋", about: tr("見積もりの単位、ボードの区画、ラベル") },
  { key: "notifications", label: tr("通知"), icon: "🔔", about: tr("Discord、通知のスケジュール、イベント通知") },
  { key: "display", label: tr("表示"), icon: "🎨", about: tr("テーマ、メモのボタン、マイルストーンのバー、動き") },
  { key: "tokens", label: tr("トークン"), icon: "🔑", about: tr("ログインとトークン") },
  { key: "other", label: tr("その他"), icon: "ℹ️", about: tr("マニュアル、フィードバック、バージョン") },
];

// サイドバーの位置の選択肢。bar は見本の絵で、帯を描く場所
const SIDEBAR_POSITION_OPTIONS: { value: SidebarPosition; label: string; note: string; bar: { x: number; y: number; width: number; height: number } }[] = [
  { value: "left", label: tr("左"), note: tr("はじめはこれ"), bar: { x: 5, y: 5, width: 9, height: 24 } },
  { value: "right", label: tr("右"), note: "", bar: { x: 32, y: 5, width: 9, height: 24 } },
  { value: "top", label: tr("上"), note: tr("横に並んだ帯になります"), bar: { x: 5, y: 5, width: 36, height: 7 } },
  { value: "bottom", label: tr("下"), note: tr("横に並んだ帯になります"), bar: { x: 5, y: 22, width: 36, height: 7 } },
];

// メモのボタン（📝）の場所。dot は見本の絵のボタンの位置（隠すときは出さない）
// マイルストーンのバー
const MILESTONE_BAR_OPTIONS: { value: MilestoneBar; label: string; note: string }[] = [
  { value: "auto", label: tr("テーマに合わせる（はじめはこれ）"), note: tr("クエストは HP（ボスの残りの体力）、ほかのテーマは達成率") },
  { value: "progress", label: tr("達成率（のびる）"), note: tr("終えた分だけバーがのびます") },
  { value: "hp", label: tr("HP（減る）"), note: tr("残りの量を HP にして、終えた分だけ減ります。前に見たときより減った分が「−2pt」と飛びます") },
];

// おしらせの窓を出す角（画面の絵の、窓の場所）
const NOTICE_CORNER_OPTIONS: { value: NoticeCorner; label: string; note: string; box: { x: number; y: number } | null }[] = [
  { value: "top-right", label: tr("右上"), note: tr("はじめはこれ"), box: { x: 27, y: 5 } },
  { value: "bottom-right", label: tr("右下"), note: "", box: { x: 27, y: 21 } },
  { value: "top-left", label: tr("左上"), note: "", box: { x: 5, y: 5 } },
  { value: "bottom-left", label: tr("左下"), note: "", box: { x: 5, y: 21 } },
  { value: "off", label: tr("アプリの中だけ"), note: tr("窓の外には出さず、アプリの右上に出します。窓を閉じているあいだの知らせは 🔔 のりれきで見られます"), box: null },
];

const MEMO_BUTTON_OPTIONS: { value: MemoButtonPosition; label: string; note: string; dot: { cx: number; cy: number } | null }[] = [
  { value: "top-right", label: tr("右上"), note: "", dot: { cx: 36, cy: 10 } },
  { value: "bottom-right", label: tr("右下"), note: "", dot: { cx: 36, cy: 24 } },
  { value: "top-left", label: tr("左上"), note: "", dot: { cx: 10, cy: 10 } },
  { value: "bottom-left", label: tr("左下"), note: tr("はじめはこれ"), dot: { cx: 10, cy: 24 } },
  { value: "hidden", label: tr("隠す"), note: tr("Ctrl+M だけで開きます"), dot: null },
];

export function SettingsView({ labels, owner, repo, onSetupLabels, onUpdateLabel, onDeleteLabel, onCreateLabel, notificationSchedules, onSaveNotificationSchedules, onSetDiscordWebhook, onLoadDiscordWebhook, onTestDiscordWebhook, projects, onOpenAddRepo, onTokensChanged, onSignOut, displaySettings, onChangeDisplaySettings, estimateUnit, onSaveEstimateUnit, onOpenSetup, setupVersion, localFolder, onOpenWork, eventNotifConfig, onSaveEventNotifConfig, login, boardConfig, onSaveBoardConfig, update, onCheckUpdate, onRunUpdate, initialPane, initialSection, onTestNotice }: SettingsViewProps) {
  const [activePane, setActivePane] = useState<SettingsPane>(initialPane ?? "connection");
  // スマホは「区分の一覧 → 区分」の 2 段（#210）。区分を開いているときは、戻るボタンで一覧へ
  const [mobileList, setMobileList] = useState(isMobile && !initialPane);
  useBackLayer(isMobile && !mobileList, () => setMobileList(true));
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
    const prefix = feedbackCategory === "bug" ? tr("[バグ]") : feedbackCategory === "feature" ? tr("[機能要望]") : tr("[フィードバック]");
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
      <h2 className="settings-title" style={{ fontSize: "var(--font-xl)", marginBottom: "var(--space-md)" }}>{tr("設定")}</h2>

      {/* スマホ: 区分の一覧（押すと、その区分だけを開く） */}
      {isMobile && mobileList && (
        <div className="settings-pane-list">
          {PANES.map((p) => (
            <button key={p.key} type="button" className="settings-pane-item" onClick={() => { setActivePane(p.key); setMobileList(false); }}>
              <span className="settings-pane-icon" aria-hidden="true">{p.icon}</span>
              <span className="settings-pane-text">
                <b>{p.label}</b>
                <small>{p.about}</small>
              </span>
              <span className="settings-pane-go" aria-hidden="true">›</span>
            </button>
          ))}
        </div>
      )}
      {isMobile && !mobileList && (
        <div className="settings-pane-back">
          <button type="button" className="btn-sm" onClick={() => setMobileList(true)}>{tr("‹ 設定")}</button>
          <b>{PANES.find((p) => p.key === activePane)?.label}</b>
        </div>
      )}

      {/* ペインタブ（PC） */}
      {!isMobile && (
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
      )}

      {/* 区分の中身（切り替えると横にすべる）。スマホの一覧のあいだは出さない */}
      {!(isMobile && mobileList) && (
      <div className="settings-pane-body">

      {/* === 接続ペイン（チーム。リポジトリの追加・切り替え・この PC のフォルダは左上のリポジトリから） === */}
      {activePane === "connection" && <>
      <SetupChecklist
        owner={owner}
        repo={repo}
        login={login}
        folder={localFolder}
        setupVersion={setupVersion}
        onOpenAccess={() => changePane("tokens")}
        onOpenFolder={onOpenWork}
        onOpenGitSetup={onOpenSetup}
      />
      <div className="settings-repo-note">
        <span>
          {tr("リポジトリの追加・切り替え・この PC のフォルダは、左上の")}{" "} <b>{owner && repo ? `${owner}/${repo}` : tr("リポジトリ")}</b> {" "}{tr("から行います。")}
        </span>
        <button type="button" className="btn-sm" onClick={onOpenAddRepo}>{tr("＋ リポジトリを追加…")}</button>
      </div>
      <TeamPane owner={owner} repo={repo} login={login} />
      </>}

      {/* === トークンペイン（いつものトークン・プロジェクトごとのトークン・ログアウト） === */}
      {activePane === "tokens" && <TokenSettings projects={projects} onChanged={onTokensChanged} onSignOut={onSignOut} />}

      {/* === タスクペイン（見積もりの単位・ボードの区画・ラベル。どれもチームで一つ） === */}
      {activePane === "tasks" && <>

      {/* 見積もりの単位（ラベル「見積:3pt」などの単位。チームで一つ） */}
      <div className="form-card">
        <h3 className="settings-section-title" style={{ marginBottom: "var(--space-sm)" }}>{tr("見積もりの単位")}</h3>
        <div className="display-opts">
          {UNIT_KEYS.map((key) => (
            <label key={key} className="display-opt">
              <input type="radio" name="estimate-unit" checked={estimateUnit === key}
                onChange={() => { onSaveEstimateUnit(key).catch(() => undefined); }} />
              <span>
                <b>{UNITS[key].name}<span className="est-unit-values">{UNITS[key].values.map((v) => formatEstimate(v, key)).join(tr("・"))}</span></b>
                <small>{UNITS[key].guide}</small>
              </span>
            </label>
          ))}
        </div>
        <p className="settings-hint" style={{ marginTop: "var(--space-sm)" }}>
          {trx("チームで一つの単位を使います（リポジトリの <0>config/estimate.yaml</0> に置き、GitHub に送ります）。 単位を変えても、付けてある見積もりのラベルはそのままです。時間・日・人月どうしは 1 日＝{HOURS_PER_DAY} 時間、1 人月＝{DAYS_PER_PERSON_MONTH} 日で換算して合計し、 ポイントと時間の単位は換算しません。", { HOURS_PER_DAY, DAYS_PER_PERSON_MONTH }, [<code />])}
        </p>
      </div>

      {/* ボードの区画（config/board.yaml） */}
      <BoardColumnsSetting boardConfig={boardConfig} labels={labels} onSave={onSaveBoardConfig} />

      {/* ラベル管理 */}
      <div className="form-card">
        <div className="settings-section-header">
          <h3 className="settings-section-title">{tr("ラベル管理")}</h3>
          <div className="flex-row" style={{ gap: "6px" }}>
            <button onClick={() => setShowNewLabelForm(!showNewLabelForm)} className="btn-sm">
              {showNewLabelForm ? "×" : tr("+ 新規ラベル")}
            </button>
            <button onClick={onSetupLabels} className="btn-sm" title={tr("優先（高・中・低）とセクション（プログラマー・デザイナー・プランナー・その他）の 7 つを作ります。もうあるラベルはそのままです")}>{tr("ラベル一括作成")}</button>
          </div>
        </div>

        {/* 新規ラベル作成フォーム */}
        {showNewLabelForm && (
          <div className="settings-form-inner">
            <div className="flex-row">
              <input type="color" value={newLabelColor} onChange={(e) => setNewLabelColor(e.target.value)}
                className="color-picker-input" />
              <input value={newLabelName} onChange={(e) => setNewLabelName(e.target.value)}
                placeholder={tr("ラベル名（例: セクション:サウンド）")} className="input-full" />
            </div>
            <input value={newLabelDesc} onChange={(e) => setNewLabelDesc(e.target.value)}
              placeholder={tr("説明（任意）")} className="input-full" />
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
              {labelSaving ? tr("作成中...") : tr("作成")}
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
                    placeholder={tr("説明（任意）")} className="input-full" style={{ fontSize: "var(--font-sm)" }} />
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
                      {labelSaving ? tr("保存中...") : tr("保存")}
                    </button>
                    <button onClick={() => setEditingLabel(null)} className="btn-sm"
                      style={{ fontSize: "var(--font-sm)" }}>
                      {tr("キャンセル")}
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
                      <span style={{ fontSize: "var(--font-xs)", color: "var(--accent-red)", marginRight: "var(--space-xs)" }}>{tr("削除しますか？")}</span>
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
                        {labelSaving ? "..." : tr("はい")}
                      </button>
                      <button onClick={() => setDeletingLabel(null)} className="btn-sm"
                        style={{ fontSize: "var(--font-xs)" }}>
                        {tr("いいえ")}
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
                        {tr("編集")}
                      </button>
                      <button onClick={() => setDeletingLabel(l.name)} className="btn-sm"
                        style={{ color: "var(--accent-red)", fontSize: "var(--font-xs)" }}>
                        {tr("削除")}
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
          {labels.length === 0 && (
            <p className="settings-hint--subtle">{tr("ラベルがありません")}</p>
          )}
        </div>
      </div>

      </>}

      {/* === 通知ペイン === */}
      {activePane === "notifications" && <>

      {/* アプリのおしらせ（PC だけ。アプリの窓の外の小さな窓と、× でインジケーターに残す） */}
      {!isMobile && (
      <div className="form-card">
        <h3 className="settings-section-title" style={{ marginBottom: "var(--space-xs)" }}>{tr("アプリのおしらせ")}</h3>
        <p className="settings-hint" style={{ marginBottom: "var(--space-sm)" }}>
          {tr("担当になった・レビューを頼まれた・名前を呼ばれた・修正を頼まれた・承認された・期限が近い・チェックや Actions の失敗・🆘 助けを求められた・マイルストーンの達成を、画面の角の小さな窓に出します（× か「開く」まで残ります）。届いた知らせは上のバーの 🔔 に 60 日残ります。")}
        </p>
        <div className="settings-subtitle">{tr("出す場所")}</div>
        <div className="display-opts pos-opts">
          {NOTICE_CORNER_OPTIONS.map((opt) => (
            <label key={opt.value} className="display-opt">
              <input type="radio" name="notice-corner" checked={displaySettings.noticeCorner === opt.value}
                onChange={() => onChangeDisplaySettings({ noticeCorner: opt.value })} />
              <svg className="display-preview" width="46" height="34" aria-hidden="true">
                <rect x="2" y="2" width="42" height="30" rx="4" className="pv-win" />
                {opt.box ? <rect {...opt.box} width="14" height="8" rx="1.5" className="pv-bar" /> : <text x="23" y="21" className="pv-key">{tr("アプリ")}</text>}
              </svg>
              <span>
                <b>{opt.label}</b>
                {opt.note && <small>{opt.note}</small>}
              </span>
            </label>
          ))}
        </div>
        <div className="settings-subtitle" style={{ marginTop: "var(--space-md)" }}>{tr("× を押したとき")}</div>
        <div className="display-opts">
          <label className="display-opt">
            <input type="radio" name="close-to-tray" checked={displaySettings.closeToTray}
              onChange={() => onChangeDisplaySettings({ closeToTray: true })} />
            <span>
              {trx("<0>インジケーターに残す（はじめはこれ）</0><1>画面の右下のインジケーター（タスクトレイ）に残り、おしらせを出し続けます。終えるときはアイコンを右クリック →「終了する」</1>", undefined, [<b />, <small />])}
            </span>
          </label>
          <label className="display-opt">
            <input type="radio" name="close-to-tray" checked={!displaySettings.closeToTray}
              onChange={() => onChangeDisplaySettings({ closeToTray: false })} />
            <span>
              {trx("<0>終了する</0><1>閉じているあいだはおしらせも出ません</1>", undefined, [<b />, <small />])}
            </span>
          </label>
        </div>
        {onTestNotice && (
          <div style={{ marginTop: "var(--space-md)" }}>
            <button type="button" className="btn-sm" onClick={onTestNotice}>{tr("🔔 ためしに出す")}</button>
          </div>
        )}
      </div>
      )}

      {/* Discord Webhook */}
      <div className="form-card">
        <h3 className="settings-section-title" style={{ marginBottom: "var(--space-xs)" }}>{tr("Discord Webhook通知")}</h3>
        <p style={{ fontSize: "var(--font-sm)", color: "var(--accent-blue)", marginBottom: "10px" }}>
          {trx("対象: <0>{owner}/{repo}</0><1>（プロジェクトごとに個別設定）</1>", { owner, repo }, [<strong />, <span style={{ color: "var(--text-faint)", marginLeft: "6px" }} />])}
        </p>

        {/* ステータス表示 */}
        <div className={`status-banner ${discordConfigured ? "status-banner--success" : "status-banner--warning"}`} style={{ marginBottom: "10px" }}>
          <span style={{ fontSize: "var(--font-xl)" }}>{discordConfigured ? "✅" : "⚠️"}</span>
          <span>
            {discordConfigured
              ? tr("Webhook設定済み — イベント通知がDiscordに送信されます")
              : tr("Webhook未設定 — Discord通知を使うにはWebhook URLを登録してください")}
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
            className={discordWebhookInput.trim() || !discordConfigured ? "btn-primary" : "btn-sm danger"}
            disabled={!discordWebhookInput.trim() && !discordConfigured}
          >
            {/* 空にして押すと解除（決めてあるときだけ）。決めていないのに空なら、押せない「保存」 */}
            {discordWebhookInput.trim() || !discordConfigured ? tr("保存") : tr("解除")}
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
            {discordTesting ? tr("送信中...") : tr("テスト送信")}
          </button>
        </div>
        <details style={{ marginTop: "10px" }}>
          <summary style={{ fontSize: "var(--font-xs)", color: "var(--text-muted)", cursor: "pointer" }}>
            {tr("Webhook URLの取得方法")}
          </summary>
          <ol style={{ fontSize: "var(--font-xs)", color: "var(--text-muted)", lineHeight: 1.8, paddingLeft: "18px", marginTop: "6px" }}>
            <li>{tr("Discordでサーバーの「サーバー設定」を開く")}</li>
            <li>{tr("「連携サービス」→「ウェブフック」を選択")}</li>
            <li>{tr("「新しいウェブフック」を作成し、通知先チャンネルを選択")}</li>
            <li>{tr("「ウェブフックURLをコピー」してここに貼り付け")}</li>
          </ol>
        </details>
      </div>

      {/* 通知スケジュール */}
      <div className="form-card">
        <div className="settings-section-header">
          <h3 className="settings-section-title">{tr("通知スケジュール")}</h3>
          <button onClick={() => setShowNotifForm(!showNotifForm)} className="btn-sm">
            {showNotifForm ? "×" : tr("+ 追加")}
          </button>
        </div>

        {showNotifForm && (
          <div className="settings-form-inner">
            <input value={notifName} onChange={(e) => setNotifName(e.target.value)}
              placeholder={tr("通知名（例: 朝のタスク確認）")} className="input-full" />
            <div className="flex-row flex-wrap" style={{ gap: "6px" }}>
              <select value={notifFrequency} onChange={(e) => setNotifFrequency(e.target.value)} className="select-sm">
                <option value="daily">{tr("毎日")}</option>
                <option value="weekly">{tr("毎週")}</option>
                <option value="monthly">{tr("毎月")}</option>
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
                <span className="settings-hint--subtle">{tr("（未選択＝毎日）")}</span>
              </div>
            )}
            {notifFrequency === "weekly" && (
              <select value={notifDay} onChange={(e) => setNotifDay(e.target.value)} className="select-sm">
                <option value="">{tr("曜日を選択...")}</option>
                {weekdays.map((wd) => (
                  <option key={wd} value={wd}>{trx("{weekdayLabels}曜日", { weekdayLabels: weekdayLabels[wd] })}</option>
                ))}
              </select>
            )}
            {notifFrequency === "monthly" && (
              <input type="number" value={notifDay} onChange={(e) => setNotifDay(e.target.value)}
                placeholder={tr("日（1-31）")} className="input-full" style={{ maxWidth: "120px" }} min="1" max="31" />
            )}
            <select value={notifType} onChange={(e) => setNotifType(e.target.value)} className="select-sm">
              {Object.entries(notifyTypes).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
            {notifType === "custom" && (
              <input value={notifMessage} onChange={(e) => setNotifMessage(e.target.value)}
                placeholder={tr("通知メッセージ")} className="input-full" />
            )}
            <div className="flex-row">
              <span style={{ fontSize: "var(--font-sm)", color: "var(--text-muted)" }}>{tr("通知先:")}</span>
              <label style={{ fontSize: "var(--font-sm)", display: "flex", alignItems: "center", gap: "2px" }}>
                <input type="checkbox" checked={notifChannels.includes("os")}
                  onChange={(e) => {
                    if (e.target.checked) setNotifChannels([...notifChannels, "os"]);
                    else setNotifChannels(notifChannels.filter((c) => c !== "os"));
                  }} />
                {tr("OS通知")}
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
              {notifSaving ? tr("保存中...") : tr("追加")}
            </button>
          </div>
        )}

        {notificationSchedules.map((notif, index) => {
          const scheduleStr = notif.schedule.frequency === "daily"
            ? tr("毎日{v}", { v: notif.schedule.days ? ` (${notif.schedule.days.map((d) => weekdayLabels[d] || d).join("")})` : "" })
            : notif.schedule.frequency === "weekly"
            ? tr("毎週{v}曜日", { v: weekdayLabels[String(notif.schedule.day)] || notif.schedule.day })
            : tr("毎月{day}日", { day: notif.schedule.day });
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
                style={{ color: "var(--accent-red)", fontSize: "var(--font-xs)" }}>{tr("削除")}</button>
            </div>
          );
        })}
        {notificationSchedules.length === 0 && !showNotifForm && (
          <p className="settings-hint--subtle">{tr("通知スケジュールが設定されていません")}</p>
        )}
      </div>

      {/* イベント通知設定 */}
      <div className="form-card">
        <div className="settings-section-header" style={{ marginBottom: "var(--space-md)" }}>
          <h3 className="settings-section-title">{tr("イベント通知")}</h3>
          <div className="flex-row">
            {eventConfigHasChanges && (
              <button onClick={() => onSaveEventNotifConfig(editingEventConfig)} className="btn-primary"
                style={{ fontSize: "var(--font-sm)" }}>
                {tr("保存")}
              </button>
            )}
            <label style={{ fontSize: "var(--font-sm)", color: "var(--text-muted)", display: "flex", alignItems: "center", gap: "var(--space-xs)" }}>
              <input
                type="checkbox"
                checked={editingEventConfig.enabled}
                onChange={() => setEditingEventConfig((prev) => ({ ...prev, enabled: !prev.enabled }))}
              />
              {tr("有効")}
            </label>
          </div>
        </div>

        {editingEventConfig.enabled && (
          <>
            {!discordConfigured && (
              <div className="status-banner status-banner--warning" style={{ marginBottom: "10px" }}>
                {trx("<0>⚠️</0><1>Discord Webhookが未設定のため、Discord通知は送信されません。上のセクションで設定してください。</1>", undefined, [<span style={{ fontSize: "var(--font-lg)" }} />, <span style={{ fontSize: "var(--font-xs)" }} />])}
              </div>
            )}
            <label style={{ fontSize: "var(--font-sm)", color: "var(--text-muted)", display: "flex", alignItems: "center", gap: "var(--space-xs)", marginBottom: "10px" }}>
              <input
                type="checkbox"
                checked={editingEventConfig.os_for_own_actions}
                onChange={() => setEditingEventConfig((prev) => ({ ...prev, os_for_own_actions: !prev.os_for_own_actions }))}
              />
              {tr("自分の操作でもOS通知を送信")}
            </label>

            <div className="settings-list">
              {/* ヘッダー行 */}
              <div className="settings-event-header">
                {trx("<0>イベント</0><1>有効</1><2>OS</2><3>Discord</3>", undefined, [<span className="settings-event-label" />, <span className="settings-event-cell" />, <span className="settings-event-cell" />, <span className="settings-event-cell--wide" />])}
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

      {/* 言語（#256）。変えると画面を読み直す */}
      <div className="form-card" id="settings-language">
        <h3 className="settings-section-title" style={{ marginBottom: "var(--space-sm)" }}>{tr("言語")}</h3>
        <LanguageSelect />
      </div>

      <div className="form-card" id="settings-theme">
        <h3 className="settings-section-title" style={{ marginBottom: "var(--space-sm)" }}>{tr("テーマ")}</h3>
        {/* 選ぶ画面のような大きなカード。カードは、それぞれのテーマの色と模様で描き、ミニの画面が動く（選んでいるカードと、マウスを乗せたカード） */}
        <div className="theme-cards" role="radiogroup" aria-label={tr("テーマ")}>
          {THEMES.map((t) => {
            const on = displaySettings.theme === t.key;
            return (
              <button key={t.key} type="button" role="radio" aria-checked={on} className={`theme-card theme-card--${t.key}${on ? " on" : ""}`}
                onClick={() => onChangeDisplaySettings({ theme: t.key })}>
                <ThemeMini theme={t.key} />
                <span className="theme-card-name">
                  {t.label}
                  {on && <span className="theme-card-on">{tr("使っている")}</span>}
                </span>
                <span className="theme-card-about">{t.about}</span>
              </button>
            );
          })}
        </div>
        <p className="settings-hint" style={{ marginTop: "var(--space-sm)" }}>
          {tr("アプリ全体の色が変わります。ボードと、ボードの下の机も、テーマのものになります。")}
        </p>
      </div>

      {/* 全体図は PC だけ（スマホは git の操作をしない） */}
      {!isMobile && <>
      <div className="form-card">
        <h3 className="settings-section-title" style={{ marginBottom: "var(--space-sm)" }}>{tr("全体図でのブランチの見せ方")}</h3>
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
              {trx("<0>ラベル</0><1>Sourcetree と同じ。ブランチ名はコミットの横に付きます</1>", undefined, [<b />, <small />])}
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
              {trx("<0>線</0><1>ブランチごとに 1 本の線。いつ切られたかが分かります</1>", undefined, [<b />, <small />])}
            </span>
          </label>
        </div>
      </div>
      </>}

      <div className="form-card" id="settings-gantt-colors">
        <div className="settings-section-header">
          <h3 className="settings-section-title">{tr("ガントの帯の色")}</h3>
          <button type="button" className="btn-sm"
            disabled={JSON.stringify(displaySettings.ganttColors) === JSON.stringify(DEFAULT_BAR_COLORS)}
            onClick={() => onChangeDisplaySettings({ ganttColors: DEFAULT_BAR_COLORS })}>
            {tr("はじめの色に戻す")}
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
          {tr("完了・クリティカルパス（遅れると全体が遅れるタスク）・優先:高・状態（進行中・ブロック）の順に効きます。どれでもない帯は「デフォルト」の色です。")}
        </p>
      </div>

      {/* サイドバーは PC だけ（スマホは下のナビ） */}
      {!isMobile && (
      <div className="form-card">
        <h3 className="settings-section-title" style={{ marginBottom: "var(--space-sm)" }}>{tr("サイドバーの位置")}</h3>
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
          {tr("サイドバーの「たたむ」（Ctrl+B）で隠すと、その端にマウスを寄せたときだけ出てきます。")}
        </p>
      </div>
      )}

      <div className="form-card">
        <h3 className="settings-section-title" style={{ marginBottom: "var(--space-sm)" }}>{tr("メモのボタン（📝）")}</h3>
        <div className="display-opts pos-opts">
          {MEMO_BUTTON_OPTIONS.filter((opt) => !(isMobile && opt.value === "hidden")).map((opt) => (
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
          {isMobile ? tr("ボタンは下の帯にかぶらない所に出ます。") : tr("どの場所でも Ctrl+M でメモの欄が開きます。ボタンはサイドバーや上のバーにかぶらない所に出ます。")}
        </p>
      </div>

      <div className="form-card">
        <h3 className="settings-section-title" style={{ marginBottom: "var(--space-sm)" }}>{tr("マイルストーンのバー")}</h3>
        <div className="display-opts">
          {MILESTONE_BAR_OPTIONS.map((opt) => (
            <label key={opt.value} className="display-opt">
              <input type="radio" name="milestone-bar" checked={displaySettings.milestoneBar === opt.value}
                onChange={() => onChangeDisplaySettings({ milestoneBar: opt.value })} />
              <span>
                <b>{opt.label}</b>
                <small>{opt.note}</small>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="form-card">
        <h3 className="settings-section-title" style={{ marginBottom: "var(--space-sm)" }}>{tr("画面の動き")}</h3>
        <div className="display-opts">
          <label className="display-opt">
            <input type="radio" name="motion" checked={displaySettings.motion === "normal"}
              onChange={() => onChangeDisplaySettings({ motion: "normal" })} />
            <span>
              {trx("<0>ふつう（はじめはこれ）</0><1>動いた向きで動きが変わります。縦に並んだものは上下、横に並んだもの（タブ・横の帯）は左右、作業 ⇄ ブランチ ⇄ 全体図 とカード ⇄ 詳細 は寄る・引く</1>", undefined, [<b />, <small />])}
            </span>
          </label>
          <label className="display-opt">
            <input type="radio" name="motion" checked={displaySettings.motion === "reduced"}
              onChange={() => onChangeDisplaySettings({ motion: "reduced" })} />
            <span>
              {trx("<0>少なめ</0><1>画面はうすく出るだけ。OS で「視差効果を減らす」（アニメーションを減らす）にしているときも、動きは少なくなります</1>", undefined, [<b />, <small />])}
            </span>
          </label>
        </div>
      </div>

      <div className="form-card">
        <h3 className="settings-section-title" style={{ marginBottom: "var(--space-sm)" }}>{tr("お祝いの音")}</h3>
        <label className="display-opt">
          <input type="checkbox" checked={displaySettings.celebrationSound}
            onChange={(e) => onChangeDisplaySettings({ celebrationSound: e.target.checked })} />
          <span>
            <b>{tr("マイルストーンを達成したときに鳴らす")}</b>
          </span>
        </label>
      </div>

      {/* 背景の動き（テーマの粒）。スマホでは動かさない */}
      {!isMobile && (
      <div className="form-card">
        <h3 className="settings-section-title" style={{ marginBottom: "var(--space-sm)" }}>{tr("背景の動き")}</h3>
        <div className="display-opts">
          <label className="display-opt">
            <input type="radio" name="stage-motion" checked={displaySettings.stageMotion}
              onChange={() => onChangeDisplaySettings({ stageMotion: true })} />
            <span>
              {trx("<0>動かす（はじめはこれ）</0><1>画面の後ろでテーマの粒が動きます（黒板はチョークの粉、クエストは金の粒、ナイトは星、スプリングは花びら、ウィンターは雪 など）</1>", undefined, [<b />, <small />])}
            </span>
          </label>
          <label className="display-opt">
            <input type="radio" name="stage-motion" checked={!displaySettings.stageMotion}
              onChange={() => onChangeDisplaySettings({ stageMotion: false })} />
            <span>
              {trx("<0>止める</0><1>粒は止まったまま出ます。画面の動きを「少なめ」にしたときも、OS でアニメーションを減らしているときも止まります</1>", undefined, [<b />, <small />])}
            </span>
          </label>
        </div>
      </div>
      )}

      </>}

      {/* === その他ペイン === */}
      {activePane === "other" && <>

      {/* この PC の git（PC のみ） */}
      {!isMobile && <GitInfoCard onOpenSetup={onOpenSetup} setupVersion={setupVersion} />}

      {/* Actions の「はじめる準備」に出すもの（今のリポジトリ・この PC）。スマホに Actions の画面はないので出さない */}
      {owner && repo && !isMobile && (
        <div className="form-card" id="settings-actions-setup">
          <h3 className="settings-section-title" style={{ marginBottom: "var(--space-xs)" }}>{tr("Actions の「はじめる準備」に出すもの")}</h3>
          <p className="settings-hint" style={{ marginBottom: "var(--space-sm)" }}>
            {trx("{owner}/{repo} の Actions の画面に出す勧めです。そこで「今は使わない」を押すと、ここのチェックが外れます。チェックしてあっても、要るときだけ出ます。", { owner, repo })}
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
          <h3 className="settings-section-title" style={{ marginBottom: "var(--space-sm)" }}>{tr("バージョン")}</h3>
          <div className="update-row">
            <span>Life Manager <b>{appVersion ? `v${appVersion}` : "…"}</b></span>
            <button type="button" className="btn-sm" onClick={checkUpdate} disabled={updateCheck === "checking" || update.updating}>
              {updateCheck === "checking" ? tr("確かめています…") : tr("新しいバージョンを確かめる")}
            </button>
          </div>
          {update.available ? (
            <div className="update-result update-result--new">
              <span>{trx("新しいバージョン <0>v{version}</0> があります", { version: update.available.version }, [<b />])}</span>
              <button type="button" className="btn-primary" onClick={onRunUpdate} disabled={update.updating}>
                {update.updating ? tr("更新しています…") : tr("今すぐ更新")}
              </button>
            </div>
          ) : updateCheck === "latest" ? (
            <p className="update-result">{tr("✔ 今のバージョンが最新です")}</p>
          ) : updateCheck === "error" ? (
            <p className="update-result update-result--error">{tr("確かめられませんでした。インターネットにつながっているか確かめて、もう一度押してください")}</p>
          ) : null}
          <p className="settings-hint" style={{ marginTop: "var(--space-sm)" }}>
            {tr("起動したときにも確かめます。新しいバージョンがあると、画面の上にお知らせが出ます。")}
          </p>
        </div>
      )}

      {/* フィードバック */}
      <div className="form-card">
          <div className="settings-section-header">
            <h3 className="settings-section-title">{tr("フィードバック")}</h3>
          </div>
          <p className="settings-hint" style={{ marginBottom: "var(--space-sm)" }}>
            {tr("バグ報告や機能要望をメールで送信できます。")}
          </p>
          <div className="flex-row" style={{ gap: "var(--space-xs)", marginBottom: "var(--space-sm)" }}>
            {(["bug", "feature", "other"] as const).map((cat) => {
              const catLabel = cat === "bug" ? tr("バグ報告") : cat === "feature" ? tr("機能要望") : tr("その他");
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
            placeholder={tr("タイトル")} className="input-full" style={{ marginBottom: "var(--space-xs)" }} />
          <textarea value={feedbackBody} onChange={(e) => setFeedbackBody(e.target.value)}
            placeholder={tr("詳細（任意）")} className="textarea-full" rows={3}
            style={{ marginBottom: "var(--space-sm)" }} />
          <button onClick={handleSendFeedback} className="btn-primary"
            disabled={!feedbackTitle.trim()}
            style={{ alignSelf: "flex-start" }}>
            {tr("メールで送信")}
          </button>
        </div>

      {/* バージョン・マニュアル */}
      <div style={{ textAlign: "center", marginTop: "var(--space-lg)" }}>
        <button
          className="btn-sm"
          // HTML のマニュアル（ブラウザで開く）。開けなければ GitHub の README
          onClick={() => void openManual()}
          style={{ fontSize: "var(--font-xs)" }}
        >
          {tr("マニュアルを開く")}
        </button>
        {appVersion && isMobile && (
          <p style={{ fontSize: "var(--font-xs)", color: "var(--text-faint)", marginTop: "var(--space-sm)" }}>
            Life Manager v{appVersion}
          </p>
        )}
      </div>

      </>}
      </div>
      )}
    </div>
  );
}
