import { Fragment, useState, useRef, useEffect, useMemo, useContext, useCallback, type ReactNode } from "react";
import type { GitHubIssue, GitHubLabel, GitHubMilestone, GitHubUser } from "../../lib/types";
import { IssueCard } from "../common/IssueCard";
import { IssueTable } from "../common/IssueTable";
import { LabelFilterButton } from "../common/LabelFilterButton";
import { SavedViewsMenu } from "../common/SavedViewsMenu";
import { EstimatePicker, EstimateSumText, useEstimateUnit } from "../common/EstimateChip";
import { BulkBar, type BulkAction } from "../common/BulkBar";
import { IssueIndexContext } from "../common/SubIssueMarks";
import { TemplatePicker } from "../common/TemplatePicker";
import { BUILTIN_TEMPLATES, type IssueTemplate } from "../../lib/issueTemplates";
import { serializeGanttDates } from "../../lib/ganttParser";
import { issueRef } from "../../lib/issueRef";
import { isEscape } from "../../lib/keys";
import { stepDirection, withTransition } from "../../lib/motion";
import { isSameRepo, parseIssueApiUrl } from "../../lib/subIssues";
import { ME, type MilestoneFilter, type SavedView, type StateFilter, type ViewSettings } from "../../lib/savedViews";
import { ESTIMATE_PREFIX, estimateOf, parseEstimateLabel, sumEstimates, withEstimate } from "../../lib/estimate";
import {
  GROUP_LABELS, groupIssues, matchesLabelFilters, sortIssues, SORT_LABELS,
  type GroupKey, type LabelFilters, type ListMode, type SortKey,
} from "../../lib/taskList";

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
      return `${n} 件を完了にしました`;
    case "reopen":
      return `${n} 件を再開しました`;
    case "status":
      return `${n} 件の状態を「${action.label.replace("状態:", "")}」にしました`;
    case "label":
      return `${n} 件にラベル「${action.label}」を付けました`;
    case "milestone":
      return action.number === null ? `${n} 件のマイルストーンを外しました` : `${n} 件のマイルストーンを「${action.title}」にしました`;
    case "assignee":
      return action.login === null ? `${n} 件の担当を外しました` : `${n} 件の担当を「${action.login}」にしました`;
    case "estimate":
      return action.value === null ? `${n} 件の見積もりを外しました` : `${n} 件の見積もりを「${action.value}」にしました`;
  }
}

