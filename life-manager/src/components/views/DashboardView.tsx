import { Fragment, useState, useRef, useEffect, useMemo, useContext, useCallback, type ReactNode } from "react";
import type { GitHubIssue, GitHubLabel, GitHubMilestone, GitHubUser } from "../../lib/types";
import { IssueCard } from "../common/IssueCard";
import { IssueTable } from "../common/IssueTable";
import { TaskFilterButton, TaskFilterChips, TaskFilterGroups, clearAll, filterCount, type TaskFilterProps } from "../common/TaskFilterButton";
import { MobileSheet, SheetRow } from "../common/MobileSheet";
import { isMobile } from "../../lib/platform";
import { SavedViewsMenu } from "../common/SavedViewsMenu";
import { EstimatePicker, EstimateSumText, useEstimateUnit } from "../common/EstimateChip";
import { BulkBar, type BulkAction } from "../common/BulkBar";
import { IssueIndexContext } from "../common/SubIssueMarks";
import { TemplatePicker } from "../common/TemplatePicker";
import { BUILTIN_TEMPLATES, type IssueTemplate } from "../../lib/issueTemplates";
import { serializeGanttDates, withGanttDates } from "../../lib/ganttParser";
import { localToday, plansFor, type TentativePlan } from "../../lib/ganttSchedule";
import { isSending, issueRef } from "../../lib/issueRef";
import { isEscape } from "../../lib/keys";
import { stepDirection, withTransition } from "../../lib/motion";
import { celebrateDone, sparkleNew } from "../../lib/celebrate";
import { isSameRepo, parseIssueApiUrl } from "../../lib/subIssues";
import { ME, type MilestoneFilter, type SavedView, type StateFilter, type ViewSettings } from "../../lib/savedViews";
import { ESTIMATE_PREFIX, estimateOf, parseEstimateLabel, sumEstimates, withEstimate } from "../../lib/estimate";
import {
  GROUP_LABELS, groupIssues, matchesLabelFilters, sortIssues, SORT_LABELS,
  type GroupKey, type LabelFilters, type ListMode, type SortKey,
} from "../../lib/taskList";
import { Avatar } from "../common/Avatar";
import { inCategory, SECTION_PREFIX } from "../../lib/section";
import { tr, trx, jaOf, labelText } from "../../lib/i18n";

/** 並び・まとめ方・カード／表は、次に開いたときも同じにする */
const SORT_STORE = "task-list-sort";
const GROUP_STORE = "task-list-group";
const MODE_STORE = "task-list-mode";
/** 前の版の「親子でまとめる」（まとめ方がまだ無いときに読む） */
const TREE_STORE = "task-list-tree";

function loadSort(): SortKey {
  try {
    const v = localStorage.getItem(SORT_STORE);
    return v && v in SORT_LABELS ? (v as SortKey) : "new";
  } catch {
    return "new";
  }
}

function loadGroup(): GroupKey {
  try {
    const v = localStorage.getItem(GROUP_STORE);
    if (v && v in GROUP_LABELS) return v as GroupKey;
    return localStorage.getItem(TREE_STORE) === "off" ? "none" : "tree";
  } catch {
    return "tree";
  }
}

function loadMode(): ListMode {
  try {
    return localStorage.getItem(MODE_STORE) === "table" ? "table" : "card";
  } catch {
    return "card";
  }
}

function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 覚えられなくても、今の画面では使える
  }
}

type IssueUpdates = { title?: string; body?: string; labels?: string[]; assignees?: string[]; milestone?: number | null };

/** まとめて変えたあとの知らせ */
function bulkMessage(action: BulkAction, n: number): string {
  switch (action.kind) {
    case "close":
      return tr("{n} 件を完了にしました", { n });
    case "reopen":
      return tr("{n} 件を再開しました", { n });
    case "status":
      return tr("{n} 件の状態を「{replace}」にしました", { n, replace: tr(action.label.replace("状態:", "")) });
    case "label":
      return tr("{n} 件にラベル「{label}」を付けました", { n, label: action.label });
    case "milestone":
      return action.number === null ? tr("{n} 件のマイルストーンを外しました", { n }) : tr("{n} 件のマイルストーンを「{title}」にしました", { n, title: action.title });
    case "assignee":
      return action.login === null ? tr("{n} 件の担当を外しました", { n }) : tr("{n} 件の担当を「{login}」にしました", { n, login: action.login });
    case "estimate":
      return action.value === null ? tr("{n} 件の見積もりを外しました", { n }) : tr("{n} 件の見積もりを「{value}」にしました", { n, value: action.value });
    case "schedule":
      return tr("{n} 件の日程を、見積もりから決めました", { n });
  }
}

