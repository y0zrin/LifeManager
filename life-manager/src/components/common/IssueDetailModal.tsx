import { useState, useEffect, useRef } from "react";
import type { GitHubIssue, GitHubComment, GitHubLabel, GitHubMilestone, GitHubUser, Reminder } from "../../lib/types";
import type { ProgressMode } from "../../lib/ganttTypes";
import { parseGanttDates, parseDependencies, parseProgress, serializeGanttDates, serializeDependencies, serializeProgress, stripGanttMetadata } from "../../lib/ganttParser";
import { LabelBadge } from "./LabelBadge";
import { TaskListBody } from "./TaskListBody";

interface IssueDetailModalProps {
  issue: GitHubIssue;
  onClose: () => void;
  listComments: (issueNumber: number) => Promise<GitHubComment[]>;
  createComment: (issueNumber: number, body: string) => Promise<void>;
  availableLabels: GitHubLabel[];
  milestones: GitHubMilestone[];
  collaborators: GitHubUser[];
  updateIssue: (n: number, updates: { title?: string; body?: string; labels?: string[]; assignees?: string[]; milestone?: number | null }) => Promise<void>;
  onCloseIssue: (issueNumber: number) => Promise<void>;
  onReopenIssue: (issueNumber: number) => Promise<void>;
  onToggleTodo: (issueNumber: number, newBody: string) => Promise<void>;
  reminders: Reminder[];
  onAddReminder: (issueNumber: number, title: string, datetime: string, channels: string[]) => Promise<void>;
  onRemoveReminder: (issueNumber: number, datetime: string) => Promise<void>;
  allIssues?: GitHubIssue[];
}

