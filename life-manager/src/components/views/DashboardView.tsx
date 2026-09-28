import { useState, useRef, useEffect, useMemo, useContext } from "react";
import type { GitHubIssue, GitHubLabel, GitHubMilestone, GitHubUser } from "../../lib/types";
import { IssueCard } from "../common/IssueCard";
import { LabelFilterButton } from "../common/LabelFilterButton";
import { BulkBar, type BulkAction } from "../common/BulkBar";
import { IssueIndexContext } from "../common/SubIssueMarks";
import { serializeGanttDates } from "../../lib/ganttParser";
import { issueRef } from "../../lib/issueRef";
import { isEnter, isEscape } from "../../lib/keys";
import { isSameRepo, parseIssueApiUrl } from "../../lib/subIssues";
import { groupByParent, matchesLabelFilters, sortIssues, SORT_LABELS, type LabelFilters, type SortKey } from "../../lib/taskList";

/** 並び・親子でまとめるかは、次に開いたときも同じにする */
const SORT_STORE = "task-list-sort";
const TREE_STORE = "task-list-tree";

function loadSort(): SortKey {
  try {
    const v = localStorage.getItem(SORT_STORE);
    return v && v in SORT_LABELS ? (v as SortKey) : "new";
  } catch {
    return "new";
  }
}

