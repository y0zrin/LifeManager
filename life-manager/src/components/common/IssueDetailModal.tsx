import { useState, useEffect, useLayoutEffect, useRef, useContext, type ReactNode } from "react";
import type { CloseReason, GitHubIssue, GitHubComment, GitHubLabel, GitHubMilestone, GitHubUser, Reminder, TimelineEvent } from "../../lib/types";
import type { ProgressMode } from "../../lib/ganttTypes";
import { parseGanttDates, parseDependencies, parseProgress, serializeGanttDates, serializeDependencies, serializeProgress, stripGanttMetadata } from "../../lib/ganttParser";
import { LabelBadge } from "./LabelBadge";
import { TaskListBody } from "./TaskListBody";
import { PendingChip } from "./PendingChip";
import { ParentCrumb, SubIssues, type SubIssueApi } from "./SubIssues";
import { CloseMenu, closeReasonText } from "./CloseMenu";
import { RelatedIssues } from "./RelatedIssues";
import { HistoryOrderToggle, IssueTimeline, useHistoryOrder } from "./IssueTimeline";
import { isSending, issueRef } from "../../lib/issueRef";
import { splitAppMarks, visibleBody, withAppMarks } from "../../lib/bodyMarks";
import { isEnter, isEscape } from "../../lib/keys";
import { ESTIMATE_PREFIX, estimateOf } from "../../lib/estimate";
import { EstimatePicker } from "./EstimateChip";
import { Avatar } from "./Avatar";
import { relatedOf } from "../../lib/related";
import { ArtifactsTab } from "../media/ArtifactsTab";
import { helpDoneBody, parseHelp } from "../../lib/help";
import { FailedChip, SendingChip } from "./Sending";
import { IssueIndexContext } from "./SubIssueMarks";
import { dropLocalComment, pruneLocalComments, putLocalComment, useLocalComments } from "../../lib/sending";
import { isMobile, keyHint } from "../../lib/platform";
import { inCategory } from "../../lib/section";
import { tr, trx, localeTag } from "../../lib/i18n";

/** 詳細のタブ: 履歴（コメントと変更。はじめはこれ）・設定（ラベル・担当・ガントなど）・つながり（サブイシュー・関連）。内容（本文）はタブの上にいつも出す */
type DetailTab = "history" | "settings" | "links" | "artifacts";

/** 内容をたたんだときの高さ（3 行ほど） */
const CONTENT_CLAMP_PX = 88;

/** 設定の表で開いている編集の欄（一度に一つ） */
type EditRow = "labels" | "assignees" | "dates" | "deps" | "progress" | "reminder";

/** ラベルを選ぶ欄の並び（カテゴリごとに 1 行） */
// ラベルの分類（ラベルの名前の頭。データなので日本語のまま。画面には tr() で訳して出す）
const LABEL_GROUPS = ["種別", "状態", "優先", "セクション"];

/** YYYY-MM-DD → M/D */
function md(date: string): string {
  const [, m, d] = date.split("-").map(Number);
  return `${m}/${d}`;
}

interface IssueDetailModalProps {
  /** 重ねずに、その場に出す（PC のタスクの右の欄）。Esc で閉じない */
  inline?: boolean;
  issue: GitHubIssue;
  onClose: () => void;
  listComments: (issueNumber: number) => Promise<GitHubComment[]>;
  createComment: (issueNumber: number, body: string) => Promise<GitHubComment | null>;
  availableLabels: GitHubLabel[];
  milestones: GitHubMilestone[];
  collaborators: GitHubUser[];
  updateIssue: (n: number, updates: { title?: string; body?: string; labels?: string[]; assignees?: string[]; milestone?: number | null }) => Promise<void>;
  /** 閉じる（reason で閉じ方。重複なら元の Issue も） */
  onCloseIssue: (issueNumber: number, reason?: CloseReason, duplicateOf?: GitHubIssue) => Promise<void>;
  onReopenIssue: (issueNumber: number) => Promise<void>;
  onToggleTodo: (issueNumber: number, newBody: string) => Promise<void>;
  reminders: Reminder[];
  onAddReminder: (issueNumber: number, title: string, datetime: string, channels: string[]) => Promise<void>;
  onRemoveReminder: (issueNumber: number, datetime: string) => Promise<void>;
  allIssues?: GitHubIssue[];
  /** ほかの Issue の詳細に切り替える（親・子へ移るとき。一覧にない子は、その中身も渡す） */
  onOpenIssue?: (n: number, fallback?: GitHubIssue) => void;
  /** サブイシュー（親子）の読み書き。渡さなければ、サブイシューの欄を出さない */
  subIssueApi?: SubIssueApi;
  /** 変更の履歴（タイムライン）を読む。渡さなければ、コメントだけを出す */
  listTimeline?: (n: number) => Promise<TimelineEvent[]>;
  /** 履歴のコミットを押したとき（変更内容を見る） */
  onShowCommit?: (hash: string, actor: string, date: string) => void;
  /** 見積もりを付け替える（null なら外す）。渡さなければ、見積もりの行を出さない */
  onSetEstimate?: (issueNumber: number, value: number | null) => Promise<void>;
  /** 成果物（つながるコミットで変わったファイル）を探すリポジトリと、この PC の作業フォルダ。渡さなければ、成果物のタブを出さない */
  artifacts?: { owner: string; repo: string; folder?: string };
  /** ログインしている人（🆘 の解決で、呼ぶ人から自分を除く） */
  me?: string;
  /** 🆘 助けを求める（渡さなければ、ボタンを出さない） */
  onAskHelp?: (issue: GitHubIssue) => void;
  /** 外でコメントを足したとき（🆘 を送ったなど）に増える。変わったらコメントを読み直す */
  commentsVersion?: number;
}

