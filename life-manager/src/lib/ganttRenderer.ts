import type { GanttTask, GanttViewConfig, GanttBarColors } from "./ganttTypes";
import { DEFAULT_BAR_COLORS } from "./ganttTypes";

interface ThemeColors {
  bgPrimary: string;
  bgSecondary: string;
  bgTertiary: string;
  borderDefault: string;
  borderSubtle: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  textFaint: string;
  accentBlue: string;
  accentGreen: string;
  accentRed: string;
}

function readThemeColors(): ThemeColors {
  const s = getComputedStyle(document.documentElement);
  const g = (v: string) => s.getPropertyValue(v).trim() || "#888";
  return {
    bgPrimary: g("--bg-primary"),
    bgSecondary: g("--bg-secondary"),
    bgTertiary: g("--bg-tertiary"),
    borderDefault: g("--border-default"),
    borderSubtle: g("--border-subtle"),
    textPrimary: g("--text-primary"),
    textSecondary: g("--text-secondary"),
    textMuted: g("--text-muted"),
    textFaint: g("--text-faint"),
    accentBlue: g("--accent-blue"),
    accentGreen: g("--accent-green"),
    accentRed: g("--accent-red"),
  };
}

export function dateToDays(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

function formatDate(dateStr: string): string {
  const [, m, d] = dateStr.split("-").map(Number);
  return `${m}/${d}`;
}

function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dayOfWeekUTC(dateStr: string): number {
  const d = new Date(dateStr + "T00:00:00Z");
  return d.getUTCDay(); // 0=Sun
}

/** クリティカルパス計算: 依存関係チェーン中で最長のパス上にあるタスクのissueNumber集合を返す */
export function computeCriticalPath(tasks: GanttTask[]): Set<number> {
  const byNum = new Map<number, GanttTask>();
  for (const t of tasks) byNum.set(t.issueNumber, t);

  // 各タスクの「最遅終了日」を依存チェーンの末端から逆算
  const cache = new Map<number, { end: number; chain: number[] }>();

  function longest(num: number): { end: number; chain: number[] } {
    if (cache.has(num)) return cache.get(num)!;
    const t = byNum.get(num);
    if (!t || !t.endDate) {
      const r = { end: 0, chain: [] as number[] };
      cache.set(num, r);
      return r;
    }
    const myEnd = dateToDays(t.endDate);

    // このタスクに依存しているタスク（後続タスク）を探す
    let best = { end: myEnd, chain: [num] };
    for (const other of tasks) {
      if (other.dependencies.includes(num) && other.startDate && other.endDate) {
        const sub = longest(other.issueNumber);
        if (sub.end > best.end) {
          best = { end: sub.end, chain: [num, ...sub.chain] };
        }
      }
    }
    cache.set(num, best);
    return best;
  }

  // 全タスクから開始して最長チェーンを求める
  let criticalChain: number[] = [];
  let maxEnd = 0;
  for (const t of tasks) {
    if (!t.startDate || !t.endDate) continue;
    const result = longest(t.issueNumber);
    if (result.end > maxEnd || (result.end === maxEnd && result.chain.length > criticalChain.length)) {
      maxEnd = result.end;
      criticalChain = result.chain;
    }
  }
  return new Set(criticalChain);
}

export class GanttRenderer {
  private ctx: CanvasRenderingContext2D;
  private dpr: number;
  private colors: ThemeColors;

  constructor(ctx: CanvasRenderingContext2D, dpr: number) {
    this.ctx = ctx;
    this.dpr = dpr;
    this.colors = readThemeColors();
  }

  refreshColors() {
    this.colors = readThemeColors();
  }

  draw(
    tasks: GanttTask[],
    config: GanttViewConfig,
    scrollX: number,
    scrollY: number,
    canvasWidth: number,
    canvasHeight: number,
    startRow: number,
    endRow: number,
    criticalPath?: Set<number>,
    barColors?: GanttBarColors,
    showCPLabel?: boolean,
  ) {
    const ctx = this.ctx;
    ctx.save();
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);

    this.drawGrid(config, scrollX, scrollY, canvasWidth, canvasHeight, tasks.length);
    this.drawTodayLine(config, scrollX, canvasHeight);
    this.drawBars(tasks, config, scrollX, scrollY, canvasWidth, startRow, endRow, criticalPath, barColors ?? DEFAULT_BAR_COLORS, showCPLabel ?? false);
    this.drawDependencyArrows(tasks, config, scrollX, scrollY, startRow, endRow);
    this.drawHeader(config, scrollX, canvasWidth);

    ctx.restore();
  }

  dateToX(dateStr: string, config: GanttViewConfig, scrollX: number): number {
    const days = dateToDays(dateStr) - dateToDays(config.startDate);
    return days * config.pixelsPerDay - scrollX;
  }

  rowToY(rowIndex: number, config: GanttViewConfig, scrollY: number): number {
    return config.headerHeight + rowIndex * config.rowHeight - scrollY;
  }

  private drawHeader(config: GanttViewConfig, scrollX: number, canvasWidth: number) {
    const ctx = this.ctx;
    const { headerHeight, pixelsPerDay, startDate } = config;

    // Header background
    ctx.fillStyle = this.colors.bgSecondary;
    ctx.fillRect(0, 0, canvasWidth, headerHeight);

    // Header bottom border
    ctx.strokeStyle = this.colors.borderDefault;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, headerHeight - 0.5);
    ctx.lineTo(canvasWidth, headerHeight - 0.5);
    ctx.stroke();

    ctx.fillStyle = this.colors.textMuted;
    ctx.font = "11px sans-serif";
    ctx.textAlign = "center";

    const visibleStartDay = Math.floor(scrollX / pixelsPerDay);
    const visibleEndDay = Math.ceil((scrollX + canvasWidth) / pixelsPerDay);

    if (config.timeScale === "day") {
      for (let i = visibleStartDay; i <= visibleEndDay; i++) {
        const date = addDays(startDate, i);
        const x = i * pixelsPerDay - scrollX + pixelsPerDay / 2;
        const dow = dayOfWeekUTC(date);
        ctx.fillStyle = dow === 0 || dow === 6 ? this.colors.accentRed : this.colors.textMuted;
        ctx.fillText(formatDate(date), x, headerHeight - 6);
      }
    } else if (config.timeScale === "week") {
      // Show week start dates
      for (let i = visibleStartDay; i <= visibleEndDay; i++) {
        const date = addDays(startDate, i);
        const dow = dayOfWeekUTC(date);
        if (dow === 1 || i === visibleStartDay) { // Monday
          const x = i * pixelsPerDay - scrollX + 2;
          ctx.textAlign = "left";
          ctx.fillStyle = this.colors.textMuted;
          ctx.fillText(formatDate(date), x, headerHeight - 6);
        }
      }
    } else {
      // Month: show month name
      let lastMonth = -1;
      for (let i = visibleStartDay; i <= visibleEndDay; i++) {
        const date = addDays(startDate, i);
        const month = parseInt(date.split("-")[1], 10);
        if (month !== lastMonth) {
          lastMonth = month;
          const x = i * pixelsPerDay - scrollX + 4;
          ctx.textAlign = "left";
          ctx.fillStyle = this.colors.textMuted;
          ctx.fillText(`${date.split("-")[0]}/${month}`, x, headerHeight - 6);
        }
      }
    }
  }

  private drawGrid(config: GanttViewConfig, scrollX: number, scrollY: number, canvasWidth: number, canvasHeight: number, taskCount: number) {
    const ctx = this.ctx;
    const { pixelsPerDay, startDate, headerHeight, rowHeight } = config;

    const visibleStartDay = Math.floor(scrollX / pixelsPerDay);
    const visibleEndDay = Math.ceil((scrollX + canvasWidth) / pixelsPerDay);

    for (let i = visibleStartDay; i <= visibleEndDay; i++) {
      const x = Math.round(i * pixelsPerDay - scrollX) + 0.5;
      const date = addDays(startDate, i);
      const dow = dayOfWeekUTC(date);

      // Weekend background
      if (dow === 0 || dow === 6) {
        ctx.fillStyle = this.colors.bgTertiary;
        ctx.fillRect(x - 0.5, headerHeight, pixelsPerDay, canvasHeight - headerHeight);
      }

      // Gridline (vertical)
      const isGridLine =
        config.timeScale === "day" ||
        (config.timeScale === "week" && dow === 1) ||
        (config.timeScale === "month" && date.endsWith("-01"));

      if (isGridLine) {
        ctx.strokeStyle = this.colors.borderSubtle;
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(x, headerHeight);
        ctx.lineTo(x, canvasHeight);
        ctx.stroke();
      }
    }

    // 行の水平罫線
    ctx.strokeStyle = this.colors.borderSubtle;
    ctx.lineWidth = 0.5;
    const startRow = Math.max(0, Math.floor(scrollY / rowHeight));
    const endRow = Math.min(taskCount, Math.ceil((scrollY + canvasHeight) / rowHeight) + 1);
    for (let r = startRow; r <= endRow; r++) {
      const y = Math.round(headerHeight + r * rowHeight - scrollY) + 0.5;
      if (y < headerHeight || y > canvasHeight) continue;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(canvasWidth, y);
      ctx.stroke();
    }
  }

  private drawTodayLine(config: GanttViewConfig, scrollX: number, canvasHeight: number) {
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const x = this.dateToX(todayStr, config, scrollX);

    if (x < -2 || x > this.ctx.canvas.width / this.dpr + 2) return;

    const ctx = this.ctx;
    ctx.strokeStyle = this.colors.accentBlue;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, config.headerHeight);
    ctx.lineTo(x, canvasHeight);
    ctx.stroke();
  }

  private drawBars(
    tasks: GanttTask[],
    config: GanttViewConfig,
    scrollX: number,
    scrollY: number,
    canvasWidth: number,
    startRow: number,
    endRow: number,
    criticalPath?: Set<number>,
    barColors: GanttBarColors = DEFAULT_BAR_COLORS,
    showCPLabel: boolean = false,
  ) {
    const ctx = this.ctx;
    const barHeight = config.rowHeight * 0.6;
    const barMargin = (config.rowHeight - barHeight) / 2;
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

    for (let i = startRow; i < endRow && i < tasks.length; i++) {
      const task = tasks[i];
      if (!task.startDate || !task.endDate) continue;

      const x1 = this.dateToX(task.startDate, config, scrollX);
      const x2 = this.dateToX(task.endDate, config, scrollX) + config.pixelsPerDay;
      const y = this.rowToY(i, config, scrollY) + barMargin;
      const barWidth = x2 - x1;

      // Skip if off screen
      if (x2 < 0 || x1 > canvasWidth) continue;

      const isCritical = criticalPath?.has(task.issueNumber) ?? false;
      const barColor = this.resolveBarColor(task, isCritical, barColors);

      // Background (full bar)
      ctx.fillStyle = barColor + "40";
      ctx.beginPath();
      ctx.roundRect(x1, y, barWidth, barHeight, 3);
      ctx.fill();

      // Progress fill
      if (task.progressValue > 0) {
        const progressWidth = barWidth * (task.progressValue / 100);
        ctx.fillStyle = barColor + "B0";
        ctx.beginPath();
        ctx.roundRect(x1, y, progressWidth, barHeight, 3);
        ctx.fill();
      }

      // Border (critical path = thick)
      ctx.strokeStyle = isCritical ? barColors.critical : barColor;
      ctx.lineWidth = isCritical ? 2.5 : 1;
      ctx.beginPath();
      ctx.roundRect(x1, y, barWidth, barHeight, 3);
      ctx.stroke();

      // Critical path marker (CPボタンON時のみテキスト表示)
      if (isCritical && showCPLabel && barWidth > 30) {
        ctx.fillStyle = barColors.critical;
        ctx.font = "bold 8px sans-serif";
        ctx.textAlign = "right";
        ctx.fillText("CP", x2 - 4, y + 10);
      }

      // 遅延/前倒し表示
      const todayDays = dateToDays(todayStr);
      const endDays = dateToDays(task.endDate);
      if (task.state === "closed") {
        // 完了済みで予定より早い場合 → 前倒し表示（明るい緑）
        const diff = endDays - todayDays;
        if (diff > 0) {
          ctx.fillStyle = barColors.closed + "50";
          ctx.font = "bold 9px sans-serif";
          ctx.textAlign = "right";
          ctx.fillText(`${diff}日前倒し`, x2 - 4, y - 2);
        }
      } else if (todayDays > endDays) {
        // 未完了で期限超過 → 赤い延長バー（透過なし）
        const delayDays = todayDays - endDays;
        const delayX = x2;
        const delayWidth = delayDays * config.pixelsPerDay;
        ctx.fillStyle = barColors.blocked;
        ctx.beginPath();
        ctx.roundRect(delayX, y, delayWidth, barHeight, [0, 3, 3, 0]);
        ctx.fill();
        // 遅延日数テキスト
        ctx.fillStyle = "#fff";
        ctx.font = "bold 9px sans-serif";
        ctx.textAlign = "left";
        if (delayWidth > 25) {
          ctx.fillText(`+${delayDays}d`, delayX + 3, y + barHeight / 2 + 3);
        } else {
          ctx.textAlign = "left";
          ctx.fillStyle = barColors.blocked;
          ctx.fillText(`+${delayDays}d`, delayX + delayWidth + 2, y + barHeight / 2 + 3);
        }
      }

      // Progress text inside bar
      if (barWidth > 50) {
        ctx.fillStyle = this.colors.textPrimary;
        ctx.font = "10px sans-serif";
        ctx.textAlign = "left";
        ctx.fillText(`${task.progressValue}%`, x1 + 4, y + barHeight - 4);
      }
    }
  }

  private resolveBarColor(task: GanttTask, isCritical: boolean, colors: GanttBarColors): string {
    if (task.state === "closed") return colors.closed;
    if (isCritical) return colors.critical;
    if (task.labels.some((l) => l.name === "優先:高")) return colors.highPriority;
    const statusLabel = task.labels.find((l) => l.name.startsWith("状態:"));
    if (statusLabel) {
      if (statusLabel.name === "状態:進行中") return colors.inProgress;
      if (statusLabel.name === "状態:ブロック") return colors.blocked;
    }
    return colors.default;
  }

  private drawDependencyArrows(
    tasks: GanttTask[],
    config: GanttViewConfig,
    scrollX: number,
    scrollY: number,
    startRow: number,
    endRow: number,
  ) {
    const ctx = this.ctx;
    const taskIndex = new Map<number, number>();
    tasks.forEach((t, i) => taskIndex.set(t.issueNumber, i));

    const barHeight = config.rowHeight * 0.6;
    const barMidY = (config.rowHeight - barHeight) / 2 + barHeight / 2;
    const gap = 8;

    for (let i = startRow; i < endRow && i < tasks.length; i++) {
      const task = tasks[i];
      if (task.dependencies.length === 0 || !task.startDate) continue;

      for (const depNum of task.dependencies) {
        const depIdx = taskIndex.get(depNum);
        if (depIdx === undefined) continue;
        const dep = tasks[depIdx];
        if (!dep.startDate || !dep.endDate) continue;

        // 先行タスクの右端 → 後続タスクの左端
        const fromX = this.dateToX(dep.endDate, config, scrollX) + config.pixelsPerDay;
        const fromY = this.rowToY(depIdx, config, scrollY) + barMidY;
        const toX = this.dateToX(task.startDate, config, scrollX);
        const toY = this.rowToY(i, config, scrollY) + barMidY;

        ctx.strokeStyle = this.colors.textSecondary;
        ctx.lineWidth = 1.5;
        ctx.beginPath();

        if (toX >= fromX + gap) {
          // 重なりなし: S字カーブ
          const bendX = (fromX + toX) / 2;
          ctx.moveTo(fromX, fromY);
          ctx.lineTo(bendX, fromY);
          ctx.lineTo(bendX, toY);
          ctx.lineTo(toX, toY);
        } else {
          // 重なりあり: 行間を迂回
          const belowRow = Math.max(depIdx, i) + 1;
          const channelY = this.rowToY(belowRow, config, scrollY) - 2;
          ctx.moveTo(fromX, fromY);
          ctx.lineTo(fromX + gap, fromY);
          ctx.lineTo(fromX + gap, channelY);
          ctx.lineTo(toX - gap, channelY);
          ctx.lineTo(toX - gap, toY);
          ctx.lineTo(toX, toY);
        }
        ctx.stroke();

        // 矢印ヘッド（常に右向き、後続タスクの左端に向かう）
        ctx.fillStyle = this.colors.textSecondary;
        ctx.beginPath();
        ctx.moveTo(toX, toY);
        ctx.lineTo(toX - 5, toY - 3);
        ctx.lineTo(toX - 5, toY + 3);
        ctx.closePath();
        ctx.fill();
      }
    }
  }

  /** クリック位置からタスクを特定 */
  hitTest(
    canvasX: number,
    canvasY: number,
    tasks: GanttTask[],
    config: GanttViewConfig,
    scrollX: number,
    scrollY: number,
  ): number | null {
    const rowIndex = Math.floor((canvasY - config.headerHeight + scrollY) / config.rowHeight);
    if (rowIndex < 0 || rowIndex >= tasks.length) return null;

    const task = tasks[rowIndex];
    if (!task.startDate || !task.endDate) return null;

    const x1 = this.dateToX(task.startDate, config, scrollX);
    const x2 = this.dateToX(task.endDate, config, scrollX) + config.pixelsPerDay;

    if (canvasX >= x1 && canvasX <= x2) {
      return task.issueNumber;
    }
    return null;
  }

  /** バーのどの部位をクリックしたか判定 */
  hitTestBar(
    canvasX: number,
    canvasY: number,
    tasks: GanttTask[],
    config: GanttViewConfig,
    scrollX: number,
    scrollY: number,
  ): { taskIndex: number; part: "move" | "resize-start" | "resize-end" } | null {
    // ヘッダー領域はスキップ
    if (canvasY < config.headerHeight) return null;

    const EDGE = 6;
    const rowIndex = Math.floor((canvasY - config.headerHeight + scrollY) / config.rowHeight);
    if (rowIndex < 0 || rowIndex >= tasks.length) return null;

    const task = tasks[rowIndex];
    if (!task.startDate || !task.endDate) return null;

    // バーのY範囲チェック
    const barHeight = config.rowHeight * 0.6;
    const barMargin = (config.rowHeight - barHeight) / 2;
    const barY = this.rowToY(rowIndex, config, scrollY) + barMargin;
    if (canvasY < barY || canvasY > barY + barHeight) return null;

    const x1 = this.dateToX(task.startDate, config, scrollX);
    const x2 = this.dateToX(task.endDate, config, scrollX) + config.pixelsPerDay;

    if (canvasX < x1 || canvasX > x2) return null;

    if (canvasX <= x1 + EDGE) return { taskIndex: rowIndex, part: "resize-start" };
    if (canvasX >= x2 - EDGE) return { taskIndex: rowIndex, part: "resize-end" };
    return { taskIndex: rowIndex, part: "move" };
  }

  /** ピクセルX座標を日付文字列に変換 */
  xToDate(canvasX: number, config: GanttViewConfig, scrollX: number): string {
    const days = Math.floor((canvasX + scrollX) / config.pixelsPerDay);
    const epochDays = days + dateToDays(config.startDate);
    const ms = epochDays * 86400000;
    const d = new Date(ms);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
}
