import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { useGitHub } from "./hooks/useGitHub";
import { useLocalFolders } from "./hooks/useLocalFolders";
import { useGit } from "./hooks/useGit";
import { useGitActions } from "./hooks/useGitActions";
import { useDisplaySettings } from "./hooks/useDisplaySettings";
import { useOverlayScrollGuard } from "./hooks/useOverlayScrollGuard";
import { useHistory } from "./hooks/useHistory";
import { useOffline } from "./hooks/useOffline";
import { isMobile, THIS_DEVICE } from "./lib/platform";
import { isSending, isTemporary, issueRef } from "./lib/issueRef";
import { ancestors, homeBranches, listBranchEntries, type BranchEntry } from "./lib/history";
import { DashboardView } from "./components/views/DashboardView";
import { KanbanView } from "./components/views/KanbanView";
import { MilestoneView } from "./components/views/MilestoneView";
import { SettingsView, type SettingsPane, type UpdateCheck } from "./components/views/SettingsView";
import { RoutinesView } from "./components/views/RoutinesView";
import { TimelineView } from "./components/views/TimelineView";
import { GanttView } from "./components/views/GanttView";
import { WorkView, EMPTY_DRAFT, loadWorkIssue, type CommitDraft } from "./components/views/WorkView";
import { BranchesView } from "./components/views/BranchesView";
import { OverviewView } from "./components/views/OverviewView";
import { PullsView } from "./components/views/PullsView";
import { ActionsView } from "./components/views/ActionsView";
import { useActions } from "./hooks/useActions";
import { ReleasesView } from "./components/views/ReleasesView";
import { ActivityView } from "./components/views/ActivityView";
import { useActivity } from "./hooks/useActivity";
import { useNotices } from "./hooks/useNotices";
import { NoticeToasts } from "./components/notices/NoticeToasts";
import { NoticesDrawer } from "./components/notices/NoticesDrawer";
import { HelpDialog } from "./components/notices/HelpDialog";
import { lastGitFailure } from "./lib/gitFailure";
import { useSendingCount } from "./lib/sending";
import { SendingBird, SendingContext } from "./components/common/Sending";
import { Buncho } from "./components/common/Buncho";
import type { HelpContext } from "./lib/help";
import type { Notice } from "./lib/notices";
import type { PullDetail } from "./lib/pulls";
import { GitToolbar } from "./components/git/GitToolbar";
import { GitNotices } from "./components/git/GitNotices";
import { ConflictNotice } from "./components/git/ConflictNotice";
import { Celebration } from "./components/common/Celebration";
import { MilestoneCelebration } from "./components/milestones/MilestoneCelebration";
import { useMilestoneClear } from "./hooks/useMilestoneClear";
import { GitDialog } from "./components/git/GitDialog";
import { ContextMenu, type MenuSpec } from "./components/git/ContextMenu";
import { CommitDetail } from "./components/git/CommitDetail";
import { GitignoreEditor } from "./components/git/GitignoreEditor";
import { DEFAULT_COLUMNS } from "./lib/board";
import { EstimateUnitContext } from "./components/common/EstimateChip";
import { SetupDialog } from "./components/git/SetupDialog";
import { setupStatus as readSetupStatus } from "./lib/git";
import * as gitApi from "./lib/git";
import { CommandPalette } from "./components/common/CommandPalette";
import { IssueDetailModal } from "./components/common/IssueDetailModal";
import { IssueIndexContext, type IssueIndex } from "./components/common/SubIssueMarks";
import { SyncIndicator } from "./components/common/SyncIndicator";
import { ConflictDialog } from "./components/common/ConflictDialog";
import { SetupView } from "./components/views/SetupView";
import { ThemePicker, markThemeChosen, needsThemeChoice } from "./components/common/ThemePicker";
import { applyTheme, type Theme } from "./lib/theme";
import { InsightsView } from "./components/views/InsightsView";
import { useMediaQuery } from "./hooks/useMediaQuery";
import { adoptLogin, forgetAccount, isSetupPending, listAccounts, markSetupPending, restoreAccount, SIGNED_OUT_STORE, stashAccount, switchAccount, type TokenReport } from "./lib/auth";
import { TokenBanner } from "./components/common/TokenBanner";
import { AccountMenu } from "./components/common/AccountMenu";
import { RepoSwitcher } from "./components/common/RepoSwitcher";
import { RepoPicker } from "./components/common/RepoPicker";
import { AccountPicker } from "./components/common/AccountPicker";
import { AddRepoWizard } from "./components/common/AddRepoWizard";
import { MemoFab } from "./components/common/MemoFab";
import type { GitCommit, GitFileChange, GitHubIssue, GitSetupStatus, ViewType } from "./lib/types";
import type { LabelFilters } from "./lib/taskList";
import "./App.css";
import { isEscape } from "./lib/keys";
import { motionOn, setMotionEnabled, stepDirection, withTransition } from "./lib/motion";

type NavItem = { key: ViewType; icon: string; label: string };

// サイドバーの並び: ホーム（オーバービュー・ヒストリー）→ タスク系（作業から）→ リポジトリ系。設定はいちばん下。
// タスク系は、マイルストーンを作る → ボードでタスクを足す（マイルストーンに入れる）→ 日時・見積もりを入れてガントへ、の順。
// ルーチンは使う回数が少なく、タスク一覧は補助なので下に
const HOME_GROUP = "ホーム";
const INSIGHTS_ITEM: NavItem = { key: "insights", icon: "📈", label: "オーバービュー" };
const HOME_ITEMS: NavItem[] = [INSIGHTS_ITEM, { key: "activity", icon: "📰", label: "ヒストリー" }];
const WORK_ITEM: NavItem = { key: "work", icon: "✏️", label: "作業" };
const TASK_ITEMS: NavItem[] = [
  WORK_ITEM,
  { key: "milestones", icon: "🎯", label: "マイルストーン" },
  { key: "kanban", icon: "📊", label: "ボード" },
  { key: "gantt", icon: "📐", label: "ガント" },
  { key: "timeline", icon: "📅", label: "日誌" },
  { key: "routines", icon: "🔄", label: "ルーチン" },
  { key: "dashboard", icon: "📋", label: "タスク一覧" },
];
const REPO_ITEMS: NavItem[] = [
  { key: "branches", icon: "🌿", label: "ブランチ" },
  { key: "overview", icon: "🗺️", label: "全体図" },
  { key: "pulls", icon: "🔃", label: "プルリク" },
  { key: "actions", icon: "▶️", label: "Actions" },
  { key: "releases", icon: "🏷️", label: "リリース" },
];
const SETTINGS_ITEM: NavItem = { key: "settings", icon: "⚙️", label: "設定" };
const ALL_NAV_ITEMS: NavItem[] = [...HOME_ITEMS, ...TASK_ITEMS, ...REPO_ITEMS, SETTINGS_ITEM];
// スマホの下部ナビは従来どおり（オーバービューとタスク系。作業などの新しい画面はスマホ版を詰めるときに足す）
const MOBILE_NAV_ITEMS: NavItem[] = [INSIGHTS_ITEM, ...TASK_ITEMS.filter((item) => item !== WORK_ITEM), SETTINGS_ITEM];

const SIDEBAR_COLLAPSED_KEY = "sidebar-collapsed";
// たたむボタンの矢印（サイドバーのある端へ向ける）
const HIDE_ARROW = { left: "◀", right: "▶", top: "▲", bottom: "▼" } as const;
// 「次からは起動時に表示しない」を選んだか（使う準備のダイアログ）
const SETUP_DONT_SHOW_KEY = "setup-dont-show";

// 作業 → ブランチ → 全体図 は、右へ行くほど一歩ずつ引いて見る画面。切り替えは寄る・引く動きにする
const ZOOM_LEVELS: ViewType[] = ["work", "branches", "overview"];

function zoomAnimation(from: ViewType, to: ViewType): string {
  const a = ZOOM_LEVELS.indexOf(from);
  const b = ZOOM_LEVELS.indexOf(to);
  if (a < 0 || b < 0 || a === b) return "";
  return b > a ? " zoom-out" : " zoom-in";
}

