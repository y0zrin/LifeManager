import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import type { GitHubIssue, GitHubMilestone, GitHubLabel, GitHubUser } from "../../lib/types";
import type { GanttViewConfig, TimeScale, GanttBarColors } from "../../lib/ganttTypes";
import { TIME_SCALE_CONFIG, DEFAULT_BAR_COLORS, BAR_COLOR_LABELS } from "../../lib/ganttTypes";
import { issuesToGanttTasks, updateBodyMetadata, serializeGanttDates } from "../../lib/ganttParser";
import { GanttRenderer, dateToDays, computeCriticalPath } from "../../lib/ganttRenderer";

interface GanttViewProps {
  issues: GitHubIssue[];
  closedIssues: GitHubIssue[];
  milestones: GitHubMilestone[];
  labels: GitHubLabel[];
  collaborators: GitHubUser[];
  currentUser: string;
  onSelectIssue: (n: number) => void;
  onUpdateIssueBody: (issueNumber: number, newBody: string) => Promise<void>;
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
  issues, closedIssues, milestones, labels, onSelectIssue, onUpdateIssueBody,
}: GanttViewProps) {
  const [selectedMilestone, setSelectedMilestone] = useState<number | null>(() => {
    const saved = localStorage.getItem("gantt-selected-milestone");
    return saved ? parseInt(saved, 10) : null;
  });
  const [timeScale, setTimeScale] = useState<TimeScale>("week");
  const [showCriticalPath, setShowCriticalPath] = useState(false);
  const [showColorSettings, setShowColorSettings] = useState(false);
  const [barColors, setBarColors] = useState<GanttBarColors>(() => {
    try {
      const saved = localStorage.getItem("gantt-bar-colors");
      return saved ? { ...DEFAULT_BAR_COLORS, ...JSON.parse(saved) } : DEFAULT_BAR_COLORS;
    } catch { return DEFAULT_BAR_COLORS; }
  });
  const updateBarColor = (key: keyof GanttBarColors, value: string) => {
    const next = { ...barColors, [key]: value };
    setBarColors(next);
    localStorage.setItem("gantt-bar-colors", JSON.stringify(next));
  };
  const [scrollX, setScrollX] = useState(0);
  const [scrollY, setScrollY] = useState(0);
  const [filterAssignee, setFilterAssignee] = useState<string>("");
  const [filterStatus, setFilterStatus] = useState<string>("");
  const [filterDomain, setFilterDomain] = useState<string>("");

  // 保存されたマイルストーンが現在のプロジェクトに存在しなければクリア
  useEffect(() => {
    if (selectedMilestone !== null && milestones.length > 0 && !milestones.some((m) => m.number === selectedMilestone)) {
      setSelectedMilestone(null);
      localStorage.removeItem("gantt-selected-milestone");
    }
  }, [milestones, selectedMilestone]);

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

  // Convert to GanttTasks
  const ganttTasks = useMemo(() => issuesToGanttTasks(filteredIssues), [filteredIssues]);

  // Compute date range from tasks
  const dateRange = useMemo(() => {
    const today = formatDate(new Date());
    let minDate = today;
    let maxDate = today;
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
  }, [ganttTasks]);

  const config: GanttViewConfig = useMemo(() => ({
    timeScale,
    startDate: dateRange.start,
    endDate: dateRange.end,
    rowHeight: ROW_HEIGHT,
    headerHeight: HEADER_HEIGHT,
    pixelsPerDay: TIME_SCALE_CONFIG[timeScale].pixelsPerDay,
  }), [timeScale, dateRange]);

  // タイムライン全体の幅 (px)
  const totalWidth = useMemo(() => {
    const days = dateToDays(dateRange.end) - dateToDays(dateRange.start);
    return days * config.pixelsPerDay;
  }, [dateRange, config.pixelsPerDay]);

  // 横スクロールの最大値
  const maxScrollX = useMemo(() => Math.max(0, totalWidth - canvasSize.width), [totalWidth, canvasSize.width]);
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

    renderer.draw(ganttTasks, config, scrollX, scrollY, canvasSize.width, canvasSize.height, startRow, endRow, criticalPath, barColors, showCriticalPath);
  }, [ganttTasks, config, scrollX, scrollY, canvasSize, criticalPath, barColors]);

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
      return;
    }
    if (hit.part === "move") setCanvasCursor("move");
    else setCanvasCursor("col-resize");
    const task = ganttTasks[hit.taskIndex];
    setTooltip({ x: e.clientX, y: e.clientY, task });
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
          renderer.draw(ganttTasks, config, scrollX, scrollY, canvasSize.width, canvasSize.height, startRow, endRow, criticalPath, barColors, showCriticalPath);
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
  }, [dragging, ganttTasks, config, canvasSize, scrollX, scrollY, maxScrollX, issues, closedIssues, onUpdateIssueBody]);

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
      onSelectIssue(issueNum);
    }
  }, [ganttTasks, config, scrollX, scrollY, onSelectIssue]);

  // Unique assignees and label categories for filters
  const assignees = useMemo(() => {
    const set = new Set<string>();
    allIssues.forEach((i) => i.assignees.forEach((a) => set.add(a.login)));
    return Array.from(set);
  }, [allIssues]);

  const statusLabels = useMemo(() => labels.filter((l) => l.name.startsWith("状態:")), [labels]);
  const domainLabels = useMemo(() => labels.filter((l) => l.name.startsWith("分野:")), [labels]);

  // Visible task list rows
  const visibleStartRow = Math.max(0, Math.floor(scrollY / ROW_HEIGHT));
  const visibleEndRow = Math.min(ganttTasks.length, Math.ceil((scrollY + canvasSize.height) / ROW_HEIGHT) + 1);


  return (
    <div className="content" style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, overflow: "hidden", padding: 0 }}>
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
              <option value="">全分野</option>
              {domainLabels.map((l) => <option key={l.name} value={l.name}>{l.name}</option>)}
            </select>

            <div style={{ display: "flex", gap: "2px" }}>
              {(["day", "week", "month"] as TimeScale[]).map((ts) => (
                <button
                  key={ts}
                  className={`btn-sm ${timeScale === ts ? "active" : ""}`}
                  onClick={() => setTimeScale(ts)}
                  style={{
                    backgroundColor: timeScale === ts ? "var(--accent-blue)" : undefined,
                    color: timeScale === ts ? "#fff" : undefined,
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
                color: showCriticalPath ? "#fff" : undefined,
              }}>
              CP
            </button>
            <button className="btn-sm" onClick={() => setShowColorSettings(!showColorSettings)}
              style={{ fontSize: "var(--font-xs)" }}>
              {showColorSettings ? "×" : "色設定"}
            </button>
            <span style={{ fontSize: "var(--font-xs)", color: "var(--text-muted)" }}>
              {ganttTasks.length} 件
            </span>
          </>
        )}
      </div>

      {/* 色設定パネル */}
      {showColorSettings && (
        <div className="form-card" style={{ display: "flex", gap: "var(--space-sm)", flexWrap: "wrap", alignItems: "center", padding: "var(--space-sm) var(--space-md)" }}>
          {(Object.keys(BAR_COLOR_LABELS) as (keyof GanttBarColors)[]).map((key) => (
            <label key={key} style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "var(--font-xs)", color: "var(--text-muted)" }}>
              <input type="color" value={barColors[key]}
                onChange={(e) => updateBarColor(key, e.target.value)}
                style={{ width: "20px", height: "20px", border: "none", padding: 0, cursor: "pointer" }} />
              {BAR_COLOR_LABELS[key]}
            </label>
          ))}
          <button className="btn-sm" style={{ fontSize: "var(--font-xs)" }}
            onClick={() => { setBarColors(DEFAULT_BAR_COLORS); localStorage.removeItem("gantt-bar-colors"); }}>
            リセット
          </button>
        </div>
      )}

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
                  >
                    <span style={{ color: "var(--text-faint)", flexShrink: 0 }}>#{task.issueNumber}</span>
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
                onMouseLeave={() => setTooltip(null)}
                onClick={handleCanvasClick}
              />
              {tooltip && (
                <div className="gantt-tooltip" style={{
                  left: tooltip.x - (canvasRef.current?.getBoundingClientRect().left ?? 0) + 12,
                  top: tooltip.y - (canvasRef.current?.getBoundingClientRect().top ?? 0) - 8,
                }}>
                  <div className="gantt-tooltip-title">#{tooltip.task.issueNumber} {tooltip.task.title}</div>
                  {tooltip.task.startDate && tooltip.task.endDate && (
                    <div className="gantt-tooltip-dates">{tooltip.task.startDate} 〜 {tooltip.task.endDate}</div>
                  )}
                  <div className="gantt-tooltip-progress">進捗: {tooltip.task.progressValue}%</div>
                  {tooltip.task.assignees.length > 0 && (
                    <div className="gantt-tooltip-assignees">担当: {tooltip.task.assignees.map(a => a.login).join(", ")}</div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