export function IssueDetailModal({ inline = false, issue, onClose, listComments, createComment, availableLabels, milestones, collaborators, updateIssue, onCloseIssue, onReopenIssue, onToggleTodo, reminders, onAddReminder, onRemoveReminder, allIssues = [], onOpenIssue, subIssueApi, listTimeline, onShowCommit, onSetEstimate, artifacts, me = "", onAskHelp, commentsVersion = 0 }: IssueDetailModalProps) {
  const estimate = estimateOf(issue);
  const [comments, setComments] = useState<GitHubComment[]>([]);
  // 送っている・送れなかった・送れたがまだ読み直していないコメント（手元の置き場。詳細を閉じても残る）は、読んだコメントのあとに並べる
  const { owner, repo } = useContext(IssueIndexContext);
  const localKey = `${me}@${owner}/${repo}#${issue.number}`;
  const localComments = useLocalComments(localKey);
  // この詳細が画面に出ているか（閉じたあとに送り終わったコメントで、読み直さない）
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const shownComments = localComments.length > 0
    ? [...comments, ...localComments.filter((c) => !comments.some((x) => x.id === c.id))]
    : comments;
  const [newComment, setNewComment] = useState("");
  const [loading, setLoading] = useState(true);

  // --- 編集状態 ---
  const [editingTitle, setEditingTitle] = useState(false);
  const [editTitle, setEditTitle] = useState(issue.title);
  const [editingBody, setEditingBody] = useState(false);
  // 本文を直す欄には、アプリの印（ガントの日程・関連など）を出さない。保存するときに戻す
  const [editBody, setEditBody] = useState(() => splitAppMarks(issue.body).text);
  const [tab, setTab] = useState<DetailTab>("history");
  // 成果物の数（タブを開いて探したあと）
  const [artifactCount, setArtifactCount] = useState<number | null>(null);
  // 内容が長いときは、たたんでおく（「すべて表示」で全部）
  const [contentOpen, setContentOpen] = useState(false);
  const [contentLong, setContentLong] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  // 履歴の並び（はじめは新しい順。この PC に覚える）
  const [historyOrder, setHistoryOrder] = useHistoryOrder();
  const [openRow, setOpenRow] = useState<EditRow | null>(null);
  const [editLabels, setEditLabels] = useState<string[]>(Array.isArray(issue.labels) ? issue.labels.map((l) => l.name) : []);
  const [editAssignees, setEditAssignees] = useState<string[]>(Array.isArray(issue.assignees) ? issue.assignees.map((a) => a.login) : []);
  const editBodyRef = useRef<HTMLTextAreaElement>(null);
  const [reminderDatetime, setReminderDatetime] = useState("");
  const [reminderChannels, setReminderChannels] = useState<string[]>(["os"]);
  const issueReminders = reminders.filter((r) => r.issue_number === issue.number);

  // --- ガントメタデータ ---
  const ganttDates = parseGanttDates(issue.body);
  const ganttDeps = parseDependencies(issue.body);
  const ganttProgress = parseProgress(issue.body);
  const [ganttStart, setGanttStart] = useState(ganttDates?.start || "");
  const [ganttEnd, setGanttEnd] = useState(ganttDates?.end || "");
  const [ganttDepsInput, setGanttDepsInput] = useState(ganttDeps.map((n) => `#${n}`).join(","));
  const [ganttProgressMode, setGanttProgressMode] = useState<ProgressMode>(ganttProgress.mode);
  const [ganttProgressValue, setGanttProgressValue] = useState(String(ganttProgress.value));
  const [ganttSaving, setGanttSaving] = useState(false);
  const [depSearch, setDepSearch] = useState("");
  const [showDepSuggestions, setShowDepSuggestions] = useState(false);
  const depSuggestions = depSearch.length >= 1
    ? allIssues
        .filter((i) => {
          if (i.number === issue.number || isSending(i.number)) return false;
          const numMatch = depSearch.match(/^#?(\d+)$/);
          if (numMatch) return String(i.number).includes(numMatch[1]);
          return i.title.toLowerCase().includes(depSearch.toLowerCase());
        })
        .slice(0, 5)
    : [];

  useEffect(() => {
    loadComments();
    // 別の Issue に移ったら、履歴のタブから（内容はたたんで）
    setTab("history");
    setContentOpen(false);
    setOpenRow(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issue.number]);

  // issue が外で変わったら（読み直し・ほかの画面での変更）、書きかけていない欄を今の値にする。
  // 開いている欄（題名・本文・ラベルなど）は戻さない（#268。読み直しで、書きかけが消えないように）
  useEffect(() => {
    if (!editingTitle) setEditTitle(issue.title ?? "");
    if (!editingBody) setEditBody(splitAppMarks(issue.body).text);
    if (openRow !== "labels") setEditLabels(Array.isArray(issue.labels) ? issue.labels.map((l) => l.name) : []);
    if (openRow !== "assignees") setEditAssignees(Array.isArray(issue.assignees) ? issue.assignees.map((a) => a.login) : []);
    if (openRow !== "dates" && openRow !== "deps" && openRow !== "progress") {
      const d = parseGanttDates(issue.body);
      const deps = parseDependencies(issue.body);
      const prog = parseProgress(issue.body);
      setGanttStart(d?.start || "");
      setGanttEnd(d?.end || "");
      setGanttDepsInput(deps.map((n) => `#${n}`).join(","));
      setGanttProgressMode(prog.mode);
      setGanttProgressValue(String(prog.value));
    }
    // 開いている欄が変わっただけでは戻さない（閉じるときは cancelRow が戻す）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issue]);

  // 外でコメントを足したら（🆘 を送ったなど）、読み直す
  useEffect(() => {
    if (commentsVersion > 0) loadComments(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commentsVersion]);

  /** コメントを読む。quiet なら「読み込み中」を出さない（送ったあと）。読めなかったときは、出ている一覧をそのままにする */
  async function loadComments(quiet = false) {
    if (!quiet) setLoading(true);
    try {
      const result = await listComments(issue.number);
      const fresh = Array.isArray(result) ? result : [];
      setComments(fresh);
      // 送れたコメントが、読んだ一覧に入ったら、手元の置き場から外す
      pruneLocalComments(localKey, fresh.map((c) => c.id));
    } catch (e) {
      console.error(e);
      if (!quiet) setComments([]);
    }
    if (!quiet) setLoading(false);
  }

  /** コメントを送る: すぐ履歴に「送っています…」で出す。送れたら GitHub の返事のコメントに置き換え（読み直した一覧に入るまで手元に残す）、
   *  送れなければ「送れませんでした」（詳細を閉じても残る） */
  async function postComment(body: string, again?: GitHubComment) {
    const key = localKey;
    const now = new Date().toISOString();
    const mine: GitHubComment = again ?? { id: -Date.now(), body, user: { login: me || tr("あなた"), avatar_url: "" }, created_at: now, updated_at: now };
    putLocalComment(key, { ...mine, _sending: true, _failed: undefined });
    try {
      const created = await createComment(issue.number, body);
      dropLocalComment(key, mine.id);
      if (created && typeof created.id === "number") putLocalComment(key, { ...created, _sent: true });
      // 読み直す（と、送れたものを置き場から外す）のは、この詳細がまだ出ているときだけ。
      // 閉じたあとなら、送れたコメントは置き場に残り、開き直した詳細が次に読み直したときに外す
      if (mounted.current) await loadComments(true);
    } catch (e) {
      putLocalComment(key, { ...mine, _sending: false, _failed: String(e) });
    }
  }

  async function handleSubmit() {
    const text = newComment;
    if (!text.trim()) return;
    // 書く欄はすぐ空に（送っているあいだは、履歴に出ている）
    setNewComment("");
    await postComment(text);
  }

  /** 送れなかったコメント: もう一度・書く欄に戻す */
  function retryComment(c: GitHubComment) {
    void postComment(c.body, c);
  }
  function restoreComment(c: GitHubComment) {
    dropLocalComment(localKey, c.id);
    setNewComment((cur) => (cur.trim() ? `${cur}\n${c.body}` : c.body));
    requestAnimationFrame(() => composerRef.current?.focus());
  }

  // 🆘 のコメントへ: 返事を書く（書く欄に @ を入れて移る）・解決した（助けを求めた人と、呼ばれた人に知らせる）
  const composerRef = useRef<HTMLTextAreaElement>(null);
  function replyHelp(c: GitHubComment) {
    const who = c.user?.login;
    setNewComment((cur) => (who && !cur.includes(`@${who}`) ? `@${who} ${cur}` : cur));
    requestAnimationFrame(() => {
      const ta = composerRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      ta.scrollIntoView({ block: "nearest" });
    });
  }
  async function resolveHelp(c: GitHubComment) {
    const people = [c.user?.login ?? "", ...parseHelp(c.body ?? "").to].filter((l) => l && l.toLowerCase() !== me.toLowerCase());
    await postComment(helpDoneBody([...new Set(people)]));
  }

  // --- タイトル保存 ---
  async function handleTitleSave() {
    const trimmed = editTitle.trim();
    if (!trimmed || trimmed === issue.title) {
      setEditTitle(issue.title);
      setEditingTitle(false);
      return;
    }
    await updateIssue(issue.number, { title: trimmed });
    setEditingTitle(false);
  }

  // --- 本文保存 ---
  async function handleBodySave() {
    // 印は、今の本文のもの（直しているあいだにガントの日程を変えても、消さない）
    const { text, marks } = splitAppMarks(issue.body);
    if (editBody.trimEnd() === text) {
      setEditingBody(false);
      return;
    }
    await updateIssue(issue.number, { body: withAppMarks(editBody, marks) });
    setEditingBody(false);
  }

  // --- ラベル保存 ---
  async function handleLabelsSave() {
    await updateIssue(issue.number, { labels: editLabels });
    setOpenRow(null);
  }

  function toggleLabel(name: string) {
    if (editLabels.includes(name)) {
      setEditLabels(editLabels.filter((n) => n !== name));
    } else {
      setEditLabels([...editLabels, name]);
    }
  }

  function toggleAssignee(login: string) {
    if (editAssignees.includes(login)) {
      setEditAssignees(editAssignees.filter((a) => a !== login));
    } else {
      setEditAssignees([...editAssignees, login]);
    }
  }

  async function handleAssigneesSave() {
    await updateIssue(issue.number, { assignees: editAssignees });
    setOpenRow(null);
  }

  // --- ガント（日程・先行・進み）。どの欄から保存しても、3 つともいまの値で本文の印に書く ---
  async function handleGanttSave() {
    setGanttSaving(true);
    try {
      let body = stripGanttMetadata(issue.body || "");
      if (ganttStart && ganttEnd) {
        const s = ganttStart <= ganttEnd ? ganttStart : ganttEnd;
        const e = ganttStart <= ganttEnd ? ganttEnd : ganttStart;
        body += "\n" + serializeGanttDates(s, e);
      }
      const deps = ganttDepsInput.split(",").map((s) => parseInt(s.replace("#", "").trim(), 10)).filter((n) => !isNaN(n));
      if (deps.length > 0) {
        body += "\n" + serializeDependencies(deps);
      }
      if (ganttProgressMode !== "checkbox") {
        const val = ganttProgressMode === "manual" ? parseInt(ganttProgressValue, 10) || 0 : ganttProgressValue;
        body += "\n" + serializeProgress(ganttProgressMode, val);
      }
      await onToggleTodo(issue.number, body);
      setOpenRow(null);
    } finally {
      setGanttSaving(false);
    }
  }

  /** 編集の欄を閉じる（入れかけたものは、今の値に戻す） */
  function cancelRow() {
    setEditLabels(Array.isArray(issue.labels) ? issue.labels.map((l) => l.name) : []);
    setEditAssignees(issue.assignees?.map((a) => a.login) || []);
    const d = parseGanttDates(issue.body);
    const deps = parseDependencies(issue.body);
    const prog = parseProgress(issue.body);
    setGanttStart(d?.start || "");
    setGanttEnd(d?.end || "");
    setGanttDepsInput(deps.map((n) => `#${n}`).join(","));
    setGanttProgressMode(prog.mode);
    setGanttProgressValue(String(prog.value));
    setDepSearch("");
    setOpenRow(null);
  }

  /** 設定の表の欄を開く・閉じる（ほかの欄を開いていたら、そちらは戻して閉じる） */
  function toggleRow(row: EditRow) {
    if (openRow === row) {
      cancelRow();
      return;
    }
    cancelRow();
    if (row === "reminder") {
      // はじめは 1 時間後
      const d = new Date(Date.now() + 3600000);
      const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
      setReminderDatetime(local.toISOString().slice(0, 16));
    }
    setOpenRow(row);
  }

  // ESCキーで閉じる（重ねて出すときだけ。右の欄に出すときは閉じない）
  useEffect(() => {
    if (inline) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (isEscape(e)) onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, inline]);

  // 内容がたたむ高さを超えるか（本文が変わったとき・幅が変わって折り返しが変わったときに測り直す）
  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const measure = () => setContentLong(el.scrollHeight > CONTENT_CLAMP_PX + 4);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [issue.body, editingBody]);

  const todoMatch = issue.body?.match(/- \[[ x]\]/g);
  const todoTotal = todoMatch?.length || 0;
  const todoDone = issue.body?.match(/- \[x\]/g)?.length || 0;

  // タブの数（つながり: 子と関連、履歴: コメント）
  const linkCount = (issue.sub_issues_summary?.total ?? 0) + (issue.number > 0 ? relatedOf(issue, allIssues).length : 0);
  const commentCount = Math.max(issue.comments ?? 0, comments.length);
  const TABS: { key: DetailTab; label: string; count?: number }[] = [
    { key: "history", label: tr("履歴"), count: commentCount },
    { key: "settings", label: tr("設定") },
    { key: "links", label: tr("つながり"), count: linkCount },
    ...(artifacts && issue.number > 0 ? [{ key: "artifacts" as const, label: tr("成果物"), count: artifactCount ?? undefined }] : []),
  ];

  // 設定の表に出す値
  const shownLabels = (issue.labels ?? []).filter((l) => !l.name.startsWith(ESTIMATE_PREFIX));
  const ganttDays = ganttDates ? Math.round((Date.parse(ganttDates.end) - Date.parse(ganttDates.start)) / 86400000) + 1 : 0;
  const progressText =
    ganttProgress.mode === "manual"
      ? tr("{value}%（手で入れた値）", { value: ganttProgress.value })
      : ganttProgress.mode === "binary"
        ? ganttProgress.value === "done"
          ? tr("達成")
          : tr("まだ")
        : todoTotal > 0
          ? tr("チェックリスト {todoDone}/{todoTotal}", { todoDone, todoTotal })
          : tr("チェックリスト（項目なし）");
  const progressRate =
    ganttProgress.mode === "manual"
      ? Number(ganttProgress.value) / 100
      : ganttProgress.mode === "binary"
        ? ganttProgress.value === "done"
          ? 1
          : 0
        : todoTotal > 0
          ? todoDone / todoTotal
          : 0;
  const labelGroups = [
    ...LABEL_GROUPS.map((g) => ({ name: tr(g), labels: availableLabels.filter((l) => inCategory(l.name, `${g}:`)) })),
    {
      name: tr("そのほか"),
      labels: availableLabels.filter((l) => !l.name.startsWith(ESTIMATE_PREFIX) && !LABEL_GROUPS.some((g) => inCategory(l.name, `${g}:`))),
    },
  ].filter((g) => g.labels.length > 0);

  // 設定の表の 1 行（名前・値・✎）。開いていたら、その下に編集の欄
  const row = (key: EditRow | null, name: string, value: ReactNode, editor?: ReactNode, mark = "✎") => (
    <>
      <div className={`idm-row${key && openRow === key ? " open" : ""}`}>
        <span className="idm-key">{name}</span>
        <div className="idm-val">{value}</div>
        {key ? (
          <button type="button" className="idm-edit" onClick={() => toggleRow(key)} aria-expanded={openRow === key} title={tr("{name}を変える", { name })}>
            {openRow === key ? "×" : mark}
          </button>
        ) : (
          <span />
        )}
      </div>
      {key && openRow === key && editor && <div className="idm-editor">{editor}</div>}
    </>
  );
  const editorButtons = (onSave: () => void, disabled = false, saveLabel = tr("保存")) => (
    <div className="idm-editor-btns">
      <button type="button" className="btn-sm" onClick={cancelRow}>
        {tr("やめる")}
      </button>
      <button type="button" className="btn-primary" onClick={onSave} disabled={disabled}>
        {saveLabel}
      </button>
    </div>
  );
  const none = (text = tr("なし")) => <span className="idm-none">{text}</span>;

  const body = (
      <div onClick={(e) => e.stopPropagation()} className={inline ? "modal-content issue-detail-inline" : "modal-content issue-modal"}>
        {inline && (
          <button type="button" onClick={onClose} className="issue-detail-close" title={tr("閉じる")}>×</button>
        )}
        {/* 見出し（番号・状態・閉じる・題・ラベル）。どのタブでも見える */}
        <div className="idm-head">
          {onOpenIssue && <ParentCrumb issue={issue} onOpenIssue={onOpenIssue} />}
          <div className="flex-row flex-wrap" style={{ marginBottom: "4px" }}>
            <span style={{ color: "var(--text-faint)", fontSize: "var(--font-lg)" }}>{issueRef(issue.number)}</span>
            {issue._pending && <PendingChip />}
            <span style={{ color: "var(--text-faint)", fontSize: "var(--font-sm)" }}>
              {issue.state === "open" ? tr("🟢 開いている") : tr("{v} 閉じた（{closeReasonText}）", { v: issue.state_reason === "not_planned" ? "⚪" : "🟣", closeReasonText: closeReasonText(issue.state_reason) })}
            </span>
            {issue.milestone && (
              <span style={{ color: "var(--text-muted)", fontSize: "var(--font-sm)" }}>
                📌 {issue.milestone.title}
              </span>
            )}
            {issue.state === "open" ? (
              // 閉じ方（完了・予定なし・重複）を選んで閉じる。困ったら 🆘（チームの人を @ で呼ぶコメント）
              <span className="idm-head-actions">
                {onAskHelp && issue.number > 0 && (
                  <button type="button" className="btn-help" onClick={() => onAskHelp(issue)} title={tr("チームの人を @ で呼んで、この Issue にコメントを残します")}>
                    {tr("🆘 助けを求める")}
                  </button>
                )}
                <CloseMenu issue={issue} allIssues={allIssues} onClose={(reason, original) => onCloseIssue(issue.number, reason, original)} onReopen={() => void onReopenIssue(issue.number)} />
              </span>
            ) : (
              <button
                className="btn-primary"
                style={{ marginLeft: "auto", fontSize: "var(--font-sm)", padding: "3px 10px" }}
                onClick={() => onReopenIssue(issue.number)}
              >
                {tr("リオープン")}
              </button>
            )}
          </div>

          {/* タイトル（クリックで編集） */}
          {editingTitle ? (
            <input
              autoFocus
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              onKeyDown={(e) => { if (isEnter(e)) handleTitleSave(); if (isEscape(e)) { setEditTitle(issue.title); setEditingTitle(false); } }}
              onBlur={handleTitleSave}
              className="idm-title-input"
            />
          ) : (
            <h2 onClick={() => setEditingTitle(true)} className="idm-title" title={isMobile ? tr("押して編集") : tr("クリックして編集")}>
              {issue.title}
            </h2>
          )}

          {/* ラベルと担当の一覧（押すと 設定 のタブで変えられる） */}
          <button
            type="button"
            className="idm-summary"
            onClick={() => {
              setTab("settings");
              toggleRow("labels");
            }}
            title={tr("設定のタブで変える")}
          >
            {shownLabels.map((l) => (
              <LabelBadge key={l.name} name={l.name} color={l.color} />
            ))}
            {shownLabels.length === 0 && <span className="idm-none">{tr("ラベルなし")}</span>}
            {(issue.assignees ?? []).map((a) => (
              <span key={a.login} className="idm-person">
                <Avatar login={a.login} url={a.avatar_url} className="avatar-sm" />
                {a.login}
              </span>
            ))}
          </button>
        </div>

        {/* 内容（本文とチェックリスト）。どのタブでも見える。長いときは 3 行ほどでたたみ、「すべて表示」で全部 */}
        {editingBody ? (
          <div className="idm-content-edit">
            <textarea
              ref={editBodyRef}
              autoFocus
              value={editBody}
              onChange={(e) => setEditBody(e.target.value)}
              onKeyDown={(e) => { if (isEscape(e)) { setEditBody(splitAppMarks(issue.body).text); setEditingBody(false); } }}
              className="idm-body-input"
            />
            <div style={{ display: "flex", gap: "6px", marginTop: "6px", alignItems: "center" }}>
              <button className="btn-primary" onClick={handleBodySave} style={{ fontSize: "12px", padding: "3px 10px" }}>
                {tr("保存")}
              </button>
              <button className="btn-sm" onClick={() => { setEditBody(splitAppMarks(issue.body).text); setEditingBody(false); }} style={{ fontSize: "12px" }}>
                {tr("キャンセル")}
              </button>
              <button className="btn-sm" style={{ fontSize: "11px", marginLeft: "auto" }}
                onClick={() => {
                  const ta = editBodyRef.current;
                  if (!ta) return;
                  const pos = ta.selectionStart ?? editBody.length;
                  const before = editBody.substring(0, pos);
                  const after = editBody.substring(pos);
                  const prefix = before.length > 0 && !before.endsWith("\n") ? "\n" : "";
                  const newBody = before + prefix + "- [ ] " + after;
                  setEditBody(newBody);
                  requestAnimationFrame(() => {
                    const cursor = pos + prefix.length + 6;
                    ta.focus();
                    ta.setSelectionRange(cursor, cursor);
                  });
                }}>{tr("+ タスク項目")}</button>
            </div>
          </div>
        ) : (
          <>
            <div ref={contentRef} className={`idm-content${contentLong && !contentOpen ? " clamped" : ""}`}>
              {issue.body && todoTotal > 0 ? (
                /* タスクリストがある場合はTaskListBodyでレンダリング（たたんでいても、見えている所のチェックは付けられる） */
                <TaskListBody
                  body={issue.body}
                  issueNumber={issue.number}
                  onToggle={onToggleTodo}
                />
              ) : (
                <div onClick={() => setEditingBody(true)} className="idm-body" title={isMobile ? tr("押して編集") : tr("クリックして編集")}>
                  {visibleBody(issue.body) || <span style={{ color: "var(--text-faint)" }}>{isMobile ? tr("本文なし（押して追加）") : tr("本文なし（クリックで追加）")}</span>}
                </div>
              )}
              {/* 編集ボタン（右上に小さく配置） */}
              <button className="btn-sm idm-body-edit" onClick={() => setEditingBody(true)} title={tr("本文を編集")}>
                ✏️
              </button>
            </div>
            {(contentLong || todoTotal > 0) && (
              <div className="idm-content-foot">
                {contentLong && (
                  <button type="button" className="link-button" onClick={() => setContentOpen(!contentOpen)} aria-expanded={contentOpen}>
                    {contentOpen ? tr("たたむ ▴") : tr("すべて表示 ▾")}
                  </button>
                )}
                {todoTotal > 0 && (
                  <>
                    <span className="idm-none">{trx("チェック {todoDone}/{todoTotal}", { todoDone, todoTotal })}</span>
                    <span className="idm-content-bar" aria-hidden="true">
                      <i style={{ width: `${(todoDone / todoTotal) * 100}%` }} />
                    </span>
                  </>
                )}
              </div>
            )}
          </>
        )}

        {/* タブ */}
        <div className="idm-tabs" role="tablist" aria-label={tr("Issue の詳細")}>
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              className={`idm-tab${tab === t.key ? " on" : ""}`}
              onClick={() => setTab(t.key)}
            >
              {t.label}
              {!!t.count && <span className="idm-tab-n">{t.count}</span>}
            </button>
          ))}
        </div>

        {/* === 設定: ラベル・見積もり・担当・マイルストーン・ガント・リマインダー === */}
        {tab === "settings" && (
          <div className="idm-props">
            <div className="idm-grp">
              <small className="idm-grp-title">{tr("分ける")}</small>
              {row(
                "labels",
                tr("ラベル"),
                shownLabels.length > 0 ? shownLabels.map((l) => <LabelBadge key={l.name} name={l.name} color={l.color} />) : none(),
                <>
                  {/* 見積もりは下の「見積もり」で付け替える（ここで選ぶと 2 つ付いてしまうため出さない） */}
                  {labelGroups.map((g) => (
                    <div key={g.name} className="idm-label-group">
                      <small>{g.name}</small>
                      {g.labels.map((l) => {
                        const active = editLabels.includes(l.name);
                        return (
                          <span
                            key={l.name}
                            className={`label-chip ${active ? "active" : ""}`}
                            onClick={() => toggleLabel(l.name)}
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
                  ))}
                  {editorButtons(handleLabelsSave)}
                </>,
              )}
              {/* 見積もりの目安は、ボタンにマウスを乗せると出る（表を低く保つため、ここでは説明の文を出さない） */}
              {onSetEstimate && row(null, tr("見積もり"), <EstimatePicker value={estimate} onChange={(v) => onSetEstimate(issue.number, v)} other showGuide={false} />)}
            </div>

            <div className="idm-grp">
              <small className="idm-grp-title">{tr("だれが・いつまでに")}</small>
              {row(
                "assignees",
                tr("担当"),
                issue.assignees && issue.assignees.length > 0
                  ? issue.assignees.map((a) => (
                      <span key={a.login} className="idm-person">
                        <Avatar login={a.login} url={a.avatar_url} className="avatar-sm" />
                        {a.login}
                      </span>
                    ))
                  : none(tr("だれもいない")),
                <>
                  <div className="label-selector" style={{ gap: "6px" }}>
                    {collaborators.map((c) => {
                      const active = editAssignees.includes(c.login);
                      return (
                        <span key={c.login} onClick={() => toggleAssignee(c.login)} className={`idm-pick${active ? " on" : ""}`}>
                          <Avatar login={c.login} url={c.avatar_url} className="avatar-sm" />
                          {c.login}
                        </span>
                      );
                    })}
                  </div>
                  {editorButtons(handleAssigneesSave)}
                </>,
              )}
              {row(
                null,
                tr("マイルストーン"),
                <select
                  className="select-sm idm-select"
                  value={issue.milestone?.number ?? ""}
                  onChange={async (e) => {
                    const val = e.target.value;
                    await updateIssue(issue.number, { milestone: val ? Number(val) : null });
                  }}
                >
                  <option value="">{tr("マイルストーンなし")}</option>
                  {milestones.map((m) => (
                    <option key={m.number} value={m.number}>
                      {m.title}
                    </option>
                  ))}
                </select>,
              )}
            </div>

            <div className="idm-grp">
              <small className="idm-grp-title">{tr("ガント")}</small>
              {row(
                "dates",
                tr("日程"),
                ganttDates ? tr("{md} → {md2}（{ganttDays} 日）", { md: md(ganttDates.start), md2: md(ganttDates.end), ganttDays }) : none(),
                <>
                  <p className="idm-editor-hint">{tr("ガントの帯になります。")}{!isMobile && tr("ガントで帯をドラッグしても変えられます。")}</p>
                  <div className="idm-field">
                    {tr("開始")}
                    <input type="date" className="idm-input" value={ganttStart} onChange={(e) => setGanttStart(e.target.value)} />{tr("→ 終了")}
                    <input type="date" className="idm-input" value={ganttEnd} onChange={(e) => setGanttEnd(e.target.value)} />
                    {(ganttStart || ganttEnd) && (
                      <button type="button" className="link-button" onClick={() => { setGanttStart(""); setGanttEnd(""); }}>
                        {tr("日程を外す")}
                      </button>
                    )}
                  </div>
                  {editorButtons(handleGanttSave, ganttSaving || (!!ganttStart !== !!ganttEnd), ganttSaving ? tr("保存中...") : tr("保存"))}
                </>,
              )}
              {row(
                "deps",
                tr("先行"),
                ganttDeps.length > 0
                  ? ganttDeps.map((n) => {
                      const dep = allIssues.find((i) => i.number === n);
                      return (
                        <span key={n} className="idm-dep">
                          {issueRef(n)}
                          {dep ? ` ${dep.title.substring(0, 18)}` : ""}
                        </span>
                      );
                    })
                  : none(),
                <>
                  <div className="idm-field" style={{ marginBottom: "6px" }}>
                    {ganttDepsInput.split(",").filter(Boolean).map((s) => {
                      const num = parseInt(s.replace("#", "").trim(), 10);
                      if (isNaN(num)) return null;
                      const depIssue = allIssues.find((i) => i.number === num);
                      return (
                        <span key={num} className="idm-dep">
                          {issueRef(num)}{depIssue ? ` ${depIssue.title.substring(0, 15)}` : ""}
                          <span style={{ cursor: "pointer", color: "var(--text-faint)", marginLeft: "2px" }}
                            onClick={() => {
                              const deps = ganttDepsInput.split(",").map(x => x.trim()).filter(x => x && parseInt(x.replace("#", ""), 10) !== num);
                              setGanttDepsInput(deps.join(","));
                            }}>×</span>
                        </span>
                      );
                    })}
                  </div>
                  <div style={{ position: "relative" }}>
                    <input value={depSearch}
                      onChange={(e) => { setDepSearch(e.target.value); setShowDepSuggestions(true); }}
                      onFocus={() => setShowDepSuggestions(true)}
                      onBlur={() => setTimeout(() => setShowDepSuggestions(false), 200)}
                      placeholder={tr("番号か題で探して足す…")}
                      className="idm-input" style={{ width: "240px" }} />
                    {showDepSuggestions && depSuggestions.length > 0 && (
                      <div className="suggestion-dropdown" style={{ maxWidth: "300px" }}>
                        {depSuggestions.map((s) => (
                          <button key={s.number} className="suggestion-item"
                            onMouseDown={(e) => {
                              e.preventDefault();
                              const existing = ganttDepsInput.split(",").map(x => x.trim()).filter(Boolean);
                              if (!existing.some(x => parseInt(x.replace("#", ""), 10) === s.number)) {
                                const newDeps = [...existing, `#${s.number}`].join(",");
                                setGanttDepsInput(newDeps);
                              }
                              setDepSearch("");
                              setShowDepSuggestions(false);
                            }}>
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
                  {editorButtons(handleGanttSave, ganttSaving, ganttSaving ? tr("保存中...") : tr("保存"))}
                </>,
                ganttDeps.length > 0 ? "✎" : "＋",
              )}
              {row(
                "progress",
                tr("進み"),
                <>
                  {progressText}
                  <span className="idm-mini" aria-hidden="true">
                    <i style={{ width: `${Math.round(Math.max(0, Math.min(1, progressRate)) * 100)}%` }} />
                  </span>
                </>,
                <>
                  <div className="idm-field">
                    {tr("数え方")}
                    <select className="select-sm" value={ganttProgressMode} onChange={(e) => {
                      const mode = e.target.value as ProgressMode;
                      setGanttProgressMode(mode);
                      if (mode === "binary") setGanttProgressValue("undone");
                      else setGanttProgressValue("0");
                    }}>
                      <option value="checkbox">{tr("チェックリストの数")}</option>
                      <option value="manual">{tr("手で入れる（%）")}</option>
                      <option value="binary">{tr("達成したか")}</option>
                    </select>
                    {ganttProgressMode === "manual" && (
                      <>
                        <input value={ganttProgressValue} onChange={(e) => setGanttProgressValue(e.target.value)}
                          placeholder="0-100" className="idm-input" style={{ width: "64px" }} />
                        %
                      </>
                    )}
                    {ganttProgressMode === "binary" && (
                      <button type="button" className={`btn-sm ${ganttProgressValue === "done" ? "active" : ""}`}
                        style={{ backgroundColor: ganttProgressValue === "done" ? "var(--accent-green)" : undefined, color: ganttProgressValue === "done" ? "var(--text-on-accent)" : undefined }}
                        onClick={() => setGanttProgressValue(ganttProgressValue === "done" ? "undone" : "done")}
                      >
                        {ganttProgressValue === "done" ? tr("達成") : tr("まだ")}
                      </button>
                    )}
                  </div>
                  {editorButtons(handleGanttSave, ganttSaving, ganttSaving ? tr("保存中...") : tr("保存"))}
                </>,
              )}
            </div>

            <div className="idm-grp">
              <small className="idm-grp-title">{tr("知らせ")}</small>
              {row(
                "reminder",
                tr("リマインダー"),
                issueReminders.length > 0
                  ? issueReminders.map((r) => (
                      <span key={r.datetime} className="idm-dep">
                        {new Date(r.datetime).toLocaleString(localeTag(), { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}（{r.channels.map((c) => (c === "os" ? "OS" : "Discord")).join(tr("・"))}）
                        <span style={{ cursor: "pointer", color: "var(--accent-red)", marginLeft: "2px" }} title={tr("取り消す")}
                          onClick={() => onRemoveReminder(issue.number, r.datetime)}>×</span>
                      </span>
                    ))
                  : none(),
                <>
                  <div className="idm-field">
                    <input type="datetime-local" className="idm-input" value={reminderDatetime} onChange={(e) => setReminderDatetime(e.target.value)} />
                    <label className="chk">
                      <input type="checkbox" checked={reminderChannels.includes("os")}
                        onChange={(e) => {
                          if (e.target.checked) setReminderChannels([...reminderChannels, "os"]);
                          else setReminderChannels(reminderChannels.filter((c) => c !== "os"));
                        }} />
                      OS
                    </label>
                    <label className="chk">
                      <input type="checkbox" checked={reminderChannels.includes("discord")}
                        onChange={(e) => {
                          if (e.target.checked) setReminderChannels([...reminderChannels, "discord"]);
                          else setReminderChannels(reminderChannels.filter((c) => c !== "discord"));
                        }} />
                      Discord
                    </label>
                  </div>
                  {editorButtons(
                    async () => {
                      await onAddReminder(issue.number, issue.title, reminderDatetime, reminderChannels);
                      setOpenRow(null);
                    },
                    !reminderDatetime || reminderChannels.length === 0,
                    tr("足す"),
                  )}
                </>,
                "＋",
              )}
            </div>
          </div>
        )}

        {/* === 成果物: つながるコミットで変わったファイル（押すとメディアビューワー） === */}
        {tab === "artifacts" && artifacts && issue.number > 0 && (
          <ArtifactsTab owner={artifacts.owner} repo={artifacts.repo} folder={artifacts.folder} number={issue.number} onCount={setArtifactCount} />
        )}

        {/* === つながり: サブイシュー・関連 === */}
        {tab === "links" && (
          <>
            {/* サブイシュー（子の一覧と進み具合）。まだ送っていない Issue（仮の番号）も、送信待ちのまま付け外しできる（#273） */}
            {subIssueApi && onOpenIssue && (
              <SubIssues
                issue={issue}
                allIssues={allIssues}
                api={subIssueApi}
                onOpenIssue={onOpenIssue}
                onCloseIssue={onCloseIssue}
                onReopenIssue={onReopenIssue}
              />
            )}
            {/* 関連（意味の近い Issue。本文の見えない印に残し、相手の詳細にも出す） */}
            {onOpenIssue && issue.number > 0 && (
              <RelatedIssues
                issue={issue}
                allIssues={allIssues}
                onUpdateBody={(n, body) => updateIssue(n, { body })}
                onOpenIssue={onOpenIssue}
              />
            )}
            {issue.number <= 0 && <p className="idm-none">{tr("まだ GitHub に送っていない Issue には、つながりを付けられません。")}</p>}
          </>
        )}

        {/* === 履歴: コメントと変更の履歴（新しい順なら書く欄が上、古い順なら下） === */}
        {tab === "history" && (() => {
          const composer = (
            <>
              <textarea
                ref={composerRef}
                value={newComment}
                onChange={(e) => setNewComment(e.target.value)}
                onKeyDown={(e) => { if (isEnter(e) && (e.ctrlKey || e.metaKey)) handleSubmit(); }}
                placeholder={tr("コメントを追加...{keyHint}", { keyHint: keyHint(tr(" (Ctrl+Enter で送信)")) })}
                className="textarea-full"
                style={{ minHeight: "60px" }}
              />
              <button onClick={handleSubmit} className="btn-primary" disabled={!newComment.trim()}
                style={{ marginTop: "6px" }}>
                {tr("コメント追加")}
              </button>
            </>
          );
          if (listTimeline && onOpenIssue) {
            return (
              <IssueTimeline
                issue={issue}
                comments={shownComments}
                loadingComments={loading}
                listTimeline={listTimeline}
                onOpenIssue={onOpenIssue}
                onShowCommit={onShowCommit}
                order={historyOrder}
                onOrderChange={setHistoryOrder}
                composer={composer}
                onReplyHelp={replyHelp}
                onResolveHelp={issue.number > 0 ? resolveHelp : undefined}
                onRetryComment={retryComment}
                onRestoreComment={restoreComment}
              />
            );
          }
          // 変更の履歴を読めないときは、コメントだけ
          const sorted = [...shownComments].sort((x, y) => (historyOrder === "newest" ? y.created_at.localeCompare(x.created_at) : x.created_at.localeCompare(y.created_at)));
          return (
            <>
              <div className="issue-timeline-head">
                <h3 className="section-header">{trx("💬 コメント ({length})", { length: comments.length })}</h3>
                <HistoryOrderToggle order={historyOrder} onChange={setHistoryOrder} />
              </div>
              {historyOrder === "newest" && <div className="issue-timeline-composer">{composer}</div>}
              {loading ? (
                <p style={{ color: "var(--text-muted)", fontSize: "12px" }}>{tr("読み込み中...")}</p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginBottom: "12px" }}>
                  {sorted.map((c) => (
                    <div key={c.id} style={{ padding: "10px", background: "var(--bg-secondary)", borderRadius: "6px", border: "1px solid var(--border-default)" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                        <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--accent-blue)" }}>
                          {c.user?.login ?? "unknown"}
                          {c._pending && <PendingChip />}
                        </span>
                        {c._sending ? (
                          <SendingChip />
                        ) : c._failed ? (
                          <span style={{ display: "inline-flex", gap: "6px", alignItems: "center" }}>
                            <FailedChip />
                            <button type="button" className="btn-primary" onClick={() => retryComment(c)}>{tr("もう一度")}</button>
                            <button type="button" className="btn-sm" onClick={() => restoreComment(c)}>{tr("書く欄に戻す")}</button>
                          </span>
                        ) : (
                          <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>
                            {new Date(c.created_at).toLocaleString(localeTag())}
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: "13px", color: "var(--text-secondary)", whiteSpace: "pre-wrap", lineHeight: 1.5 }}>
                        {c.body}
                      </div>
                    </div>
                  ))}
                  {shownComments.length === 0 && (
                    <p style={{ color: "var(--text-faint)", fontSize: "12px" }}>{tr("コメントはまだありません")}</p>
                  )}
                </div>
              )}
              {historyOrder === "oldest" && <div className="issue-timeline-composer">{composer}</div>}
            </>
          );
        })()}
      </div>
  );
  return inline ? body : (
    <div className="palette-overlay issue-overlay" onClick={onClose}>
      <button onClick={onClose} className="modal-close-btn" title={tr("閉じる (Esc)")}>×</button>
      {body}
    </div>
  );
}
