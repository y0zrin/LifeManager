import { useState, useCallback, useRef, useEffect } from "react";
import type { GitHubIssue, GitHubLabel, GitHubMilestone, BoardConfig, BoardColumn, GitHubUser } from "../../lib/types";
import { TicketCard } from "../common/TicketCard";

const DEFAULT_COLUMNS: BoardColumn[] = [
  { key: "状態:未整理", title: "未整理", emoji: "📥" },
  { key: "状態:未着手", title: "未着手", emoji: "📋" },
  { key: "状態:進行中", title: "進行中", emoji: "🔥" },
  { key: "状態:チェック待ち", title: "チェック待ち", emoji: "👀" },
  { key: "状態:動作確認", title: "動作確認", emoji: "🧪" },
  { key: "状態:完了承認待ち", title: "完了承認待ち", emoji: "✅" },
  { key: "状態:いつか", title: "いつか", emoji: "💭" },
];

interface KanbanViewProps {
  issues: GitHubIssue[];
  labels: GitHubLabel[];
  milestones: GitHubMilestone[];
  collaborators: GitHubUser[];
  boardConfig: BoardConfig | null;
  currentUser: string;
  onStatusChange: (n: number, status: string) => void;
  onAssignToMe: (n: number) => void;
  onSelectIssue: (n: number) => void;
  onSaveBoardConfig: (config: BoardConfig) => Promise<void>;
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

function getPriorityColor(issue: GitHubIssue): string {
  const p = issue.labels.find((l) => l.name.startsWith("優先:"));
  return p?.name === "優先:高" ? "#f85149"
    : p?.name === "優先:中" ? "#d29922"
    : p?.name === "優先:低" ? "#3fb950"
    : "transparent";
}

export function KanbanView({ issues, labels, milestones, collaborators, boardConfig, currentUser, onStatusChange, onAssignToMe, onSelectIssue, onSaveBoardConfig }: KanbanViewProps) {
  const baseColumns = boardConfig?.columns || DEFAULT_COLUMNS;
  const isMobile = useIsMobile();

  // Filters
  const [filterAssignee, setFilterAssignee] = useState("");
  const [filterPriority, setFilterPriority] = useState("");
  const [filterMilestone, setFilterMilestone] = useState("");
  const [filterField, setFilterField] = useState("");

  // Column settings modal
  const [showColumnSettings, setShowColumnSettings] = useState(false);
  const [editColumns, setEditColumns] = useState<BoardColumn[]>(baseColumns);
  const [newColKey, setNewColKey] = useState("");
  const [newColTitle, setNewColTitle] = useState("");
  const [newColEmoji, setNewColEmoji] = useState("");

  // Mouse-based D&D state (desktop only)
  const [draggingIssue, setDraggingIssue] = useState<number | null>(null);
  const [draggingStatus, setDraggingStatus] = useState<string>("");
  const [dragOverColumn, setDragOverColumn] = useState<string | null>(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const [dropTarget, setDropTarget] = useState<{ x: number; y: number } | null>(null);
  const isDraggingRef = useRef(false);
  const mouseDownRef = useRef<{ x: number; y: number; issueNumber: number; status: string } | null>(null);
  const dragOffsetRef = useRef({ x: 0, y: 0 });
  const columnRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // Mobile: selected issue for status change
  const [mobileSelectedIssue, setMobileSelectedIssue] = useState<number | null>(null);
  // Mobile: active column tab
  const [activeColumnIndex, setActiveColumnIndex] = useState(0);

  // Apply filters
  let filteredIssues = issues;
  if (filterAssignee) {
    filteredIssues = filteredIssues.filter((i) =>
      i.assignees?.some((a) => a.login === filterAssignee)
    );
  }
  if (filterPriority) {
    filteredIssues = filteredIssues.filter((i) =>
      i.labels.some((l) => l.name === filterPriority)
    );
  }
  if (filterMilestone) {
    filteredIssues = filteredIssues.filter((i) =>
      i.milestone?.title === filterMilestone
    );
  }
  if (filterField) {
    filteredIssues = filteredIssues.filter((i) =>
      i.labels.some((l) => l.name === filterField)
    );
  }

  const hasFilters = filterAssignee || filterPriority || filterMilestone || filterField;

  // Desktop: separate my desk from status columns
  const myDeskIssues = currentUser
    ? filteredIssues.filter((i) => i.assignees?.some((a) => a.login === currentUser))
    : [];

  const statusColumnData = baseColumns.map((col) => ({
    ...col,
    issues: col.key === "none"
      ? filteredIssues.filter((i) => !i.labels.some((l) => l.name.startsWith("状態:")))
      : filteredIssues.filter((i) => i.labels.some((l) => l.name === col.key)),
  }));

  // Mobile: include @me as first tab
  const mobileColumns = currentUser
    ? [{ key: "@me", title: "自分のタスク", emoji: "👤" }, ...baseColumns]
    : baseColumns;

  const mobileColumnData = mobileColumns.map((col) => ({
    ...col,
    issues: col.key === "@me"
      ? filteredIssues.filter((i) => i.assignees?.some((a) => a.login === currentUser))
      : col.key === "none"
        ? filteredIssues.filter((i) => !i.labels.some((l) => l.name.startsWith("状態:")))
        : filteredIssues.filter((i) => i.labels.some((l) => l.name === col.key)),
  }));

  // Mouse-based D&D handlers (desktop)
  const handleMouseDown = useCallback((e: React.MouseEvent, issueNumber: number, currentStatus: string) => {
    if (e.button !== 0) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    mouseDownRef.current = { x: e.clientX, y: e.clientY, issueNumber, status: currentStatus };
    dragOffsetRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }, []);

  useEffect(() => {
    function handleMouseMove(e: MouseEvent) {
      if (!mouseDownRef.current) return;
      const dx = e.clientX - mouseDownRef.current.x;
      const dy = e.clientY - mouseDownRef.current.y;
      // 5px以上動いたらドラッグ開始
      if (!isDraggingRef.current && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) {
        isDraggingRef.current = true;
        setDraggingIssue(mouseDownRef.current.issueNumber);
        setDraggingStatus(mouseDownRef.current.status);
        setMousePos({ x: e.clientX, y: e.clientY });
      }
      if (isDraggingRef.current) {
        setMousePos({ x: e.clientX, y: e.clientY });
        // マウス位置からどのカラム/トレイの上にいるか判定
        let found: string | null = null;
        columnRefs.current.forEach((el, key) => {
          const rect = el.getBoundingClientRect();
          if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
            found = key;
          }
        });
        setDragOverColumn(found);
      }
    }

    function handleMouseUp() {
      if (isDraggingRef.current && draggingIssue !== null && dragOverColumn !== null) {
        const issueNum = draggingIssue;
        const targetCol = dragOverColumn;
        const srcStatus = draggingStatus || "";

        // ドロップアニメーション: ターゲット位置を計算
        const targetEl = columnRefs.current.get(targetCol);
        if (targetEl) {
          const rect = targetEl.getBoundingClientRect();
          setDropTarget({ x: rect.left + 10, y: rect.top + 40 });

          setTimeout(() => {
            if (targetCol === "@me") {
              onAssignToMe(issueNum);
            } else {
              const targetStatus = targetCol === "none" ? "" : targetCol;
              if (srcStatus !== targetStatus) {
                onStatusChange(issueNum, targetStatus);
              }
            }
            setDropTarget(null);
            setDraggingIssue(null);
            setDragOverColumn(null);
            setDraggingStatus("");
            mouseDownRef.current = null;
            setTimeout(() => { isDraggingRef.current = false; }, 100);
          }, 300);
          return;
        }
      }
      mouseDownRef.current = null;
      setDraggingIssue(null);
      setDragOverColumn(null);
      setDraggingStatus("");
      // クリック判定用に少し遅延してフラグをリセット
      setTimeout(() => { isDraggingRef.current = false; }, 100);
    }

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [draggingIssue, draggingStatus, dragOverColumn, onStatusChange, onAssignToMe]);

  // Mobile: handle status change via action sheet
  function handleMobileStatusChange(issueNumber: number, targetColumnKey: string) {
    if (targetColumnKey === "@me") {
      onAssignToMe(issueNumber);
    } else {
      const targetStatus = targetColumnKey === "none" ? "" : targetColumnKey;
      onStatusChange(issueNumber, targetStatus);
    }
    setMobileSelectedIssue(null);
  }

  // Column settings handlers（@meカラムは自動生成なので設定対象外）
  function handleOpenColumnSettings() {
    setEditColumns([...baseColumns]);
    setShowColumnSettings(true);
  }

  function handleMoveColumn(index: number, direction: -1 | 1) {
    const newCols = [...editColumns];
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= newCols.length) return;
    [newCols[index], newCols[targetIndex]] = [newCols[targetIndex], newCols[index]];
    setEditColumns(newCols);
  }

  function handleRemoveColumn(index: number) {
    setEditColumns(editColumns.filter((_, i) => i !== index));
  }

  function handleAddColumn() {
    if (!newColKey.trim() || !newColTitle.trim()) return;
    setEditColumns([...editColumns, { key: newColKey.trim(), title: newColTitle.trim(), emoji: newColEmoji || "📋" }]);
    setNewColKey("");
    setNewColTitle("");
    setNewColEmoji("");
  }

  async function handleSaveColumns() {
    await onSaveBoardConfig({ columns: editColumns });
    setShowColumnSettings(false);
  }

  const fieldLabels = labels.filter((l) => l.name.startsWith("分野:"));
  const priorityLabels = labels.filter((l) => l.name.startsWith("優先:"));
  const statusLabels = labels.filter((l) => l.name.startsWith("状態:"));

  function getIssueStatus(issue: GitHubIssue): string {
    return issue.labels.find((l) => l.name.startsWith("状態:"))?.name || "";
  }

  // ドラッグ中のIssueオブジェクト（フロートカード用）
  const draggedIssue = draggingIssue !== null
    ? issues.find((i) => i.number === draggingIssue) || null
    : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "calc(100vh - var(--header-height))" }}>
      {/* Filter toolbar */}
      <div className="board-toolbar">
        <div className="flex-row flex-wrap" style={{ flex: 1 }}>
          <select className="select-sm" value={filterAssignee} onChange={(e) => setFilterAssignee(e.target.value)}>
            <option value="">担当者</option>
            {collaborators.map((c) => (
              <option key={c.login} value={c.login}>{c.login}</option>
            ))}
          </select>
          <select className="select-sm" value={filterPriority} onChange={(e) => setFilterPriority(e.target.value)}>
            <option value="">優先度</option>
            {priorityLabels.map((l) => (
              <option key={l.name} value={l.name}>{l.name.split(":")[1]}</option>
            ))}
          </select>
          <select className="select-sm" value={filterField} onChange={(e) => setFilterField(e.target.value)}>
            <option value="">分野</option>
            {fieldLabels.map((l) => (
              <option key={l.name} value={l.name}>{l.name.split(":")[1]}</option>
            ))}
          </select>
          <select className="select-sm" value={filterMilestone} onChange={(e) => setFilterMilestone(e.target.value)}>
            <option value="">マイルストーン</option>
            {milestones.map((m) => (
              <option key={m.number} value={m.title}>{m.title}</option>
            ))}
          </select>
          {hasFilters && (
            <button className="btn-sm" onClick={() => { setFilterAssignee(""); setFilterPriority(""); setFilterMilestone(""); setFilterField(""); }}
              style={{ color: "var(--accent-red)" }}>
              × リセット
            </button>
          )}
        </div>
        <button className="btn-sm" onClick={handleOpenColumnSettings}>
          ⚙ カラム設定
        </button>
      </div>

      {/* Column settings modal */}
      {showColumnSettings && (
        <div className="palette-overlay" onClick={() => setShowColumnSettings(false)}>
          <div className="modal-content" style={{ maxWidth: "420px" }}
            onClick={(e) => e.stopPropagation()}>
            <h3 style={{ fontSize: "var(--font-lg)", marginBottom: "var(--space-md)", color: "var(--text-primary)" }}>カラム設定</h3>

            {editColumns.map((col, index) => (
              <div key={index} className="flex-row" style={{ marginBottom: "6px", padding: "6px 8px", background: "var(--bg-primary)", borderRadius: "var(--radius-md)" }}>
                <span style={{ fontSize: "16px", width: "24px", textAlign: "center" }}>{col.emoji}</span>
                <span style={{ flex: 1, fontSize: "var(--font-md)", color: "var(--text-primary)" }}>{col.title}</span>
                <span style={{ fontSize: "var(--font-xs)", color: "var(--text-faint)" }}>{col.key}</span>
                <button className="btn-sm" onClick={() => handleMoveColumn(index, -1)} disabled={index === 0} style={{ padding: "2px 6px", fontSize: "var(--font-xs)" }}>↑</button>
                <button className="btn-sm" onClick={() => handleMoveColumn(index, 1)} disabled={index === editColumns.length - 1} style={{ padding: "2px 6px", fontSize: "var(--font-xs)" }}>↓</button>
                <button className="btn-sm" onClick={() => handleRemoveColumn(index)} style={{ padding: "2px 6px", fontSize: "var(--font-xs)", color: "var(--accent-red)" }}>×</button>
              </div>
            ))}

            {/* Add column form */}
            <div style={{ marginTop: "var(--space-md)", padding: "10px", background: "var(--bg-primary)", borderRadius: "var(--radius-md)" }}>
              <p style={{ fontSize: "var(--font-sm)", color: "var(--text-muted)", marginBottom: "6px" }}>カラムを追加</p>
              <div className="flex-row" style={{ marginBottom: "6px" }}>
                <select className="select-sm" value={newColKey} onChange={(e) => {
                  setNewColKey(e.target.value);
                  if (e.target.value && !newColTitle) {
                    const label = e.target.value === "none" ? "未分類" : e.target.value.split(":")[1] || "";
                    setNewColTitle(label);
                  }
                }} style={{ flex: 1 }}>
                  <option value="">ラベルキーを選択...</option>
                  <option value="none">未分類 (ラベルなし)</option>
                  {statusLabels.map((l) => (
                    <option key={l.name} value={l.name}>{l.name}</option>
                  ))}
                </select>
              </div>
              <div className="emoji-picker" style={{ display: "flex", flexWrap: "wrap", gap: "2px", marginBottom: "6px" }}>
                {["📋","📥","🔥","👀","🧪","✅","💭","⏳","🚀","🐛","💡","📌","🎯","⚡","🔒","📦","🏷️","🗂️","📐","🛠️"].map((em) => (
                  <button
                    key={em}
                    type="button"
                    className={`btn-sm${newColEmoji === em ? " emoji-selected" : ""}`}
                    onClick={() => setNewColEmoji(newColEmoji === em ? "" : em)}
                    style={{ padding: "2px 4px", fontSize: "16px", minWidth: "28px", minHeight: "28px", background: newColEmoji === em ? "var(--accent-blue)" : undefined }}
                  >
                    {em}
                  </button>
                ))}
              </div>
              <div className="flex-row">
                <span style={{ fontSize: "20px", width: "32px", textAlign: "center", flexShrink: 0 }}>{newColEmoji || "📋"}</span>
                <input value={newColTitle} onChange={(e) => setNewColTitle(e.target.value)} placeholder="表示名" className="input-full" style={{ flex: 1 }} />
                <button className="btn-primary" onClick={handleAddColumn} disabled={!newColKey || !newColTitle} style={{ fontSize: "var(--font-sm)" }}>追加</button>
              </div>
            </div>

            <div className="flex-row" style={{ marginTop: "var(--space-md)", justifyContent: "flex-end" }}>
              <button className="btn-sm" onClick={() => setShowColumnSettings(false)}>キャンセル</button>
              <button className="btn-primary" onClick={handleSaveColumns}>保存</button>
            </div>
          </div>
        </div>
      )}

      {/* Mobile: tab-based column view */}
      {isMobile ? (
        <>
          {/* Column tabs */}
          <div className="kanban-tabs">
            {mobileColumnData.map((col, idx) => (
              <button
                key={col.key}
                className={`kanban-tab ${idx === activeColumnIndex ? "active" : ""}`}
                onClick={() => setActiveColumnIndex(idx)}
              >
                {col.emoji} {col.title}
                <span className="kanban-tab-count">{col.issues.length}</span>
              </button>
            ))}
          </div>

          {/* Active column content */}
          <div className="kanban-mobile-body">
            {mobileColumnData[activeColumnIndex]?.issues.map((issue) => (
              <div key={issue.number} className="kanban-mobile-card">
                <div onClick={() => onSelectIssue(issue.number)}>
                  <TicketCard issue={issue} onSelect={() => {}} />
                </div>
                <div className="kanban-mobile-actions">
                  <button
                    className="btn-sm"
                    onClick={() => setMobileSelectedIssue(
                      mobileSelectedIssue === issue.number ? null : issue.number
                    )}
                    style={{ fontSize: "var(--font-xs)" }}
                  >
                    移動
                  </button>
                </div>
                {/* Status change action sheet */}
                {mobileSelectedIssue === issue.number && (
                  <div className="kanban-status-sheet">
                    {mobileColumns.filter((c) => c.key !== (getIssueStatus(issue) || "none")).map((col) => (
                      <button
                        key={col.key}
                        className="kanban-status-option"
                        onClick={() => handleMobileStatusChange(issue.number, col.key)}
                      >
                        {col.emoji} {col.title}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {mobileColumnData[activeColumnIndex]?.issues.length === 0 && (
              <p style={{ color: "var(--text-faint)", fontSize: "var(--font-sm)", textAlign: "center", padding: "20px 0" }}>
                チケットなし
              </p>
            )}
          </div>
        </>
      ) : (
        <>
          {/* Desktop: マイデスクトレイ */}
          {currentUser && (
            <div
              className={`mydesk-tray${dragOverColumn === "@me" ? " mydesk-tray-dragover" : ""}`}
              ref={(el) => { if (el) columnRefs.current.set("@me", el); }}
            >
              <div className="mydesk-header">
                <span>👤 自分のタスク</span>
                <span className="mydesk-count">{myDeskIssues.length}</span>
              </div>
              {myDeskIssues.length > 0 ? (
                <div className="mydesk-cards">
                  {myDeskIssues.map((issue) => (
                    <div
                      key={issue.number}
                      onMouseDown={(e) => handleMouseDown(e, issue.number, getIssueStatus(issue))}
                      className={draggingIssue === issue.number ? "kanban-card-dragging" : ""}
                      style={{ cursor: draggingIssue ? "grabbing" : "grab", userSelect: "none" }}
                    >
                      <div
                        className="mydesk-card"
                        onClick={() => { if (!isDraggingRef.current) onSelectIssue(issue.number); }}
                        style={{ borderLeft: `3px solid ${getPriorityColor(issue)}` }}
                      >
                        <span className="mydesk-card-number">#{issue.number}</span>
                        <span className="mydesk-card-title">{issue.title}</span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mydesk-empty">
                  {draggingIssue !== null ? "ここにドロップして引き取る" : "担当タスクなし"}
                </p>
              )}
            </div>
          )}

          {/* Desktop: D&D column board */}
          <div className="kanban" style={{ flex: 1, minHeight: 0, height: "auto" }}>
            {statusColumnData.map((col) => (
              <div
                key={col.key}
                ref={(el) => { if (el) columnRefs.current.set(col.key, el); }}
                className={`kanban-column${dragOverColumn === col.key ? " kanban-column-dragover" : ""}`}
              >
                <h3 className="kanban-header">
                  <span>{col.emoji} {col.title}</span>
                  <span style={{ color: "var(--text-faint)", fontWeight: "normal", fontSize: "var(--font-sm)", marginLeft: "6px" }}>
                    {col.issues.length}
                  </span>
                </h3>
                <div className="kanban-body">
                  {col.issues.map((issue) => (
                    <div
                      key={issue.number}
                      onMouseDown={(e) => handleMouseDown(e, issue.number, getIssueStatus(issue))}
                      className={draggingIssue === issue.number ? "kanban-card-dragging" : ""}
                      style={{ cursor: draggingIssue ? "grabbing" : "grab", userSelect: "none" }}
                    >
                      <TicketCard issue={issue} onSelect={(n) => {
                        if (!isDraggingRef.current) onSelectIssue(n);
                      }} />
                    </div>
                  ))}
                  {col.issues.length === 0 && (
                    <p style={{ color: "var(--text-faint)", fontSize: "var(--font-sm)", textAlign: "center", padding: "20px 0" }}>
                      チケットなし
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* フロートカード（ドラッグ中にマウスに追従する浮遊カード） */}
          {draggedIssue && isDraggingRef.current && (
            <div
              className={`kanban-float-card${dropTarget ? " kanban-float-dropping" : ""}`}
              style={{
                left: dropTarget ? dropTarget.x : mousePos.x - dragOffsetRef.current.x,
                top: dropTarget ? dropTarget.y : mousePos.y - dragOffsetRef.current.y,
              }}
            >
              <TicketCard issue={draggedIssue} onSelect={() => {}} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
