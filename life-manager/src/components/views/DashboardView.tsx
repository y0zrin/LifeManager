import { useState, useRef, useEffect, useMemo } from "react";
import type { GitHubIssue, GitHubLabel, GitHubMilestone, GitHubUser } from "../../lib/types";
import { IssueCard } from "../common/IssueCard";

interface DashboardViewProps {
  issues: GitHubIssue[];
  closedIssues: GitHubIssue[];
  labels: GitHubLabel[];
  milestones: GitHubMilestone[];
  collaborators: GitHubUser[];
  currentUser: string;
  filters: Record<string, string>;
  onFiltersChange: (filters: Record<string, string>) => void;
  onClose: (n: number) => void;
  onReopen: (n: number) => void;
  onPromote: (n: number) => void;
  onStatusChange: (n: number, status: string) => void;
  onCreateIssue: (title: string, body: string, labels: string[], milestone: number | null, assignees?: string[]) => Promise<number>;
  onCreateMemo: (text: string, theme: string) => Promise<void>;
  onRefresh: () => Promise<void>;
  onSelectIssue: (n: number) => void;
  onAddReminder: (issueNumber: number, title: string, datetime: string, channels: string[]) => Promise<void>;
  status?: string;
}

export function DashboardView({
  issues, closedIssues, labels, milestones, collaborators, currentUser, filters, onFiltersChange,
  onClose, onReopen, onPromote, onStatusChange,
  onCreateIssue, onCreateMemo, onRefresh, onSelectIssue, onAddReminder, status,
}: DashboardViewProps) {
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
    const body = issueBody;
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
    // ラベルフィルタ
    return Object.values(filters).every(
      (f) => !f || issue.labels.some((l) => l.name === f)
    );
  });

  const activeFilterCount = Object.values(filters).filter(Boolean).length + (assigneeFilter ? 1 : 0) + (searchQuery ? 1 : 0);

  return (
    <div className="content">
      {/* メモ投入 */}
      <div className="memo-bar">
        <input
          value={memoText}
          onChange={(e) => setMemoText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleMemoSubmit(); }}
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
            <select
              key={cat}
              value={filters[cat] || ""}
              onChange={(e) =>
                onFiltersChange({ ...filters, [cat]: e.target.value })
              }
              className="select-sm"
            >
              <option value="">{categoryLabels[cat]}: 全て</option>
              {catLabels.map((l) => (
                <option key={l.name} value={l.name}>
                  {l.name.replace(cat, "")}
                </option>
              ))}
            </select>
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
                    <span className="suggestion-number">#{s.number}</span>
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

      {/* Issue一覧 */}
      <div className="issue-count">{filteredIssues.length} 件</div>
      {filteredIssues.map((issue) => (
        <IssueCard key={issue.number} issue={issue}
          onClose={onClose} onReopen={onReopen}
          onPromote={onPromote} onStatusChange={onStatusChange}
          onSelect={onSelectIssue} />
      ))}
      {filteredIssues.length === 0 && status && (status.includes("見つかりません") || status.includes("認証エラー") || status.includes("アクセス拒否")) ? (
        <div className="error-message">
          <p className="error-message__title">⚠️ {status}</p>
          <p className="error-message__detail">設定画面でリポジトリやトークンを確認してください。</p>
        </div>
      ) : filteredIssues.length === 0 ? (
        <p className="empty-message">イシューがありません</p>
      ) : null}
    </div>
  );
}
