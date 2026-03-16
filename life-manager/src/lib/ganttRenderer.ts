import type { GanttTask, GanttViewConfig } from "./ganttTypes";

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
  ) {
    const ctx = this.ctx;
    ctx.save();
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);

    this.drawGrid(config, scrollX, canvasWidth, canvasHeight);
    this.drawTodayLine(config, scrollX, canvasHeight);
    this.drawBars(tasks, config, scrollX, scrollY, canvasWidth, startRow, endRow);
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

  private drawGrid(config: GanttViewConfig, scrollX: number, canvasWidth: number, canvasHeight: number) {
    const ctx = this.ctx;
    const { pixelsPerDay, startDate, headerHeight } = config;

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

      // Gridline
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
  ) {
    const ctx = this.ctx;
    const barHeight = config.rowHeight * 0.6;
    const barMargin = (config.rowHeight - barHeight) / 2;

    for (let i = startRow; i < endRow && i < tasks.length; i++) {
      const task = tasks[i];
      if (!task.startDate || !task.endDate) continue;

      const x1 = this.dateToX(task.startDate, config, scrollX);
      const x2 = this.dateToX(task.endDate, config, scrollX) + config.pixelsPerDay;
      const y = this.rowToY(i, config, scrollY) + barMargin;
      const barWidth = x2 - x1;

      // Skip if off screen
      if (x2 < 0 || x1 > canvasWidth) continue;

      // Bar color from status label
      const barColor = this.getBarColor(task);

      // Background (full bar)
      ctx.fillStyle = barColor + "40"; // 25% opacity
      ctx.beginPath();
      ctx.roundRect(x1, y, barWidth, barHeight, 3);
      ctx.fill();

      // Progress fill
      if (task.progressValue > 0) {
        const progressWidth = barWidth * (task.progressValue / 100);
        ctx.fillStyle = barColor + "B0"; // 70% opacity
        ctx.beginPath();
        ctx.roundRect(x1, y, progressWidth, barHeight, 3);
        ctx.fill();
      }

      // Border
      ctx.strokeStyle = barColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(x1, y, barWidth, barHeight, 3);
      ctx.stroke();

      // Progress text inside bar
      if (barWidth > 50) {
        ctx.fillStyle = this.colors.textPrimary;
        ctx.font = "10px sans-serif";
        ctx.textAlign = "left";
        ctx.fillText(`${task.progressValue}%`, x1 + 4, y + barHeight - 4);
      }
    }
  }

  private getBarColor(task: GanttTask): string {
    if (task.state === "closed") return this.colors.accentGreen;
    const statusLabel = task.labels.find((l) => l.name.startsWith("状態:"));
    if (statusLabel) {
      if (statusLabel.name === "状態:進行中") return this.colors.accentBlue;
      if (statusLabel.name === "状態:ブロック") return this.colors.accentRed;
    }
    return this.colors.textMuted;
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
        if (!dep.endDate) continue;

        const fromX = this.dateToX(dep.endDate, config, scrollX) + config.pixelsPerDay;
        const fromY = this.rowToY(depIdx, config, scrollY) + barMidY;
        const toX = this.dateToX(task.startDate, config, scrollX);
        const toY = this.rowToY(i, config, scrollY) + barMidY;

        ctx.strokeStyle = this.colors.textSecondary;
        ctx.lineWidth = 1.5;
        ctx.beginPath();

        const midX = fromX + gap;
        if (toX >= midX) {
          // バー重なりなし: シンプルなS字
          const bendX = (fromX + toX) / 2;
          ctx.moveTo(fromX, fromY);
          ctx.lineTo(bendX, fromY);
          ctx.lineTo(bendX, toY);
          ctx.lineTo(toX, toY);
        } else {
          // バー重なりあり: 行間の隙間を通る迂回ルート
          const channelRow = depIdx < i ? depIdx + 1 : depIdx;
          const channelY = this.rowToY(channelRow, config, scrollY);
          const elbowL = toX - gap;
          ctx.moveTo(fromX, fromY);
          ctx.lineTo(midX, fromY);
          ctx.lineTo(midX, channelY);
          ctx.lineTo(elbowL, channelY);
          ctx.lineTo(elbowL, toY);
          ctx.lineTo(toX, toY);
        }
        ctx.stroke();

        // Arrowhead
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
}
