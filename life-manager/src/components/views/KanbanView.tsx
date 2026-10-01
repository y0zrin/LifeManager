import { useState, useCallback, useRef, useEffect, type CSSProperties } from "react";
import type { GitHubIssue, GitHubLabel, GitHubMilestone, BoardConfig, BoardColumn, BoardGenre, GitHubUser } from "../../lib/types";
import { IssueSendState, SendingBird, isUnsent } from "../common/Sending";
import { Buncho } from "../common/Buncho";
import { isIdle } from "../../lib/idle";
import { issueRef } from "../../lib/issueRef";
import { PendingChip } from "../common/PendingChip";
import { BOARD_GENRES, DEFAULT_COLUMNS, genreOf } from "../../lib/board";
import type { Theme } from "../../lib/theme";
import { ESTIMATE_PREFIX, estimateDays, estimateOf, formatEstimate, sumEstimates } from "../../lib/estimate";
import { daysUntil, dueOf } from "../../lib/due";
import { EstimateSumText, useEstimateUnit } from "../common/EstimateChip";
import { TaskFilterButton, TaskFilterChips, type TaskFilterProps } from "../common/TaskFilterButton";
import { matchesLabelFilters, type LabelFilters } from "../../lib/taskList";
import type { MilestoneFilter } from "../../lib/savedViews";
import { closingIssues, issueOfBranch, listPulls, pullVerdicts } from "../../lib/pulls";

interface KanbanViewProps {
  owner: string;
  repo: string;
  issues: GitHubIssue[];
  labels: GitHubLabel[];
  milestones: GitHubMilestone[];
  collaborators: GitHubUser[];
  boardConfig: BoardConfig | null;
  currentUser: string;
  /** 作業タブで取り組んでいる Issue（「✏️ 作業中」の印） */
  workingIssue: number | null;
  onStatusChange: (n: number, status: string) => void;
  onSelectIssue: (n: number) => void;
  onOpenPull: (n: number) => void;
  /** 見た目（テーマのボード: 黒板・ホワイトボード・クエストボード） */
  look: Theme;
  /** 下の机に置いた付箋を、自分の担当にする */
  onAssignToMe: (n: number) => void;
  /** 設定 → タスク の「ボードの区画」を開く */
  onOpenBoardSettings: () => void;
}

const GENRE_KEY = "board-genre";
const MINE_KEY = "board-mine-only";

function loadPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return (allowed as readonly string[]).includes(v ?? "") ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

function savePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 覚えられなくても、今は選んだとおりに出す
  }
}

function useIsMobile(breakpoint = 640) {
  const [isMobile, setIsMobile] = useState(window.innerWidth < breakpoint);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener("change", handler);
    setIsMobile(mq.matches);
    return () => mq.removeEventListener("change", handler);
  }, [breakpoint]);
  return isMobile;
}

/** 空の区画に出す、どうすれば入るか */
const EMPTY_HINTS: Record<string, string> = {
  "状態:進行中": "作業タブで始めると、ここに入ります",
  "状態:チェック待ち": "プルリクを作ると、ここに入ります",
};

