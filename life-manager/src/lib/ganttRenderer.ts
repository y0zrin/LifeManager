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
  /** 見積もりの色（仮の帯） */
  accentTeal: string;
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
    accentTeal: g("--accent-teal"),
  };
}

/**
 * 先行 → 後続 の矢印の道すじ（折れ線の点）。帯の中を通らないように:
 * 間があるときは、縦の線を、あいだの行の帯にかからない所に。間がない（後続が先にはじまる）ときは、先行の行のすぐ横の、
 * 行と行のあいだの溝で折り返す（後続の帯の中を通って裏へ回らない）。最後は、いつも左から後続の左端に入る
 */
export function routeDependency(o: {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  /** 折り返すときの溝の y（先行の行の、後続のある側の境目） */
  gutterY: number;
  /** その x に縦の線を引いても、あいだの行の帯にかからないか */
  free: (x: number) => boolean;
  stub: number;
}): [number, number][] {
  const { fromX, fromY, toX, toY, gutterY, free, stub } = o;
  if (toX >= fromX + stub * 2) {
    // 間がある: まん中から試し、だめなら先行の終わりから後続のはじまりまでを順に
    const span = toX - fromX - stub * 2;
    const candidates = [fromX + stub + span / 2];
    for (let k = 0; k <= 8; k++) candidates.push(fromX + stub + (span * k) / 8);
    const x = candidates.find(free) ?? fromX + stub + span / 2;
    return [[fromX, fromY], [x, fromY], [x, toY], [toX, toY]];
  }
  // 間がない: 先行のすぐ横で溝へ出て、後続の左へ戻り、左から入る
  const x1 = fromX + stub;
  let x2 = toX - stub;
  for (let k = 2; k <= 6 && !free(x2); k++) x2 = toX - stub * k;
  if (!free(x2)) x2 = toX - stub;
  return [[fromX, fromY], [x1, fromY], [x1, gutterY], [x2, gutterY], [x2, toY], [toX, toY]];
}

