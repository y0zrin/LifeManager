import { useState, useRef } from "react";
import type { GitHubIssue, GitHubLabel, GitHubMilestone, GitHubUser } from "../../lib/types";
import { IssueCard } from "../common/IssueCard";

interface DashboardViewProps {
  issues: GitHubIssue[];
  labels: GitHubLabel[];
  milestones: GitHubMilestone[];
  collaborators: GitHubUser[];
  filters: Record<string, string>;
  onFiltersChange: (filters: Record<string, string>) => void;
  onClose: (n: number) => void;
  onReopen: (n: number) => void;
  onPromote: (n: number) => void;
  onStatusChange: (n: number, status: string) => void;
  onCreateIssue: (title: string, body: string, labels: string[], milestone: number | null, assignees?: string[]) => Promise<void>;
  onCreateMemo: (text: string, theme: string) => Promise<void>;
  onRefresh: () => Promise<void>;
  onSelectIssue: (n: number) => void;
  status?: string;
}

export function DashboardView({
  issues, labels, milestones, collaborators, filters, onFiltersChange,
  onClose, onReopen, onPromote, onStatusChange,
  onCreateIssue, onCreateMemo, onRefresh, onSelectIssue, status,
}: DashboardViewProps) {
  const [memoText, setMemoText] = useState("");
  const [memoTheme, setMemoTheme] = useState("分野:私用");
  const [showIssueForm, setShowIssueForm] = useState(false);
  const [issueTitle, setIssueTitle] = useState("");
  const [issueBody, setIssueBody] = useState("");
  const [issueSelectedLabels, setIssueSelectedLabels] = useState<string[]>(["種別:イシュー", "状態:未整理"]);
  const [issueMilestone, setIssueMilestone] = useState<number | undefined>(undefined);
  const [issueAssignees, setIssueAssignees] = useState<string[]>([]);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  async function handleMemoSubmit() {
    if (!memoText.trim()) return;
    await onCreateMemo(memoText, memoTheme);
    setMemoText("");
  }

  async function handleIssueCreate() {
    if (!issueTitle.trim()) return;
    await onCreateIssue(issueTitle, issueBody, [...issueSelectedLabels], issueMilestone || null, issueAssignees.length > 0 ? issueAssignees : undefined);
    setIssueTitle("");
    setIssueBody("");
    setIssueAssignees([]);
    setShowIssueForm(false);
  }

  const categories = ["種別:", "分野:", "状態:", "優先:"] as const;
  const categoryLabels: Record<string, string> = {
    "種別:": "種別", "分野:": "分野", "状態:": "状態", "優先:": "優先",
  };

  const filteredIssues = issues.filter((issue) =>
    Object.values(filters).every(
      (f) => !f || issue.labels.some((l) => l.name === f)
    )
  );

  const activeFilterCount = Object.values(filters).filter(Boolean).length;

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
        {activeFilterCount > 0 && (
          <button onClick={() => onFiltersChange({})} className="btn-sm" style={{ color: "var(--accent-red)" }}>
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
          <input value={issueTitle} onChange={(e) => setIssueTitle(e.target.value)}
            placeholder="タイトル" className="input-full" />
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