/** ボードの下の机（テーマごと）。付箋を置くと、自分の担当になる */
const DESKS: Record<Theme, { name: string; count: string; drop: string; empty: string; deco: string }> = {
  chalk: { name: "✏️ 自分の机", count: "自分の担当", drop: "ここに置くと、自分の担当になります", empty: "担当の付箋はありません。付箋をここへ持ってくると、自分の担当になります", deco: "📓✏️" },
  white: { name: "🖥 自分のデスク", count: "自分の担当", drop: "ここに置くと、自分の担当になります", empty: "担当の付箋はありません。付箋をここへ持ってくると、自分の担当になります", deco: "⌨️☕" },
  quest: { name: "🛎 ギルドの受付", count: "受注した依頼", drop: "受付に出すと、受注します（自分の担当になります）", empty: "受注した依頼はありません。依頼書をここへ持ってくると、受注します", deco: "🛎🪶" },
  night: { name: "🌙 夜の机", count: "自分の担当", drop: "ここに置くと、自分の担当になります", empty: "担当の付箋はありません。付箋をここへ持ってくると、自分の担当になります", deco: "🕯️☕" },
  day: { name: "☀️ カフェのテーブル", count: "自分の担当", drop: "ここに置くと、自分の担当になります", empty: "担当の付箋はありません。付箋をここへ持ってくると、自分の担当になります", deco: "🌿☕" },
  spring: { name: "🌸 春の机", count: "自分の担当", drop: "ここに置くと、自分の担当になります", empty: "担当の付箋はありません。付箋をここへ持ってくると、自分の担当になります", deco: "🍡🍵" },
  winter: { name: "❄️ こたつ", count: "自分の担当", drop: "こたつに入れると、自分の担当になります", empty: "担当の付箋はありません。付箋をここへ持ってくると、自分の担当になります", deco: "🍊🍊" },
  kingyo: { name: "🎐 縁側", count: "自分の担当", drop: "ここに置くと、自分の担当になります", empty: "担当の付箋はありません。付箋をここへ持ってくると、自分の担当になります", deco: "🍉🍧" },
  // 文机の上の小物（手紙・一輪挿し・湯のみ）は App.css の絵
  buncho: { name: "🪶 文机", count: "自分の担当", drop: "ここに置くと、自分の担当になります", empty: "担当の付箋はありません。付箋をここへ持ってくると、自分の担当になります", deco: "" },
};

/**
 * 文鳥のテーマ: パートナーの文鳥がとまるボードと、止まり木の上の場所。しばらくすると（26〜48 秒）、ほかのボードの止まり木へ移る。
 * だれも操作していないあいだ（窓が前面にない・隠れている）と、背景の動きを止めているあいだは移らない
 */
function usePerch(count: number, on: boolean) {
  const [perch, setPerch] = useState<{ at: number; x: number; flip: boolean; phase: "arrive" | "leave" }>({ at: 0, x: 18, flip: true, phase: "arrive" });
  useEffect(() => {
    if (!on || count === 0) return;
    let timer = 0;
    const schedule = () => {
      timer = window.setTimeout(move, 26000 + Math.random() * 22000);
    };
    const move = () => {
      if (isIdle() || document.documentElement.classList.contains("stage-still")) {
        schedule();
        return;
      }
      setPerch((p) => ({ ...p, phase: "leave" }));
      timer = window.setTimeout(() => {
        setPerch((p) => ({
          at: count > 1 ? (p.at + 1 + Math.floor(Math.random() * (count - 1))) % count : 0,
          x: Math.round(8 + Math.random() * 56),
          flip: Math.random() < 0.6,
          phase: "arrive",
        }));
        schedule();
      }, 450);
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, [count, on]);
  return { ...perch, at: Math.min(perch.at, Math.max(0, count - 1)) };
}

/** 金魚のテーマ: 水そう（ボード）の中を泳ぐ金魚。ボードごとに、色・場所・向き・速さを変える */
const FISH: { kind: "red" | "black" | "sarasa"; x: number; y: number; dx: number; dy: number; t: number; d: number }[] = [
  { kind: "red", x: 16, y: 56, dx: 150, dy: -14, t: 11, d: 0 },
  { kind: "black", x: 58, y: 74, dx: -120, dy: 10, t: 13, d: -4 },
  { kind: "sarasa", x: 30, y: 86, dx: 170, dy: -6, t: 15, d: -2 },
];

function Fishes({ seed }: { seed: number }) {
  const count = seed % 2 === 0 ? 3 : 2;
  return (
    <div className="bd-fishes" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => {
        const f = FISH[(seed + i) % FISH.length];
        const style = {
          left: `${(f.x + seed * 17) % 60 + 8}%`,
          top: `${f.y - (seed % 3) * 7}%`,
          "--dx": `${f.dx}px`,
          "--dy": `${f.dy}px`,
          // 絵は右向き。はじめに左へ進む金魚は、左を向いて泳ぎ出す
          "--face": f.dx < 0 ? -1 : 1,
          "--t": `${f.t + (seed % 3)}s`,
          "--d": `${f.d - seed * 1.3}s`,
        } as CSSProperties;
        return <span key={i} className={`bd-fish ${f.kind}`} style={style} />;
      })}
    </div>
  );
}

/** 付箋の色（ホワイトボード・黒板）: 種別で分ける */
function noteColor(issue: GitHubIssue): string {
  const kind = issue.labels.find((l) => l.name.startsWith("種別:"))?.name;
  if (kind === "種別:バグ") return "pink";
  if (kind === "種別:メモ") return "blue";
  if (kind === "種別:ルーチン") return "green";
  return "yellow";
}