/** 折れ線を、角を丸めて引く */
function strokeRounded(ctx: CanvasRenderingContext2D, points: [number, number][], radius: number) {
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (let k = 1; k < points.length - 1; k++) {
    const [px, py] = points[k - 1];
    const [x, y] = points[k];
    const [nx, ny] = points[k + 1];
    // 角の前後の短いほうの半分まで（短い段で丸めすぎない）
    const r = Math.max(0, Math.min(radius, Math.hypot(x - px, y - py) / 2, Math.hypot(nx - x, ny - y) / 2));
    ctx.arcTo(x, y, nx, ny, r);
  }
  const last = points[points.length - 1];
  ctx.lineTo(last[0], last[1]);
  ctx.stroke();
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
    this.drawDeadline(config, scrollX, canvasHeight);
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
          const label = formatDate(date);
          ctx.textAlign = "left";
          // 左端の日付は、すぐあとの月曜の日付と重なるなら出さない
          const toMonday = (8 - dow) % 7;
          if (dow !== 1 && toMonday * pixelsPerDay < ctx.measureText(label).width + 8) continue;
          const x = i * pixelsPerDay - scrollX + 2;
          ctx.fillStyle = this.colors.textMuted;
          ctx.fillText(label, x, headerHeight - 6);
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
          const label = `${date.split("-")[0]}/${month}`;
          ctx.textAlign = "left";
          // 左端の月は、すぐあとの月の名前と重なるなら出さない
          if (i === visibleStartDay) {
            const [y, m, d] = date.split("-").map(Number);
            const daysLeft = new Date(Date.UTC(y, m, 0)).getUTCDate() - d + 1;
            if (d !== 1 && daysLeft * pixelsPerDay < ctx.measureText(label).width + 8) continue;
          }
          const x = i * pixelsPerDay - scrollX + 4;
          ctx.fillStyle = this.colors.textMuted;
          ctx.fillText(label, x, headerHeight - 6);
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

  /** マイルストーンの期限（その日の終わりに赤い点線） */
  private drawDeadline(config: GanttViewConfig, scrollX: number, canvasHeight: number) {
    if (!config.deadline) return;
    const x = this.dateToX(config.deadline, config, scrollX) + config.pixelsPerDay;
    if (x < -2 || x > this.ctx.canvas.width / this.dpr + 60) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = this.colors.accentRed;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(x, config.headerHeight);
    ctx.lineTo(x, canvasHeight);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = this.colors.accentRed;
    ctx.font = "10px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(`期限 ${formatDate(config.deadline)}`, x + 4, config.headerHeight + 12);
    ctx.restore();
  }

  /** 見積もりから仮に置いた帯（点線・うすい色）。マイルストーンの期限を超えた分は赤 */
  private drawTentativeBar(task: GanttTask, config: GanttViewConfig, x1: number, x2: number, y: number, barHeight: number, scrollX: number) {
    const ctx = this.ctx;
    const teal = this.colors.accentTeal;
    ctx.save();
    ctx.setLineDash([4, 3]);
    ctx.fillStyle = teal + "22";
    ctx.strokeStyle = teal;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x1, y, x2 - x1, barHeight, 3);
    ctx.fill();
    ctx.stroke();
    if (config.deadline && task.endDate && dateToDays(task.endDate) > dateToDays(config.deadline)) {
      const dx = Math.max(x1, this.dateToX(config.deadline, config, scrollX) + config.pixelsPerDay);
      ctx.fillStyle = this.colors.accentRed + "44";
      ctx.strokeStyle = this.colors.accentRed;
      ctx.beginPath();
      ctx.roundRect(dx, y, x2 - dx, barHeight, [0, 3, 3, 0]);
      ctx.fill();
      ctx.stroke();
    }
    ctx.setLineDash([]);
    if (x2 - x1 > 34 && task.estimate) {
      ctx.fillStyle = this.colors.textMuted;
      ctx.font = "10px sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(`仮 ${task.estimate}`, x1 + 4, y + barHeight - 4);
    }
    ctx.restore();
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

      // 見積もりからの仮の帯は、進み具合・遅れ・CP の印を付けずに点線で描く
      if (task.tentative) {
        this.drawTentativeBar(task, config, x1, x2, y, barHeight, scrollX);
        continue;
      }

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
    // 帯の端から、曲がるまでの長さ
    const stub = 8;
    // 見えている帯の右端（期限を過ぎた帯は、赤い延長と、外に出る「+3d」の字まで）
    const now = new Date();
    const todayDays = dateToDays(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`);
    const visibleEnd = (t: GanttTask) => {
      const x = this.dateToX(t.endDate!, config, scrollX) + config.pixelsPerDay;
      const late = t.state === "closed" ? 0 : todayDays - dateToDays(t.endDate!);
      if (late <= 0) return x;
      const w = late * config.pixelsPerDay;
      return x + w + (w > 25 ? 0 : 26);
    };
    // 行ごとの帯の左右（あいだの行の帯にかからない縦の道を探すため）
    const spans = tasks.map((t) => (t.startDate && t.endDate ? [this.dateToX(t.startDate, config, scrollX), visibleEnd(t)] : null));

    // 見えている行を通る矢印をぜんぶ引く（後続・先行のどちらかが画面の外でも。前は後続が見えているものだけで、
    // 見えている先行から画面の下の後続へ向かう矢印が出なかった）。画面の外の分は、キャンバスの外・見出しの下に隠れる
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      if (task.dependencies.length === 0 || !task.startDate) continue;

      for (const depNum of task.dependencies) {
        const depIdx = taskIndex.get(depNum);
        if (depIdx === undefined) continue;
        if (Math.max(depIdx, i) < startRow || Math.min(depIdx, i) >= endRow) continue;
        const dep = tasks[depIdx];
        if (!dep.startDate || !dep.endDate) continue;

        // 先行タスクの（見えている）右端 → 後続タスクの左端
        const plannedEnd = this.dateToX(dep.endDate, config, scrollX) + config.pixelsPerDay;
        const fromX = visibleEnd(dep);
        const fromY = this.rowToY(depIdx, config, scrollY) + barMidY;
        const toX = this.dateToX(task.startDate, config, scrollX);
        const toY = this.rowToY(i, config, scrollY) + barMidY;
        const lo = Math.min(depIdx, i);
        const hi = Math.max(depIdx, i);
        const free = (x: number) => {
          for (let r = lo + 1; r < hi; r++) {
            const sp = spans[r];
            if (sp && x > sp[0] - 3 && x < sp[1] + 3) return false;
          }
          return true;
        };
        // 折り返すときの、行と行のあいだの溝（先行の行の、後続のある側）
        const gutterY = this.rowToY(i > depIdx ? depIdx + 1 : depIdx, config, scrollY);
        const points = routeDependency({ fromX, fromY, toX, toY, gutterY, free, stub });
        // 後続が、先行の終わる予定より前にはじまる（順番が守られていない）: 赤の点線
        const broken = toX < plannedEnd;

        // 下地（背景の色の太い線）を先に引いて、格子や帯の上でも線が読めるように
        ctx.save();
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.strokeStyle = this.colors.bgPrimary;
        ctx.globalAlpha = 0.75;
        ctx.lineWidth = 4.5;
        strokeRounded(ctx, points, 5);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = broken ? this.colors.accentRed : this.colors.textSecondary;
        ctx.lineWidth = 1.5;
        if (broken) ctx.setLineDash([4, 3]);
        strokeRounded(ctx, points, 5);
        ctx.setLineDash([]);

        // 矢印の頭（いつも右向き。後続タスクの左端に向かう）
        ctx.fillStyle = broken ? this.colors.accentRed : this.colors.textSecondary;
        ctx.beginPath();
        ctx.moveTo(toX, toY);
        ctx.lineTo(toX - 6, toY - 3.5);
        ctx.lineTo(toX - 6, toY + 3.5);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
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
