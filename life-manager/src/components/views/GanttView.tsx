import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import type { GitHubIssue, GitHubMilestone, GitHubLabel, GitHubUser } from "../../lib/types";
import type { GanttViewConfig, TimeScale, GanttBarColors } from "../../lib/ganttTypes";
import { TIME_SCALE_CONFIG } from "../../lib/ganttTypes";
import { issuesToGanttTasks, updateBodyMetadata, serializeGanttDates, compareGanttRows } from "../../lib/ganttParser";
import { issueRef } from "../../lib/issueRef";
import { GanttRenderer, dateToDays, computeCriticalPath } from "../../lib/ganttRenderer";
import { planTentative, type TentativePlan } from "../../lib/ganttSchedule";
import { useDismiss } from "../../hooks/useDismiss";
import { isSectionLabel, sectionOf } from "../../lib/section";

interface GanttViewProps {
  issues: GitHubIssue[];
  closedIssues: GitHubIssue[];
  milestones: GitHubMilestone[];
  labels: GitHubLabel[];
  collaborators: GitHubUser[];
  currentUser: string;
  onSelectIssue: (n: number) => void;
  onUpdateIssueBody: (issueNumber: number, newBody: string) => Promise<void>;
  /** 帯の色（設定 → 表示） */
  barColors: GanttBarColors;
  /** 設定 → 表示 の「ガントの帯の色」を開く */
  onOpenColorSettings: () => void;
}