/** 見積もりから、難しさの星（クエストボード）。日に直して 1〜5 */
function starsOf(issue: GitHubIssue): string {
  const e = estimateOf(issue);
  if (!e) return "";
  const d = estimateDays(e);
  const n = d <= 0.25 ? 1 : d <= 1 ? 2 : d <= 3 ? 3 : d <= 5 ? 4 : 5;
  return "★".repeat(n);
}

/** つないだプルリクと、その進み（付箋の「🔃 #2 レビュー待ち」） */
interface PullMark {
  number: number;
  state: string;
}

interface NoteProps {
  issue: GitHubIssue;
  look: Theme;
  me: string;
  working: boolean;
  pull: PullMark | null;
  onOpenPull: (n: number) => void;
}

/** 付箋（クエストボードでは依頼書） */
function BoardNote({ issue, look, me, working, pull, onOpenPull }: NoteProps) {
  const est = estimateOf(issue);
  const due = issue.state === "open" ? dueOf(issue) : null;
  const days = due ? daysUntil(due.date) : null;
  const [, m, d] = due ? due.date.split("-").map(Number) : [0, 0, 0];
  const overdue = days !== null && days < 0;
  const names = (issue.assignees ?? []).map((a) => a.login);
  const mine = !!me && names.includes(me);
  const others = names.filter((n) => n !== me);
  const quest = look === "quest";
  // 番号で決まる、少しの傾き（毎回同じ）
  const tilt = (((issue.number * 37) % 7) - 3) * 0.4;
  const fields = issue.labels.filter((l) => l.name.startsWith("分野:")).map((l) => l.name.replace("分野:", ""));

  return (
    <div className={`bd-note bd-${quest ? "paper" : noteColor(issue)}${mine ? " mine" : ""}${issue._sending ? " sending" : ""}${issue._failed ? " failed" : ""}`} style={{ "--tilt": `${tilt}deg` } as CSSProperties}>
      {overdue && <span className="bd-late">期限切れ</span>}
      <div className="bd-nt">
        <span className="bd-no">{issueRef(issue.number)}</span>
        {issue.title}
        {issue._pending && <PendingChip />}
      </div>
      {isUnsent(issue) && (
        <div className="bd-send">
          <IssueSendState issue={issue} />
        </div>
      )}
      <div className="bd-line">
        {quest && est && <span className="bd-stars">{starsOf(issue)}</span>}
        {est && <span>{quest ? `報酬 ${formatEstimate(est.value, est.unit)}` : formatEstimate(est.value, est.unit)}</span>}
        {due && (
          <span className={overdue ? "bd-over" : ""}>
            {quest ? `期限 ${m}/${d}` : overdue ? `${m}/${d} 期限切れ！` : `${m}/${d} まで`}
          </span>
        )}
        {fields.length > 0 && <span>{fields.join("・")}</span>}
      </div>
      <div className="bd-foot">
        {mine ? (
          quest ? (
            <span className="bd-hanko">受注</span>
          ) : (
            <span className="bd-magnet">{me.slice(0, 1).toUpperCase()}</span>
          )
        ) : others.length > 0 && !quest ? (
          <span className="bd-magnet other">{others[0].slice(0, 1).toUpperCase()}</span>
        ) : null}
        <span className={mine ? "bd-mine" : "bd-who"}>
          {mine ? (others.length > 0 ? `自分・${others.join("・")}` : "自分") : others.length > 0 ? others.join("・") : quest ? "受注者 募集中" : "担当なし"}
        </span>
        {working && <span className="bd-flag work">✏️ 作業中</span>}
        {pull && (
          <button
            type="button"
            className="bd-flag pr"
            title={`プルリク #${pull.number} を開く`}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onOpenPull(pull.number);
            }}
          >
            🔃 #{pull.number} {pull.state}
          </button>
        )}
      </div>
    </div>
  );
}