function App() {
  const gh = useGitHub();
  const localFolders = useLocalFolders();
  const display = useDisplaySettings();
  // 重ねて出す詳細・ダイアログの上のホイールで、後ろの画面を動かさない
  useOverlayScrollGuard();
  const [view, setViewState] = useState<ViewType>("dashboard");
  // 画面を切り替える。動いた向きで動きの種類を変える: 作業 ⇄ ブランチ ⇄ 全体図 は奥行き（寄る・引く）、
  // ほかはサイドバーの並びの前後で、縦のサイドバーなら上下・横の帯（上・下に置いたとき、スマホの下のナビ）なら左右
  const viewRef = useRef(view);
  const sidebarPosRef = useRef(display.settings.sidebarPosition);
  sidebarPosRef.current = display.settings.sidebarPosition;
  const setView = useCallback((next: ViewType) => {
    const from = viewRef.current;
    if (next === from) return;
    viewRef.current = next;
    const a = ZOOM_LEVELS.indexOf(from);
    const b = ZOOM_LEVELS.indexOf(next);
    const pos = sidebarPosRef.current;
    const horizontal = isMobile || pos === "top" || pos === "bottom";
    const order = (isMobile ? MOBILE_NAV_ITEMS : ALL_NAV_ITEMS).map((item) => item.key);
    const dir = a >= 0 && b >= 0 ? (b > a ? "vt-out" : "vt-in") : stepDirection(order, from, next, horizontal ? "horizontal" : "vertical");
    withTransition(() => setViewState(next), ["vt-screen", dir]);
  }, []);
  useEffect(() => {
    setMotionEnabled(display.settings.motion === "normal");
  }, [display.settings.motion]);
  // 設定を開いたときに出すペインと区切り（「メンバーを招待する」・ログインとトークン・ボードの区画・ガントの色。設定を離れたら元に戻す）
  const [settingsPane, setSettingsPane] = useState<SettingsPane | null>(null);
  const [settingsSection, setSettingsSection] = useState<string | null>(null);
  // 設定を、決めた区分で開き直す（設定を開いたまま、アカウントのメニューから「ログインとトークン」を選んだときも）
  const [settingsNonce, setSettingsNonce] = useState(0);
  // リポジトリを追加（左上のリポジトリの一覧・設定 → 接続 から）
  const [addRepoOpen, setAddRepoOpen] = useState(false);
  useEffect(() => {
    if (view !== "settings") {
      setSettingsPane(null);
      setSettingsSection(null);
    }
  }, [view]);
  // git の操作は PC だけ。作業・ブランチ・全体図を開いているあいだは、状態をこまめに読み直す
  const folder = isMobile ? undefined : localFolders.folders[`${gh.owner}/${gh.repo}`];
  const repoView = view === "work" || view === "branches" || view === "overview" || view === "pulls";
  const git = useGit(folder, repoView);
  const {
    actions: gitActions,
    dialog: gitDialog,
    closeDialog: closeGitDialog,
    detail: commitDetail,
    closeDetail: closeCommitDetail,
    gitignoreOpen,
    closeGitignore,
  } = useGitActions(git, { owner: gh.owner, repo: gh.repo });
  // 右クリック・「⋯」のメニュー
  const [menu, setMenu] = useState<MenuSpec | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  // 使う準備（Git のインストール・コミットに使う名前）。setupVersion は、変わったら Git を確かめ直す合図
  const [setup, setSetup] = useState<{ status: GitSetupStatus; auto: boolean } | null>(null);
  const [setupVersion, setSetupVersion] = useState(0);
  const [commitDraft, setCommitDraft] = useState<CommitDraft>(EMPTY_DRAFT);
  const [commitRequest, setCommitRequest] = useState<{ empty: boolean } | null>(null);
  const clearCommitRequest = useCallback(() => setCommitRequest(null), []);

  // ブランチ画面・全体図の履歴（この PC の作業フォルダがあればその git から、なければ GitHub から読む）
  const historyView = view === "branches" || view === "overview";
  const historyReloadKey = git.status
    ? [git.status.head, git.status.branch, git.status.ahead, git.status.behind, git.opCount].join("|")
    : "";
  const hist = useHistory({ folder, owner: gh.owner, repo: gh.repo }, historyView, historyReloadKey);
  const byHash = useMemo(() => new Map((hist.history?.commits ?? []).map((c) => [c.hash, c])), [hist.history]);
  const branchEntries = useMemo(
    () => (hist.history ? listBranchEntries(hist.history, git.branches) : []),
    [hist.history, git.branches],
  );
  const homeOf = useMemo(() => homeBranches(byHash, branchEntries), [byHash, branchEntries]);
  // 見ているブランチ（ブランチ画面と全体図で共有）。未選択ならチェックアウト中、なければ既定のブランチ
  const [repoBranch, setRepoBranch] = useState<string | null>(null);
  const [focusCommit, setFocusCommit] = useState<string | null>(null);
  const clearFocusCommit = useCallback(() => setFocusCommit(null), []);
  const fallbackBranch = (branchEntries.find((e) => e.isCurrent) ?? branchEntries.find((e) => e.isDefault) ?? branchEntries[0])?.name ?? null;
  const selectedBranch = repoBranch && branchEntries.some((e) => e.name === repoBranch) ? repoBranch : fallbackBranch;
  // 今のブランチ（HEAD）の履歴にあるコミット（戻す・打ち消す・取り込むのメニューで使う）
  const headAncestors = useMemo(
    () => (hist.history?.head ? ancestors(byHash, hist.history.head) : new Set<string>()),
    [byHash, hist.history],
  );
  const historyIsLocal = hist.history?.source === "local";
  const openCommitMenu = (pos: { x: number; y: number }, c: GitCommit) =>
    setMenu({
      ...pos,
      title: `コミット ${c.hash.slice(0, 7)}`,
      items: gitActions.commitMenu(c, { local: historyIsLocal, inCurrent: headAncestors.has(c.hash) }),
    });
  const openBranchMenu = (pos: { x: number; y: number }, e: BranchEntry) =>
    setMenu({ ...pos, title: `ブランチ ${e.name}`, items: gitActions.branchMenu(e, historyIsLocal) });
  const openFileMenu = (pos: { x: number; y: number }, f: GitFileChange, conflict: boolean) =>
    setMenu({ ...pos, title: f.path, items: gitActions.fileMenu(f, conflict) });

  // 画面の切り替えの動き（同じ画面のあいだは変えない）
  const viewAnim = useRef<{ view: ViewType; anim: string }>({ view, anim: "" });
  if (viewAnim.current.view !== view) viewAnim.current = { view, anim: zoomAnimation(viewAnim.current.view, view) };
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  // たたんだサイドバーを、画面の端にマウスを寄せたときだけ出す
  const [sidebarPeek, setSidebarPeek] = useState(false);
  const peekTimer = useRef(0);
  const showSidebar = useCallback(() => {
    window.clearTimeout(peekTimer.current);
    setSidebarPeek(true);
  }, []);
  const hideSidebarSoon = useCallback(() => {
    window.clearTimeout(peekTimer.current);
    peekTimer.current = window.setTimeout(() => setSidebarPeek(false), 350);
  }, []);
  const [showPalette, setShowPalette] = useState(false);
  const [filters, setFilters] = useState<LabelFilters>({});
  const [selectedIssue, setSelectedIssue] = useState<number | null>(null);
  // オフラインのあいだの変更（送信待ち）。送信待ちが変わったら手元の写しで、送れたら GitHub から読み直す
  const offline = useOffline(gh.owner, gh.repo, gh.connected, {
    onChanged: gh.reloadCached,
    onSynced: gh.loadAll,
    // 仮の番号の Issue を開いていたら、GitHub に作られた番号に切り替える
    onCreated: (temp, real) => setSelectedIssue((cur) => (cur === temp ? real : cur)),
  });
  const [showConflicts, setShowConflicts] = useState(false);
  const openConflicts = useCallback(() => setShowConflicts(true), []);
  const closeConflicts = useCallback(() => setShowConflicts(false), []);
  const syncIndicator = (
    <SyncIndicator
      status={offline.status}
      syncing={offline.syncing}
      stopped={offline.stopped}
      onSync={offline.sync}
      onOpenConflicts={openConflicts}
    />
  );
  // 作業タブで選べるのは、GitHub の番号がある Issue だけ（コミットのメッセージに番号を入れるため）
  const workIssues = useMemo(() => gh.issues.filter((i) => !isTemporary(i.number)), [gh.issues]);
  // 送れなかった仮の Issue の「もう一度」「やめる」（カード・付箋から）
  const { retrySending, discardSending } = gh;
  const sendingActions = useMemo(
    () => ({ retry: (n: number) => void retrySending(n), discard: discardSending }),
    [retrySending, discardSending],
  );
  // 番号で Issue を引く（カードに親の題名を出すなど）
  const issueIndex = useMemo<IssueIndex>(() => {
    const byNumber = new Map<number, GitHubIssue>();
    for (const i of gh.closedIssues) byNumber.set(i.number, i);
    for (const i of gh.issues) byNumber.set(i.number, i);
    return { owner: gh.owner, repo: gh.repo, find: (n) => byNumber.get(n) };
  }, [gh.issues, gh.closedIssues, gh.owner, gh.repo]);
  // 詳細の中で子を開いたとき、その子がまだ一覧にない（読み込んだあとに GitHub で作られたなど）なら、渡された中身で開く
  const [openedFallback, setOpenedFallback] = useState<GitHubIssue | null>(null);
  const openIssue = useCallback((n: number, fallback?: GitHubIssue) => {
    setOpenedFallback(fallback ?? null);
    setSelectedIssue(n);
  }, []);

  // 一覧のカード（か表の行）から詳細を開く・閉じる: カードがふくらんで詳細になり、閉じると元の場所へ戻る（奥行き）
  const issueSource = (n: number) => document.querySelector<HTMLElement>(`.issue-card[data-issue="${n}"], .task-row[data-issue="${n}"]`);
  const openIssueFromList = useCallback((n: number) => {
    const source = issueSource(n);
    if (!source || !motionOn()) {
      setSelectedIssue(n);
      return;
    }
    source.style.viewTransitionName = "issue-detail";
    withTransition(() => {
      source.style.viewTransitionName = "";
      setSelectedIssue(n);
    }, ["vt-detail"]);
  }, []);
  const closeIssueDetail = useCallback((n: number | null) => {
    let target: HTMLElement | null = null;
    withTransition(() => {
      setSelectedIssue(null);
      target = n === null ? null : issueSource(n);
      if (target) target.style.viewTransitionName = "issue-detail";
    }, ["vt-detail"]).then(() => {
      if (target) target.style.viewTransitionName = "";
    });
  }, []);

  // タスク（PC で窓が広く、カードのとき）: 左に一覧、右に選んだタスクの詳細。選んだタスクは、リポジトリごとに覚える
  const wideEnough = useMediaQuery("(min-width: 1100px)");
  const [taskSplit, setTaskSplit] = useState(false);
  const taskSelectedKey = `task-selected:${gh.owner}/${gh.repo}`;
  const [taskSelected, setTaskSelected] = useState<number | null>(null);
  useEffect(() => {
    try {
      const saved = localStorage.getItem(taskSelectedKey);
      setTaskSelected(saved ? Number(saved) : null);
    } catch {
      setTaskSelected(null);
    }
  }, [taskSelectedKey]);
  const selectTask = useCallback((n: number | null) => {
    setTaskSelected(n);
    try {
      if (n === null) localStorage.removeItem(taskSelectedKey);
      else localStorage.setItem(taskSelectedKey, String(n));
    } catch {
      // 覚えられなくても、今は右に出せる
    }
  }, [taskSelectedKey]);
  const openTask = useCallback((n: number, fallback?: GitHubIssue) => {
    setOpenedFallback(fallback ?? null);
    selectTask(n);
  }, [selectTask]);
  const subIssueApi = { list: gh.listSubIssues, create: gh.createSubIssue, add: gh.addSubIssue, remove: gh.removeSubIssue };
  // Issue の変更の履歴から開いたコミット（手元にまだないこともあるので、GitHub から読む）
  const [timelineCommit, setTimelineCommit] = useState<GitCommit | null>(null);
  const showTimelineCommit = useCallback((hash: string, actor: string, date: string) => {
    setTimelineCommit({ hash, parents: [], author: actor, date, subject: "" });
  }, []);
  const [initializing, setInitializing] = useState(true);
  // セットアップの途中で閉じた → 前のプロジェクトは開かず、セットアップの続きから
  const [resumeSetup, setResumeSetup] = useState(false);
  // はじめて起動したとき、ログインの前に見た目を選ぶ（選んだら、セットアップの手順の 1. に「見た目」を出し、押すと選び直せる）
  const [themeFirst, setThemeFirst] = useState(needsThemeChoice);
  const [lookChosen, setLookChosen] = useState(false);
  const previewTheme = useCallback((t: Theme) => applyTheme(t), []);
  // 別のアカウントを足しているところ（足す前のアカウントの名前。やめたら、そのアカウントに戻る）
  const [addingAccount, setAddingAccount] = useState<string | null>(null);
  // 選ぶ画面。アカウントは、起動したとき（この PC にアカウントが 2 つ以上）と、左下のメニュー・リポジトリを選ぶ画面の右上から
  const [accountPicker, setAccountPicker] = useState<"startup" | "menu" | null>(null);
  const [repoPickerOpen, setRepoPickerOpen] = useState(false);
  // 競合（コンフリクト）の知らせ。同じ競合では 1 回だけ出す（競合がなくなったら、次の競合でまた出す）
  const [conflictNotice, setConflictNotice] = useState(false);
  const toldConflict = useRef<string | null>(null);
  const [updateAvailable, setUpdateAvailable] = useState<{ version: string; body: string } | null>(null);
  const [updating, setUpdating] = useState(false);
  // 上のお知らせの「後で」（設定 → その他 の バージョン には出したまま）
  const [updateBannerHidden, setUpdateBannerHidden] = useState(false);
  // マイルストーンの最後のタスクを完了にしたら（どの画面からでも）、大きく祝う
  useMilestoneClear(`${gh.owner}/${gh.repo}`, gh.milestones, gh.issues, gh.closedIssues, gh.estimateUnit, gh.connected && !initializing);

  // アップデートチェック（起動したときと、設定 → その他 の「新しいバージョンを確かめる」）
  const checkForUpdate = useCallback(async (): Promise<UpdateCheck> => {
    try {
      const update = await check();
      if (update) {
        setUpdateAvailable({ version: update.version, body: update.body || "" });
        return "available";
      }
      return "latest";
    } catch {
      // 起動したときの失敗は知らせない（設定から確かめたときだけ出す）
      return "error";
    }
  }, []);

  // アップデート実行
  const performUpdate = useCallback(async () => {
    try {
      setUpdating(true);
      const update = await check();
      if (update) {
        await update.downloadAndInstall();
        await relaunch();
      }
    } catch (e) {
      gh.setStatus("アップデートエラー: " + e);
      setUpdating(false);
    }
  }, []);

  // 起動時: トークン読み込み + 通知パーミッション要求 + アップデートチェック
  useEffect(() => {
    async function init() {
      if (isSetupPending()) {
        // セットアップの途中で閉じた（別のアカウントでログインし直したところかもしれない）→ 続きから
        setResumeSetup(true);
      } else {
        try {
          await gh.loadToken();
          // この PC にアカウントが 2 つ以上ある（学校の PC などを何人かで使う）→ だれが使うかを選んでから
          if ((await listAccounts().catch(() => [])).length > 0) setAccountPicker("startup");
        } catch {
          // トークン未設定 → セットアップ画面を表示
        }
      }
      // Android 13+ 通知パーミッション
      try {
        const granted = await isPermissionGranted();
        if (!granted) await requestPermission();
      } catch {
        // デスクトップでは不要
      }
      // ウィンドウタイトルにバージョン表示
      try {
        const ver = await invoke("get_app_version") as string;
        await getCurrentWindow().setTitle(`Life Manager v${ver}`);
      } catch {}
      setInitializing(false);
      // バックグラウンドでアップデートチェック
      checkForUpdate();
    }
    init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ctrl+K でコマンドパレット
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        setShowPalette((prev) => !prev);
      }
      // Ctrl+B でサイドバーをたたむ・固定する
      if ((e.ctrlKey || e.metaKey) && (e.key === "b" || e.key === "B")) {
        e.preventDefault();
        toggleSidebar();
      }
      if (isEscape(e)) {
        setShowPalette(false);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // 最初のセットアップ: ログイン（またはトークン）はもう済んでいる。使うリポジトリをプロジェクトにして、つなぐ
  // （トークンはプロジェクト専用には入れない。いつものトークンを使う）
  async function handleSetupDone(owner: string, repo: string, inviteNext = false, folder?: string) {
    await gh.setRepoConfig(owner, repo);
    await gh.addProject(owner, repo, `${owner}/${repo}`);
    // 新しく作って、この PC にクローンしたとき
    if (folder) await localFolders.setFolder(owner, repo, folder);
    // 別のアカウントを足したときは、前のアカウントのデータを捨てて読み直す
    if (addingAccount) await gh.reloadAccount();
    else await gh.loadToken();
    markSetupPending(false);
    setResumeSetup(false);
    setAddingAccount(null);
    // 「はじめて、メンバーを招待する」なら 設定 → 接続 を開く
    if (inviteNext) setSettingsPane("connection");
    setView(inviteNext ? "settings" : "dashboard");
  }

  // --- アカウントの切り替え ---

  // 今のアカウントを切り替えた・戻したあと: 開いていた詳細を閉じ、そのアカウントのリポジトリを読み直す
  async function afterAccountChange(message: string) {
    setSelectedIssue(null);
    markSetupPending(false);
    setResumeSetup(false);
    setAddingAccount(null);
    await gh.reloadAccount();
    gh.setStatus(message);
  }

  // 送っていない変更があるあいだは切り替えない（前のアカウントの変更を、次のアカウントで送ってしまわないように）
  const accountSwitchBlocked = offline.status.pending.length > 0
    ? `まだ GitHub に送っていない変更が ${offline.status.pending.length} 件あります。送ってから切り替えてください`
    : undefined;

  async function handleSwitchAccount(target: string, currentAvatar?: string | null) {
    const from = gh.currentUser;
    try {
      await switchAccount(from, currentAvatar, target);
      await afterAccountChange(`${target} に切り替えました（${from} は左下のメニューから戻れます）`);
    } catch (e) {
      gh.setStatus(`切り替えられませんでした: ${e}`);
    }
  }

  // 別のアカウントを足す: 今のアカウントをしまって、ログインの画面へ
  async function handleAddAccount(currentAvatar?: string | null) {
    const from = gh.currentUser;
    try {
      await stashAccount(from, currentAvatar);
      setSelectedIssue(null);
      setAddingAccount(from);
    } catch (e) {
      gh.setStatus(`アカウントを足せませんでした: ${e}`);
    }
  }

  // ログインの画面から、しまってあるアカウントに戻る（足すのをやめた・ほかのアカウントで続ける）
  async function handleRestoreAccount(login: string) {
    await restoreAccount(login);
    try {
      sessionStorage.removeItem(SIGNED_OUT_STORE);
    } catch {
      // 知らせの印が残っても、使うのに困らない
    }
    await afterAccountChange(`${login} に戻りました`);
  }

  // ログインできた: 前にこの PC で使っていたアカウントなら、そのリポジトリの一覧に戻して、セットアップを飛ばす
  async function handleLoggedIn(report: TokenReport): Promise<boolean> {
    const restored = await adoptLogin(report.login);
    if (!restored) return false;
    const same = addingAccount && addingAccount.toLowerCase() === report.login.toLowerCase();
    await afterAccountChange(
      same
        ? `${report.login} のままでした。別のアカウントを足すときは、ブラウザの GitHub を切り替えてからログインしてください`
        : `${report.login} でログインしました`,
    );
    return true;
  }

  async function handleForgetAccount(login: string) {
    await forgetAccount(login);
    gh.setStatus(`${login} を、${THIS_DEVICE}から外しました`);
  }

  // ログアウト: 今のアカウントだけ。ほかにしまってあるアカウントがあれば、そちらに切り替える
  async function handleSignOut() {
    const from = gh.currentUser;
    const others = await listAccounts().catch(() => []);
    await gh.signOut();
    if (others.length > 0) {
      await handleRestoreAccount(others[0].login);
      gh.setStatus(`${from} からログアウトしました。${others[0].login} に切り替えました`);
    }
  }

  useEffect(() => {
    const st = git.status;
    if (!folder || !st) return;
    if (!st.conflicted) {
      toldConflict.current = null;
      return;
    }
    const key = `${folder}|${st.operation ?? "-"}|${st.head ?? ""}`;
    if (toldConflict.current === key) return;
    toldConflict.current = key;
    setConflictNotice(true);
  }, [folder, git.status]);

  // 設定を、決めた区分（と区切り）で開く
  function openSettings(pane: SettingsPane, section?: string) {
    setSettingsPane(pane);
    setSettingsSection(section ?? null);
    setSettingsNonce((n) => n + 1);
    setView("settings");
  }
  // アカウントのメニューの「ログインとトークン」・トークンの期限のお知らせ: 設定 → トークン を開く
  function openTokens() {
    openSettings("tokens");
  }

  async function handleSwitchProject(projOwner: string, projRepo: string) {
    await gh.switchProject(projOwner, projRepo);
  }

  // プルリク: 見ているプルリク（作業タブから開けるよう、ここで持つ）と、作業タブからの「プルリクを作る」
  const [pullSelected, setPullSelected] = useState<number | null>(null);
  const [pullCreate, setPullCreate] = useState<{ head: string | null; issue: number | null } | null>(null);
  const clearPullCreate = useCallback(() => setPullCreate(null), []);
  const openPull = useCallback((n: number) => {
    setPullSelected(n);
    setView("pulls");
  }, [setView]);
  const createPull = useCallback((head: string | null, issue: number | null) => {
    setPullCreate({ head, issue });
    setView("pulls");
  }, [setView]);
  // 作業を始める（作業タブの ① で選んだとき）: 自分が担当でなければ自分を担当にし、状態を「進行中」にする（ボードと合わせる）
  const startWork = async (n: number) => {
    const issue = gh.issues.find((i) => i.number === n);
    if (!issue) return;
    if (gh.currentUser && !issue.assignees?.some((a) => a.login === gh.currentUser)) await gh.assignToMe(n);
    if (!issue.labels.some((l) => l.name === "状態:進行中")) await gh.changeIssueStatus(n, "状態:進行中");
  };
  // Actions: 解決する順の山（サイドバーの 🔴・🟠 の数のため、画面を開いていなくても読む）と、プルリクのチェックから開く実行
  const actions = useActions(gh.owner, gh.repo, gh.connected && !isMobile, view === "actions", gh.currentUser);
  // ヒストリー: チームの動きと「あなたがすること」（サイドバーの数のため、画面を開いていなくても読む）
  // 送っている途中の仮の Issue（まだ番号がない）は、期限の知らせなどに入れない
  const sentIssues = useMemo(() => gh.issues.filter((i) => !isSending(i.number)), [gh.issues]);
  const activity = useActivity(gh.owner, gh.repo, gh.currentUser, gh.connected && !isMobile, view === "activity", sentIssues, actions.stack);
  const [actionsFocus, setActionsFocus] = useState<{ runId: number; jobId?: number | null } | null>(null);
  const clearActionsFocus = useCallback(() => setActionsFocus(null), []);
  const openRun = useCallback((runId: number, jobId?: number | null) => {
    setActionsFocus({ runId, jobId });
    setView("actions");
  }, [setView]);
  // おしらせ（🔔 のりれきと、アプリの窓の外の おしらせの窓）。「開く」で、その Issue・プルリク・Actions・画面へ
  const [noticesOpen, setNoticesOpen] = useState(false);
  const closeNotices = useCallback(() => setNoticesOpen(false), []);
  const openNotice = useCallback((n: Notice) => {
    setNoticesOpen(false);
    // ほかのリポジトリの知らせなら、そのリポジトリに切り替えて、ヒストリー（あなたがすること）を出す
    if (n.repo && n.repo !== `${gh.owner}/${gh.repo}`) {
      const [o, r] = n.repo.split("/");
      if (gh.projects.some((p) => p.owner === o && p.repo === r)) {
        void gh.switchProject(o, r).then(() => setView("activity"));
      }
      return;
    }
    const t = n.target;
    if (!t) return;
    if (t.kind === "run") openRun(t.runId);
    else if (t.kind === "view") {
      const next = t.view;
      if (ALL_NAV_ITEMS.some((item) => item.key === next)) setView(next as ViewType);
    } else if (t.kind === "pull") openPull(t.number);
    else openIssue(t.number);
  }, [gh, openIssue, openPull, openRun, setView]);
  const notices = useNotices({
    repo: gh.owner ? `${gh.owner}/${gh.repo}` : "",
    me: gh.currentUser,
    // ヒストリーを読めてから（読む前の「あなたがすること」は、期限などだけ）
    todos: activity.feed ? activity.all : null,
    shown: activity.todos.length,
    pullsSettled: activity.pullsSettled,
    enabled: gh.connected && !isMobile && !initializing,
    corner: display.settings.noticeCorner,
    onOpen: openNotice,
    onOpenHistory: () => setNoticesOpen(true),
  });
  const { clearDot: clearNoticeDot, clearToasts: clearNoticeToasts } = notices;
  // りれきを開いたら、🔔 の点を消し（未読の数は持たない）、アプリの中に出している知らせを片付ける
  useEffect(() => {
    if (!noticesOpen) return;
    clearNoticeDot();
    clearNoticeToasts();
  }, [noticesOpen, clearNoticeDot, clearNoticeToasts]);
  // × を押したとき、インジケーターに残すか（PC だけ。設定 → 通知）
  useEffect(() => {
    if (!isMobile) invoke("set_close_to_tray", { on: display.settings.closeToTray }).catch(() => {});
  }, [display.settings.closeToTray]);
  // 🆘 助けを求める（Issue の詳細・作業タブから）。いっしょに送れる今のようすは、開いたときのもの
  const [helpFor, setHelpFor] = useState<{ number: number; title: string; context: HelpContext } | null>(null);
  // 🆘 を送ったら、開いている詳細のコメントを読み直す
  const [commentsVersion, setCommentsVersion] = useState(0);
  const askHelp = useCallback(async (issue: { number: number; title: string }) => {
    // 作業の画面を開いていないと、git のようすが古いことがあるので読み直す
    const st = folder && !isMobile ? await gitApi.readStatus(folder).catch(() => git.status) : null;
    const failure = lastGitFailure();
    setHelpFor({
      number: issue.number,
      title: issue.title,
      context: {
        branch: st?.branch ? { name: st.branch, changes: st.files.length } : undefined,
        failure: failure ? { command: failure.command, message: failure.message } : undefined,
        conflicts: st?.files.filter((f) => f.staged === "U").map((f) => f.path),
      },
    });
  }, [folder, git.status]);
  // プルリクの競合を、この PC の作業フォルダで直す: 最新を取ってきて、そのブランチで入れる先を取り込む → 作業タブの「競合を直す」へ
  const fixPullLocally = useCallback(async (p: PullDetail) => {
    const st = git.status;
    if (!st) return;
    if (st.files.length > 0 || st.operation) {
      git.notify("error", "作業中の変更（または途中の操作）があります。先にコミットするか、退避してから、もう一度「この PC で直す」を押します");
      setView("work");
      return;
    }
    const fetched = await git.exec("フェッチしています", gitApi.fetch, "GitHub の最新を取ってきました");
    if (!fetched.ok) return;
    if (st.branch !== p.head) {
      const switched = await git.exec("切り替えています", (path) => gitApi.switchBranch(path, p.head, false), `${p.head} に切り替えました`);
      if (!switched.ok) return;
    }
    await git.exec("取り込んでいます", (path) => gitApi.pull(path), `${p.head} を GitHub の最新にしました`, { quiet: true });
    await git.exec("取り込んでいます", (path) => gitApi.merge(path, `origin/${p.base}`), `origin/${p.base} を ${p.head} に取り込みました（競合はありませんでした）`);
    setView("work");
  }, [git, setView]);

  // 別のリポジトリに切り替えたら、コミット欄の書きかけや見ていたブランチは持ち越さない
  useEffect(() => {
    setCommitDraft(EMPTY_DRAFT);
    setRepoBranch(null);
    setFocusCommit(null);
    setPullSelected(null);
    setPullCreate(null);
    setActionsFocus(null);
  }, [gh.owner, gh.repo]);

  // 全体図の点をクリック: そのコミットを積み重ねてきたブランチのページで、そのコミットへ寄る
  const openCommit = useCallback(
    (hash: string) => {
      setRepoBranch(homeOf.get(hash) ?? fallbackBranch);
      setFocusCommit(hash);
      setView("branches");
    },
    [homeOf, fallbackBranch],
  );

  // −／＋ キーと Ctrl＋ホイールで、作業 ⇄ ブランチ ⇄ 全体図 を一段ずつ引いたり寄ったりする
  useEffect(() => {
    const level = ZOOM_LEVELS.indexOf(view);
    if (level < 0) return;
    const step = (dir: number) => {
      const next = ZOOM_LEVELS[level + dir];
      // スマホ版には作業タブがない
      if (next && !(next === "work" && isMobile)) setView(next);
    };
    function onKeyDown(e: KeyboardEvent) {
      const t = e.target as HTMLElement;
      if (e.ctrlKey || e.metaKey || e.altKey || t.closest?.("input, textarea, select, [contenteditable]")) return;
      if (e.key === "-") { e.preventDefault(); step(1); }
      else if (e.key === "+" || e.key === "=") { e.preventDefault(); step(-1); }
    }
    let lastWheel = 0;
    function onWheel(e: WheelEvent) {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const now = Date.now();
      if (now - lastWheel < 450) return;
      lastWheel = now;
      step(e.deltaY > 0 ? 1 : -1);
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("wheel", onWheel);
    };
  }, [view]);

  // 起動したら（PC のみ）、Git が入っているか・コミットに使う名前が決まっているかを確かめ、足りなければ案内する
  const setupChecked = useRef(false);
  useEffect(() => {
    if (isMobile || !gh.connected || setupChecked.current) return;
    setupChecked.current = true;
    let dontShow = false;
    try {
      dontShow = localStorage.getItem(SETUP_DONT_SHOW_KEY) === "1";
    } catch {
      // 読めなければ案内する
    }
    if (dontShow) return;
    readSetupStatus()
      .then((status) => {
        if (!status.git || !status.user_name || !status.user_email) setSetup({ status, auto: true });
      })
      .catch((e) => console.error("使う準備を確かめられませんでした:", e));
  }, [gh.connected]);

  const openSetup = useCallback(() => {
    readSetupStatus()
      .then((status) => setSetup({ status, auto: false }))
      .catch((e) => git.notify("error", String(e)));
  }, [git.notify]);

  function closeSetup(dontShow: boolean) {
    if (dontShow) {
      try {
        localStorage.setItem(SETUP_DONT_SHOW_KEY, "1");
      } catch {
        // 保存できなくても閉じる
      }
    }
    setSetup(null);
  }

  // Git を入れた・名前を決めたあとは、Git の有無と作業フォルダの状態を読み直す
  function handleSetupChanged() {
    setSetupVersion((v) => v + 1);
    git.refresh();
  }

  // ツールバーの「コミット…」「空コミット…」: 作業タブを開いてコミット欄に移る
  function handleOpenCommit(empty: boolean) {
    setView("work");
    setCommitRequest({ empty });
  }

  function toggleSidebar() {
    setSidebarPeek(false);
    setSidebarCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
      } catch {
        // 保存できなくても表示は切り替わる
      }
      return next;
    });
  }

  function renderNavItem(item: NavItem) {
    // 作業には、作業中の変更があるファイルの数を出す（競合しているあいだは ⚠ を出す）
    const count = item.key === "work" ? git.status?.files.length ?? 0 : 0;
    const conflicted = item.key === "work" && !!git.status?.conflicted;
    // Actions には、すぐ直す・早めに直すものの数。ヒストリーには、あなたがすることの数
    const urgent = item.key === "actions" ? actions.urgent : 0;
    const todo = item.key === "activity" ? activity.todos.length : 0;
    return (
      <button
        key={item.key}
        className={`sidebar-item ${view === item.key ? "active" : ""}`}
        data-view={item.key}
        onClick={() => {
          setView(item.key);
          setSidebarPeek(false);
        }}
        title={
          conflicted
            ? `${item.label}（競合しています）`
            : count > 0
              ? `${item.label}（作業中の変更 ${count}）`
              : urgent > 0
                ? `${item.label}（すぐ・早めに直すもの ${urgent}）`
                : todo > 0
                  ? `${item.label}（あなたがすること ${todo}）`
                  : item.label
        }
      >
        {/* 選んでいる画面の印（画面を切り替えると、次の画面の印まですべって移る） */}
        {view === item.key && <span className="sidebar-active-bg" aria-hidden="true" />}
        <span className="sidebar-icon">{item.icon}</span>
        <span className="sidebar-label">{item.label}</span>
        {conflicted ? <span className="sidebar-conflict">⚠ 競合</span> : count > 0 && <span className="sidebar-count">{count}</span>}
        {urgent > 0 && <span className="sidebar-alert">{urgent}</span>}
        {todo > 0 && <span className="sidebar-todo">{todo}</span>}
      </button>
    );
  }

  const currentLabel = ALL_NAV_ITEMS.find((item) => item.key === view)?.label ?? "";
  // GitHub に書いている数（上のバーの「送っています N」）
  const sendingCount = useSendingCount();
  // 作業タブで取り組んでいる Issue（上のバーの 🆘 助けを求める）
  const workIssueNumber = view === "work" ? loadWorkIssue(gh.owner, gh.repo) : null;
  const workIssue = workIssueNumber !== null ? gh.issues.find((i) => i.number === workIssueNumber) ?? null : null;

  // 左上のリポジトリ（押すと一覧。切り替え・この PC のフォルダ・一覧から外す・リポジトリを追加）
  const projectSelect = (
    <RepoSwitcher
      projects={gh.projects}
      owner={gh.owner}
      repo={gh.repo}
      folders={localFolders.folders}
      onSwitch={handleSwitchProject}
      onRemove={gh.removeProject}
      onSetFolder={localFolders.setFolder}
      onAdd={() => setAddRepoOpen(true)}
      onOpenPicker={isMobile ? undefined : () => setRepoPickerOpen(true)}
    />
  );

  // 初期化中
  if (initializing) {
    return (
      <main className="app" style={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: "100vh" }}>
        <p style={{ color: "var(--text-muted)" }}>読み込み中...</p>
      </main>
    );
  }

  // 未接続・セットアップの途中 → セットアップ画面
  if (!gh.connected || resumeSetup || addingAccount) {
    if (themeFirst && !addingAccount) {
      return (
        <ThemePicker
          initial={display.settings.theme}
          onPreview={previewTheme}
          onDone={(t) => {
            display.update({ theme: t });
            markThemeChosen();
            setThemeFirst(false);
            setLookChosen(true);
          }}
        />
      );
    }
    return (
      <SetupView
        onLook={lookChosen ? () => setThemeFirst(true) : undefined}
        onDone={handleSetupDone}
        resume={resumeSetup}
        adding={addingAccount}
        onRestoreAccount={handleRestoreAccount}
        onLoggedIn={handleLoggedIn}
      />
    );
  }

  // Issue の詳細。重ねて出す（ほかの画面・スマホ）か、タスクの右の欄に出す（inline）
  function renderIssueDetail(n: number | null, inline: boolean, onClose: () => void, onOpen: (n: number, fallback?: GitHubIssue) => void) {
    // 送っている途中の仮の Issue（まだ GitHub に番号がない）は、詳細を出さない
    if (n === null || isSending(n)) return null;
    const issueObj = gh.issues.find((i) => i.number === n)
      || gh.closedIssues.find((i) => i.number === n)
      || (openedFallback?.number === n ? openedFallback : undefined);
    if (!issueObj) return null;
    return (
      <IssueDetailModal
        // 親・子へ移ったら、書きかけの状態を持ち越さないよう作り直す
        key={issueObj.number}
        inline={inline}
        issue={issueObj}
        onClose={onClose}
        listComments={gh.listComments}
        createComment={gh.createComment}
        availableLabels={gh.customLabels}
        milestones={gh.milestones}
        collaborators={gh.collaborators}
        updateIssue={gh.updateIssue}
        onCloseIssue={gh.closeIssue}
        onReopenIssue={gh.reopenIssue}
        onToggleTodo={gh.updateIssueBody}
        reminders={gh.reminders}
        onAddReminder={gh.addReminder}
        onRemoveReminder={gh.removeReminder}
        allIssues={[...gh.issues, ...gh.closedIssues]}
        onOpenIssue={onOpen}
        subIssueApi={subIssueApi}
        listTimeline={gh.listTimeline}
        onShowCommit={showTimelineCommit}
        onSetEstimate={gh.setEstimate}
        artifacts={gh.owner ? { owner: gh.owner, repo: gh.repo, folder } : undefined}
        me={gh.currentUser}
        onAskHelp={(i) => void askHelp(i)}
        commentsVersion={commentsVersion}
      />
    );
  }

  const shell = (
    <main className={`app app-shell sb-${display.settings.sidebarPosition}${sidebarCollapsed ? " sb-hidden" : ""}${display.settings.hints ? "" : " hints-off"} motion-${display.settings.motion}`}
      data-view={view}>
      {/* たたんだサイドバーは、画面の端にマウスを寄せると出てくる */}
      {sidebarCollapsed && (
        <div className="sidebar-hotzone" aria-hidden="true" onMouseEnter={showSidebar} onMouseLeave={hideSidebarSoon} />
      )}
      {/* サイドバー（PC。置く場所は 設定 → 表示 で左右上下から選べる） */}
      <aside
        className={`sidebar${sidebarCollapsed && sidebarPeek ? " peek" : ""}`}
        onMouseEnter={sidebarCollapsed ? showSidebar : undefined}
        onMouseLeave={sidebarCollapsed ? hideSidebarSoon : undefined}
        onFocus={sidebarCollapsed ? showSidebar : undefined}
        onBlur={
          sidebarCollapsed
            ? (e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) hideSidebarSoon();
              }
            : undefined
        }
      >
        <div className="sidebar-top">
          <div className="sidebar-title">Life Manager</div>
          {projectSelect}
        </div>
        <nav className="sidebar-nav">
          <div className="sidebar-group">{HOME_GROUP}</div>
          {HOME_ITEMS.map(renderNavItem)}
          <div className="sidebar-group">タスク</div>
          {TASK_ITEMS.map(renderNavItem)}
          <div className="sidebar-group">リポジトリ</div>
          {REPO_ITEMS.map(renderNavItem)}
        </nav>
        <div className="sidebar-bottom">
          {renderNavItem(SETTINGS_ITEM)}
          <button
            className="sidebar-item sidebar-toggle"
            onClick={toggleSidebar}
            title={sidebarCollapsed ? "サイドバーを固定する（Ctrl+B）" : "サイドバーをたたむ（Ctrl+B）。たたむと、画面の端にマウスを寄せたときだけ出てきます"}
          >
            <span className="sidebar-icon">{sidebarCollapsed ? "📌" : HIDE_ARROW[display.settings.sidebarPosition]}</span>
            <span className="sidebar-label">{sidebarCollapsed ? "固定する" : "たたむ"}</span>
          </button>
        </div>
        {/* 一番下: ログインしているアカウント（押すとメニュー） */}
        <AccountMenu
          login={gh.currentUser}
          onOpenTokens={openTokens}
          onSignOut={handleSignOut}
          onOpenAccounts={() => setAccountPicker("menu")}
        />
      </aside>

      <div className="app-main">
        {/* 上のバー（PC） */}
        <header className="topbar">
          <h1 className="topbar-title">{currentLabel}</h1>
          {repoView && git.status && (
            <GitToolbar git={git} actions={gitActions} onOpenCommit={handleOpenCommit} />
          )}
          <div className="topbar-right">
            {/* 文鳥のテーマ: パートナーの文鳥は、ボード以外の画面では上のバーにとまる（ボードでは止まり木にいる） */}
            {display.settings.theme === "buncho" && view !== "kanban" && (
              <span className="topbar-partner" aria-hidden="true">
                <Buncho />
              </span>
            )}
            {/* git の操作の結果は右下に出すので、リポジトリの画面では場所をツールバーにゆずる */}
            {!(repoView && git.status) && <span className="status-text">{gh.status}</span>}
            {view === "work" && workIssue && (
              <button type="button" className="btn-help" onClick={() => void askHelp(workIssue)} title={`チームの人を @ で呼んで、${workIssue.title} にコメントを残します`}>
                🆘 助けを求める
              </button>
            )}
            {sendingCount > 0 && (
              <span className="sending-top" role="status" title="GitHub に送っています（返事が来るまで）">
                <i className="sending-spin" aria-hidden="true" />
                <SendingBird />
                送っています {sendingCount}
              </span>
            )}
            {syncIndicator}
            {!isMobile && (
              <button
                type="button"
                className={`nt-bell${noticesOpen ? " on" : ""}`}
                onClick={() => setNoticesOpen((v) => !v)}
                aria-label="おしらせ"
                aria-expanded={noticesOpen}
                title={notices.dot ? "おしらせ（新しい知らせがあります）" : "おしらせ（届いた知らせのりれき）"}
              >
                🔔{notices.dot && <i className="nt-bell-dot" aria-hidden="true" />}
              </button>
            )}
            <button className="btn-sm" onClick={() => { setShowPalette(true); }}>
              Ctrl+K
            </button>
          </div>
        </header>

        {/* ヘッダー（スマホ） */}
        <header className="header mobile-header">
          <h1 className="header-title" style={{ margin: 0, fontSize: "var(--font-xl)" }}>Life Manager</h1>
          {projectSelect}
          {syncIndicator}
        </header>

        {/* アップデート通知バナー */}
        {updateAvailable && !updateBannerHidden && (
          <div className="update-banner">
            <span>新しいバージョン {updateAvailable.version} が利用可能です</span>
            <button className="btn-primary" onClick={performUpdate} disabled={updating} style={{ fontSize: "var(--font-sm)", padding: "4px 12px" }}>
              {updating ? "更新中..." : "今すぐ更新"}
            </button>
            <button className="btn-sm" onClick={() => setUpdateBannerHidden(true)} style={{ padding: "4px 8px" }}>
              後で
            </button>
          </div>
        )}

        {/* トークンの期限が近い・切れた・使えないときのお知らせ */}
        <TokenBanner owner={gh.owner} repo={gh.repo} onOpenSettings={openTokens} />

        {/* 画面（切り替えるたびにイージング付きで表示。作業・ブランチ・全体図のあいだは寄る・引く動き） */}
        <div key={view} className={`view-enter${viewAnim.current.anim}`}>
          {/* 作業（取り組み中の Issue と git の作業） */}
          {view === "work" && (
            <WorkView
              owner={gh.owner}
              repo={gh.repo}
              folder={folder}
              onSetFolder={(path) => localFolders.setFolder(gh.owner, gh.repo, path)}
              git={git}
              actions={gitActions}
              issues={workIssues}
              onOpenIssue={setSelectedIssue}
              currentUser={gh.currentUser}
              onStartIssue={startWork}
              onCloseIssue={gh.closeIssue}
              closedIssues={gh.closedIssues}
              onCreatePull={createPull}
              onOpenPull={openPull}
              draft={commitDraft}
              onDraftChange={setCommitDraft}
              commitRequest={commitRequest}
              onCommitRequestHandled={clearCommitRequest}
              onOpenSetup={openSetup}
              setupVersion={setupVersion}
              onFileMenu={openFileMenu}
            />
          )}

          {/* ブランチ・全体図 */}
          {historyView && (
            <div className="repo-screen">
              {hist.history?.source === "github" && !isMobile && (
                <div className="repo-source">
                  GitHub にある状態を表示しています。この PC の作業フォルダを決めると、手元の git の状態を表示して、操作もできます。
                  <button type="button" className="btn-sm" onClick={() => setView("work")}>
                    作業フォルダを決める
                  </button>
                </div>
              )}
              {!hist.history ? (
                <div className="content">
                  {hist.error ? (
                    <div className="work-setup">
                      <h2>履歴を読めませんでした</h2>
                      <p className="local-folder-message local-folder-message--error">{hist.error}</p>
                      <button type="button" className="btn-sm" onClick={hist.reload}>
                        もう一度読み込む
                      </button>
                    </div>
                  ) : (
                    <p className="work-loading">履歴を読み込んでいます…</p>
                  )}
                </div>
              ) : view === "branches" ? (
                <BranchesView
                  history={hist.history}
                  entries={branchEntries}
                  byHash={byHash}
                  selected={selectedBranch}
                  onSelect={setRepoBranch}
                  focusCommit={focusCommit}
                  onFocusHandled={clearFocusCommit}
                  status={hist.history.source === "local" ? git.status : null}
                  actions={hist.history.source === "local" ? gitActions : null}
                  onOpenWork={() => setView("work")}
                  onOpenOverview={() => setView("overview")}
                  onCommitMenu={openCommitMenu}
                  onBranchMenu={openBranchMenu}
                />
              ) : (
                <OverviewView
                  history={hist.history}
                  entries={branchEntries}
                  byHash={byHash}
                  selected={selectedBranch}
                  onSelect={setRepoBranch}
                  onOpenCommit={openCommit}
                  changes={hist.history.source === "local" ? git.status?.files.length ?? 0 : 0}
                  onOpenWork={() => setView("work")}
                  branchStyle={display.settings.branchStyle}
                  onBranchStyleChange={(branchStyle) => display.update({ branchStyle })}
                  home={homeOf}
                  onCommitMenu={openCommitMenu}
                  onBranchMenu={openBranchMenu}
                />
              )}
            </div>
          )}

          {/* プルリク */}
          {view === "pulls" && gh.connected && (
            <PullsView
              owner={gh.owner}
              repo={gh.repo}
              currentUser={gh.currentUser}
              collaborators={gh.collaborators}
              issues={workIssues}
              closedIssues={gh.closedIssues}
              onOpenIssue={openIssue}
              selected={pullSelected}
              onSelect={setPullSelected}
              createRequest={pullCreate}
              onCreateRequestHandled={clearPullCreate}
              onMerged={gh.loadAll}
              onPullCreatedForIssue={(n) => gh.changeIssueStatus(n, "状態:チェック待ち")}
              onFixLocally={folder && git.status ? fixPullLocally : undefined}
              localBranch={git.status?.branch ?? null}
              onOpenRun={openRun}
            />
          )}

          {/* Actions */}
          {view === "actions" && gh.connected && (
            <ActionsView
              owner={gh.owner}
              repo={gh.repo}
              actions={actions}
              onOpenPull={openPull}
              focus={actionsFocus}
              onFocusHandled={clearActionsFocus}
              currentUser={gh.currentUser}
              folder={folder ?? null}
              onPlacedWorkflow={(file) => {
                git.notify("ok", `${file} を作業フォルダに置きました。チェックを入れてコミットし、プッシュすると Actions が動き始めます`);
                git.refresh();
                setView("work");
              }}
            />
          )}

          {/* リリース */}
          {view === "releases" && gh.connected && (
            <ReleasesView
              owner={gh.owner}
              repo={gh.repo}
              currentUser={gh.currentUser}
              issueTitle={(n) => issueIndex.find(n)?.title ?? null}
              onOpenIssue={openIssue}
              onMilestonesChanged={gh.loadAll}
            />
          )}

          {/* ヒストリー（あなたがすること・チームの動き） */}
          {view === "activity" && gh.connected && (
            <ActivityView owner={gh.owner} repo={gh.repo} activity={activity} onOpenIssue={openIssue} onOpenPull={openPull} onOpenRun={(runId) => openRun(runId)}
              team={gh.collaborators} motion={display.settings.motion === "normal"} />
          )}

          {/* オーバービュー（いまの状況・チームのペース） */}
          {view === "insights" && gh.connected && (
            <InsightsView
              issues={gh.issues}
              closedIssues={gh.closedIssues}
              milestones={gh.milestones}
              labels={gh.customLabels}
              collaborators={gh.collaborators}
              owner={gh.owner}
              repo={gh.repo}
              stateOrder={(gh.boardConfig?.columns ?? DEFAULT_COLUMNS).map((c) => c.key)}
              onSelectIssue={setSelectedIssue}
              onListTimeline={gh.listTimeline}
            />
          )}

          {/* ダッシュボード */}
          {view === "dashboard" && gh.connected && (
            <DashboardView
              issues={gh.issues}
              closedIssues={gh.closedIssues}
              labels={gh.customLabels}
              milestones={gh.milestones}
              collaborators={gh.collaborators}
              currentUser={gh.currentUser}
              filters={filters}
              onFiltersChange={setFilters}
              onClose={gh.closeIssue}
              onReopen={gh.reopenIssue}
              onPromote={gh.promoteIssue}
              onStatusChange={gh.changeIssueStatus}
              onUpdateIssue={gh.updateIssue}
              onListTemplates={gh.listIssueTemplates}
              onAddTemplates={gh.addIssueTemplates}
              onCreateIssue={gh.createIssue}
              onRefresh={gh.loadAll}
              onSelectIssue={taskSplit ? selectTask : openIssueFromList}
              onAddReminder={gh.addReminder}
              savedViews={gh.savedViews}
              onSaveViews={gh.saveSavedViews}
              stateOrder={(gh.boardConfig?.columns ?? DEFAULT_COLUMNS).map((c) => c.key)}
              onEnsureEstimateLabel={gh.ensureEstimateLabel}
              status={gh.status}
              splitCapable={!isMobile && wideEnough}
              onSplitChange={setTaskSplit}
              selectedIssue={taskSelected}
              detail={taskSplit ? renderIssueDetail(taskSelected, true, () => selectTask(null), openTask) : null}
            />
          )}

          {/* ボード */}
          {view === "kanban" && gh.connected && (
            <KanbanView
              owner={gh.owner}
              repo={gh.repo}
              workingIssue={loadWorkIssue(gh.owner, gh.repo)}
              onOpenPull={openPull}
              issues={gh.issues}
              labels={gh.customLabels}
              milestones={gh.milestones}
              collaborators={gh.collaborators}
              boardConfig={gh.boardConfig}
              currentUser={gh.currentUser}
              onStatusChange={gh.changeIssueStatus}
              onSelectIssue={setSelectedIssue}
              look={display.settings.theme}
              onAssignToMe={gh.assignToMe}
              onOpenBoardSettings={() => openSettings("tasks", "settings-board")}
              onCreateIssue={gh.createIssue}
            />
          )}

          {/* マイルストーン */}
          {view === "milestones" && gh.connected && (
            <MilestoneView
              milestones={gh.milestones}
              issues={gh.issues}
              closedIssues={gh.closedIssues}
              onCreateMilestone={gh.createMilestone}
              onUpdateMilestone={gh.updateMilestone}
              onCloseMilestone={gh.closeMilestone}
              onReopenMilestone={gh.reopenMilestone}
              onRefresh={gh.loadMilestones}
              onSelectIssue={setSelectedIssue}
              repoKey={`${gh.owner}/${gh.repo}`}
              quest={display.settings.theme === "quest"}
              bar={display.settings.milestoneBar}
            />
          )}

          {/* ルーチン */}
          {view === "routines" && gh.connected && (
            <RoutinesView
              routines={gh.routines}
              availableLabels={gh.customLabels}
              onSave={gh.saveRoutines}
              onRefresh={gh.loadRoutines}
            />
          )}

          {/* タイムライン */}
          {view === "timeline" && gh.connected && (
            <TimelineView
              issues={gh.issues}
              closedIssues={gh.closedIssues}
              milestones={gh.milestones}
              me={gh.currentUser}
              onGenerateJournal={gh.generateJournal}
              onGetJournal={gh.getJournal}
              onListJournalDates={gh.listJournalDates}
              onSaveNotes={gh.saveJournalNotes}
              onSelectIssue={setSelectedIssue}
            />
          )}

          {/* ガントチャート */}
          {view === "gantt" && gh.connected && (
            <GanttView
              issues={gh.issues}
              closedIssues={gh.closedIssues}
              milestones={gh.milestones}
              labels={gh.customLabels}
              collaborators={gh.collaborators}
              currentUser={gh.currentUser}
              onSelectIssue={setSelectedIssue}
              onUpdateIssueBody={gh.updateIssueBody}
              barColors={display.settings.ganttColors}
              onOpenColorSettings={() => openSettings("display", "settings-gantt-colors")}
            />
          )}

          {/* 設定 */}
          {view === "settings" && (
            <SettingsView
              key={settingsNonce}
              labels={gh.customLabels}
              owner={gh.owner}
              repo={gh.repo}
              onSetupLabels={gh.setupLabels}
              onUpdateLabel={gh.updateLabel}
              onDeleteLabel={gh.deleteLabel}
              onCreateLabel={gh.createLabel}
              notificationSchedules={gh.notificationSchedules}
              onSaveNotificationSchedules={gh.saveNotificationSchedules}
              onSetDiscordWebhook={gh.setDiscordWebhook}
              onLoadDiscordWebhook={gh.loadDiscordWebhook}
              onTestDiscordWebhook={gh.testDiscordWebhook}
              projects={gh.projects}
              onOpenAddRepo={() => setAddRepoOpen(true)}
              onTokensChanged={gh.loadAll}
              onSignOut={handleSignOut}
              displaySettings={display.settings}
              onChangeDisplaySettings={display.update}
              estimateUnit={gh.estimateUnit}
              onSaveEstimateUnit={gh.saveEstimateUnit}
              onOpenSetup={openSetup}
              setupVersion={setupVersion}
              eventNotifConfig={gh.eventNotifConfig}
              onSaveEventNotifConfig={gh.saveEventNotifConfig}
              login={gh.currentUser}
              boardConfig={gh.boardConfig}
              onSaveBoardConfig={gh.saveBoardConfig}
              update={{ available: updateAvailable, updating }}
              onCheckUpdate={checkForUpdate}
              onRunUpdate={performUpdate}
              initialPane={settingsPane ?? undefined}
              initialSection={settingsSection ?? undefined}
              onTestNotice={notices.test}
            />
          )}
        </div>
      </div>

      {/* git の操作の結果、操作のメニュー、操作の前の確認・入力、コミットの内容 */}
      <GitNotices notices={git.notices} onDismiss={git.dismissNotice} />
      {/* おしらせ: 🔔 のりれきと、アプリの中に出す知らせ（おしらせの窓を出さない設定のとき） */}
      {noticesOpen && <NoticesDrawer notices={notices.history} onOpen={openNotice} onClose={closeNotices} />}
      {notices.toasts.length > 0 && (
        <div className="nt-inapp">
          <NoticeToasts
            notices={notices.toasts.slice(0, 3)}
            more={Math.max(0, notices.toasts.length - 3)}
            onOpen={(n) => {
              notices.closeToast(n.id);
              openNotice(n);
            }}
            onClose={notices.closeToast}
            onOpenHistory={() => setNoticesOpen(true)}
          />
        </div>
      )}

      {/* お祝い（完了のキラキラ・スタンプ・完了の知らせ、新しく入ったもののキラキラ） */}
      <Celebration motion={display.settings.motion === "normal"} />
      <MilestoneCelebration motion={display.settings.motion === "normal"} onCloseMilestone={gh.closeMilestone} />
      {conflictNotice && folder && git.status?.conflicted && (
        <ConflictNotice
          folder={folder}
          status={git.status}
          onFix={() => { setConflictNotice(false); setView("work"); }}
          onAbort={() => { setConflictNotice(false); gitActions.abortOperation(); }}
          onClose={() => setConflictNotice(false)}
        />
      )}
      {/* メモの投入（📝・Ctrl+M。置く角は 設定 → 表示 で選ぶ） */}
      {gh.connected && (
        <MemoFab position={display.settings.memoButton} labels={gh.customLabels} repoName={`${gh.owner}/${gh.repo}`} onCreateMemo={gh.createMemo} />
      )}
      {menu && <ContextMenu spec={menu} onClose={closeMenu} />}
      {addRepoOpen && (
        <AddRepoWizard
          login={gh.currentUser}
          projects={gh.projects}
          onAddProject={gh.addProject}
          onSetLocalFolder={localFolders.setFolder}
          onSwitch={handleSwitchProject}
          onNotify={gh.setStatus}
          onClose={() => setAddRepoOpen(false)}
        />
      )}
      {repoPickerOpen && (
        <RepoPicker
          projects={gh.projects}
          owner={gh.owner}
          repo={gh.repo}
          login={gh.currentUser}
          folders={localFolders.folders}
          onSwitch={handleSwitchProject}
          onRemove={gh.removeProject}
          onSetFolder={localFolders.setFolder}
          onAdd={() => setAddRepoOpen(true)}
          onOpenAccounts={() => {
            setRepoPickerOpen(false);
            setAccountPicker("menu");
          }}
          onClose={() => setRepoPickerOpen(false)}
        />
      )}
      {accountPicker && (
        <AccountPicker
          login={gh.currentUser}
          currentProjects={gh.projects.length}
          startup={accountPicker === "startup"}
          onSwitch={handleSwitchAccount}
          onAdd={handleAddAccount}
          onForget={handleForgetAccount}
          onClose={() => setAccountPicker(null)}
          switchBlocked={accountSwitchBlocked}
        />
      )}
      {gitDialog && <GitDialog key={gitDialog.title} spec={gitDialog} onClose={closeGitDialog} />}
      {gitignoreOpen && folder && <GitignoreEditor folder={folder} onSave={gitActions.saveGitignore} onClose={closeGitignore} />}
      {commitDetail && (folder || gh.owner) && (
        <CommitDetail
          source={folder ? { folder, owner: gh.owner, repo: gh.repo } : { owner: gh.owner, repo: gh.repo }}
          commit={commitDetail}
          onClose={closeCommitDetail}
        />
      )}
      {timelineCommit && gh.owner && (
        <CommitDetail source={{ owner: gh.owner, repo: gh.repo }} commit={timelineCommit} onClose={() => setTimelineCommit(null)} />
      )}
      {showConflicts && offline.status.conflicts.length > 0 && (
        <ConflictDialog
          conflicts={offline.status.conflicts}
          milestones={gh.milestones}
          onResolve={offline.resolve}
          onClose={closeConflicts}
        />
      )}
      {setup && (
        <SetupDialog
          status={setup.status}
          auto={setup.auto}
          onClose={closeSetup}
          onChanged={handleSetupChanged}
          onNotify={git.notify}
        />
      )}

      {/* ボトムナビゲーション（スマホ） */}
      <nav className="bottom-nav">
        {MOBILE_NAV_ITEMS.map((item) => (
          <button
            key={item.key}
            className={`bottom-nav-btn ${view === item.key ? "active" : ""}`}
            onClick={() => setView(item.key)}
          >
            {view === item.key && <span className="bottom-nav-active-bg" aria-hidden="true" />}
            <span className="bottom-nav-icon">{item.icon}</span>
            <span className="bottom-nav-label">{item.label}</span>
          </button>
        ))}
      </nav>

      {/* Command Palette */}
      {showPalette && (
        <CommandPalette
          issues={gh.issues}
          onCreateMemo={gh.createMemo}
          onFilterChange={(label: string) => {
            if (!label) {
              setFilters({});
            } else {
              const cat = label.split(":")[0] + ":";
              setFilters((prev) => ({ ...prev, [cat]: { values: [label], mode: "any" } }));
            }
          }}
          setStatus={gh.setStatus}
          onClose={() => setShowPalette(false)}
        />
      )}

      {/* Issue詳細（重ねて出す） */}
      {renderIssueDetail(selectedIssue, false, () => closeIssueDetail(selectedIssue), openIssue)}
      {/* 🆘 助けを求める（Issue の詳細の上に出すので、詳細のあと） */}
      {helpFor && (
        <HelpDialog
          issue={helpFor}
          me={gh.currentUser}
          collaborators={gh.collaborators}
          context={helpFor.context}
          onSend={async (body, to) => {
            const sent = await gh.createComment(helpFor.number, body);
            setCommentsVersion((v) => v + 1);
            const who = to.map((l) => `@${l}`).join(" ");
            // つながらないときは送信待ち（まだ呼べていない）。つながったら送る
            gh.setStatus(sent?._pending
              ? `🆘 ${issueRef(helpFor.number)} で ${who} に助けを求めるコメントは、まだ送れていません（つながったら送ります）`
              : `🆘 ${issueRef(helpFor.number)} で ${who} に助けを求めました`);
          }}
          onClose={() => setHelpFor(null)}
        />
      )}
    </main>
  );
  return (
    <IssueIndexContext.Provider value={issueIndex}>
      <SendingContext.Provider value={sendingActions}>
        <EstimateUnitContext.Provider value={gh.estimateUnit}>{shell}</EstimateUnitContext.Provider>
      </SendingContext.Provider>
    </IssueIndexContext.Provider>
  );
}

export default App;