interface DashboardViewProps {
  /** この人の担当で開く（オーバービューのメンバーの今から。#246）。使ったら onAssigneeRequestHandled */
  assigneeRequest?: { login: string; at: number } | null;
  onAssigneeRequestHandled?: () => void;
  issues: GitHubIssue[];
  closedIssues: GitHubIssue[];
  labels: GitHubLabel[];
  milestones: GitHubMilestone[];
  collaborators: GitHubUser[];
  currentUser: string;
  filters: LabelFilters;
  onFiltersChange: (filters: LabelFilters) => void;
  onClose: (n: number) => Promise<void> | void;
  onReopen: (n: number) => Promise<void> | void;
  onPromote: (n: number) => void;
  onStatusChange: (n: number, status: string) => Promise<void> | void;
  /** ラベル・マイルストーン・担当をまとめて変えるときに使う */
  onUpdateIssue: (n: number, updates: IssueUpdates) => Promise<void>;
  /** Issue テンプレート（.github/ISSUE_TEMPLATE）を読む・置く */
  onListTemplates: () => Promise<IssueTemplate[]>;
  onAddTemplates: (templates: IssueTemplate[]) => Promise<IssueTemplate[]>;
  onCreateIssue: (
    title: string, body: string, labels: string[], milestone: number | null, assignees?: string[],
    extra?: { prepare?: () => Promise<void>; onCreated?: (n: number) => Promise<void> | void },
  ) => Promise<number>;
  onRefresh: () => Promise<void>;
  onSelectIssue: (n: number) => void;
  onAddReminder: (issueNumber: number, title: string, datetime: string, channels: string[]) => Promise<void>;
  /** 保存した見方（config/views.yaml。チームで共有する） */
  savedViews: SavedView[];
  onSaveViews: (views: SavedView[]) => Promise<void>;
  /** 「状態」でまとめるときの順番（ボードの列の順） */
  stateOrder: string[];
  /** 見積もりのラベルがなければ作る（色をそろえるため） */
  onEnsureEstimateLabel: (value: number) => Promise<void>;
  status?: string;
  /** 左に一覧・右に詳細に分けられる（PC で、窓が広いとき）。分けるのはカードのときだけ */
  splitCapable?: boolean;
  /** 左右に分けているか（分けているあいだは、選んだタスクを右に出す） */
  onSplitChange?: (active: boolean) => void;
  /** 右に出しているタスク */
  selectedIssue?: number | null;
  /** 右の欄に出すもの（選んだタスクの詳細） */
  detail?: ReactNode;
}

/** 左の一覧の幅（%）。ドラッグで変えて、覚える */
const SPLIT_STORE = "task-split-left";
const SPLIT_MIN = 26;
const SPLIT_MAX = 66;
const clampSplit = (v: number) => Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, v));

function loadSplit(): number {
  try {
    const v = Number(localStorage.getItem(SPLIT_STORE));
    return v ? clampSplit(v) : 40;
  } catch {
    return 40;
  }
}