export function KanbanView({ owner, repo, issues, labels, milestones, collaborators, boardConfig, currentUser, workingIssue, onStatusChange, onSelectIssue, onOpenPull, look, onAssignToMe, onOpenBoardSettings }: KanbanViewProps) {
  const baseColumns = boardConfig?.columns || DEFAULT_COLUMNS;
  const unit = useEstimateUnit();
  const isMobile = useIsMobile();

  // ジャンル・自分の担当だけ（この PC に覚えておく。見た目はテーマのもの）
  const [genre, setGenreState] = useState<BoardGenre>(() => loadPref(GENRE_KEY, ["triage", "doing"] as const, "doing"));
  const [mineOnly, setMineOnlyState] = useState(() => loadPref(MINE_KEY, ["1", "0"] as const, "0") === "1");
  const setGenre = (v: BoardGenre) => { setGenreState(v); savePref(GENRE_KEY, v); };
  const setMineOnly = (v: boolean) => { setMineOnlyState(v); savePref(MINE_KEY, v ? "1" : "0"); };

  // 検索・フィルタ（タスク一覧と同じ部品。状態はボードの区画なので、ラベルの絞り込みからは外す）
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<LabelFilters>({});
  const [assignee, setAssignee] = useState("");
  const [milestone, setMilestone] = useState<MilestoneFilter | null>(null);
  const categoryNames: Record<string, string> = { "種別:": "種別", "分野:": "分野", "優先:": "優先", [ESTIMATE_PREFIX]: "見積" };
  const filterProps: TaskFilterProps = {
    categories: Object.keys(categoryNames)
      .map((prefix) => ({ prefix, name: categoryNames[prefix], labels: labels.filter((l) => l.name.startsWith(prefix)) }))
      .filter((c) => c.labels.length > 0),
    filters,
    onFiltersChange: setFilters,
    assignee,
    onAssigneeChange: setAssignee,
    currentUser,
    collaborators,
    milestone,
    onMilestoneChange: setMilestone,
    milestones,
    milestoneTitle: (n) => milestones.find((x) => x.number === n)?.title,
    state: "open",
    onStateChange: () => {},
    showState: false,
  };

  // つないだプルリク（説明の Closes #N・issue-N のブランチ）。読めなければ印を出さない
  const [pullOf, setPullOf] = useState<Map<number, PullMark>>(new Map());
  useEffect(() => {
    if (!owner || !repo) return;
    let alive = true;
    const load = async () => {
      try {
        const open = (await listPulls(owner, repo)).filter((p) => p.state === "open");
        const verdicts = open.length > 0 ? await pullVerdicts(owner, repo, open.map((p) => p.number)).catch(() => ({})) : {};
        const map = new Map<number, PullMark>();
        for (const p of open) {
          const v = (verdicts as Record<string, { approved: string[]; changes_requested: string[] }>)[String(p.number)];
          const state = p.draft ? "下書き" : v?.changes_requested.length ? "修正の依頼" : v?.approved.length ? "承認済み" : "レビュー待ち";
          const branchIssue = issueOfBranch(p.head);
          for (const n of [...closingIssues(p.body ?? ""), ...(branchIssue !== null ? [branchIssue] : [])]) {
            if (!map.has(n)) map.set(n, { number: p.number, state });
          }
        }
        if (alive) setPullOf(map);
      } catch {
        // プルリクの権限がないときなど
      }
    };
    load();
    const timer = window.setInterval(load, 120000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [owner, repo]);

  // 絞り込み
  const q = query.trim().toLowerCase().replace(/^#/, "");
  const shown = issues.filter((i) => {
    if (q && !(String(i.number).startsWith(q) || i.title.toLowerCase().includes(q))) return false;
    if (mineOnly && !i.assignees?.some((a) => a.login === currentUser)) return false;
    if (assignee && !i.assignees?.some((a) => a.login === assignee)) return false;
    if (milestone === "none" ? i.milestone : milestone !== null && i.milestone?.number !== milestone) return false;
    return matchesLabelFilters(i, filters);
  });
  const issuesOf = (col: BoardColumn) =>
    col.key === "none" ? shown.filter((i) => !i.labels.some((l) => l.name.startsWith("状態:"))) : shown.filter((i) => i.labels.some((l) => l.name === col.key));
  const columnsOf = (g: BoardGenre) => baseColumns.filter((c) => genreOf(c) === g);
  const countOf = (g: BoardGenre) => columnsOf(g).reduce((n, c) => n + issuesOf(c).length, 0);
  // ジャンルのタブに落としたときの行き先（着手済み → 進行中、未整理 → 未着手。なければ最初の区画）
  const landingOf = (g: BoardGenre) => {
    const cols = columnsOf(g);
    const prefer = g === "doing" ? "状態:進行中" : "状態:未着手";
    return (cols.find((c) => c.key === prefer) ?? cols[0])?.key ?? null;
  };

  // --- ドラッグ（PC。マウスで付箋を区画・タブへ） ---
  const [dragging, setDragging] = useState<number | null>(null);
  const [dragFrom, setDragFrom] = useState("");
  const [over, setOver] = useState<string | null>(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const isDraggingRef = useRef(false);
  const downRef = useRef<{ x: number; y: number; issue: number; status: string } | null>(null);
  const offsetRef = useRef({ x: 0, y: 0 });
  const targets = useRef<Map<string, HTMLElement>>(new Map());
  const target = (key: string) => (el: HTMLElement | null) => {
    if (el) targets.current.set(key, el);
    else targets.current.delete(key);
  };

  const statusOf = (issue: GitHubIssue) => issue.labels.find((l) => l.name.startsWith("状態:"))?.name || "";

  const onNoteMouseDown = useCallback((e: React.MouseEvent, issue: number, status: string) => {
    if (e.button !== 0) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    downRef.current = { x: e.clientX, y: e.clientY, issue, status };
    offsetRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }, []);

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!downRef.current) return;
      if (!isDraggingRef.current && (Math.abs(e.clientX - downRef.current.x) > 5 || Math.abs(e.clientY - downRef.current.y) > 5)) {
        isDraggingRef.current = true;
        setDragging(downRef.current.issue);
        setDragFrom(downRef.current.status);
      }
      if (!isDraggingRef.current) return;
      setMousePos({ x: e.clientX, y: e.clientY });
      let found: string | null = null;
      targets.current.forEach((el, key) => {
        const r = el.getBoundingClientRect();
        if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) found = key;
      });
      setOver(found);
    }
    function onUp() {
      if (isDraggingRef.current && dragging !== null && over === "@desk") {
        takeToDesk(dragging);
      } else if (isDraggingRef.current && dragging !== null && over !== null) {
        const dest = over.startsWith("@genre:") ? landingOf(over.slice(7) as BoardGenre) : over;
        const status = dest === "none" || dest === null ? "" : dest;
        if (dest !== null && status !== dragFrom) onStatusChange(dragging, status);
        // タブに落としたら、そのボードを開く
        if (over.startsWith("@genre:")) setGenre(over.slice(7) as BoardGenre);
      }
      downRef.current = null;
      setDragging(null);
      setOver(null);
      setDragFrom("");
      window.setTimeout(() => {
        isDraggingRef.current = false;
      }, 100);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging, dragFrom, over, onStatusChange]);

  // --- スマホ: 「移動」で区画を選ぶ ---
  const [moving, setMoving] = useState<number | null>(null);

  const draggedIssue = dragging !== null ? issues.find((i) => i.number === dragging) ?? null : null;

  // --- 下の机（自分の担当。絞り込みにかかわらず、区画の並びの順） ---
  const desk = DESKS[look];
  const colIndex = (issue: GitHubIssue) => {
    const i = baseColumns.findIndex((c) => c.key === (statusOf(issue) || "none"));
    return i < 0 ? baseColumns.length : i;
  };
  const myIssues = issues
    .filter((i) => i.state === "open" && !!currentUser && i.assignees?.some((a) => a.login === currentUser))
    .sort((a, b) => colIndex(a) - colIndex(b) || a.number - b.number);
  const [deskNote, setDeskNote] = useState<string | null>(null);
  useEffect(() => {
    if (!deskNote) return;
    const t = window.setTimeout(() => setDeskNote(null), 4000);
    return () => window.clearTimeout(t);
  }, [deskNote]);
  /** 机に置いた付箋: 担当がなければ自分の担当に。ほかの人の担当は置けない */
  function takeToDesk(n: number) {
    const issue = issues.find((i) => i.number === n);
    const names = (issue?.assignees ?? []).map((a) => a.login);
    if (!issue || !currentUser || names.includes(currentUser)) return;
    if (names.length > 0) {
      setDeskNote(`#${n} は ${names.join("・")} の担当です（Issue の詳細で担当を変えられます）`);
      return;
    }
    onAssignToMe(n);
    setDeskNote(look === "quest" ? `#${n} を受注しました` : `#${n} を自分の担当にしました`);
  }
  // ドラッグ中に、机に置けるか
  const deskHint = (() => {
    if (!draggedIssue) return null;
    const names = (draggedIssue.assignees ?? []).map((a) => a.login);
    if (names.includes(currentUser)) return { ok: false, text: look === "quest" ? "もう受注しています" : "もう自分の担当です" };
    if (names.length > 0) return { ok: false, text: `ほかの人（${names.join("・")}）の担当です` };
    return { ok: true, text: desk.drop };
  })();
  const cols = columnsOf(genre);
  const perch = usePerch(cols.length, look === "buncho");

  const note = (issue: GitHubIssue) => (
    <BoardNote issue={issue} look={look} me={currentUser} working={issue.number === workingIssue} pull={pullOf.get(issue.number) ?? null} onOpenPull={onOpenPull} />
  );

  return (
    <div className="bd-view">
      <div className="bd-toolbar">
        <div className="search-bar bd-search">
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Issue を検索..." className="search-input" />
          {query && (
            <button className="search-clear" onClick={() => setQuery("")}>
              ×
            </button>
          )}
        </div>
        <TaskFilterButton {...filterProps} />
        <button type="button" className={`bd-mine-toggle${mineOnly ? " on" : ""}`} aria-pressed={mineOnly} onClick={() => setMineOnly(!mineOnly)}>
          👤 自分の担当だけ{mineOnly ? " ✓" : ""}
        </button>
        <span className="grow" />
        <button className="btn-sm" onClick={onOpenBoardSettings} title="設定 → タスク の「ボードの区画」を開きます">
          ⚙ 区画の設定
        </button>
      </div>
      <TaskFilterChips {...filterProps} />

      <div className="bd-tabs" role="tablist" aria-label="ボード">
        {BOARD_GENRES.map((g) => (
          <button
            key={g.key}
            ref={target(`@genre:${g.key}`)}
            type="button"
            role="tab"
            aria-selected={genre === g.key}
            className={`bd-tab${genre === g.key ? " on" : ""}${over === `@genre:${g.key}` && genre !== g.key ? " over" : ""}`}
            onClick={() => setGenre(g.key)}
          >
            {g.icon} {g.label}
            <span className="bd-tab-n">{countOf(g.key)}</span>
            <small>{dragging !== null && genre !== g.key ? "ここに落とすと移せます" : g.about}</small>
          </button>
        ))}
      </div>

      <div className={`bd-wall look-${look}`}>
        {cols.length === 0 && <p className="bd-none">このボードに置く区画がありません（⚙ 区画の設定 で選べます）</p>}
        {cols.map((col, ci) => {
          const list = issuesOf(col);
          return (
            <section key={col.key} ref={target(col.key)} className={`bd-board${over === col.key ? " over" : ""}`}>
              {look === "kingyo" && <Fishes seed={ci} />}
              {look === "buncho" && perch.at === ci && (
                <span key={`perch-${perch.at}-${perch.x}`} className={`bd-partner ${perch.phase}`} style={{ left: `${perch.x}%` }}>
                  <Buncho flip={perch.flip} />
                </span>
              )}
              <header className="bd-head">
                <span className="bd-title">
                  {col.emoji} {col.title}
                </span>
                <span className="bd-count">{list.length}</span>
                <EstimateSumText sum={sumEstimates(list, unit)} showMissing={false} />
              </header>
              <div className="bd-notes">
                {list.map((issue) => (
                  <div
                    key={issue.number}
                    className={`bd-slot${dragging === issue.number ? " dragging" : ""}`}
                    onMouseDown={isMobile || isUnsent(issue) ? undefined : (e) => onNoteMouseDown(e, issue.number, statusOf(issue))}
                    onClick={() => {
                      // 送っているあいだ・送れなかった仮の付箋は開かない
                      if (!isDraggingRef.current && !isUnsent(issue)) onSelectIssue(issue.number);
                    }}
                  >
                    {note(issue)}
                    {/* 送っている途中・送れなかった仮の付箋は、まだ動かせない */}
                    {isMobile && !isUnsent(issue) && (
                      <button
                        type="button"
                        className="btn-sm bd-move"
                        onClick={(e) => {
                          e.stopPropagation();
                          setMoving(moving === issue.number ? null : issue.number);
                        }}
                      >
                        移動
                      </button>
                    )}
                    {isMobile && moving === issue.number && (
                      <div className="kanban-status-sheet" onClick={(e) => e.stopPropagation()}>
                        {currentUser && !issue.assignees?.length && (
                          <button
                            className="kanban-status-option"
                            onClick={() => {
                              onAssignToMe(issue.number);
                              setMoving(null);
                            }}
                          >
                            🙋 {look === "quest" ? "受注する（自分の担当にする）" : "自分の担当にする"}
                          </button>
                        )}
                        {baseColumns
                          .filter((c) => c.key !== (statusOf(issue) || "none"))
                          .map((c) => (
                            <button
                              key={c.key}
                              className="kanban-status-option"
                              onClick={() => {
                                onStatusChange(issue.number, c.key === "none" ? "" : c.key);
                                setMoving(null);
                              }}
                            >
                              {c.emoji} {c.title}
                            </button>
                          ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
              {list.length === 0 && <div className="bd-empty">{EMPTY_HINTS[col.key] ?? (isMobile ? "「移動」で、ここに移せます" : "ここへドラッグして貼ります")}</div>}
            </section>
          );
        })}
      </div>

      {/* 下の机（PC）。付箋を置くと自分の担当に。机の上には自分の担当が並ぶ（押すと詳細・ドラッグで区画へ） */}
      {!isMobile && currentUser && (
        <div ref={target("@desk")} className={`bd-desk desk-${look}${over === "@desk" ? " over" : ""}`}>
          <div className="bd-desk-name">
            <b>{desk.name}</b>
            <small>
              {desk.count} {myIssues.length}
            </small>
          </div>
          <div className="bd-desk-items">
            {myIssues.length === 0 && <span className="bd-desk-empty">{desk.empty}</span>}
            {myIssues.map((issue) => (
              <button
                key={issue.number}
                type="button"
                className={`bd-desk-chip bd-${look === "quest" ? "paper" : noteColor(issue)}${dragging === issue.number ? " dragging" : ""}${issue._sending ? " sending" : issue._failed ? " failed" : ""}`}
                title={issue._sending ? `${issue.title}（送っています…）` : issue._failed ? `${issue.title}（送れませんでした。付箋の「もう一度」で送り直せます）` : issue.title}
                onMouseDown={isUnsent(issue) ? undefined : (e) => onNoteMouseDown(e, issue.number, statusOf(issue))}
                onClick={() => {
                  if (!isDraggingRef.current && !isUnsent(issue)) onSelectIssue(issue.number);
                }}
              >
                {look === "quest" && <span className="bd-desk-hanko">受注</span>}
                <span className="bd-desk-no">
                  {issue._sending ? (
                    <>
                      <i className="sending-spin" aria-label="送っています" />
                      <SendingBird />
                    </>
                  ) : issue._failed ? (
                    "⚠"
                  ) : (
                    issueRef(issue.number)
                  )}
                </span>
                {issue.title}
              </button>
            ))}
          </div>
          <span className="bd-desk-deco" aria-hidden="true">
            {desk.deco}
          </span>
          {dragging !== null && deskHint && <div className={`bd-desk-drop${deskHint.ok ? "" : " no"}`}>{deskHint.text}</div>}
          {deskNote && dragging === null && (
            <div className="bd-desk-note" role="status">
              {deskNote}
            </div>
          )}
        </div>
      )}

      {/* ドラッグ中の付箋（マウスについてくる） */}
      {draggedIssue && isDraggingRef.current && (
        <div className={`bd-float look-${look}`} style={{ left: mousePos.x - offsetRef.current.x, top: mousePos.y - offsetRef.current.y }}>
          {note(draggedIssue)}
          {/* 机の上では、置けるかを付箋の上に出す（机の字は、持っている付箋に隠れるため） */}
          {over === "@desk" && deskHint && (
            <div className={`bd-float-tag${deskHint.ok ? "" : " no"}`}>
              {deskHint.ok ? "🙋 " : "✋ "}
              {deskHint.text}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
