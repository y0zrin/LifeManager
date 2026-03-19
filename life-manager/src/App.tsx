import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { useGitHub } from "./hooks/useGitHub";
import { DashboardView } from "./components/views/DashboardView";
import { KanbanView } from "./components/views/KanbanView";
import { MilestoneView } from "./components/views/MilestoneView";
import { SettingsView } from "./components/views/SettingsView";
import { RoutinesView } from "./components/views/RoutinesView";
import { TimelineView } from "./components/views/TimelineView";
import { GanttView } from "./components/views/GanttView";
import { CommandPalette } from "./components/common/CommandPalette";
import { IssueDetailModal } from "./components/common/IssueDetailModal";
import { SetupView } from "./components/views/SetupView";
import type { ViewType } from "./lib/types";
import "./App.css";

function App() {
  const gh = useGitHub();
  const [view, setView] = useState<ViewType>("dashboard");
  const [showPalette, setShowPalette] = useState(false);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [selectedIssue, setSelectedIssue] = useState<number | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [updateAvailable, setUpdateAvailable] = useState<{ version: string; body: string } | null>(null);
  const [updating, setUpdating] = useState(false);

  // アップデートチェック
  const checkForUpdate = useCallback(async () => {
    try {
      const update = await check();
      if (update) {
        setUpdateAvailable({ version: update.version, body: update.body || "" });
      }
    } catch {
      // アップデートチェック失敗は無視
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
      try {
        await gh.loadToken();
      } catch {
        // トークン未設定 → セットアップ画面を表示
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
      if (e.key === "Escape") {
        setShowPalette(false);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  async function handleSetToken(token: string) {
    await gh.setToken(token);
    setView("dashboard");
  }

  async function handleSetup(token: string, owner: string, repo: string) {
    await gh.setRepoConfig(owner, repo);
    await gh.setToken(token);
    // プロジェクトリストに追加（トークンも保存）
    await gh.addProject(owner, repo, `${owner}/${repo}`, token);
    setView("dashboard");
  }

  async function handleSwitchProject(projOwner: string, projRepo: string) {
    await gh.switchProject(projOwner, projRepo);
  }

  const navItems: { key: ViewType; icon: string; label: string }[] = [
    { key: "dashboard", icon: "📋", label: "タスク" },
    { key: "kanban", icon: "📊", label: "ボード" },
    { key: "milestones", icon: "🎯", label: "マイルストーン" },
    { key: "routines", icon: "🔄", label: "ルーチン" },
    { key: "timeline", icon: "📅", label: "日誌" },
    { key: "gantt", icon: "📐", label: "ガント" },
    { key: "settings", icon: "⚙️", label: "設定" },
  ];

  // 初期化中
  if (initializing) {
    return (
      <main className="app" style={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: "100vh" }}>
        <p style={{ color: "var(--text-muted)" }}>読み込み中...</p>
      </main>
    );
  }

  // 未接続 → セットアップ画面
  if (!gh.connected) {
    return <SetupView onComplete={handleSetup} status={gh.status} />;
  }

  return (
    <main className="app">
      {/* ヘッダー */}
      <header className="header">
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-md)" }}>
          <h1 className="header-title" style={{ margin: 0, fontSize: "var(--font-xl)" }}>Life Manager</h1>
          {gh.projects.length > 0 && (
            <select
              className="select-sm project-select"
              value={`${gh.owner}/${gh.repo}`}
              onChange={(e) => {
                const [o, r] = e.target.value.split("/");
                if (o && r) handleSwitchProject(o, r);
              }}
              style={{ maxWidth: "200px", fontSize: "var(--font-sm)" }}
            >
              {gh.projects.map((p) => (
                <option key={`${p.owner}/${p.repo}`} value={`${p.owner}/${p.repo}`}>
                  {p.name || `${p.owner}/${p.repo}`}
                </option>
              ))}
            </select>
          )}
          <nav className="nav">
            {navItems.map((item) => (
              <button
                key={item.key}
                className={`nav-btn ${view === item.key ? "active" : ""}`}
                onClick={() => setView(item.key)}
              >
                {item.icon} {item.label}
              </button>
            ))}
          </nav>
        </div>
        <div className="header-right" style={{ display: "flex", alignItems: "center", gap: "var(--space-sm)" }}>
          <span className="status-text">{gh.status}</span>
          <button className="btn-sm" onClick={() => { setShowPalette(true); }}>
            Ctrl+K
          </button>
        </div>
      </header>

      {/* アップデート通知バナー */}
      {updateAvailable && (
        <div className="update-banner">
          <span>新しいバージョン {updateAvailable.version} が利用可能です</span>
          <button className="btn-primary" onClick={performUpdate} disabled={updating} style={{ fontSize: "var(--font-sm)", padding: "4px 12px" }}>
            {updating ? "更新中..." : "今すぐ更新"}
          </button>
          <button className="btn-sm" onClick={() => setUpdateAvailable(null)} style={{ padding: "4px 8px" }}>
            後で
          </button>
        </div>
      )}

      {/* ボトムナビゲーション（モバイル用） */}
      <nav className="bottom-nav">
        {navItems.map((item) => (
          <button
            key={item.key}
            className={`bottom-nav-btn ${view === item.key ? "active" : ""}`}
            onClick={() => setView(item.key)}
          >
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
              setFilters((prev) => ({ ...prev, [cat]: label }));
            }
          }}
          setStatus={gh.setStatus}
          onClose={() => setShowPalette(false)}
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
          onCreateIssue={gh.createIssue}
          onCreateMemo={gh.createMemo}
          onRefresh={gh.loadAll}
          onSelectIssue={setSelectedIssue}
          onAddReminder={gh.addReminder}
          status={gh.status}
        />
      )}

      {/* ボード */}
      {view === "kanban" && gh.connected && (
        <KanbanView
          issues={gh.issues}
          labels={gh.customLabels}
          milestones={gh.milestones}
          collaborators={gh.collaborators}
          boardConfig={gh.boardConfig}
          currentUser={gh.currentUser}
          onStatusChange={gh.changeIssueStatus}
          onAssignToMe={gh.assignToMe}
          onSelectIssue={setSelectedIssue}
          onSaveBoardConfig={gh.saveBoardConfig}
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
          onRefresh={gh.loadMilestones}
          onSelectIssue={setSelectedIssue}
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
          onGenerateJournal={gh.generateJournal}
          onGetJournal={gh.getJournal}
          onSaveNotes={gh.saveJournalNotes}
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
        />
      )}

      {/* Issue詳細モーダル */}
      {selectedIssue !== null && (() => {
        const issueObj = gh.issues.find((i) => i.number === selectedIssue)
          || gh.closedIssues.find((i) => i.number === selectedIssue);
        return issueObj ? (
          <IssueDetailModal
            issue={issueObj}
            onClose={() => setSelectedIssue(null)}
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
          />
        ) : null;
      })()}

      {/* 設定 */}
      {view === "settings" && (
        <SettingsView
          connected={gh.connected}
          labels={gh.customLabels}
          owner={gh.owner}
          repo={gh.repo}
          onSetToken={handleSetToken}
          onSetupLabels={gh.setupLabels}
          onSetRepoConfig={gh.setRepoConfig}
          onUpdateLabel={gh.updateLabel}
          onDeleteLabel={gh.deleteLabel}
          onCreateLabel={gh.createLabel}
          notificationSchedules={gh.notificationSchedules}
          onSaveNotificationSchedules={gh.saveNotificationSchedules}
          onSetDiscordWebhook={gh.setDiscordWebhook}
          onLoadDiscordWebhook={gh.loadDiscordWebhook}
          onTestDiscordWebhook={gh.testDiscordWebhook}
          projects={gh.projects}
          onAddProject={gh.addProject}
          onRemoveProject={gh.removeProject}
          onSetProjectToken={gh.setProjectToken}
          eventNotifConfig={gh.eventNotifConfig}
          onSaveEventNotifConfig={gh.saveEventNotifConfig}
          onCreateIssue={gh.createIssue}
        />
      )}
    </main>
  );
}

export default App;