interface DashboardViewProps {
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
  onCreateIssue: (title: string, body: string, labels: string[], milestone: number | null, assignees?: string[]) => Promise<number>;
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
  splitCapable = false, onSplitChange, selectedIssue = null, detail,
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
      .filter(i => i.title.toLowerCase().includes(q))
      .slice(0, 5);
  }, [issueTitle, issues, closedIssues]);

  // プロジェクト切替時にマイルストーン選択をリセット
  useEffect(() => {
    setIssueMilestone(undefined);
  }, [milestones]);
  const [assigneeFilter, setAssigneeFilter] = useState(currentUser || "");
  // マイルストーンで絞る（null は全部）
  const [milestoneFilter, setMilestoneFilter] = useState<MilestoneFilter | null>(null);
  const [stateFilter, setStateFilter] = useState<StateFilter>("open");
  const [sortKey, setSortKey] = useState<SortKey>(loadSort);
  const [group, setGroup] = useState<GroupKey>(loadGroup);
  const [mode, setMode] = useState<ListMode>(loadMode);
  // 「☑ 選ぶ」: 選んだ Issue を、下の帯でまとめて変える
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [bulkBusy, setBulkBusy] = useState<string | null>(null);
  const [bulkDone, setBulkDone] = useState<string | null>(null);
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
    else if (t) setTemplateNote("本文に書いた内容があるので、テンプレートの本文は入れませんでした（本文を消してから選ぶと入ります）");
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
    if (!picking) return;
    function onKeyDown(e: KeyboardEvent) {
      if (isEscape(e) && !bulkBusy) quitPicking();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [picking, bulkBusy]);

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
    // バックグラウンドで作成（見積もりのラベルは、なければ先に作って色をそろえる）
    if (estimate) await onEnsureEstimateLabel(estimate);
    const issueNumber = await onCreateIssue(title, body, labels, milestone, assignees);
    if (reminderDt && reminderCh.length > 0 && issueNumber) {
      await onAddReminder(issueNumber, title, reminderDt, reminderCh);
    }
  }

  const categories = ["種別:", "分野:", "状態:", "優先:", ESTIMATE_PREFIX] as const;
  const categoryLabels: Record<string, string> = {
    "種別:": "種別", "分野:": "分野", "状態:": "状態", "優先:": "優先", [ESTIMATE_PREFIX]: "見積",
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
  useEffect(() => {
    const now = new Set(issues.map((i) => i.number));
    const before = seenIssues.current;
    seenIssues.current = now;
    if (!before) return;
    const added = [...now].filter((n) => !before.has(n));
    if (added.length === 0 || added.length > 3) return;
    setFreshIssues(new Set(added));
    const timer = window.setTimeout(() => setFreshIssues(new Set()), 1800);
    return () => window.clearTimeout(timer);
  }, [issues]);

  // ↑↓ で上下のタスクへ（文字を打つ欄にいるときは使わない）
  useEffect(() => {
    if (!splitActive || picking) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest("input, textarea, select, [contenteditable='true'], .palette-overlay")) return;
      const order = rows.map((r) => r.issue.number);
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

  const activeFilterCount =
    Object.values(filters).filter((f) => f?.values.length).length + (assigneeFilter ? 1 : 0) + (milestoneFilter !== null ? 1 : 0) + (searchQuery ? 1 : 0);


  const pickedIssues = allIssues.filter((i) => picked.has(i.number));

  async function runBulk(action: BulkAction) {
    if (action.kind === "estimate" && action.value !== null) await onEnsureEstimateLabel(action.value);
    const targets = pickedIssues.filter((i) =>
      action.kind === "close" || action.kind === "status" ? i.state === "open" : action.kind === "reopen" ? i.state === "closed" : true
    );
    if (targets.length === 0) return;
    setBulkDone(null);
    let done = 0;
    let failed = 0;
    for (const issue of targets) {
      setBulkBusy(`${done + failed + 1} / ${targets.length} 件目…`);
      try {
        await applyBulk(action, issue);
        done++;
      } catch {
        failed++;
      }
    }
    setBulkBusy(null);
    setPicked(new Set());
    setBulkDone(bulkMessage(action, done) + (failed ? `（${failed} 件はできませんでした。上の知らせを見てください）` : ""));
  }

  async function applyBulk(action: BulkAction, issue: GitHubIssue) {
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
    }
  }

  // 一覧（表か、まとまりごとのカード）と、ないときの知らせ
  const list = (
    <>
      {mode === "table" && rows.length > 0 ? (
        <IssueTable groups={groups} onSelect={onSelectIssue} picking={picking} picked={picked} onTogglePick={togglePick} />
      ) : (
        groups.map((g) => (
          <Fragment key={g.title || "all"}>
            {g.title && (
              <div className="task-group-head">
                {g.title}
                <span>{g.rows.length} 件</span>
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
                picking={picking} picked={picked.has(issue.number)} onTogglePick={togglePick}
                selected={splitActive && selectedIssue === issue.number} />
            ))}
          </Fragment>
        ))
      )}
      {filteredIssues.length === 0 && status && (status.includes("見つかりません") || status.includes("認証エラー") || status.includes("アクセス拒否")) ? (
        <div className="error-message">
          <p className="error-message__title">⚠️ {status}</p>
          <p className="error-message__detail">設定画面でリポジトリやトークンを確認してください。</p>
        </div>
      ) : filteredIssues.length === 0 ? (
        <p className="empty-message">イシューがありません</p>
      ) : null}
    </>
  );

  return (
    // 表のときは、列が入るように横いっぱいに使う
    <div className={`content${splitActive ? " task-split-page" : mode === "table" ? " task-table-page" : ""}`}>
      {/* 検索・絞り込み（メモの投入は、画面の下の角の 📝 か Ctrl+M から） */}
      <div className="toolbar task-toolbar">
        <div className="search-bar">
          <input value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Issue を検索..."
            className="search-input" />
          {searchQuery && (
            <button className="search-clear" onClick={() => setSearchQuery("")}>×</button>
          )}
        </div>
        {categories.map((cat) => {
          const catLabels = labels.filter((l) => l.name.startsWith(cat));
          if (catLabels.length === 0) return null;
          return (
            <LabelFilterButton
              key={cat}
              name={categoryLabels[cat]}
              prefix={cat}
              labels={catLabels}
              value={filters[cat]}
              onChange={(value) => onFiltersChange({ ...filters, [cat]: value })}
            />
          );
        })}
        <select value={assigneeFilter} onChange={(e) => setAssigneeFilter(e.target.value)} className="select-sm">
          <option value="">担当者: 全員</option>
          {currentUser && <option value={currentUser}>自分 ({currentUser})</option>}
          {collaborators.filter((c) => c.login !== currentUser).map((c) => (
            <option key={c.login} value={c.login}>{c.login}</option>
          ))}
        </select>
        <select value={milestoneFilter ?? ""} className="select-sm" aria-label="マイルストーン"
          onChange={(e) => setMilestoneFilter(e.target.value === "" ? null : e.target.value === "none" ? "none" : Number(e.target.value))}>
          <option value="">マイルストーン: 全て</option>
          {milestones.map((m) => (
            <option key={m.number} value={m.number}>🎯 {m.title}</option>
          ))}
          {typeof milestoneFilter === "number" && !milestones.some((m) => m.number === milestoneFilter) && (
            <option value={milestoneFilter}>🎯 {milestoneTitle(milestoneFilter) ?? `#${milestoneFilter}`}（閉じた）</option>
          )}
          <option value="none">マイルストーンなし</option>
        </select>
        <select value={stateFilter} onChange={(e) => setStateFilter(e.target.value as StateFilter)} className="select-sm">
          <option value="open">オープンのみ</option>
          <option value="closed">クローズのみ</option>
          <option value="all">両方</option>
        </select>
        {activeFilterCount > 0 && (
          <button onClick={() => { onFiltersChange({}); setAssigneeFilter(""); setMilestoneFilter(null); setSearchQuery(""); }} className="btn-sm" style={{ color: "var(--accent-red)" }}>
            リセット
          </button>
        )}
      </div>

      {/* カード／表・まとめる・並び・選ぶ・保存した見方・件数・更新・作る */}
      <div className="task-list-options">
        <span className="list-mode" role="group" aria-label="見せ方">
          {(["card", "table"] as ListMode[]).map((m) => (
            <button key={m} type="button" className={mode === m ? "on" : ""} aria-pressed={mode === m} onClick={() => changeMode(m)}>
              {m === "card" ? "カード" : "表"}
            </button>
          ))}
        </span>
        <select value={group} className="select-sm" aria-label="まとめる" onChange={(e) => changeGroup(e.target.value as GroupKey)}>
          {(Object.keys(GROUP_LABELS) as GroupKey[]).map((k) => (
            <option key={k} value={k}>まとめる: {GROUP_LABELS[k]}</option>
          ))}
        </select>
        <select value={sortKey} className="select-sm" aria-label="並び" onChange={(e) => changeSort(e.target.value as SortKey)}>
          {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
            <option key={k} value={k}>並び: {SORT_LABELS[k]}</option>
          ))}
        </select>
        <button type="button" className={`btn-sm${picking ? " task-list-picking" : ""}`}
          onClick={() => (picking ? quitPicking() : setPicking(true))}>
          ☑ 選ぶ
        </button>
        <SavedViewsMenu views={savedViews} current={currentView} onApply={applyView} onSave={onSaveViews} milestoneTitle={milestoneTitle} />
        <span className="issue-count task-list-count">
          {filteredIssues.length} 件
          <EstimateSumText sum={sumEstimates(filteredIssues, unit)} showMissing={false} />
        </span>
        <button onClick={onRefresh} className="btn-sm">更新</button>
        <button onClick={() => setShowIssueForm(!showIssueForm)} className="btn-sm">
          {showIssueForm ? "×" : "+ イシュー作成"}
        </button>
      </div>

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
              placeholder="タイトル" className="input-full" />
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
            placeholder="本文（タスクリストは - [ ] で記述）" className="textarea-full"
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
            }}>+ タスク項目</button>
          <div className="label-selector">
            {issueSelectedLabels.filter((name) => !labels.some((l) => l.name === name)).map((name) => (
              <span key={name} className="label-chip active label-chip--new" title="まだリポジトリにないラベルです（作るときに GitHub が作ります）"
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
            <span className="est-row-label">📏 見積もり</span>
            <EstimatePicker
              value={issueSelectedLabels.map(parseEstimateLabel).find((e) => e !== null) ?? null}
              onChange={(v) => setIssueSelectedLabels(withEstimate(issueSelectedLabels, v, unit))}
              showGuide={false}
            />
          </div>
          <select value={issueMilestone || ""} onChange={(e) => setIssueMilestone(e.target.value ? parseInt(e.target.value) : undefined)} className="select-sm">
            <option value="">マイルストーンなし</option>
            {milestones.map((m) => (
              <option key={m.number} value={m.number}>{m.title}</option>
            ))}
          </select>
          {collaborators.length > 0 && (
            <div style={{ marginTop: "4px" }}>
              <span style={{ fontSize: "var(--font-sm)", color: "var(--text-muted)" }}>担当者:</span>
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
                      <img src={c.avatar_url} alt={c.login} className="avatar-sm" />
                      {c.login}
                    </span>
                  );
                })}
              </div>
            </div>
          )}
          {/* ガント日程 */}
          <div style={{ display: "flex", gap: "6px", alignItems: "center", marginTop: "4px" }}>
            <span style={{ fontSize: "var(--font-sm)", color: "var(--text-muted)", flexShrink: 0 }}>日程:</span>
            <input type="date" value={issueGanttStart} onChange={(e) => setIssueGanttStart(e.target.value)}
              style={{ background: "var(--bg-secondary)", color: "var(--text-primary)", border: "1px solid var(--border-default)", borderRadius: "4px", padding: "3px 6px", fontSize: "12px" }} />
            <span style={{ fontSize: "var(--font-sm)", color: "var(--text-faint)" }}>〜</span>
            <input type="date" value={issueGanttEnd} onChange={(e) => setIssueGanttEnd(e.target.value)}
              style={{ background: "var(--bg-secondary)", color: "var(--text-primary)", border: "1px solid var(--border-default)", borderRadius: "4px", padding: "3px 6px", fontSize: "12px" }} />
            <span style={{ fontSize: "11px", color: "var(--text-faint)" }}>(ガント)</span>
          </div>
          {/* リマインダー設定 */}
          <div style={{ marginTop: "4px" }}>
            <span style={{ fontSize: "var(--font-sm)", color: "var(--text-muted)" }}>リマインダー (任意):</span>
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
          <button onClick={handleIssueCreate} className="btn-primary">作成</button>
          <p className="hint">
            <b>テンプレート</b>は、よく書く Issue の書き出しです。GitHub では <code>.github/ISSUE_TEMPLATE/</code> に置いた Markdown ファイルで、
            先頭に名前・説明・ラベルなどを書きます。中身を変えるときは、そのファイルを直します（作業タブでコミット、または GitHub で編集）。
          </p>
        </div>
      )}

      {/* Issue一覧。PC・カードのときは、左に一覧・右に選んだタスクの詳細 */}
      {splitActive ? (
        <div className={`task-split${dragging ? " task-split--dragging" : ""}`} ref={splitRef}>
          <div className="task-split-list" ref={listRef} style={{ width: `${splitLeft}%` }}>
            {list}
          </div>
          <div className="task-split-grip" role="separator" aria-orientation="vertical" title="ドラッグで幅を変える" onMouseDown={startDrag} />
          <div className="task-split-detail">
            {detail ?? <p className="task-split-empty">タスクを選ぶと、ここに詳細が出ます（↑↓ で上下のタスクへ）</p>}
          </div>
        </div>
      ) : (
        list
      )}

      {picking && (
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
          onSelectAll={() => { setBulkDone(null); setPicked(new Set(rows.map((r) => r.issue.number))); }}
          onQuit={quitPicking}
        />
      )}
    </div>
  );
}