export function DashboardView({
  issues, closedIssues, labels, milestones, collaborators, currentUser, filters, onFiltersChange,
  onClose, onReopen, onPromote, onStatusChange, onUpdateIssue, onListTemplates, onAddTemplates,
  onCreateIssue, onRefresh, onSelectIssue, onAddReminder, savedViews, onSaveViews, stateOrder, onEnsureEstimateLabel, status,
  splitCapable = false, onSplitChange, selectedIssue = null, detail, assigneeRequest = null, onAssigneeRequestHandled,
}: DashboardViewProps) {
  const index = useContext(IssueIndexContext);
  const unit = useEstimateUnit();
  const [showIssueForm, setShowIssueForm] = useState(false);
  const [issueTitle, setIssueTitle] = useState("");
  const [issueBody, setIssueBody] = useState("");
  const [issueSelectedLabels, setIssueSelectedLabels] = useState<string[]>(["種別:イシュー", "状態:未整理"]);
  const [issueMilestone, setIssueMilestone] = useState<number | undefined>(undefined);
  const [issueAssignees, setIssueAssignees] = useState<string[]>(currentUser ? [currentUser] : []);
  const [issueReminderDatetime, setIssueReminderDatetime] = useState("");
  const [issueReminderChannels, setIssueReminderChannels] = useState<string[]>(["os"]);
  const [issueGanttStart, setIssueGanttStart] = useState("");
  const [issueGanttEnd, setIssueGanttEnd] = useState("");
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);

  const suggestions = useMemo(() => {
    if (issueTitle.length < 2) return [];
    const q = issueTitle.toLowerCase();
    return [...issues, ...closedIssues]
      .filter(i => !isSending(i.number) && i.title.toLowerCase().includes(q))
      .slice(0, 5);
  }, [issueTitle, issues, closedIssues]);

  // プロジェクト切替時にマイルストーン選択をリセット
  useEffect(() => {
    setIssueMilestone(undefined);
  }, [milestones]);
  const [assigneeFilter, setAssigneeFilter] = useState(currentUser || "");
  // オーバービューのメンバーの今で人を押したとき: その人の担当の、開いているタスク（#246）
  useEffect(() => {
    if (!assigneeRequest) return;
    setAssigneeFilter(assigneeRequest.login);
    onAssigneeRequestHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assigneeRequest]);
  // マイルストーンで絞る（null は全部）
  const [milestoneFilter, setMilestoneFilter] = useState<MilestoneFilter | null>(null);
  const [stateFilter, setStateFilter] = useState<StateFilter>("open");
  const [sortKey, setSortKey] = useState<SortKey>(loadSort);
  const [group, setGroup] = useState<GroupKey>(loadGroup);
  const [mode, setMode] = useState<ListMode>(loadMode);
  // 「☑ 選ぶ」: 選んだ Issue を、下の帯でまとめて変える。PC はチェックをいつも出し、1 つ選ぶと帯が出る。スマホは「☑ 選ぶ」で出す
  const [picking, setPicking] = useState(false);
  const pickable = !isMobile;
  // スマホの、下から出る絞り込みの板
  const [sheetOpen, setSheetOpen] = useState(false);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [bulkBusy, setBulkBusy] = useState<string | null>(null);
  const [bulkDone, setBulkDone] = useState<string | null>(null);
  // 下の帯を出している（スマホは「☑ 選ぶ」のあいだ。PC は 1 つ以上選んだときと、まとめて変えた結果を出しているあいだ）
  const selecting = picking || (pickable && (picked.size > 0 || bulkBusy !== null || bulkDone !== null));
  // Issue テンプレート（作るフォームを開いたときに読む。プロジェクトを切り替えたら読み直す）
  const [templates, setTemplates] = useState<IssueTemplate[] | null>(null);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [appliedTemplate, setAppliedTemplate] = useState<IssueTemplate | null>(null);
  const [templateNote, setTemplateNote] = useState<string | null>(null);

  useEffect(() => {
    setTemplates(null);
    setTemplateError(null);
  }, [index.owner, index.repo]);

  useEffect(() => {
    if (!showIssueForm || templates !== null) return;
    let alive = true;
    onListTemplates()
      .then((list) => alive && setTemplates(list))
      .catch((e) => {
        if (!alive) return;
        setTemplateError(String(e));
        setTemplates([]);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showIssueForm, templates]);

  /** テンプレートを当てる。題名・本文は、空か前のテンプレートのままのときだけ入れ替える（書いた内容は消さない） */
  function applyTemplate(t: IssueTemplate | null) {
    const prev = appliedTemplate;
    const titleUntouched = !issueTitle.trim() || (prev !== null && issueTitle === prev.title);
    const bodyUntouched = !issueBody.trim() || (prev !== null && issueBody === prev.body);
    setTemplateNote(null);
    if (titleUntouched) setIssueTitle(t?.title ?? "");
    if (bodyUntouched) setIssueBody(t?.body ?? "");
    else if (t) setTemplateNote(tr("本文に書いた内容があるので、テンプレートの本文は入れませんでした。本文を消してから選ぶと入ります"));
    setIssueSelectedLabels(t && t.labels.length > 0 ? t.labels : ["種別:イシュー", "状態:未整理"]);
    setAppliedTemplate(t);
  }

  async function placeBuiltinTemplates() {
    const list = await onAddTemplates(BUILTIN_TEMPLATES);
    setTemplates(list);
    setTemplateError(null);
  }

  // 選んでいるあいだは、Esc で選ぶのをやめる
  useEffect(() => {
    if (!selecting) return;
    function onKeyDown(e: KeyboardEvent) {
      if (isEscape(e) && !bulkBusy) quitPicking();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selecting, bulkBusy]);

  function quitPicking() {
    setPicking(false);
    setPicked(new Set());
    setBulkDone(null);
  }

  function togglePick(n: number) {
    setBulkDone(null);
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });
  }

  async function handleIssueCreate() {
    if (!issueTitle.trim()) return;
    const title = issueTitle;
    let body = issueBody;
    // ガントメタデータをbodyに追記
    if (issueGanttStart && issueGanttEnd) {
      const s = issueGanttStart <= issueGanttEnd ? issueGanttStart : issueGanttEnd;
      const e = issueGanttStart <= issueGanttEnd ? issueGanttEnd : issueGanttStart;
      body = body.trimEnd() + "\n" + serializeGanttDates(s, e);
    }
    const labels = [...issueSelectedLabels];
    const milestone = issueMilestone || null;
    const estimate = labels.map(parseEstimateLabel).find((e) => e !== null && e.unit === unit)?.value;
    const assignees = issueAssignees.length > 0 ? [...issueAssignees] : undefined;
    const reminderDt = issueReminderDatetime;
    const reminderCh = [...issueReminderChannels];
    // 即座にフォームを閉じてリセット
    setShowIssueForm(false);
    setIssueTitle("");
    setIssueBody("");
    setIssueMilestone(undefined);
    setIssueSelectedLabels([]);
    setIssueAssignees(currentUser ? [currentUser] : []);
    setIssueReminderDatetime("");
    setIssueGanttStart("");
    setIssueGanttEnd("");
    setAppliedTemplate(null);
    setTemplateNote(null);
    // すぐ一覧に「送っています…」で出して、後ろで送る。見積もりのラベルは、なければ送る前に作って色をそろえる。
    // リマインダーは、届いて番号が付いたら付ける（送れなかったあとの「もう一度」で届いたときも）
    try {
      await onCreateIssue(title, body, labels, milestone, assignees, {
        prepare: estimate ? () => onEnsureEstimateLabel(estimate) : undefined,
        onCreated: reminderDt && reminderCh.length > 0 ? (n) => onAddReminder(n, title, reminderDt, reminderCh) : undefined,
      });
    } catch {
      // 送れなかった Issue は、一覧に「送れませんでした」で残る（「もう一度」「やめる」）
    }
  }

  const categories = ["種別:", SECTION_PREFIX, "状態:", "優先:", ESTIMATE_PREFIX] as const;
  const categoryLabels: Record<string, string> = {
    "種別:": tr("種別"), [SECTION_PREFIX]: tr("セクション"), "状態:": tr("状態"), "優先:": tr("優先"), [ESTIMATE_PREFIX]: tr("見積"),
  };

  const allIssues = [...issues, ...closedIssues];
  // 絞り込み（オープン／クローズの切り替えのほか）に当てはまるか
  const matchesFilters = (issue: GitHubIssue) => {
    // テキスト検索
    if (searchQuery.length >= 1) {
      const raw = searchQuery.trim();
      const numMatch = raw.match(/^#?(\d+)$/);
      if (numMatch) {
        if (issue.number !== parseInt(numMatch[1])) return false;
      } else if (raw.length >= 2) {
        const q = raw.toLowerCase();
        if (!issue.title.toLowerCase().includes(q) && !(issue.body && issue.body.toLowerCase().includes(q))) return false;
      }
    }
    // 担当者フィルタ
    if (assigneeFilter) {
      if (!issue.assignees?.some((a) => a.login === assigneeFilter)) return false;
    }
    // マイルストーン
    if (milestoneFilter === "none" ? issue.milestone : milestoneFilter !== null && issue.milestone?.number !== milestoneFilter) return false;
    // ラベルフィルタ（種類ごとに、どれか／すべて）
    return matchesLabelFilters(issue, filters);
  };
  const baseIssues = stateFilter === "open" ? issues : stateFilter === "closed" ? closedIssues : allIssues;
  const filteredIssues = baseIssues.filter(matchesFilters);

  // マイルストーンの名前（閉じたマイルストーンは一覧にないので、Issue に付いている名前から引く）
  const milestoneTitle = (n: number) =>
    milestones.find((m) => m.number === n)?.title ?? allIssues.find((i) => i.milestone?.number === n)?.milestone?.title;

  // 並べ替えてから、選んだ項目でまとめる（親子は、同じリポジトリの親が一覧に出ているときだけ、その下に並べる）
  const sorted = sortIssues(filteredIssues, sortKey);
  const groups = groupIssues(sorted, group, {
    parentOf: (issue) => {
      const parent = parseIssueApiUrl(issue.parent_issue_url);
      return parent && isSameRepo(parent, index.owner, index.repo) ? parent.number : null;
    },
    stateOrder,
  });
  const rows = groups.flatMap((g) => g.rows);

  // PC・カードのとき: 左に一覧、右に選んだタスクの詳細（表のときは、今まで通り全幅の表と、重ねて出す詳細）
  const splitActive = splitCapable && mode === "card";
  useEffect(() => {
    onSplitChange?.(splitActive);
  }, [splitActive, onSplitChange]);

  // 左右に分けているとき: 下のタスクを選ぶと、右の詳細は下から・上なら上から入れ替わる
  const pickTask = useCallback((n: number) => {
    if (!splitActive || selectedIssue === null) {
      onSelectIssue(n);
      return;
    }
    const dir = stepDirection(rows.map((r) => r.issue.number), selectedIssue, n, "vertical");
    withTransition(() => onSelectIssue(n), ["vt-pick", dir]);
  }, [splitActive, selectedIssue, rows, onSelectIssue]);

  // 新しく入ったカード（メモを投入したときなど。いちどに 3 件まで。プロジェクトを切り替えたときは光らせない）
  const seenIssues = useRef<Set<number> | null>(null);
  const [freshIssues, setFreshIssues] = useState<Set<number>>(new Set());
  // 一覧はすぐに続けて読み直されることがあるので、キラキラと「NEW」を外すのは、読み直しで取り消さない（消えるのは画面を離れたときだけ）
  const freshTimers = useRef<number[]>([]);
  useEffect(() => () => freshTimers.current.forEach((t) => window.clearTimeout(t)), []);
  useEffect(() => {
    // 送っている途中の仮の Issue は数えない（GitHub に届いて番号が付いたときに光らせる）
    const now = new Set(issues.map((i) => i.number).filter((n) => !isSending(n)));
    const before = seenIssues.current;
    seenIssues.current = now;
    if (!before) return;
    const added = [...now].filter((n) => !before.has(n));
    if (added.length === 0 || added.length > 3) return;
    setFreshIssues((prev) => new Set([...prev, ...added]));
    // 入ったところ（カードか表の行）から、少しキラキラ
    freshTimers.current.push(window.setTimeout(() => {
      for (const n of added) sparkleNew(document.querySelector(`.issue-card[data-issue="${n}"], .task-row[data-issue="${n}"]`));
    }, 120));
    freshTimers.current.push(window.setTimeout(() => {
      setFreshIssues((prev) => {
        const next = new Set(prev);
        for (const n of added) next.delete(n);
        return next;
      });
    }, 1800));
  }, [issues]);

  // ↑↓ で上下のタスクへ（文字を打つ欄にいるときは使わない）
  useEffect(() => {
    if (!splitActive || picking) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest("input, textarea, select, [contenteditable='true'], .palette-overlay")) return;
      // 送っている途中の仮の Issue は飛ばす（まだ詳細を開けない）
      const order = rows.map((r) => r.issue.number).filter((n) => !isSending(n));
      if (order.length === 0) return;
      const at = selectedIssue === null ? -1 : order.indexOf(selectedIssue);
      const next = e.key === "ArrowDown" ? order[Math.min(order.length - 1, at + 1)] : order[Math.max(0, at === -1 ? 0 : at - 1)];
      e.preventDefault();
      if (next !== selectedIssue) pickTask(next);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [splitActive, picking, rows, selectedIssue, pickTask]);

  // 選んだタスクが一覧の見えるところにあるように
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!splitActive || selectedIssue === null) return;
    listRef.current?.querySelector(`[data-issue="${selectedIssue}"]`)?.scrollIntoView({ block: "nearest" });
  }, [splitActive, selectedIssue]);

  // 左右の境目をドラッグして、左の一覧の幅を変える
  const [splitLeft, setSplitLeft] = useState(loadSplit);
  const [dragging, setDragging] = useState(false);
  const splitRef = useRef<HTMLDivElement>(null);
  function startDrag(e: React.MouseEvent) {
    e.preventDefault();
    const box = splitRef.current?.getBoundingClientRect();
    if (!box) return;
    let last = splitLeft;
    setDragging(true);
    const move = (ev: MouseEvent) => {
      last = clampSplit(((ev.clientX - box.left) / box.width) * 100);
      setSplitLeft(last);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      setDragging(false);
      try {
        localStorage.setItem(SPLIT_STORE, String(Math.round(last)));
      } catch {
        // 覚えられなくても、今の幅は使える
      }
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  // 今の見方（保存した見方と比べる・保存する形）。担当が自分なら「自分」として持つ
  const currentView: ViewSettings = {
    filters,
    assignee: assigneeFilter && assigneeFilter === currentUser ? ME : assigneeFilter,
    ...(milestoneFilter !== null ? { milestone: milestoneFilter } : {}),
    state: stateFilter,
    sort: sortKey,
    group,
    mode,
  };

  // 並び・まとめ方を変えたら、カードが新しい場所まで動いていく
  function changeSort(v: SortKey) {
    withTransition(() => setSortKey(v), ["vt-reorder"]);
    store(SORT_STORE, v);
  }

  function changeGroup(v: GroupKey) {
    withTransition(() => setGroup(v), ["vt-reorder"]);
    store(GROUP_STORE, v);
  }

  function changeMode(v: ListMode) {
    setMode(v);
    store(MODE_STORE, v);
  }

  /** 保存した見方を当てる（「自分」は開いた人に読み替える） */
  function applyView(v: SavedView) {
    onFiltersChange(v.filters);
    setAssigneeFilter(v.assignee === ME ? currentUser : v.assignee);
    setMilestoneFilter(v.milestone ?? null);
    setStateFilter(v.state);
    changeSort(v.sort);
    changeGroup(v.group);
    changeMode(v.mode);
  }

  // 「フィルタ」にまとめた絞り込み（種別・セクション・状態・優先・見積のラベル、担当者、マイルストーン、表示）
  const filterProps: TaskFilterProps = {
    categories: categories
      .map((cat) => ({ prefix: cat, name: categoryLabels[cat], labels: labels.filter((l) => inCategory(l.name, cat)) }))
      .filter((c) => c.labels.length > 0),
    filters,
    onFiltersChange,
    assignee: assigneeFilter,
    onAssigneeChange: setAssigneeFilter,
    currentUser,
    collaborators,
    milestone: milestoneFilter,
    onMilestoneChange: setMilestoneFilter,
    milestones,
    milestoneTitle,
    state: stateFilter,
    onStateChange: setStateFilter,
  };


  // 送っている途中の仮の Issue は、まとめて変える相手にしない（GitHub にまだ番号がない）
  const pickedIssues = allIssues.filter((i) => picked.has(i.number) && !isSending(i.number));

  async function runBulk(action: BulkAction) {
    if (action.kind === "estimate" && action.value !== null) await onEnsureEstimateLabel(action.value);
    let targets = pickedIssues.filter((i) =>
      action.kind === "close" || action.kind === "status" || action.kind === "schedule" ? i.state === "open" : action.kind === "reopen" ? i.state === "closed" : true
    );
    // 見積もりから日程: ガントの仮の日程と同じ置き方。日程があるか見積もりのないタスクは、そのまま
    const plans = action.kind === "schedule" ? plansFor(targets, allIssues, localToday()) : null;
    const skipped = plans ? targets.length - plans.size : 0;
    if (plans) targets = targets.filter((i) => plans.has(i.number));
    if (targets.length === 0) {
      if (plans) setBulkDone(tr("日程を決められるタスクはありません（日程があるか、見積もりがありません）"));
      return;
    }
    setBulkDone(null);
    let done = 0;
    let failed = 0;
    // まとめて完了にしたものは、知らせの「元に戻す」で開き直せる（#232）
    const closedNow: number[] = [];
    for (const issue of targets) {
      setBulkBusy(tr("{v} / {length} 件目…", { v: done + failed + 1, length: targets.length }));
      try {
        await applyBulk(action, issue, plans);
        done++;
        if (action.kind === "close") closedNow.push(issue.number);
      } catch {
        failed++;
      }
    }
    setBulkBusy(null);
    setPicked(new Set());
    setBulkDone(
      bulkMessage(action, done) +
        (skipped ? tr("（{skipped} 件は日程があるか見積もりがないので、そのまま）", { skipped }) : "") +
        (failed ? tr("（{failed} 件はできませんでした。上の知らせを見てください）", { failed }) : ""),
    );
    if (action.kind === "close" && done > 0) {
      celebrateDone(tr("{done} 件", { done }), undefined, undefined, () => {
        void (async () => {
          for (const n of closedNow) await onReopen(n);
        })();
      });
    }
  }

  async function applyBulk(action: BulkAction, issue: GitHubIssue, plans: Map<number, TentativePlan> | null) {
    const names = issue.labels.map((l) => l.name);
    switch (action.kind) {
      case "close":
        return onClose(issue.number);
      case "reopen":
        return onReopen(issue.number);
      case "status":
        return onStatusChange(issue.number, action.label);
      case "label": {
        if (names.includes(action.label)) return;
        // 優先は 1 つだけ（付け替える）
        const kept = action.label.startsWith("優先:") ? names.filter((n) => !n.startsWith("優先:")) : names;
        return onUpdateIssue(issue.number, { labels: [...kept, action.label] });
      }
      case "milestone":
        if ((issue.milestone?.number ?? null) === action.number) return;
        return onUpdateIssue(issue.number, { milestone: action.number });
      case "assignee":
        return onUpdateIssue(issue.number, { assignees: action.login ? [action.login] : [] });
      case "estimate":
        {
          const e = estimateOf(issue);
          if (action.value === null ? e === null : e?.unit === unit && e.value === action.value) return;
          return onUpdateIssue(issue.number, { labels: withEstimate(names, action.value, unit) });
        }
      case "schedule": {
        const p = plans?.get(issue.number);
        if (!p) return;
        return onUpdateIssue(issue.number, { body: withGanttDates(issue.body, p.start, p.end) });
      }
    }
  }

  // 一覧（表か、まとまりごとのカード）と、ないときの知らせ
  const list = (
    <>
      {mode === "table" && rows.length > 0 ? (
        <IssueTable groups={groups} onSelect={onSelectIssue} picking={picking} pickable={pickable} picked={picked} onTogglePick={togglePick} fresh={freshIssues} />
      ) : (
        groups.map((g) => (
          <Fragment key={g.title || "all"}>
            {g.title && (
              <div className="task-group-head">
                {trx("{title}<0>{length} 件</0>", { title: labelText(g.title), length: g.rows.length }, [<span />])}
                <EstimateSumText sum={sumEstimates(g.rows.map((r) => r.issue), unit)} />
              </div>
            )}
            {g.rows.map(({ issue, depth }, i) => (
              <IssueCard key={issue.number} issue={issue}
                onClose={onClose} onReopen={onReopen}
                onPromote={onPromote} onStatusChange={onStatusChange}
                onSelect={pickTask}
                depth={depth}
                index={i}
                fresh={freshIssues.has(issue.number)}
                picking={picking} pickable={pickable} picked={picked.has(issue.number)} onTogglePick={togglePick}
                selected={splitActive && selectedIssue === issue.number} />
            ))}
          </Fragment>
        ))
      )}
      {filteredIssues.length === 0 && status && (jaOf(status).includes("見つかりません") || jaOf(status).includes("認証エラー") || jaOf(status).includes("アクセス拒否")) ? (
        <div className="error-message">
          <p className="error-message__title">⚠️ {status}</p>
          <p className="error-message__detail">{tr("設定画面でリポジトリやトークンを確認してください。")}</p>
        </div>
      ) : filteredIssues.length === 0 ? (
        <p className="empty-message">{tr("イシューがありません")}</p>
      ) : null}
    </>
  );

  return (
    // 表のときは、列が入るように横いっぱいに使う
    <div className={`content${splitActive ? " task-split-page" : mode === "table" ? " task-table-page" : ""}`}>
      {/* 検索・絞り込み（メモの投入は、画面の下の角の 📝 か Ctrl+M から）。スマホは検索・絞り込み・＋ だけにして、ほかは下から出る板へ */}
      <div className={`toolbar task-toolbar${isMobile ? " m-compact" : ""}`}>
        <div className="search-bar">
          <input value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={tr("Issue を検索...")}
            className="search-input" />
          {searchQuery && (
            <button className="search-clear" onClick={() => setSearchQuery("")}>×</button>
          )}
        </div>
        {isMobile ? (
          <>
            <button type="button" className={`btn-sm m-filter-btn${filterCount(filterProps) ? " on" : ""}`} onClick={() => setSheetOpen(true)}>
              {tr("表示するタスク")}{filterCount(filterProps) > 0 && <span className="m-filter-n">{filterCount(filterProps)}</span>}
            </button>
            <button type="button" onClick={() => setShowIssueForm(!showIssueForm)} className="btn-sm m-add-btn" aria-label={showIssueForm ? tr("作るのをやめる") : tr("イシューを作る")}>
              {showIssueForm ? "×" : "＋"}
            </button>
          </>
        ) : (
        <>
        <TaskFilterButton {...filterProps} />
        <span className="list-mode" role="group" aria-label={tr("見せ方")}>
          {(["card", "table"] as ListMode[]).map((m) => (
            <button key={m} type="button" className={mode === m ? "on" : ""} aria-pressed={mode === m} onClick={() => changeMode(m)}>
              {m === "card" ? tr("カード") : tr("表")}
            </button>
          ))}
        </span>
        <select value={group} className="select-sm" aria-label={tr("まとめる")} onChange={(e) => changeGroup(e.target.value as GroupKey)}>
          {(Object.keys(GROUP_LABELS) as GroupKey[]).map((k) => (
            <option key={k} value={k}>{trx("まとめる: {GROUP_LABELS}", { GROUP_LABELS: GROUP_LABELS[k] })}</option>
          ))}
        </select>
        <select value={sortKey} className="select-sm" aria-label={tr("並び")} onChange={(e) => changeSort(e.target.value as SortKey)}>
          {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
            <option key={k} value={k}>{trx("並び: {SORT_LABELS}", { SORT_LABELS: SORT_LABELS[k] })}</option>
          ))}
        </select>
        <SavedViewsMenu views={savedViews} current={currentView} onApply={applyView} onSave={onSaveViews} milestoneTitle={milestoneTitle} />
        <span className="issue-count task-list-count">
          {trx("{length} 件", { length: filteredIssues.length })}
          <EstimateSumText sum={sumEstimates(filteredIssues, unit)} showMissing={false} />
        </span>
        <button onClick={onRefresh} className="btn-sm">{tr("更新")}</button>
        <button onClick={() => setShowIssueForm(!showIssueForm)} className="btn-sm">
          {showIssueForm ? "×" : tr("+ イシュー作成")}
        </button>
        </>
        )}
      </div>
      {/* かけている絞り込み（× で外す） */}
      <TaskFilterChips {...filterProps} />
      {isMobile && (
        <MobileSheet
          open={sheetOpen}
          title={tr("表示するタスク")}
          onClose={() => setSheetOpen(false)}
          footer={
            <>
              <button type="button" className="btn-sm" disabled={filterCount(filterProps) === 0} onClick={() => clearAll(filterProps)}>{tr("すべて外す")}</button>
              <button type="button" className="btn-primary" onClick={() => setSheetOpen(false)}>{trx("{length} 件を見る", { length: filteredIssues.length })}</button>
            </>
          }
        >
          <SheetRow label={tr("並び")}>
            <select value={sortKey} className="select-sm" aria-label={tr("並び")} onChange={(e) => changeSort(e.target.value as SortKey)}>
              {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
                <option key={k} value={k}>{SORT_LABELS[k]}</option>
              ))}
            </select>
          </SheetRow>
          <SheetRow label={tr("まとめる")}>
            <select value={group} className="select-sm" aria-label={tr("まとめる")} onChange={(e) => changeGroup(e.target.value as GroupKey)}>
              {(Object.keys(GROUP_LABELS) as GroupKey[]).map((k) => (
                <option key={k} value={k}>{GROUP_LABELS[k]}</option>
              ))}
            </select>
          </SheetRow>
          <SheetRow label={tr("見せ方")}>
            <span className="list-mode" role="group" aria-label={tr("見せ方")}>
              {(["card", "table"] as ListMode[]).map((m) => (
                <button key={m} type="button" className={mode === m ? "on" : ""} aria-pressed={mode === m} onClick={() => changeMode(m)}>
                  {m === "card" ? tr("カード") : tr("表")}
                </button>
              ))}
            </span>
          </SheetRow>
          <SheetRow label={tr("保存した見方")}>
            <SavedViewsMenu views={savedViews} current={currentView} onApply={applyView} onSave={onSaveViews} milestoneTitle={milestoneTitle} />
          </SheetRow>
          <TaskFilterGroups {...filterProps} />
          <SheetRow label={tr("ほか")}>
            <button type="button" className={`btn-sm${picking ? " task-list-picking" : ""}`}
              onClick={() => { setSheetOpen(false); if (picking) quitPicking(); else setPicking(true); }}>
              {tr("☑ 選んでまとめて変える")}
            </button>
            <button type="button" onClick={() => { setSheetOpen(false); onRefresh(); }} className="btn-sm">{tr("更新")}</button>
          </SheetRow>
        </MobileSheet>
      )}

      {/* Issue作成フォーム */}
      {showIssueForm && (
        <div className="form-card">
          <TemplatePicker
            templates={templates}
            selected={appliedTemplate?.file ?? null}
            onSelect={applyTemplate}
            onPlaceBuiltins={placeBuiltinTemplates}
            error={templateError}
          />
          {templateNote && <p className="issue-templates-note">{templateNote}</p>}
          <div style={{ position: "relative" }}>
            <input value={issueTitle}
              onChange={(e) => { setIssueTitle(e.target.value); setShowSuggestions(true); }}
              onFocus={() => setShowSuggestions(true)}
              onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
              placeholder={tr("タイトル")} className="input-full" />
            {showSuggestions && suggestions.length > 0 && (
              <div className="suggestion-dropdown">
                {suggestions.map((s) => (
                  <button key={s.number} className="suggestion-item"
                    onMouseDown={(e) => { e.preventDefault(); onSelectIssue(s.number); setShowSuggestions(false); }}>
                    <span className={`suggestion-state suggestion-state--${s.state}`}>
                      {s.state === "open" ? "●" : "○"}
                    </span>
                    <span className="suggestion-number">{issueRef(s.number)}</span>
                    <span className="suggestion-title">{s.title}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <textarea ref={bodyRef} value={issueBody} onChange={(e) => setIssueBody(e.target.value)}
            placeholder={tr("本文（タスクリストは - [ ] で記述）")} className="textarea-full"
            // テンプレートの本文が見えるよう、選んだら高くする
            style={appliedTemplate ? { height: "180px" } : undefined} />
          <button type="button" className="btn-sm" style={{ fontSize: "11px", marginBottom: "6px" }}
            onClick={() => {
              const ta = bodyRef.current;
              if (!ta) return;
              const pos = ta.selectionStart ?? issueBody.length;
              const before = issueBody.substring(0, pos);
              const after = issueBody.substring(pos);
              const prefix = before.length > 0 && !before.endsWith("\n") ? "\n" : "";
              const newBody = before + prefix + "- [ ] " + after;
              setIssueBody(newBody);
              requestAnimationFrame(() => {
                const cursor = pos + prefix.length + 6;
                ta.focus();
                ta.setSelectionRange(cursor, cursor);
              });
            }}>{tr("+ タスク項目")}</button>
          <div className="label-selector">
            {issueSelectedLabels.filter((name) => !labels.some((l) => l.name === name)).map((name) => (
              <span key={name} className="label-chip active label-chip--new" title={tr("まだリポジトリにないラベルです（作るときに GitHub が作ります）")}
                onClick={() => setIssueSelectedLabels(issueSelectedLabels.filter((n) => n !== name))}>
                {name}
              </span>
            ))}
            {labels.filter((l) => !l.name.startsWith(ESTIMATE_PREFIX)).map((l) => {
              const active = issueSelectedLabels.includes(l.name);
              return (
                <span
                  key={l.name}
                  className={`label-chip ${active ? "active" : ""}`}
                  onClick={() => {
                    if (active) setIssueSelectedLabels(issueSelectedLabels.filter((n) => n !== l.name));
                    else setIssueSelectedLabels([...issueSelectedLabels, l.name]);
                  }}
                  style={{
                    color: parseInt(l.color, 16) > 0x7fffff ? "#000" : "#fff",
                    backgroundColor: `#${l.color}`,
                  }}
                >
                  {l.name}
                </span>
              );
            })}
          </div>
          {/* 見積もり（ラベル「見積:3pt」など。1 つだけ） */}
          <div className="est-row est-row--form">
            <span className="est-row-label">{tr("📏 見積もり")}</span>
            <EstimatePicker
              value={issueSelectedLabels.map(parseEstimateLabel).find((e) => e !== null) ?? null}
              onChange={(v) => setIssueSelectedLabels(withEstimate(issueSelectedLabels, v, unit))}
              showGuide={false}
            />
          </div>
          <select value={issueMilestone || ""} onChange={(e) => setIssueMilestone(e.target.value ? parseInt(e.target.value) : undefined)} className="select-sm">
            <option value="">{tr("マイルストーンなし")}</option>
            {milestones.map((m) => (
              <option key={m.number} value={m.number}>{m.title}</option>
            ))}
          </select>
          {collaborators.length > 0 && (
            <div style={{ marginTop: "4px" }}>
              <span style={{ fontSize: "var(--font-sm)", color: "var(--text-muted)" }}>{tr("担当者:")}</span>
              <div className="label-selector" style={{ marginTop: "4px" }}>
                {collaborators.map((c) => {
                  const active = issueAssignees.includes(c.login);
                  return (
                    <span
                      key={c.login}
                      className={`assignee-chip ${active ? "active" : ""}`}
                      onClick={() => {
                        if (active) setIssueAssignees(issueAssignees.filter((a) => a !== c.login));
                        else setIssueAssignees([...issueAssignees, c.login]);
                      }}
                    >
                      <Avatar login={c.login} url={c.avatar_url} className="avatar-sm" />
                      {c.login}
                    </span>
                  );
                })}
              </div>
            </div>
          )}
          {/* ガント日程 */}
          <div style={{ display: "flex", gap: "6px", alignItems: "center", marginTop: "4px" }}>
            <span style={{ fontSize: "var(--font-sm)", color: "var(--text-muted)", flexShrink: 0 }}>{tr("日程:")}</span>
            <input type="date" value={issueGanttStart} onChange={(e) => setIssueGanttStart(e.target.value)}
              style={{ background: "var(--bg-secondary)", color: "var(--text-primary)", border: "1px solid var(--border-default)", borderRadius: "4px", padding: "3px 6px", fontSize: "12px" }} />
            <span style={{ fontSize: "var(--font-sm)", color: "var(--text-faint)" }}>〜</span>
            <input type="date" value={issueGanttEnd} onChange={(e) => setIssueGanttEnd(e.target.value)}
              style={{ background: "var(--bg-secondary)", color: "var(--text-primary)", border: "1px solid var(--border-default)", borderRadius: "4px", padding: "3px 6px", fontSize: "12px" }} />
            <span style={{ fontSize: "11px", color: "var(--text-faint)" }}>{tr("(ガント)")}</span>
          </div>
          {/* リマインダー設定 */}
          <div style={{ marginTop: "4px" }}>
            <span style={{ fontSize: "var(--font-sm)", color: "var(--text-muted)" }}>{tr("リマインダー (任意):")}</span>
            <div style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap", marginTop: "4px" }}>
              <input type="datetime-local" value={issueReminderDatetime}
                onChange={(e) => setIssueReminderDatetime(e.target.value)}
                style={{ background: "var(--bg-secondary)", color: "var(--text-primary)", border: "1px solid var(--border-default)", borderRadius: "4px", padding: "3px 6px", fontSize: "12px" }} />
              <label style={{ fontSize: "11px", display: "flex", alignItems: "center", gap: "2px", color: "var(--text-muted)" }}>
                <input type="checkbox" checked={issueReminderChannels.includes("os")}
                  onChange={(e) => {
                    if (e.target.checked) setIssueReminderChannels([...issueReminderChannels, "os"]);
                    else setIssueReminderChannels(issueReminderChannels.filter((c) => c !== "os"));
                  }} />
                OS
              </label>
              <label style={{ fontSize: "11px", display: "flex", alignItems: "center", gap: "2px", color: "var(--text-muted)" }}>
                <input type="checkbox" checked={issueReminderChannels.includes("discord")}
                  onChange={(e) => {
                    if (e.target.checked) setIssueReminderChannels([...issueReminderChannels, "discord"]);
                    else setIssueReminderChannels(issueReminderChannels.filter((c) => c !== "discord"));
                  }} />
                Discord
              </label>
            </div>
          </div>
          <button onClick={handleIssueCreate} className="btn-primary">{tr("作成")}</button>
        </div>
      )}

      {/* Issue一覧。PC・カードのときは、左に一覧・右に選んだタスクの詳細 */}
      {splitActive ? (
        <div className={`task-split${dragging ? " task-split--dragging" : ""}`} ref={splitRef}>
          <div className="task-split-list" ref={listRef} style={{ width: `${splitLeft}%` }}>
            {list}
          </div>
          <div className="task-split-grip" role="separator" aria-orientation="vertical" title={tr("ドラッグで幅を変える")} onMouseDown={startDrag} />
          <div className="task-split-detail">
            {detail ?? <p className="task-split-empty">{tr("タスクを選ぶとここに詳細が出ます（↑↓ で上下のタスクへ）")}</p>}
          </div>
        </div>
      ) : (
        list
      )}

      {selecting && (
        <BulkBar
          count={pickedIssues.length}
          hasOpen={pickedIssues.length === 0 || pickedIssues.some((i) => i.state === "open")}
          hasClosed={pickedIssues.some((i) => i.state === "closed")}
          labels={labels}
          milestones={milestones}
          collaborators={collaborators}
          currentUser={currentUser}
          busy={bulkBusy}
          message={bulkDone}
          onRun={runBulk}
          onSelectAll={() => { setBulkDone(null); setPicked(new Set(rows.map((r) => r.issue.number).filter((n) => !isSending(n)))); }}
          onQuit={quitPicking}
        />
      )}
    </div>
  );
}
