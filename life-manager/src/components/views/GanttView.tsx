import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import type { GitHubIssue, GitHubMilestone, GitHubLabel, GitHubUser } from "../../lib/types";
import type { GanttViewConfig, TimeScale, GanttBarColors, GanttLink } from "../../lib/ganttTypes";
import { TIME_SCALE_CONFIG } from "../../lib/ganttTypes";
import { issuesToGanttTasks, updateBodyMetadata, serializeGanttDates, withGanttDates, compareGanttRows, parseDependencies, bodyExcerpt } from "../../lib/ganttParser";
import { issueRef } from "../../lib/issueRef";
import { GanttRenderer, dateToDays, computeCriticalPath, relatedOf, type EdgeExit } from "../../lib/ganttRenderer";
import { planTentative, type TentativePlan } from "../../lib/ganttSchedule";
import { arrowKey, planArrows } from "../../lib/ganttArrows";
import { isEscape } from "../../lib/keys";
import { useBackLayer } from "../../lib/back";
import { useDismiss } from "../../hooks/useDismiss";
import { isSectionLabel, sectionOf } from "../../lib/section";
import { isMobile } from "../../lib/platform";
import { MobileSheet, SheetRow } from "../common/MobileSheet";
import { GanttMobileChart, type MobileScale } from "./GanttMobileChart";
import { tr, trx } from "../../lib/i18n";
import { revealPlan, type RevealPlan } from "../../lib/ganttReveal";
import { oneShotMotionOn } from "../../lib/motion";

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

/** 端の札が前と同じか（同じなら描き直しのたびに画面を作り直さない） */
function sameExits(a: EdgeExit[], b: EdgeExit[]): boolean {
  return (
    a.length === b.length &&
    a.every((e, i) => e.partner === b[i].partner && e.kind === b[i].kind && e.edge === b[i].edge && Math.round(e.x) === Math.round(b[i].x) && Math.round(e.y) === Math.round(b[i].y))
  );
}

/** 「2026-10-12」→「10/12」 */
function md(date: string): string {
  const [, m, d] = date.split("-").map(Number);
  return `${m}/${d}`;
}

/** 札に出す題名（長ければ切る） */
function shortTitle(title: string, max = 14): string {
  return title.length > max ? title.slice(0, max - 1) + "…" : title;
}