const ROW_HEIGHT = 36;
const HEADER_HEIGHT = 32;
const TASK_LIST_WIDTH = 260;

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function GanttView({
  issues, closedIssues, milestones, labels, onSelectIssue, onUpdateIssueBody, barColors, onOpenColorSettings,
}: GanttViewProps) {
  const [selectedMilestone, setSelectedMilestone] = useState<number | null>(() => {
    const saved = localStorage.getItem("gantt-selected-milestone");
    return saved ? parseInt(saved, 10) : null;
  });
  const [timeScale, setTimeScale] = useState<TimeScale>("week");
  const [showCriticalPath, setShowCriticalPath] = useState(false);
  const [scrollX, setScrollX] = useState(0);
  const [scrollY, setScrollY] = useState(0);
  const [filterAssignee, setFilterAssignee] = useState<string>("");
  const [filterStatus, setFilterStatus] = useState<string>("");
  const [filterDomain, setFilterDomain] = useState<string>("");
  // 日程のないタスクに、見積もりから仮の日程を置くか（次に開いたときも同じ）
  const [showTentative, setShowTentative] = useState(() => {
    try {
      return localStorage.getItem("gantt-tentative") !== "off";
    } catch {
      return true;
    }
  });

  // 保存されたマイルストーンが現在のプロジェクトに存在しなければクリア
  useEffect(() => {
    if (selectedMilestone !== null && milestones.length > 0 && !milestones.some((m) => m.number === selectedMilestone)) {
      setSelectedMilestone(null);
      localStorage.removeItem("gantt-selected-milestone");
    }
  }, [milestones, selectedMilestone]);

  // 選んでいなければ、いちばん近い開いたマイルストーン（期限の近い順。期限のないものは後ろ）を、はじめから出す
  useEffect(() => {
    if (selectedMilestone !== null || milestones.length === 0) return;
    const open = milestones.filter((m) => m.state !== "closed");
    const nearest = [...(open.length > 0 ? open : milestones)].sort((a, b) => (a.due_on ?? "9999").localeCompare(b.due_on ?? "9999"))[0];
    if (nearest) setSelectedMilestone(nearest.number);
  }, [milestones, selectedMilestone]);

  // マウスが乗っているタスク（帯か左の一覧の行）。そのタスクに出入りする矢印を目立たせる
  const [focusIssue, setFocusIssue] = useState<number | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const taskListRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<GanttRenderer | null>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });

  // All issues for selected milestone
  const allIssues = useMemo(() => {
    if (selectedMilestone === null) return [];
    return [...issues, ...closedIssues].filter(
      (i) => i.milestone?.number === selectedMilestone
    );
  }, [issues, closedIssues, selectedMilestone]);

  // Apply filters
  const filteredIssues = useMemo(() => {
    let result = allIssues;
    if (filterAssignee) {
      result = result.filter((i) => i.assignees.some((a) => a.login === filterAssignee));
    }
    if (filterStatus) {
      result = result.filter((i) => i.labels.some((l) => l.name === filterStatus));
    }
    if (filterDomain) {
      result = result.filter((i) => i.labels.some((l) => l.name === filterDomain));
    }
    return result;
  }, [allIssues, filterAssignee, filterStatus, filterDomain]);

  // 見積もりからの仮の日程。マイルストーンの全部のタスクで決める（絞り込んでも同じ位置に出す）
  const today = formatDate(new Date());
  const plans = useMemo(
    () => (showTentative ? planTentative(issuesToGanttTasks(allIssues), allIssues, today) : new Map<number, TentativePlan>()),
    [allIssues, showTentative, today],
  );

  // Convert to GanttTasks（仮の日程があれば、その日程で描く）。行は日程の順（日程のないタスクは下）
  const ganttTasks = useMemo(
    () =>
      issuesToGanttTasks(filteredIssues)
        .map((t) => {
          const plan = plans.get(t.issueNumber);
          return plan ? { ...t, startDate: plan.start, endDate: plan.end, tentative: true } : t;
        })
        .sort(compareGanttRows),
    [filteredIssues, plans],
  );

  // マイルストーンの期限（線を引き、仮の帯の超えた分を赤くする）
  const deadline = milestones.find((m) => m.number === selectedMilestone)?.due_on?.substring(0, 10) ?? null;

  // Compute date range from tasks
  const dateRange = useMemo(() => {
    let minDate = today;
    let maxDate = deadline && deadline > today ? deadline : today;
    for (const t of ganttTasks) {
      if (t.startDate && t.startDate < minDate) minDate = t.startDate;
      if (t.endDate && t.endDate > maxDate) maxDate = t.endDate;
    }
    // Add padding
    const start = new Date(minDate + "T00:00:00");
    start.setDate(start.getDate() - 7);
    const end = new Date(maxDate + "T00:00:00");
    end.setDate(end.getDate() + 14);
    return { start: formatDate(start), end: formatDate(end) };
  }, [ganttTasks, today, deadline]);

  const config: GanttViewConfig = useMemo(() => ({
    timeScale,
    startDate: dateRange.start,
    endDate: dateRange.end,
    rowHeight: ROW_HEIGHT,
    headerHeight: HEADER_HEIGHT,
    pixelsPerDay: TIME_SCALE_CONFIG[timeScale].pixelsPerDay,
    deadline,
  }), [timeScale, dateRange, deadline]);

  // タイムライン全体の幅 (px)
  const totalWidth = useMemo(() => {
    const days = dateToDays(dateRange.end) - dateToDays(dateRange.start);
    return days * config.pixelsPerDay;
  }, [dateRange, config.pixelsPerDay]);

  // 横スクロールの最大値
  const maxScrollX = useMemo(() => Math.max(0, totalWidth - canvasSize.width), [totalWidth, canvasSize.width]);

  // マイルストーンを選んだとき・目盛りを変えたときは、今日が見える所まで送る（仮の帯は今日から置くため）
  const autoScrolled = useRef("");
  useEffect(() => {
    const key = `${selectedMilestone}:${timeScale}`;
    if (autoScrolled.current === key || canvasSize.width === 0 || ganttTasks.length === 0) return;
    autoScrolled.current = key;
    const x = (dateToDays(today) - dateToDays(dateRange.start) - 3) * TIME_SCALE_CONFIG[timeScale].pixelsPerDay;
    setScrollX(Math.min(maxScrollX, Math.max(0, x)));
  }, [selectedMilestone, timeScale, canvasSize.width, ganttTasks.length, today, dateRange.start, maxScrollX]);
  const criticalPath = useMemo(() => computeCriticalPath(ganttTasks), [ganttTasks]);

  // Canvas resize — re-run when canvas appears in DOM
  const canvasVisible = selectedMilestone !== null && ganttTasks.length > 0;
  useEffect(() => {
    if (!canvasVisible) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        setCanvasSize({ width, height });
      }
    });
    observer.observe(parent);
    return () => observer.disconnect();
  }, [canvasVisible]);

  // Initialize renderer
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || canvasSize.width === 0) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvasSize.width * dpr;
    canvas.height = canvasSize.height * dpr;
    canvas.style.width = `${canvasSize.width}px`;
    canvas.style.height = `${canvasSize.height}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    rendererRef.current = new GanttRenderer(ctx, dpr);
  }, [canvasSize]);

  // Draw
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || canvasSize.width === 0) return;

    const startRow = Math.max(0, Math.floor(scrollY / ROW_HEIGHT));
    const endRow = Math.min(ganttTasks.length, Math.ceil((scrollY + canvasSize.height) / ROW_HEIGHT) + 1);

    renderer.draw(ganttTasks, config, scrollX, scrollY, canvasSize.width, canvasSize.height, startRow, endRow, criticalPath, barColors, showCriticalPath, focusIssue);
  }, [ganttTasks, config, scrollX, scrollY, canvasSize, criticalPath, barColors, focusIssue]);

  // Scroll handler
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      setScrollX((prev) => Math.min(maxScrollX, Math.max(0, prev + (e.deltaX || e.deltaY))));
    } else {
      setScrollY((prev) => {
        const maxY = Math.max(0, ganttTasks.length * ROW_HEIGHT - canvasSize.height + HEADER_HEIGHT);
        return Math.min(maxY, Math.max(0, prev + e.deltaY));
      });
    }
  }, [ganttTasks.length, canvasSize.height, maxScrollX]);


  // Drag state: scroll or bar manipulation
  type DragState =
    | { type: "scroll"; startX: number; startY: number; scrollX0: number; scrollY0: number; moved: boolean }
    | { type: "bar"; part: "move" | "resize-start" | "resize-end"; taskIndex: number; startX: number; origStart: string; origEnd: string; moved: boolean };
  const dragRef = useRef<DragState | null>(null);
  const [dragging, setDragging] = useState(false);
  const [canvasCursor, setCanvasCursor] = useState("grab");
  const [tooltip, setTooltip] = useState<{ x: number; y: number; task: typeof ganttTasks[0] } | null>(null);

  const handleMouseMoveCanvas = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (dragging) { setTooltip(null); return; }
    const renderer = rendererRef.current;
    if (!renderer) return;
    const rect = canvasRef.current!.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const hit = renderer.hitTestBar(cx, cy, ganttTasks, config, scrollX, scrollY);
    if (!hit) {
      setCanvasCursor("grab");
      setTooltip(null);
      setFocusIssue(null);
      return;
    }
    if (hit.part === "move") setCanvasCursor("move");
    else setCanvasCursor("col-resize");
    const task = ganttTasks[hit.taskIndex];
    setTooltip({ x: e.clientX, y: e.clientY, task });
    setFocusIssue(task.issueNumber);
  }, [ganttTasks, config, scrollX, scrollY, dragging]);

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const renderer = rendererRef.current;
    if (!renderer) return;
    const rect = canvasRef.current!.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;

    // バー上かチェック
    const hit = renderer.hitTestBar(cx, cy, ganttTasks, config, scrollX, scrollY);
    if (hit) {
      const task = ganttTasks[hit.taskIndex];
      if (task.startDate && task.endDate) {
        dragRef.current = {
          type: "bar", part: hit.part, taskIndex: hit.taskIndex,
          startX: e.clientX, origStart: task.startDate, origEnd: task.endDate, moved: false,
        };
        setDragging(true);
        return;
      }
    }
    // スクロールドラッグ
    dragRef.current = { type: "scroll", startX: e.clientX, startY: e.clientY, scrollX0: scrollX, scrollY0: scrollY, moved: false };
    setDragging(true);
  }, [scrollX, scrollY, ganttTasks, config]);

  useEffect(() => {
    if (!dragging) return;
    const maxY = Math.max(0, ganttTasks.length * ROW_HEIGHT - canvasSize.height + HEADER_HEIGHT);

    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;

      if (d.type === "scroll") {
        const dx = d.startX - e.clientX;
        const dy = d.startY - e.clientY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) d.moved = true;
        setScrollX(Math.min(maxScrollX, Math.max(0, d.scrollX0 + dx)));
        setScrollY(Math.min(maxY, Math.max(0, d.scrollY0 + dy)));
      } else {
        // バードラッグ
        const dx = e.clientX - d.startX;
        if (Math.abs(dx) > 3) d.moved = true;
        const dayDelta = Math.round(dx / config.pixelsPerDay);
        if (dayDelta === 0 && !d.moved) return;

        const addDays = (dateStr: string, n: number): string => {
          const ms = dateToDays(dateStr) * 86400000 + n * 86400000;
          const dt = new Date(ms);
          const y = dt.getUTCFullYear();
          const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
          const day = String(dt.getUTCDate()).padStart(2, "0");
          return `${y}-${m}-${day}`;
        };

        const task = ganttTasks[d.taskIndex];
        let newStart = task.startDate!;
        let newEnd = task.endDate!;
        if (d.part === "move") {
          newStart = addDays(d.origStart, dayDelta);
          newEnd = addDays(d.origEnd, dayDelta);
        } else if (d.part === "resize-start") {
          newStart = addDays(d.origStart, dayDelta);
          if (dateToDays(newStart) > dateToDays(d.origEnd)) newStart = d.origEnd;
        } else {
          newEnd = addDays(d.origEnd, dayDelta);
          if (dateToDays(newEnd) < dateToDays(d.origStart)) newEnd = d.origStart;
        }
        // ローカルで即座に反映（描画のみ）
        task.startDate = newStart;
        task.endDate = newEnd;
        // 再描画
        const renderer = rendererRef.current;
        if (renderer && canvasSize.width > 0) {
          const startRow = Math.max(0, Math.floor(scrollY / ROW_HEIGHT));
          const endRow = Math.min(ganttTasks.length, Math.ceil((scrollY + canvasSize.height) / ROW_HEIGHT) + 1);
          renderer.draw(ganttTasks, config, scrollX, scrollY, canvasSize.width, canvasSize.height, startRow, endRow, criticalPath, barColors, showCriticalPath, focusIssue);
        }
      }
    };

    const onUp = async () => {
      const d = dragRef.current;
      setDragging(false);
      if (!d || !d.moved) return;

      if (d.type === "bar") {
        const task = ganttTasks[d.taskIndex];
        if (!task.startDate || !task.endDate) return;
        if (task.startDate === d.origStart && task.endDate === d.origEnd) return;
        // Issueのbodyを更新
        const issue = [...issues, ...closedIssues].find((i) => i.number === task.issueNumber);
        if (!issue) return;
        const pattern = /<!--\s*gantt:\d{4}-\d{2}-\d{2}\/\d{4}-\d{2}-\d{2}\s*-->/;
        const newBody = updateBodyMetadata(issue.body, pattern, serializeGanttDates(task.startDate, task.endDate));
        await onUpdateIssueBody(task.issueNumber, newBody);
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging, ganttTasks, config, canvasSize, scrollX, scrollY, maxScrollX, issues, closedIssues, onUpdateIssueBody, focusIssue]);

  // 仮の帯を押したときの吹き出し（この日程で決める・詳細を開く）
  const [tentativePop, setTentativePop] = useState<{ x: number; y: number; flipX: boolean; flipY: boolean; task: typeof ganttTasks[0] } | null>(null);
  const tentativePopRef = useRef<HTMLDivElement>(null);
  const closeTentativePop = useCallback(() => setTentativePop(null), []);
  useDismiss(tentativePopRef, tentativePop !== null, closeTentativePop);
  // 絵を送ったり目盛りを変えたりしたら、吹き出しは帯から離れるので閉じる
  useEffect(() => setTentativePop(null), [scrollX, scrollY, timeScale, selectedMilestone]);

  /** 仮の日程を、本当の日程（本文の <!-- gantt:開始/終了 -->）として書き込む */
  async function fixTentative(task: typeof ganttTasks[0]) {
    setTentativePop(null);
    const issue = [...issues, ...closedIssues].find((i) => i.number === task.issueNumber);
    if (!issue || !task.startDate || !task.endDate) return;
    const pattern = /<!--\s*gantt:\d{4}-\d{2}-\d{2}\/\d{4}-\d{2}-\d{2}\s*-->/;
    await onUpdateIssueBody(task.issueNumber, updateBodyMetadata(issue.body, pattern, serializeGanttDates(task.startDate, task.endDate)));
  }

  // Click handler (ignore if dragged)
  const handleCanvasClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (dragRef.current?.moved) return;
    const renderer = rendererRef.current;
    if (!renderer) return;
    const rect = canvasRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const issueNum = renderer.hitTest(x, y, ganttTasks, config, scrollX, scrollY);
    if (issueNum !== null) {
      const task = ganttTasks.find((t) => t.issueNumber === issueNum);
      if (task?.tentative) {
        setTooltip(null);
        // 吹き出しは幅 300px・高さ 140px ほど。入りきらない側では向きを変える
        setTentativePop({ x, y, flipX: x > canvasSize.width - 330, flipY: y > canvasSize.height - 160, task });
        return;
      }
      onSelectIssue(issueNum);
    }
  }, [ganttTasks, config, scrollX, scrollY, onSelectIssue, canvasSize]);

  // Unique assignees and label categories for filters
  const assignees = useMemo(() => {
    const set = new Set<string>();
    allIssues.forEach((i) => i.assignees.forEach((a) => set.add(a.login)));
    return Array.from(set);
  }, [allIssues]);

  const statusLabels = useMemo(() => labels.filter((l) => l.name.startsWith("状態:")), [labels]);
  const domainLabels = useMemo(() => labels.filter((l) => isSectionLabel(l.name)), [labels]);

  // Visible task list rows
  const visibleStartRow = Math.max(0, Math.floor(scrollY / ROW_HEIGHT));
  const visibleEndRow = Math.min(ganttTasks.length, Math.ceil((scrollY + canvasSize.height) / ROW_HEIGHT) + 1);


  return (
    <div className="content gantt-screen" style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, overflow: "hidden", padding: 0 }}>
      {/* Toolbar */}
      <div className="toolbar" style={{ flexWrap: "wrap", gap: "var(--space-sm)", padding: "var(--space-sm) var(--space-md)" }}>
        <select
          className="select-sm"
          value={selectedMilestone ?? ""}
          onChange={(e) => {
            const val = e.target.value ? parseInt(e.target.value) : null;
            setSelectedMilestone(val);
            if (val !== null) {
              localStorage.setItem("gantt-selected-milestone", String(val));
            } else {
              localStorage.removeItem("gantt-selected-milestone");
            }
            setScrollX(0);
            setScrollY(0);
          }}
        >
          <option value="">マイルストーンを選択</option>
          {milestones.map((m) => (
            <option key={m.number} value={m.number}>{m.title}</option>
          ))}
        </select>

        {selectedMilestone !== null && (
          <>
            <select className="select-sm" value={filterAssignee} onChange={(e) => setFilterAssignee(e.target.value)}>
              <option value="">全担当者</option>
              {assignees.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>

            <select className="select-sm" value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
              <option value="">全状態</option>
              {statusLabels.map((l) => <option key={l.name} value={l.name}>{l.name}</option>)}
            </select>

            <select className="select-sm" value={filterDomain} onChange={(e) => setFilterDomain(e.target.value)}>
              <option value="">全セクション</option>
              {domainLabels.map((l) => <option key={l.name} value={l.name}>{sectionOf(l.name)}</option>)}
            </select>

            <div style={{ display: "flex", gap: "2px" }}>
              {(["day", "week", "month"] as TimeScale[]).map((ts) => (
                <button
                  key={ts}
                  className={`btn-sm ${timeScale === ts ? "active" : ""}`}
                  onClick={() => setTimeScale(ts)}
                  style={{
                    backgroundColor: timeScale === ts ? "var(--accent-blue)" : undefined,
                    color: timeScale === ts ? "var(--bg-primary)" : undefined,
                  }}
                >
                  {TIME_SCALE_CONFIG[ts].label}
                </button>
              ))}
            </div>

            <button className="btn-sm"
              onClick={() => setShowCriticalPath(!showCriticalPath)}
              style={{
                fontSize: "var(--font-xs)",
                backgroundColor: showCriticalPath ? "var(--accent-red)" : undefined,
                color: showCriticalPath ? "var(--text-on-accent)" : undefined,
              }}>
              CP
            </button>
            <button className="btn-sm" onClick={onOpenColorSettings} title="設定 → 表示 の「ガントの帯の色」を開きます"
              style={{ fontSize: "var(--font-xs)" }}>
              ⚙ 色の設定
            </button>
            <label className="chk gantt-tentative-toggle" title="日程のないタスクに、見積もりから仮の帯（点線）を置きます">
              <input type="checkbox" checked={showTentative}
                onChange={(e) => {
                  setShowTentative(e.target.checked);
                  try {
                    localStorage.setItem("gantt-tentative", e.target.checked ? "on" : "off");
                  } catch {
                    // 覚えられなくても、今は切り替わる
                  }
                }} />
              見積もりから仮の日程を置く
            </label>
            <span style={{ fontSize: "var(--font-xs)", color: "var(--text-muted)" }}>
              {ganttTasks.length} 件
            </span>
          </>
        )}
      </div>

      {/* Main area */}
      {selectedMilestone === null ? (
        <div className="empty-message">マイルストーンを選択してください</div>
      ) : ganttTasks.length === 0 ? (
        <div className="empty-message">該当するIssueがありません</div>
      ) : (
        <div style={{ display: "flex", flex: 1, minHeight: 0, overflow: "hidden", borderTop: "1px solid var(--border-default)" }}>
          {/* Task list (left panel) */}
          <div
            style={{
              width: TASK_LIST_WIDTH,
              minWidth: TASK_LIST_WIDTH,
              borderRight: "1px solid var(--border-default)",
              display: "flex",
              flexDirection: "column",
            }}
          >
            {/* スクロールバー分のスペーサー（右パネルと高さを揃える） */}
            <div style={{ height: 14, flexShrink: 0, backgroundColor: "var(--bg-secondary)", borderBottom: "1px solid var(--border-subtle)" }} />
            {/* 固定ヘッダー */}
            <div style={{
              height: HEADER_HEIGHT,
              backgroundColor: "var(--bg-secondary)",
              borderBottom: "1px solid var(--border-default)",
              display: "flex",
              alignItems: "center",
              padding: "0 8px",
              fontSize: "var(--font-xs)",
              color: "var(--text-muted)",
              fontWeight: 600,
              flexShrink: 0,
            }}>
              Issue
            </div>
            {/* スクロール領域 */}
            <div ref={taskListRef} style={{ flex: 1, overflow: "hidden", position: "relative" }}>
              {ganttTasks.slice(visibleStartRow, visibleEndRow).map((task, idx) => {
                const rowIdx = visibleStartRow + idx;
                return (
                  <div
                    key={task.issueNumber}
                    style={{
                      position: "absolute",
                      top: rowIdx * ROW_HEIGHT - scrollY,
                      left: 0,
                      right: 0,
                      height: ROW_HEIGHT,
                      display: "flex",
                      alignItems: "center",
                      padding: "0 8px",
                      gap: "6px",
                      fontSize: "var(--font-xs)",
                      borderBottom: "1px solid var(--border-subtle)",
                      cursor: "pointer",
                      overflow: "hidden",
                    }}
                    onClick={() => onSelectIssue(task.issueNumber)}
                    onMouseEnter={() => setFocusIssue(task.issueNumber)}
                    onMouseLeave={() => setFocusIssue(null)}
                  >
                    <span style={{ color: "var(--text-faint)", flexShrink: 0 }}>{issueRef(task.issueNumber)}</span>
                    <span style={{
                      color: task.state === "closed" ? "var(--text-faint)" : "var(--text-secondary)",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      flex: 1,
                      textDecoration: task.state === "closed" ? "line-through" : "none",
                    }}>
                      {task.title}
                    </span>
                    {task.estimate && <span className="est-chip gantt-est">{task.estimate}</span>}
                    {task.tentative && <span className="gantt-kari" title="日程が決まっていないので、見積もりから仮に置いています">仮</span>}
                    {!task.startDate && !task.estimate && task.state === "open" && (
                      <span className="gantt-none">日程・見積もりなし</span>
                    )}
                    <span style={{ color: "var(--text-faint)", flexShrink: 0, fontSize: "10px" }}>
                      {task.progressValue}%
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Canvas (right panel) */}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
            {/* 横スクロールバー (上部固定) */}
            <div
              style={{
                height: 14,
                flexShrink: 0,
                backgroundColor: "var(--bg-secondary)",
                borderBottom: "1px solid var(--border-subtle)",
                position: "relative",
                cursor: maxScrollX > 0 ? "pointer" : "default",
              }}
              onMouseDown={maxScrollX > 0 ? (e) => {
                const bar = e.currentTarget;
                const rect = bar.getBoundingClientRect();
                const ratio = (e.clientX - rect.left) / rect.width;
                setScrollX(Math.min(maxScrollX, Math.max(0, ratio * totalWidth - canvasSize.width / 2)));

                const onMove = (ev: MouseEvent) => {
                  const r = (ev.clientX - rect.left) / rect.width;
                  setScrollX(Math.min(maxScrollX, Math.max(0, r * totalWidth - canvasSize.width / 2)));
                };
                const onUp = () => {
                  window.removeEventListener("mousemove", onMove);
                  window.removeEventListener("mouseup", onUp);
                };
                window.addEventListener("mousemove", onMove);
                window.addEventListener("mouseup", onUp);
              } : undefined}
            >
              <div
                style={{
                  position: "absolute",
                  top: 2,
                  height: 10,
                  borderRadius: 5,
                  backgroundColor: "var(--text-faint)",
                  left: totalWidth > 0 ? `${(scrollX / totalWidth) * 100}%` : "0%",
                  width: totalWidth > 0 ? `${Math.max(5, (canvasSize.width / totalWidth) * 100)}%` : "100%",
                }}
              />
            </div>
            <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>
              <canvas
                ref={canvasRef}
                style={{ display: "block", width: "100%", height: "100%", cursor: dragging ? (dragRef.current?.type === "bar" ? canvasCursor : "grabbing") : canvasCursor }}
                onWheel={handleWheel}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMoveCanvas}
                onMouseLeave={() => {
                  setTooltip(null);
                  setFocusIssue(null);
                }}
                onClick={handleCanvasClick}
              />
              {tooltip && (
                <div className="gantt-tooltip" style={{
                  left: tooltip.x - (canvasRef.current?.getBoundingClientRect().left ?? 0) + 12,
                  top: tooltip.y - (canvasRef.current?.getBoundingClientRect().top ?? 0) - 8,
                }}>
                  <div className="gantt-tooltip-title">{issueRef(tooltip.task.issueNumber)} {tooltip.task.title}</div>
                  {tooltip.task.startDate && tooltip.task.endDate && (
                    <div className="gantt-tooltip-dates">
                      {tooltip.task.tentative && "仮に "}{tooltip.task.startDate} 〜 {tooltip.task.endDate}
                    </div>
                  )}
                  {tooltip.task.tentative && (
                    <div className="gantt-tooltip-dates">見積もり {tooltip.task.estimate} から仮に置いています（押すと決められます）</div>
                  )}
                  <div className="gantt-tooltip-progress">進捗: {tooltip.task.progressValue}%</div>
                  {tooltip.task.assignees.length > 0 && (
                    <div className="gantt-tooltip-assignees">担当: {tooltip.task.assignees.map(a => a.login).join(", ")}</div>
                  )}
                </div>
              )}
              {tentativePop && (
                <div ref={tentativePopRef} className="gantt-tentative-pop popover" style={{
                  // 右端・下端の近くでは、押した所の左・上に出す（絵の枠で切れないように）
                  left: tentativePop.x + (tentativePop.flipX ? -12 : 12),
                  top: tentativePop.y + (tentativePop.flipY ? -8 : 8),
                  transform: `translate(${tentativePop.flipX ? "-100%" : "0"}, ${tentativePop.flipY ? "-100%" : "0"})`,
                }}>
                  <div className="gantt-tooltip-title">{issueRef(tentativePop.task.issueNumber)} {tentativePop.task.title}</div>
                  <div className="gantt-tentative-note">
                    見積もり {tentativePop.task.estimate} → 仮に {tentativePop.task.startDate} 〜 {tentativePop.task.endDate}
                  </div>
                  <div className="gantt-tentative-note">日程が決まっていないので、見積もりから仮に置いています。帯を動かして決めることもできます</div>
                  <div className="gantt-tentative-actions">
                    <button type="button" className="btn-primary" onClick={() => fixTentative(tentativePop.task)}>この日程で決める</button>
                    <button type="button" className="btn-sm" onClick={() => { const n = tentativePop.task.issueNumber; setTentativePop(null); onSelectIssue(n); }}>詳細を開く</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