export function IssueDetailModal({ issue, onClose, listComments, createComment, availableLabels, milestones, collaborators, updateIssue, onCloseIssue, onReopenIssue, onToggleTodo, reminders, onAddReminder, onRemoveReminder, allIssues = [] }: IssueDetailModalProps) {
  const [comments, setComments] = useState<GitHubComment[]>([]);
  const [newComment, setNewComment] = useState("");
  const [loading, setLoading] = useState(true);

  // --- 編集状態 ---
  const [editingTitle, setEditingTitle] = useState(false);
  const [editTitle, setEditTitle] = useState(issue.title);
  const [editingBody, setEditingBody] = useState(false);
  const [editBody, setEditBody] = useState(issue.body || "");
  const [editingLabels, setEditingLabels] = useState(false);
  const [editLabels, setEditLabels] = useState<string[]>(Array.isArray(issue.labels) ? issue.labels.map((l) => l.name) : []);
  const [editingAssignees, setEditingAssignees] = useState(false);
  const [editAssignees, setEditAssignees] = useState<string[]>(Array.isArray(issue.assignees) ? issue.assignees.map((a) => a.login) : []);
  const editBodyRef = useRef<HTMLTextAreaElement>(null);
  const [showReminderForm, setShowReminderForm] = useState(false);
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
          if (i.number === issue.number) return false;
          const numMatch = depSearch.match(/^#?(\d+)$/);
          if (numMatch) return String(i.number).includes(numMatch[1]);
          return i.title.toLowerCase().includes(depSearch.toLowerCase());
        })
        .slice(0, 5)
    : [];

  useEffect(() => {
    loadComments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issue.number]);

  // issue が外部で更新された場合に編集状態をリセット
  useEffect(() => {
    setEditTitle(issue.title ?? "");
    setEditBody(issue.body || "");
    setEditLabels(Array.isArray(issue.labels) ? issue.labels.map((l) => l.name) : []);
    setEditAssignees(Array.isArray(issue.assignees) ? issue.assignees.map((a) => a.login) : []);
    const d = parseGanttDates(issue.body);
    const deps = parseDependencies(issue.body);
    const prog = parseProgress(issue.body);
    setGanttStart(d?.start || "");
    setGanttEnd(d?.end || "");
    setGanttDepsInput(deps.map((n) => `#${n}`).join(","));
    setGanttProgressMode(prog.mode);
    setGanttProgressValue(String(prog.value));
  }, [issue]);

  async function loadComments() {
    setLoading(true);
    try {
      const result = await listComments(issue.number);
      setComments(Array.isArray(result) ? result : []);
    } catch (e) {
      console.error(e);
      setComments([]);
    }
    setLoading(false);
  }

  async function handleSubmit() {
    if (!newComment.trim()) return;
    await createComment(issue.number, newComment);
    setNewComment("");
    await loadComments();
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
    if (editBody === (issue.body || "")) {
      setEditingBody(false);
      return;
    }
    await updateIssue(issue.number, { body: editBody });
    setEditingBody(false);
  }

  // --- ラベル保存 ---
  async function handleLabelsSave() {
    await updateIssue(issue.number, { labels: editLabels });
    setEditingLabels(false);
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
    setEditingAssignees(false);
  }

  // ESCキーで閉じる
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const todoMatch = issue.body?.match(/- \[[ x]\]/g);
  const todoTotal = todoMatch?.length || 0;
  const todoDone = issue.body?.match(/- \[x\]/g)?.length || 0;

  return (
    <div className="palette-overlay" onClick={onClose}>
      <button onClick={onClose} className="modal-close-btn" title="閉じる (Esc)">×</button>
      <div onClick={(e) => e.stopPropagation()} className="modal-content">
        {/* ヘッダー */}
        <div style={{ marginBottom: "12px" }}>
          <div style={{ flex: 1 }}>
            <div className="flex-row flex-wrap" style={{ marginBottom: "4px" }}>
              <span style={{ color: "var(--text-faint)", fontSize: "var(--font-lg)" }}>#{issue.number}</span>
              <span style={{ color: "var(--text-faint)", fontSize: "var(--font-sm)" }}>
                {issue.state === "open" ? "🟢 Open" : "🟣 Closed"}
              </span>
              {issue.milestone && (
                <span style={{ color: "var(--text-muted)", fontSize: "var(--font-sm)" }}>
                  📌 {issue.milestone.title}
                </span>
              )}
              <button
                className={issue.state === "open" ? "btn-sm" : "btn-primary"}
                style={{ marginLeft: "auto", fontSize: "var(--font-sm)", padding: "3px 10px" }}
                onClick={async () => {
                  if (issue.state === "open") {
                    await onCloseIssue(issue.number);
                  } else {
                    await onReopenIssue(issue.number);
                  }
                }}
              >
                {issue.state === "open" ? "クローズ" : "リオープン"}
              </button>
            </div>

            {/* タイトル（クリックで編集） */}
            {editingTitle ? (
              <input
                autoFocus
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleTitleSave(); if (e.key === "Escape") { setEditTitle(issue.title); setEditingTitle(false); } }}
                onBlur={handleTitleSave}
                style={{
                  display: "block",
                  width: "100%",
                  margin: "4px 0 8px",
                  fontSize: "18px",
                  fontWeight: 600,
                  color: "#e6edf3",
                  background: "#161b22",
                  border: "1px solid #58a6ff",
                  borderRadius: "4px",
                  padding: "4px 8px",
                  outline: "none",
                }}
              />
            ) : (
              <h2
                onClick={() => setEditingTitle(true)}
                style={{
                  margin: "4px 0 8px",
                  fontSize: "18px",
                  color: "#e6edf3",
                  cursor: "pointer",
                  borderBottom: "1px dashed transparent",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.borderBottomColor = "#30363d")}
                onMouseLeave={(e) => (e.currentTarget.style.borderBottomColor = "transparent")}
                title="クリックして編集"
              >
                {issue.title}
              </h2>
            )}

            {/* ラベル表示 / 編集 */}
            {editingLabels ? (
              <div>
                <div className="label-selector" style={{ marginBottom: "8px" }}>
                  {availableLabels.map((l) => {
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
                <div style={{ display: "flex", gap: "6px" }}>
                  <button className="btn-primary" onClick={handleLabelsSave} style={{ fontSize: "12px", padding: "3px 10px" }}>
                    保存
                  </button>
                  <button className="btn-sm" onClick={() => { setEditLabels(Array.isArray(issue.labels) ? issue.labels.map((l) => l.name) : []); setEditingLabels(false); }} style={{ fontSize: "12px" }}>
                    キャンセル
                  </button>
                </div>
              </div>
            ) : (
              <div
                style={{ display: "flex", flexWrap: "wrap", gap: "4px", cursor: "pointer" }}
                onClick={() => setEditingLabels(true)}
                title="クリックしてラベルを編集"
              >
                {(issue.labels ?? []).map((l) => (
                  <LabelBadge key={l.name} name={l.name} color={l.color} />
                ))}
                {(!issue.labels || issue.labels.length === 0) && (
                  <span style={{ color: "#484f58", fontSize: "12px" }}>ラベルなし（クリックで追加）</span>
                )}
              </div>
            )}

            {/* 担当者（アサイン） */}
            {editingAssignees ? (
              <div style={{ marginTop: "10px", padding: "10px", background: "var(--bg-secondary)", borderRadius: "var(--radius-lg)", border: "1px solid var(--border-default)" }}>
                <span style={{ fontSize: "var(--font-sm)", color: "var(--accent-blue)", marginBottom: "6px", display: "block", fontWeight: 600 }}>👥 担当者を選択</span>
                <div className="label-selector" style={{ gap: "6px", marginBottom: "10px" }}>
                  {collaborators.map((c) => {
                    const active = editAssignees.includes(c.login);
                    return (
                      <span
                        key={c.login}
                        onClick={() => toggleAssignee(c.login)}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "6px",
                          padding: "4px 10px",
                          borderRadius: "16px",
                          fontSize: "var(--font-sm)",
                          fontWeight: 600,
                          cursor: "pointer",
                          color: active ? "#fff" : "var(--text-muted)",
                          backgroundColor: active ? "#1f6feb" : "var(--bg-primary)",
                          border: active ? "2px solid var(--accent-blue)" : "2px solid var(--border-default)",
                          transition: "all 0.15s",
                        }}
                      >
                        <img src={c.avatar_url} alt={c.login} className="avatar-md" style={{ border: active ? "1px solid #fff" : "1px solid var(--border-default)" }} />
                        {c.login}
                      </span>
                    );
                  })}
                </div>
                <div style={{ display: "flex", gap: "6px" }}>
                  <button className="btn-primary" onClick={handleAssigneesSave} style={{ fontSize: "12px", padding: "3px 10px" }}>
                    保存
                  </button>
                  <button className="btn-sm" onClick={() => { setEditAssignees(issue.assignees?.map((a) => a.login) || []); setEditingAssignees(false); }} style={{ fontSize: "12px" }}>
                    キャンセル
                  </button>
                </div>
              </div>
            ) : (
              <div
                style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "10px", cursor: "pointer", alignItems: "center", padding: "6px 8px", borderRadius: "6px", border: "1px solid #21262d", background: "#161b2288" }}
                onClick={() => setEditingAssignees(true)}
                title="クリックして担当者を編集"
                onMouseEnter={(e) => (e.currentTarget.style.borderColor = "#30363d")}
                onMouseLeave={(e) => (e.currentTarget.style.borderColor = "#21262d")}
              >
                <span style={{ fontSize: "12px", color: "#8b949e", marginRight: "2px" }}>👥</span>
                {issue.assignees && issue.assignees.length > 0 ? (
                  issue.assignees.map((a) => (
                    <span key={a.login} style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "12px", color: "#e6edf3", padding: "2px 8px", background: "#1f6feb33", borderRadius: "12px", border: "1px solid #1f6feb55" }}>
                      <img src={a.avatar_url} alt={a.login} style={{ width: "18px", height: "18px", borderRadius: "50%", border: "1px solid #58a6ff" }} />
                      {a.login}
                    </span>
                  ))
                ) : (
                  <span style={{ color: "#484f58", fontSize: "12px" }}>未設定（クリックで追加）</span>
                )}
              </div>
            )}
          </div>

            {/* マイルストーン */}
            <div
              style={{ display: "flex", alignItems: "center", gap: "6px", marginTop: "10px", padding: "6px 8px", borderRadius: "6px", border: "1px solid #21262d", background: "#161b2288" }}
              onMouseEnter={(e) => (e.currentTarget.style.borderColor = "#30363d")}
              onMouseLeave={(e) => (e.currentTarget.style.borderColor = "#21262d")}
            >
              <span style={{ fontSize: "12px", color: "#8b949e" }}>🎯</span>
              <select
                value={issue.milestone?.number ?? ""}
                onChange={async (e) => {
                  const val = e.target.value;
                  await updateIssue(issue.number, { milestone: val ? Number(val) : null });
                }}
                style={{
                  flex: 1,
                  background: "transparent",
                  color: "var(--text-primary)",
                  border: "none",
                  fontSize: "12px",
                  cursor: "pointer",
                  outline: "none",
                }}
              >
                <option value="" style={{ background: "var(--bg-secondary)" }}>マイルストーンなし</option>
                {milestones.map((m) => (
                  <option key={m.number} value={m.number} style={{ background: "var(--bg-secondary)" }}>
                    {m.title}
                  </option>
                ))}
              </select>
            </div>
        </div>

        {/* 本文（クリックで編集） */}
        {editingBody ? (
          <div style={{ marginBottom: "16px" }}>
            <textarea
              ref={editBodyRef}
              autoFocus
              value={editBody}
              onChange={(e) => setEditBody(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") { setEditBody(issue.body || ""); setEditingBody(false); } }}
              style={{
                width: "100%",
                minHeight: "120px",
                padding: "12px",
                background: "#161b22",
                borderRadius: "6px",
                fontSize: "13px",
                color: "#c9d1d9",
                border: "1px solid #58a6ff",
                lineHeight: 1.6,
                resize: "vertical",
                outline: "none",
                fontFamily: "inherit",
              }}
            />
            <div style={{ display: "flex", gap: "6px", marginTop: "6px", alignItems: "center" }}>
              <button className="btn-primary" onClick={handleBodySave} style={{ fontSize: "12px", padding: "3px 10px" }}>
                保存
              </button>
              <button className="btn-sm" onClick={() => { setEditBody(issue.body || ""); setEditingBody(false); }} style={{ fontSize: "12px" }}>
                キャンセル
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
                }}>+ タスク項目</button>
            </div>
          </div>
        ) : issue.body && todoTotal > 0 ? (
          /* タスクリストがある場合はTaskListBodyでレンダリング */
          <div style={{ position: "relative" }}>
            <TaskListBody
              body={issue.body}
              issueNumber={issue.number}
              onToggle={onToggleTodo}
            />
            {/* 編集ボタン（右上に小さく配置） */}
            <button
              className="btn-sm"
              onClick={() => setEditingBody(true)}
              title="本文を編集"
              style={{
                position: "absolute",
                top: "4px",
                right: "4px",
                fontSize: "11px",
                padding: "2px 6px",
                opacity: 0.6,
              }}
              onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
              onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.6")}
            >
              ✏️
            </button>
          </div>
        ) : (
          <div
            onClick={() => setEditingBody(true)}
            style={{
              padding: "12px",
              background: "#161b22",
              borderRadius: "6px",
              marginBottom: "16px",
              whiteSpace: "pre-wrap",
              fontSize: "13px",
              color: "#c9d1d9",
              border: "1px solid #30363d",
              lineHeight: 1.6,
              cursor: "pointer",
              minHeight: "40px",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.borderColor = "#30363d")}
            onMouseLeave={(e) => (e.currentTarget.style.borderColor = "#30363d")}
            title="クリックして編集"
          >
            {issue.body || <span style={{ color: "#484f58" }}>本文なし（クリックで追加）</span>}
          </div>
        )}

        {/* タスク進捗 */}
        {todoTotal > 0 && (
          <div style={{ fontSize: "12px", color: "#888", marginBottom: "16px" }}>
            タスク進捗: {todoDone}/{todoTotal}
            <div style={{ width: "100%", height: "6px", background: "#21262d", borderRadius: "3px", marginTop: "4px" }}>
              <div style={{ width: `${(todoDone / todoTotal) * 100}%`, height: "100%", background: "#238636", borderRadius: "3px" }} />
            </div>
          </div>
        )}

        {/* ガントチャート設定 */}
        <div style={{ marginBottom: "12px", borderTop: "1px solid var(--border-default)", paddingTop: "12px" }}>
          <span style={{ fontSize: "var(--font-md)", color: "var(--text-muted)", display: "block", marginBottom: "6px" }}>ガントチャート</span>

          <div style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap", marginBottom: "6px" }}>
            <label style={{ fontSize: "11px", color: "var(--text-muted)" }}>開始:</label>
            <input type="date" value={ganttStart} onChange={(e) => setGanttStart(e.target.value)}
              style={{ background: "var(--bg-secondary)", color: "var(--text-primary)", border: "1px solid var(--border-default)", borderRadius: "4px", padding: "3px 6px", fontSize: "12px" }} />
            <label style={{ fontSize: "11px", color: "var(--text-muted)" }}>終了:</label>
            <input type="date" value={ganttEnd} onChange={(e) => setGanttEnd(e.target.value)}
              style={{ background: "var(--bg-secondary)", color: "var(--text-primary)", border: "1px solid var(--border-default)", borderRadius: "4px", padding: "3px 6px", fontSize: "12px" }} />
          </div>

          <div style={{ marginBottom: "6px" }}>
            <label style={{ fontSize: "11px", color: "var(--text-muted)", display: "block", marginBottom: "4px" }}>先行:</label>
            <div style={{ display: "flex", gap: "4px", alignItems: "center", flexWrap: "wrap", marginBottom: "4px" }}>
              {ganttDepsInput.split(",").filter(Boolean).map((s) => {
                const num = parseInt(s.replace("#", "").trim(), 10);
                if (isNaN(num)) return null;
                const depIssue = allIssues.find((i) => i.number === num);
                return (
                  <span key={num} style={{
                    display: "inline-flex", alignItems: "center", gap: "3px",
                    padding: "1px 6px", borderRadius: "10px", fontSize: "11px",
                    backgroundColor: "var(--bg-tertiary)", color: "var(--text-secondary)",
                  }}>
                    #{num}{depIssue ? ` ${depIssue.title.substring(0, 15)}` : ""}
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
                placeholder="Issue検索して追加..."
                style={{ background: "var(--bg-secondary)", color: "var(--text-primary)", border: "1px solid var(--border-default)", borderRadius: "4px", padding: "3px 6px", fontSize: "12px", width: "200px" }} />
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
                      <span className="suggestion-number">#{s.number}</span>
                      <span className="suggestion-title">{s.title}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap", marginBottom: "6px" }}>
            <label style={{ fontSize: "11px", color: "var(--text-muted)" }}>進捗:</label>
            <select value={ganttProgressMode} onChange={(e) => {
              const mode = e.target.value as ProgressMode;
              setGanttProgressMode(mode);
              if (mode === "binary") setGanttProgressValue("undone");
              else if (mode === "manual") setGanttProgressValue("0");
              else setGanttProgressValue("0");
            }} style={{ background: "var(--bg-secondary)", color: "var(--text-primary)", border: "1px solid var(--border-default)", borderRadius: "4px", padding: "3px 6px", fontSize: "12px" }}>
              <option value="checkbox">チェックボックス</option>
              <option value="manual">任意の値</option>
              <option value="binary">達成可否</option>
            </select>
            {ganttProgressMode === "manual" && (
              <input value={ganttProgressValue} onChange={(e) => setGanttProgressValue(e.target.value)}
                placeholder="0-100" style={{ background: "var(--bg-secondary)", color: "var(--text-primary)", border: "1px solid var(--border-default)", borderRadius: "4px", padding: "3px 6px", fontSize: "12px", width: "60px" }} />
            )}
            {ganttProgressMode === "manual" && <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>%</span>}
            {ganttProgressMode === "binary" && (
              <button className={`btn-sm ${ganttProgressValue === "done" ? "active" : ""}`}
                style={{ fontSize: "11px", backgroundColor: ganttProgressValue === "done" ? "var(--accent-green)" : undefined, color: ganttProgressValue === "done" ? "#fff" : undefined }}
                onClick={() => setGanttProgressValue(ganttProgressValue === "done" ? "undone" : "done")}
              >
                {ganttProgressValue === "done" ? "完了" : "未完了"}
              </button>
            )}
          </div>

          <button className="btn-primary" style={{ fontSize: "11px", padding: "3px 8px" }}
            disabled={ganttSaving}
            onClick={async () => {
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
              } finally {
                setGanttSaving(false);
              }
            }}>
            {ganttSaving ? "保存中..." : "ガント設定を保存"}
          </button>
        </div>

        {/* リマインダー */}
        <div style={{ marginBottom: "12px", borderTop: "1px solid var(--border-default)", paddingTop: "12px" }}>
          <div className="flex-row" style={{ marginBottom: "6px" }}>
            <span style={{ fontSize: "var(--font-md)", color: "var(--text-muted)" }}>リマインダー</span>
            <button className="btn-sm" style={{ fontSize: "11px" }}
              onClick={() => {
                if (!showReminderForm) {
                  // デフォルトを1時間後に設定
                  const d = new Date(Date.now() + 3600000);
                  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
                  setReminderDatetime(local.toISOString().slice(0, 16));
                }
                setShowReminderForm(!showReminderForm);
              }}>
              {showReminderForm ? "×" : "+ 設定"}
            </button>
          </div>

          {showReminderForm && (
            <div style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap", marginBottom: "6px" }}>
              <input type="datetime-local" value={reminderDatetime}
                onChange={(e) => setReminderDatetime(e.target.value)}
                style={{ background: "var(--bg-secondary)", color: "var(--text-primary)", border: "1px solid var(--border-default)", borderRadius: "4px", padding: "3px 6px", fontSize: "12px" }} />
              <label style={{ fontSize: "11px", display: "flex", alignItems: "center", gap: "2px", color: "var(--text-muted)" }}>
                <input type="checkbox" checked={reminderChannels.includes("os")}
                  onChange={(e) => {
                    if (e.target.checked) setReminderChannels([...reminderChannels, "os"]);
                    else setReminderChannels(reminderChannels.filter((c) => c !== "os"));
                  }} />
                OS
              </label>
              <label style={{ fontSize: "11px", display: "flex", alignItems: "center", gap: "2px", color: "var(--text-muted)" }}>
                <input type="checkbox" checked={reminderChannels.includes("discord")}
                  onChange={(e) => {
                    if (e.target.checked) setReminderChannels([...reminderChannels, "discord"]);
                    else setReminderChannels(reminderChannels.filter((c) => c !== "discord"));
                  }} />
                Discord
              </label>
              <button className="btn-primary" style={{ fontSize: "11px", padding: "3px 8px" }}
                disabled={!reminderDatetime || reminderChannels.length === 0}
                onClick={async () => {
                  await onAddReminder(issue.number, issue.title, reminderDatetime, reminderChannels);
                  setShowReminderForm(false);
                }}>
                設定
              </button>
            </div>
          )}

          {issueReminders.map((r) => (
            <div key={r.datetime} style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "#888", marginBottom: "4px" }}>
              <span>{new Date(r.datetime).toLocaleString("ja-JP")}</span>
              <span style={{ color: "#666" }}>[{r.channels.join(", ")}]</span>
              <button className="btn-sm" style={{ fontSize: "10px", color: "#f85149", padding: "1px 4px" }}
                onClick={() => onRemoveReminder(issue.number, r.datetime)}>
                取消
              </button>
            </div>
          ))}
        </div>

        {/* コメント */}
        <h3 className="section-header">
          💬 コメント ({comments.length})
        </h3>

        {loading ? (
          <p style={{ color: "#666", fontSize: "12px" }}>読み込み中...</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginBottom: "12px" }}>
            {comments.map((c) => (
              <div key={c.id} style={{ padding: "10px", background: "#161b22", borderRadius: "6px", border: "1px solid #30363d" }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                  <span style={{ fontSize: "12px", fontWeight: 600, color: "#58a6ff" }}>
                    {c.user?.login ?? "unknown"}
                  </span>
                  <span style={{ fontSize: "11px", color: "#666" }}>
                    {new Date(c.created_at).toLocaleString("ja-JP")}
                  </span>
                </div>
                <div style={{ fontSize: "13px", color: "#c9d1d9", whiteSpace: "pre-wrap", lineHeight: 1.5 }}>
                  {c.body}
                </div>
              </div>
            ))}
            {comments.length === 0 && (
              <p style={{ color: "#484f58", fontSize: "12px" }}>コメントはまだありません</p>
            )}
          </div>
        )}

        {/* コメント入力 */}
        <textarea
          value={newComment}
          onChange={(e) => setNewComment(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) handleSubmit(); }}
          placeholder="コメントを追加... (Ctrl+Enter で送信)"
          className="textarea-full"
          style={{ minHeight: "60px" }}
        />
        <button onClick={handleSubmit} className="btn-primary" disabled={!newComment.trim()}
          style={{ marginTop: "6px" }}>
          コメント追加
        </button>
      </div>
    </div>
  );
}