/** 下の帯の 1 行に出す札の数（ほかは「ほか N つ」。札にマウスを乗せると題名が全部出る） */
const LINKS_PER_LINE = 6;

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
  // スマホ（#209）: 目盛り（全体・週・日）と、下から出る絞り込みの板
  const [mobileScale, setMobileScale] = useState<MobileScale>("all");
  const [sheetOpen, setSheetOpen] = useState(false);
  // 日程のないタスクに、見積もりから仮の日程を置くか（次に開いたときも同じ）
  const [showTentative, setShowTentative] = useState(() => {
    try {
      return localStorage.getItem("gantt-tentative") !== "off";
    } catch {
      return true;
    }
  });
  // 矢印は選んだタスク（乗せた・押した）の分だけにするか（スマホはいつもこれ。#224）
  const [arrowsFocusOnly, setArrowsFocusOnly] = useState(() => {
    try {
      return localStorage.getItem("gantt-arrows") === "focus";
    } catch {
      return false;
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

  // マウスが乗っているタスク（帯か左の一覧の行）。そのタスクに出入りする矢印を目立たせる。
  // 帯から離れても、ほかの帯に乗るか、ガントの外へ出るか、何もない所を押すまでは続ける（下の帯や端の札を押せるように）
  const [focusIssue, setFocusIssue] = useState<number | null>(null);
  // 押して固定したタスク（詳細を閉じたあとも目立たせたまま。何もない所を押す・Esc・下の帯の ✕ で外す）
  const [pinnedIssue, setPinnedIssue] = useState<number | null>(null);
  const focus = focusIssue ?? pinnedIssue;
  // スマホの戻るボタンで、固定を外す
  useBackLayer(pinnedIssue !== null, () => {
    setPinnedIssue(null);
    setFocusIssue(null);
  });
  // ガントの外へ出たら、少し待ってから乗せていたのを外す（札や下の帯へ動かすあいだに外れないように）
  const leaveTimer = useRef<number | null>(null);
  const cancelLeave = () => {
    if (leaveTimer.current !== null) {
      window.clearTimeout(leaveTimer.current);
      leaveTimer.current = null;
    }
  };
  const scheduleLeave = () => {
    cancelLeave();
    leaveTimer.current = window.setTimeout(() => setFocusIssue(null), 200);
  };
  // 相手が画面の外にある矢印の、画面の端から出ていくところ（札を出す）
  const [edgeExits, setEdgeExits] = useState<EdgeExit[]>([]);

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
  // 描く矢印（余計な矢印を省く）と、右上・左下のどちらに通すか（交わりが少なくなるように）
  const arrowPlan = useMemo(() => planArrows(ganttTasks), [ganttTasks]);

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

  // 帯が伸びて出る動き（#215）: 開いたとき・マイルストーンを切り替えたとき、帯を日付の早い順に左から右へ伸ばし、矢印はそのあとに出す。
  // 動きを少なくしているときは出さない。描くより前に始めの形を決めるので、描くところより先に置く
  const revealRef = useRef<{ plan: RevealPlan; start: number } | null>(null);
  const revealedFor = useRef<number | null>(null);
  const hasCanvas = canvasSize.width > 0 && ganttTasks.length > 0;
  const drawRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (isMobile || selectedMilestone === null || !hasCanvas || revealedFor.current === selectedMilestone) return;
    revealedFor.current = selectedMilestone;
    if (!oneShotMotionOn()) return;
    revealRef.current = { plan: revealPlan(ganttTasks), start: performance.now() };
    let frame = 0;
    const step = () => {
      const r = revealRef.current;
      if (!r) return;
      const done = performance.now() - r.start >= r.plan.total;
      if (done) revealRef.current = null;
      drawRef.current();
      if (!done) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(frame);
      if (revealRef.current) {
        revealRef.current = null;
        drawRef.current();
      }
    };
    // ganttTasks は始めたときのもので順位を決める（伸びている途中に一覧が変わっても、やり直さない）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedMilestone, hasCanvas]);

  // Draw（帯が伸びて出ている途中なら、その形で）
  const drawCanvas = () => {
    const renderer = rendererRef.current;
    if (!renderer || canvasSize.width === 0) return;

    const startRow = Math.max(0, Math.floor(scrollY / ROW_HEIGHT));
    const endRow = Math.min(ganttTasks.length, Math.ceil((scrollY + canvasSize.height) / ROW_HEIGHT) + 1);

    const r = revealRef.current;
    const reveal = r ? { plan: r.plan, t: performance.now() - r.start } : null;
    const exits = renderer.draw(ganttTasks, config, scrollX, scrollY, canvasSize.width, canvasSize.height, startRow, endRow, criticalPath, barColors, showCriticalPath, focus, arrowPlan, arrowsFocusOnly, reveal);
    setEdgeExits((prev) => (sameExits(prev, exits) ? prev : exits));
  };
  drawRef.current = drawCanvas;
  useEffect(() => {
    drawCanvas();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ganttTasks, config, scrollX, scrollY, canvasSize, criticalPath, barColors, focus, arrowPlan, arrowsFocusOnly]);

  // スマホ: 帯が伸びて出る動き（CSS で。終わったら外す）
  const [mobileReveal, setMobileReveal] = useState<RevealPlan | null>(null);
  const mobileRevealedFor = useRef<number | null>(null);
  const hasTasks = ganttTasks.length > 0;
  useEffect(() => {
    if (!isMobile || selectedMilestone === null || !hasTasks || mobileRevealedFor.current === selectedMilestone) return;
    mobileRevealedFor.current = selectedMilestone;
    if (!oneShotMotionOn()) return;
    const plan = revealPlan(ganttTasks);
    setMobileReveal(plan);
    const timer = window.setTimeout(() => setMobileReveal(null), plan.total + 50);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedMilestone, hasTasks]);

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

  const handleMouseMoveCanvas = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (dragging) return;
    const renderer = rendererRef.current;
    if (!renderer) return;
    const rect = canvasRef.current!.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const hit = renderer.hitTestBar(cx, cy, ganttTasks, config, scrollX, scrollY);
    if (!hit) {
      // 帯から離れても、乗せていたタスクはそのまま（矢印をたどって、相手や札まで動かせるように）
      setCanvasCursor("grab");
      return;
    }
    if (hit.part === "move") setCanvasCursor("move");
    else setCanvasCursor("col-resize");
    setFocusIssue(ganttTasks[hit.taskIndex].issueNumber);
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
          renderer.draw(ganttTasks, config, scrollX, scrollY, canvasSize.width, canvasSize.height, startRow, endRow, criticalPath, barColors, showCriticalPath, focus, arrowPlan, arrowsFocusOnly);
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
  }, [dragging, ganttTasks, config, canvasSize, scrollX, scrollY, maxScrollX, issues, closedIssues, onUpdateIssueBody, focus, arrowPlan, arrowsFocusOnly]);

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
    await onUpdateIssueBody(task.issueNumber, withGanttDates(issue.body, task.startDate, task.endDate));
  }

  // 仮の日程をまとめて決める（#225）: 確かめる → 1 件ずつ書き込む（進み）→ 決めた数
  const tentativeTasks = useMemo(() => ganttTasks.filter((t) => t.tentative), [ganttTasks]);
  const [fixAll, setFixAll] = useState<null | "confirm" | { done: number; total: number }>(null);
  const [fixNote, setFixNote] = useState<string | null>(null);
  useEffect(() => {
    setFixAll(null);
    setFixNote(null);
  }, [selectedMilestone]);
  async function fixAllTentative() {
    // 押したときの仮の日程で決める（書くたびに置き直さない）
    const list = tentativeTasks;
    let done = 0;
    let failed = 0;
    for (const t of list) {
      setFixAll({ done: done + failed, total: list.length });
      try {
        await fixTentative(t);
        done++;
      } catch {
        failed++;
      }
    }
    setFixAll(null);
    setFixNote(tr("{done} 件の日程を決めました{v}", { done, v: failed ? tr("（{failed} 件は決められませんでした）", { failed }) : "" }));
  }
  const fixAllControl =
    fixAll === "confirm" ? (
      <span className="gantt-fixall">
        {trx("仮の日程の {length} 件を、今の日程で決めますか？", { length: tentativeTasks.length })}
        <button type="button" className="btn-sm" onClick={() => setFixAll(null)}>{tr("やめる")}</button>
        <button type="button" className="btn-sm primary" onClick={() => void fixAllTentative()}>{tr("決める")}</button>
      </span>
    ) : fixAll !== null ? (
      <span className="gantt-fixall">
        <i className="spinner" aria-hidden="true" /> {" "}{trx("決めています（{done} / {total}）", { done: fixAll.done, total: fixAll.total })}
      </span>
    ) : showTentative && tentativeTasks.length > 0 ? (
      <button type="button" className="btn-sm" onClick={() => { setFixNote(null); setFixAll("confirm"); }}>
        {trx("仮の日程を決める（{length} 件）", { length: tentativeTasks.length })}
      </button>
    ) : fixNote ? (
      <span className="gantt-fixall muted">{fixNote}</span>
    ) : null;

  // Click handler (ignore if dragged)
  const handleCanvasClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (dragRef.current?.moved) return;
    const renderer = rendererRef.current;
    if (!renderer) return;
    const rect = canvasRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const issueNum = renderer.hitTest(x, y, ganttTasks, config, scrollX, scrollY);
    if (issueNum === null) {
      // 何もない所を押したら、乗せていたのも固定も外す
      setFocusIssue(null);
      setPinnedIssue(null);
      return;
    }
    {
      // 押したタスクは固定する（詳細を閉じたあとも、そのタスクの矢印を目立たせたまま）
      setPinnedIssue(issueNum);
      const task = ganttTasks.find((t) => t.issueNumber === issueNum);
      if (task?.tentative) {
        // 吹き出しは幅 300px・高さ 140px ほど。入りきらない側では向きを変える
        setTentativePop({ x, y, flipX: x > canvasSize.width - 330, flipY: y > canvasSize.height - 160, task });
        return;
      }
      onSelectIssue(issueNum);
    }
  }, [ganttTasks, config, scrollX, scrollY, onSelectIssue, canvasSize]);

  // 乗せたタスクの先行・後続（帯のある相手。左の一覧の札に使う）
  const rel = useMemo(() => (focus === null ? null : relatedOf(ganttTasks, focus)), [ganttTasks, focus]);

  // 下の帯に出す、先行・後続の一覧（帯のない相手も、なぜ帯がないかを添えて出す）
  const links = useMemo(() => {
    if (focus === null) return null;
    const self = ganttTasks.find((t) => t.issueNumber === focus);
    if (!self) return null;
    const taskOf = new Map(ganttTasks.map((t) => [t.issueNumber, t]));
    const inMilestone = new Set(allIssues.map((i) => i.number));
    const every = [...issues, ...closedIssues];
    const issueOf = new Map(every.map((i) => [i.number, i]));
    const reasonOf = (n: number): string | null => {
      const t = taskOf.get(n);
      if (t?.startDate && t.endDate) return null;
      const issue = issueOf.get(n);
      if (!issue) return tr("見つからない");
      if (issue.state === "closed") return tr("閉じた");
      if (!inMilestone.has(n)) return tr("ほかのマイルストーン");
      if (!t) return tr("表示するタスクに入っていない");
      return tr("日程なし");
    };
    const link = (n: number, kind: "pred" | "succ"): GanttLink => {
      const t = taskOf.get(n);
      const reason = reasonOf(n);
      // 先行の終わる日より前（同じ日も）に、後続がはじまる
      const [before, after] = kind === "pred" ? [t, self] : [self, t];
      const broken = !reason && !!before?.endDate && !!after?.startDate && dateToDays(after.startDate) <= dateToDays(before.endDate);
      return {
        n,
        title: issueOf.get(n)?.title ?? t?.title ?? "",
        reason,
        redundant: arrowPlan.redundant.has(kind === "pred" ? arrowKey(n, focus) : arrowKey(focus, n)),
        broken,
        // 先行が遅れている（日程のある開いた先行の、終わりの日が過ぎた）
        late: kind === "pred" && !reason && !!t && t.state !== "closed" && !t.tentative && !!t.endDate && t.endDate < today,
      };
    };
    const preds = [...new Set(self.dependencies)].filter((n) => n !== focus).map((n) => link(n, "pred"));
    const succNums = every.filter((i) => i.number !== focus && parseDependencies(i.body).includes(focus)).map((i) => i.number);
    const succs = [...new Set(succNums)].sort((a, b) => a - b).map((n) => link(n, "succ"));
    // タスクの内容（本文のはじめ。#217）
    const excerpt = bodyExcerpt(issueOf.get(focus)?.body ?? null);
    return { self, preds, succs, excerpt };
  }, [focus, ganttTasks, allIssues, issues, closedIssues, arrowPlan, today]);

  /** 相手の行まで送る（送ったあとも、乗せていたタスクの矢印を目立たせたままにする） */
  const jumpTo = useCallback((n: number) => {
    const idx = ganttTasks.findIndex((t) => t.issueNumber === n);
    if (idx < 0) return;
    if (focus !== null) setPinnedIssue(focus);
    const maxY = Math.max(0, ganttTasks.length * ROW_HEIGHT - canvasSize.height + HEADER_HEIGHT);
    setScrollY(Math.min(maxY, Math.max(0, idx * ROW_HEIGHT - (canvasSize.height - HEADER_HEIGHT) / 2)));
    const t = ganttTasks[idx];
    if (t.startDate) {
      const x = (dateToDays(t.startDate) - dateToDays(dateRange.start) - 3) * TIME_SCALE_CONFIG[timeScale].pixelsPerDay;
      setScrollX(Math.min(maxScrollX, Math.max(0, x)));
    }
  }, [ganttTasks, focus, canvasSize.height, dateRange.start, timeScale, maxScrollX]);

  // Esc で、乗せていたのと固定を外す（詳細や吹き出しが開いているときは、そちらを閉じるだけ）
  useEffect(() => {
    if (focus === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (!isEscape(e) || document.querySelector(".palette-overlay, [aria-modal='true'], .popover")) return;
      setFocusIssue(null);
      setPinnedIssue(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focus]);

  // マイルストーンを変えたら外す。固定したタスクがガントから消えたら外す
  useEffect(() => {
    setFocusIssue(null);
    setPinnedIssue(null);
  }, [selectedMilestone]);
  useEffect(() => {
    if (pinnedIssue !== null && !ganttTasks.some((t) => t.issueNumber === pinnedIssue)) setPinnedIssue(null);
  }, [ganttTasks, pinnedIssue]);

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

  function changeMilestone(val: number | null) {
    setSelectedMilestone(val);
    if (val !== null) {
      localStorage.setItem("gantt-selected-milestone", String(val));
    } else {
      localStorage.removeItem("gantt-selected-milestone");
    }
    setScrollX(0);
    setScrollY(0);
  }

  function changeTentative(on: boolean) {
    setShowTentative(on);
    try {
      localStorage.setItem("gantt-tentative", on ? "on" : "off");
    } catch {
      // 覚えられなくても、今は切り替わる
    }
  }

  function changeArrows(focusOnly: boolean) {
    setArrowsFocusOnly(focusOnly);
    try {
      localStorage.setItem("gantt-arrows", focusOnly ? "focus" : "all");
    } catch {
      // 覚えられなくても、今は切り替わる
    }
  }

  // スマホ（#209）: 上の段は 1 行（マイルストーン・目盛り・絞り込み）。担当・状態・セクション・仮の日程は下から出る板に。
  // 行は 2 段（上に題名、下に帯）で、帯は見るだけ（指で動かさない。日程は詳細から）
  if (isMobile) {
    const activeFilters = (filterAssignee ? 1 : 0) + (filterStatus ? 1 : 0) + (filterDomain ? 1 : 0);
    return (
      <div className="content gantt-screen m-gantt" style={{ padding: 0 }}>
        <div className="toolbar m-compact mg-toolbar">
          <select className="select-sm mg-ms" aria-label={tr("マイルストーン")} value={selectedMilestone ?? ""} onChange={(e) => changeMilestone(e.target.value ? parseInt(e.target.value) : null)}>
            <option value="">{tr("マイルストーンを選ぶ")}</option>
            {milestones.map((m) => (
              <option key={m.number} value={m.number}>{m.title}</option>
            ))}
          </select>
          <span className="list-mode mg-scale" role="group" aria-label={tr("目盛り")}>
            {(["all", "week", "day"] as MobileScale[]).map((sc) => (
              <button key={sc} type="button" className={mobileScale === sc ? "on" : ""} aria-pressed={mobileScale === sc} onClick={() => setMobileScale(sc)}>
                {sc === "all" ? tr("全体") : sc === "week" ? tr("週") : tr("日")}
              </button>
            ))}
          </span>
          <button type="button" className={`btn-sm m-filter-btn${activeFilters ? " on" : ""}`} onClick={() => setSheetOpen(true)}>
            {tr("表示するタスク")}{activeFilters > 0 && <span className="m-filter-n">{activeFilters}</span>}
          </button>
        </div>
        <MobileSheet
          open={sheetOpen}
          title={tr("表示するタスク")}
          onClose={() => setSheetOpen(false)}
          footer={
            <>
              <button type="button" className="btn-sm" disabled={!activeFilters} onClick={() => { setFilterAssignee(""); setFilterStatus(""); setFilterDomain(""); }}>{tr("すべて外す")}</button>
              <button type="button" className="btn-primary" onClick={() => setSheetOpen(false)}>{trx("{length} 件を見る", { length: ganttTasks.length })}</button>
            </>
          }
        >
          <SheetRow label={tr("担当")}>
            <select className="select-sm" value={filterAssignee} onChange={(e) => setFilterAssignee(e.target.value)}>
              <option value="">{tr("全員")}</option>
              {assignees.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </SheetRow>
          <SheetRow label={tr("状態")}>
            <select className="select-sm" value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
              <option value="">{tr("全部")}</option>
              {statusLabels.map((l) => <option key={l.name} value={l.name}>{tr(l.name.replace(/^状態:/, ""))}</option>)}
            </select>
          </SheetRow>
          <SheetRow label={tr("セクション")}>
            <select className="select-sm" value={filterDomain} onChange={(e) => setFilterDomain(e.target.value)}>
              <option value="">{tr("全部")}</option>
              {domainLabels.map((l) => <option key={l.name} value={l.name}>{sectionOf(l.name)}</option>)}
            </select>
          </SheetRow>
          <SheetRow label={tr("見せ方")}>
            <label className="chk gantt-tentative-toggle">
              <input type="checkbox" checked={showTentative} onChange={(e) => changeTentative(e.target.checked)} />
              {tr("見積もりから仮の日程を置く")}
            </label>
            <button type="button" className="btn-sm" onClick={() => { setSheetOpen(false); onOpenColorSettings(); }}>{tr("⚙ 帯の色")}</button>
          </SheetRow>
          {fixAllControl && <SheetRow label={tr("仮の日程")}>{fixAllControl}</SheetRow>}
        </MobileSheet>

        {selectedMilestone === null ? (
          <div className="empty-message">{tr("マイルストーンを選んでください")}</div>
        ) : ganttTasks.length === 0 ? (
          <div className="empty-message">{tr("当てはまるタスクがありません")}</div>
        ) : (
          <GanttMobileChart
            tasks={ganttTasks}
            today={today}
            deadline={deadline}
            criticalPath={criticalPath}
            redundant={arrowPlan.redundant}
            barColors={barColors}
            scale={mobileScale}
            focus={pinnedIssue}
            onFocus={(n) => {
              setFocusIssue(null);
              setPinnedIssue(n);
            }}
            links={pinnedIssue === null ? null : links}
            onOpenIssue={onSelectIssue}
            onFixTentative={fixTentative}
            reveal={mobileReveal}
          />
        )}
      </div>
    );
  }


  return (
    <div className="content gantt-screen" style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, overflow: "hidden", padding: 0 }}>
      {/* Toolbar */}
      <div className="toolbar" style={{ flexWrap: "wrap", gap: "var(--space-sm)", padding: "var(--space-sm) var(--space-md)" }}>
        <select
          className="select-sm"
          value={selectedMilestone ?? ""}
          onChange={(e) => changeMilestone(e.target.value ? parseInt(e.target.value) : null)}
        >
          <option value="">{tr("マイルストーンを選択")}</option>
          {milestones.map((m) => (
            <option key={m.number} value={m.number}>{m.title}</option>
          ))}
        </select>

        {selectedMilestone !== null && (
          <>
            <select className="select-sm" value={filterAssignee} onChange={(e) => setFilterAssignee(e.target.value)}>
              <option value="">{tr("全担当者")}</option>
              {assignees.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>

            <select className="select-sm" value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
              <option value="">{tr("全状態")}</option>
              {statusLabels.map((l) => <option key={l.name} value={l.name}>{l.name}</option>)}
            </select>

            <select className="select-sm" value={filterDomain} onChange={(e) => setFilterDomain(e.target.value)}>
              <option value="">{tr("全セクション")}</option>
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
            <button className="btn-sm" onClick={onOpenColorSettings} title={tr("設定 → 表示 の「ガントの帯の色」を開きます")}
              style={{ fontSize: "var(--font-xs)" }}>
              {tr("⚙ 色の設定")}
            </button>
            <label className="chk gantt-tentative-toggle" title={tr("日程のないタスクに、見積もりから仮の帯（点線）を置きます")}>
              <input type="checkbox" checked={showTentative} onChange={(e) => changeTentative(e.target.checked)} />
              {tr("見積もりから仮の日程を置く")}
            </label>
            <label className="chk gantt-tentative-toggle" title={tr("帯か左の一覧の行に乗せる（押す）と、そのタスクの先行と後続の矢印だけを出します")}>
              <input type="checkbox" checked={arrowsFocusOnly} onChange={(e) => changeArrows(e.target.checked)} />
              {tr("矢印は選んだタスクだけ")}
            </label>
            {trx("{fixAllControl}<0>{length} 件</0>", { fixAllControl, length: ganttTasks.length }, [<span style={{ fontSize: "var(--font-xs)", color: "var(--text-muted)" }} />])}
          </>
        )}
      </div>

      {/* Main area */}
      {selectedMilestone === null ? (
        <div className="empty-message">{tr("マイルストーンを選択してください")}</div>
      ) : ganttTasks.length === 0 ? (
        <div className="empty-message">{tr("該当するIssueがありません")}</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }} onMouseEnter={cancelLeave} onMouseLeave={scheduleLeave}>
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
                // 乗せたタスクと、その先行・後続の行には札（線をたどらなくても、名前で読める）
                const relKind = rel === null ? null : task.issueNumber === rel.focus ? "focus" : rel.preds.has(task.issueNumber) ? "pred" : rel.succs.has(task.issueNumber) ? "succ" : null;
                // 乗せているときも、押して固定したときも「選択中」（固定しているかは、下の帯の「📌 固定中」で分かる。#216）
                const relLabel = relKind === "focus" ? tr("選択中") : relKind === "pred" ? tr("先行") : relKind === "succ" ? tr("後続") : null;
                return (
                  <div
                    key={task.issueNumber}
                    className={relKind ? `gantt-row-${relKind}` : undefined}
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
                    onClick={() => {
                      setPinnedIssue(task.issueNumber);
                      onSelectIssue(task.issueNumber);
                    }}
                    onMouseEnter={() => setFocusIssue(task.issueNumber)}
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
                    {relLabel && <span className={`gantt-rel ${relKind}`}>{relLabel}</span>}
                    {task.estimate && <span className="est-chip gantt-est">{task.estimate}</span>}
                    {task.tentative && <span className="gantt-kari" title={tr("日程が決まっていないので、見積もりから仮に置いています")}>{tr("仮")}</span>}
                    {!task.startDate && !task.estimate && task.state === "open" && (
                      <span className="gantt-none">{tr("日程・見積もりなし")}</span>
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
                onClick={handleCanvasClick}
              />
              {edgeExits.map((ex) => {
                const partner = ganttTasks.find((t) => t.issueNumber === ex.partner);
                const arrow = { top: "↑", bottom: "↓", left: "←", right: "→" }[ex.edge];
                const x = Math.min(canvasSize.width - 70, Math.max(70, ex.x));
                const style: React.CSSProperties =
                  ex.edge === "top" ? { left: x, top: HEADER_HEIGHT + 4, transform: "translateX(-50%)" }
                  : ex.edge === "bottom" ? { left: x, bottom: 4, transform: "translateX(-50%)" }
                  : ex.edge === "left" ? { left: 4, top: ex.y, transform: "translateY(-50%)" }
                  : { right: 4, top: ex.y, transform: "translateY(-50%)" };
                return (
                  <button
                    key={`${ex.kind}:${ex.partner}`}
                    type="button"
                    className={`gantt-edge ${ex.kind}`}
                    style={style}
                    title={tr("押すと、その行まで送ります")}
                    onClick={() => jumpTo(ex.partner)}
                  >
                    {arrow}{" "}
                    {ex.kind === "pred"
                      ? tr("先行 {issueRef} {title} へ", { issueRef: issueRef(ex.partner), title: partner ? shortTitle(partner.title) : "" })
                      : tr("後続 {issueRef} {title} へ", { issueRef: issueRef(ex.partner), title: partner ? shortTitle(partner.title) : "" })}
                  </button>
                );
              })}
              {tentativePop && (
                <div ref={tentativePopRef} className="gantt-tentative-pop popover" style={{
                  // 右端・下端の近くでは、押した所の左・上に出す（絵の枠で切れないように）
                  left: tentativePop.x + (tentativePop.flipX ? -12 : 12),
                  top: tentativePop.y + (tentativePop.flipY ? -8 : 8),
                  transform: `translate(${tentativePop.flipX ? "-100%" : "0"}, ${tentativePop.flipY ? "-100%" : "0"})`,
                }}>
                  <div className="gantt-tooltip-title">{issueRef(tentativePop.task.issueNumber)} {tentativePop.task.title}</div>
                  <div className="gantt-tentative-note">
                    {trx("見積もり {estimate} → 仮に {startDate} 〜 {endDate}", { estimate: tentativePop.task.estimate, startDate: tentativePop.task.startDate, endDate: tentativePop.task.endDate })}
                  </div>
                  <div className="gantt-tentative-note">{tr("日程が決まっていないので、見積もりから仮に置いています。")}</div>
                  <div className="gantt-tentative-actions">
                    <button type="button" className="btn-primary" onClick={() => fixTentative(tentativePop.task)}>{tr("この日程で決める")}</button>
                    <button type="button" className="btn-sm" onClick={() => { const n = tentativePop.task.issueNumber; setTentativePop(null); onSelectIssue(n); }}>{tr("詳細を開く")}</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
        {/* 下の帯: 乗せた（固定した）タスクの詳しいことと、先行・後続（帯のそばのカードは矢印にかぶるので、ここに出す） */}
        <div className={`gantt-info${links ? "" : " empty"}`}>
          {links ? (
            <>
              <div className="gantt-info-head">
                <span className="gantt-info-title">{issueRef(links.self.issueNumber)} {links.self.title}</span>
                <span className="gantt-info-meta">
                  {[
                    links.self.startDate && links.self.endDate
                      ? links.self.tentative
                        ? tr("仮に {start}〜{end}", { start: md(links.self.startDate), end: md(links.self.endDate) })
                        : `${md(links.self.startDate)}〜${md(links.self.endDate)}`
                      : tr("日程なし"),
                    links.self.estimate ? tr("見積 {estimate}", { estimate: links.self.estimate }) : null,
                    tr("進み {v}%", { v: links.self.progressValue }),
                    links.self.assignees.length > 0 ? tr("担当 {join}", { join: links.self.assignees.map((a) => a.login).join(", ") }) : tr("担当なし"),
                  ]
                    .filter(Boolean)
                    .join(tr(" ・ "))}
                </span>
                {pinnedIssue !== null && (
                  <button type="button" className="btn-sm gantt-info-pin" title={tr("固定をやめます（Esc か、何もない所を押しても外れます）")} onClick={() => { setPinnedIssue(null); setFocusIssue(null); }}>
                    {trx("📌 {issueRef} を固定中 ✕", { issueRef: issueRef(pinnedIssue) })}
                  </button>
                )}
              </div>
              {/* タスクの内容（本文のはじめ。2 行まで） */}
              <div className={`gantt-info-body${links.excerpt ? "" : " none"}`} title={links.excerpt || undefined}>
                {links.excerpt || tr("本文はありません")}
              </div>
              {(["pred", "succ"] as const).map((kind) => {
                const list = kind === "pred" ? links.preds : links.succs;
                return (
                  <div key={kind} className="gantt-info-links">
                    <span className={`gantt-info-label ${kind}`}>{kind === "pred" ? tr("先行") : tr("後続")}</span>
                    {list.length === 0 && <span>{tr("なし")}</span>}
                    {list.slice(0, LINKS_PER_LINE).map((l) => (
                      <span key={l.n} style={{ display: "contents" }}>
                        <button
                          type="button"
                          className={`gantt-link ${l.reason ? "off" : kind}`}
                          disabled={l.reason !== null}
                          title={l.reason ? tr("{issueRef} {title}（{reason}。ガントに帯がありません）", { issueRef: issueRef(l.n), title: l.title, reason: l.reason }) : tr("{issueRef} {title}（押すと、その行まで送ります）", { issueRef: issueRef(l.n), title: l.title })}
                          onClick={() => jumpTo(l.n)}
                        >
                          {issueRef(l.n)} {shortTitle(l.title, 10)}
                          {l.redundant ? tr("（点線）") : ""}
                          {l.reason ? `（${l.reason}）` : ""}
                        </button>
                        {l.broken && <span className="gantt-link-warn" title={kind === "pred" ? tr("この先行が終わる前に、このタスクがはじまります") : tr("このタスクが終わる前に、この後続がはじまります")}>{tr("順番が逆")}</span>}
                      </span>
                    ))}
                    {list.length > LINKS_PER_LINE && (
                      <span title={list.slice(LINKS_PER_LINE).map((l) => `${issueRef(l.n)} ${l.title}`).join("\n")}>{tr("ほか {n} つ", { n: list.length - LINKS_PER_LINE })}</span>
                    )}
                  </div>
                );
              })}
            </>
          ) : (
            <span>
              {tr("帯か左の一覧の行に乗せると、ここに先行と後続が出ます。")}
            </span>
          )}
        </div>
        </div>
      )}
    </div>
  );
}