function loadTree(): boolean {
  try {
    return localStorage.getItem(TREE_STORE) !== "off";
  } catch {
    return true;
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
  onCreateIssue: (title: string, body: string, labels: string[], milestone: number | null, assignees?: string[]) => Promise<number>;
  onCreateMemo: (text: string, theme: string) => Promise<void>;
  onRefresh: () => Promise<void>;
  onSelectIssue: (n: number) => void;
  onAddReminder: (issueNumber: number, title: string, datetime: string, channels: string[]) => Promise<void>;
  status?: string;
}

export function DashboardView({
  issues, closedIssues, labels, milestones, collaborators, currentUser, filters, onFiltersChange,
  onClose, onReopen, onPromote, onStatusChange, onUpdateIssue,
  onCreateIssue, onCreateMemo, onRefresh, onSelectIssue, onAddReminder, status,
}: DashboardViewProps) {
  const index = useContext(IssueIndexContext);
  const [memoText, setMemoText] = useState("");
  const [memoTheme, setMemoTheme] = useState("分野:私用");
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
  const [stateFilter, setStateFilter] = useState<"open" | "closed" | "all">("open");
  const [sortKey, setSortKey] = useState<SortKey>(loadSort);
  const [tree, setTree] = useState(loadTree);
  // 「☑ 選ぶ」: 選んだ Issue を、下の帯でまとめて変える
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [bulkBusy, setBulkBusy] = useState<string | null>(null);
  const [bulkDone, setBulkDone] = useState<string | null>(null);

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

  async function handleMemoSubmit() {
    if (!memoText.trim()) return;
    const text = memoText;
    const theme = memoTheme;
    setMemoText("");
    await onCreateMemo(text, theme);
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
    // バックグラウンドで作成
    const issueNumber = await onCreateIssue(title, body, labels, milestone, assignees);
    if (reminderDt && reminderCh.length > 0 && issueNumber) {
      await onAddReminder(issueNumber, title, reminderDt, reminderCh);
    }
  }

  const categories = ["種別:", "分野:", "状態:", "優先:"] as const;
  const categoryLabels: Record<string, string> = {
    "種別:": "種別", "分野:": "分野", "状態:": "状態", "優先:": "優先",
  };

  const baseIssues = stateFilter === "open" ? issues : stateFilter === "closed" ? closedIssues : [...issues, ...closedIssues];
  const allIssues = [...issues, ...closedIssues];
  const filteredIssues = baseIssues.filter((issue) => {
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
    // ラベルフィルタ（種類ごとに、どれか／すべて）
    return matchesLabelFilters(issue, filters);
  });

  // 並べ替え、親子でまとめる（同じリポジトリの親が一覧に出ているときだけ、その下に並べる）
  const sorted = sortIssues(filteredIssues, sortKey);
  const rows = tree
    ? groupByParent(sorted, (issue) => {
        const parent = parseIssueApiUrl(issue.parent_issue_url);
        return parent && isSameRepo(parent, index.owner, index.repo) ? parent.number : null;
      })
    : sorted.map((issue) => ({ issue, depth: 0 }));

  const activeFilterCount = Object.values(filters).filter((f) => f?.values.length).length + (assigneeFilter ? 1 : 0) + (searchQuery ? 1 : 0);

  const pickedIssues = allIssues.filter((i) => picked.has(i.number));

  async function runBulk(action: BulkAction) {
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
    }
  }

  return (
    <div className="content">
      {/* メモ投入 */}
      <div className="memo-bar">
        <input
          value={memoText}
          onChange={(e) => setMemoText(e.target.value)}
          onKeyDown={(e) => { if (isEnter(e)) handleMemoSubmit(); }}
          placeholder="メモを投入... (Enter)"
          className="memo-input"
        />
        <select value={memoTheme} onChange={(e) => setMemoTheme(e.target.value)} className="select-sm">
          <option value="分野:私用">私用</option>
          <option value="分野:仕事">仕事</option>
          <option value="分野:やりたい">やりたい</option>
          <option value="分野:健康">健康</option>
          <option value="分野:学習">学習</option>
        </select>
        <button onClick={handleMemoSubmit} className="btn-primary">投入</button>
      </div>

      {/* 検索 */}
      <div className="search-bar">
        <input value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Issue を検索..."
          className="search-input" />
        {searchQuery && (
          <button className="search-clear" onClick={() => setSearchQuery("")}>×</button>
        )}
      </div>

      {/* フィルタ & アクション */}
      <div className="toolbar">
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
        <select value={stateFilter} onChange={(e) => setStateFilter(e.target.value as "open" | "closed" | "all")} className="select-sm">
          <option value="open">オープンのみ</option>
          <option value="closed">クローズのみ</option>
          <option value="all">両方</option>
        </select>
        {activeFilterCount > 0 && (
          <button onClick={() => { onFiltersChange({}); setAssigneeFilter(""); setSearchQuery(""); }} className="btn-sm" style={{ color: "var(--accent-red)" }}>
            リセット
          </button>
        )}
        <button onClick={onRefresh} className="btn-sm">更新</button>
        <button onClick={() => setShowIssueForm(!showIssueForm)} className="btn-sm">
          {showIssueForm ? "×" : "+ イシュー作成"}
        </button>
      </div>

      {/* Issue作成フォーム */}
      {showIssueForm && (
        <div className="form-card">
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
            placeholder="本文（タスクリストは - [ ] で記述）" className="textarea-full" />
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
            {labels.map((l) => {
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
        </div>
      )}

      {/* 並び・親子でまとめる・選ぶ */}
      <div className="task-list-options">
        <select value={sortKey} className="select-sm" aria-label="並び"
          onChange={(e) => { const v = e.target.value as SortKey; setSortKey(v); store(SORT_STORE, v); }}>
          {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
            <option key={k} value={k}>並び: {SORT_LABELS[k]}</option>
          ))}
        </select>
        <label className="chk task-list-tree">
          <input type="checkbox" checked={tree}
            onChange={(e) => { setTree(e.target.checked); store(TREE_STORE, e.target.checked ? "on" : "off"); }} />
          親子でまとめる
        </label>
        <button type="button" className={`btn-sm${picking ? " task-list-picking" : ""}`}
          onClick={() => (picking ? quitPicking() : setPicking(true))}>
          ☑ 選ぶ
        </button>
        <span className="issue-count task-list-count">{filteredIssues.length} 件</span>
      </div>

      {/* Issue一覧 */}
      {rows.map(({ issue, depth }) => (
        <IssueCard key={issue.number} issue={issue}
          onClose={onClose} onReopen={onReopen}
          onPromote={onPromote} onStatusChange={onStatusChange}
          onSelect={onSelectIssue}
          depth={depth}
          picking={picking} picked={picked.has(issue.number)} onTogglePick={togglePick} />
      ))}
      {filteredIssues.length === 0 && status && (status.includes("見つかりません") || status.includes("認証エラー") || status.includes("アクセス拒否")) ? (
        <div className="error-message">
          <p className="error-message__title">⚠️ {status}</p>
          <p className="error-message__detail">設定画面でリポジトリやトークンを確認してください。</p>
        </div>
      ) : filteredIssues.length === 0 ? (
        <p className="empty-message">イシューがありません</p>
      ) : null}

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
