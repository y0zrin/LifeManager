import { useRef, useState, type CSSProperties } from "react";
import type { GitHubIssue } from "../../lib/types";
import { motionOn } from "../../lib/motion";
import { celebrateDone } from "../../lib/celebrate";
import { LabelBadge } from "./LabelBadge";
import { IssueSendState, isUnsent } from "./Sending";
import { PendingChip } from "./PendingChip";
import { ParentMark, SubIssueBadge } from "./SubIssueMarks";
import { DueChip } from "./DueChip";
import { EstimateChip } from "./EstimateChip";
import { issueRef } from "../../lib/issueRef";
import { ESTIMATE_PREFIX } from "../../lib/estimate";
import { Avatar } from "./Avatar";
import { isMobile } from "../../lib/platform";

export function IssueCard({
  issue,
  onClose,
  onReopen,
  onPromote,
  onStatusChange,
  onSelect,
  depth = 0,
  picking = false,
  picked = false,
  onTogglePick,
  selected = false,
  index = 0,
  fresh = false,
}: {
  issue: GitHubIssue;
  onClose: (n: number) => void;
  onReopen: (n: number) => void;
  onPromote: (n: number) => void;
  onStatusChange: (n: number, status: string) => void;
  onSelect?: (n: number) => void;
  /** 親子でまとめたときの深さ（子は親の下に字下げし、「↑ 親」の印は出さない） */
  depth?: number;
  /** 「☑ 選ぶ」のあいだ（押すと選ぶ・外す。操作のボタンは隠す） */
  picking?: boolean;
  picked?: boolean;
  onTogglePick?: (n: number) => void;
  /** 右の欄に詳細を出している（PC のタスク） */
  selected?: boolean;
  /** 一覧の何番目か（画面に入るとき、順に出す） */
  index?: number;
  /** 新しく入った（メモを投入したときなど）。上から入って少し光る */
  fresh?: boolean;
}) {
  // 完了を押したあと: キラキラとスタンプ（重ねの側）→ しぼんで消える → 閉じる（動きを使わないときは、すぐ閉じる）
  const [leaving, setLeaving] = useState<"none" | "stamp" | "shrink">("none");
  const cardRef = useRef<HTMLDivElement>(null);
  function finish(button: HTMLElement) {
    if (leaving !== "none") return;
    celebrateDone(`#${issue.number}`, button);
    if (!motionOn()) {
      onClose(issue.number);
      return;
    }
    setLeaving("stamp");
    window.setTimeout(() => {
      const el = cardRef.current;
      if (el) el.style.height = `${el.offsetHeight}px`;
      requestAnimationFrame(() => setLeaving("shrink"));
    }, 600);
    // 画面を移っても閉じるように、ここで呼ぶ
    window.setTimeout(() => onClose(issue.number), 950);
  }

  const isMemo = issue.labels.some((l) => l.name === "種別:メモ");
  const currentStatus = issue.labels.find((l) => l.name.startsWith("状態:"))?.name || "";
  const dateStr = new Date(issue.created_at).toLocaleDateString("ja-JP");

  const todoMatch = issue.body?.match(/- \[[ x]\]/g);
  const todoTotal = todoMatch?.length || 0;
  const todoDone = issue.body?.match(/- \[x\]/g)?.length || 0;
  // 本文の抜き出し（ガントの日程などの見えない印 <!-- … --> は出さない）
  // 本文の頭。スマホは、チェックの行（- [ ] …）を除く（下の「☑ 2/4」で数を出すので）。#208
  const excerpt = (issue.body ?? "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .filter((line) => !isMobile || !/^\s*[-*] \[[ xX]\]/.test(line))
    .join("\n")
    .trim();

  // 送っているあいだ・送れなかった仮の Issue（まだ番号がない）: 押しても開かない
  const unsent = isUnsent(issue);

  function handleCardClick(e: React.MouseEvent) {
    if (unsent) return;
    if ((e.target as HTMLElement).closest("button, select, input, [data-todo-progress]")) return;
    if (picking) onTogglePick?.(issue.number);
    else onSelect?.(issue.number);
  }

  return (
    <div ref={cardRef}
      className={`issue-card${depth > 0 ? " issue-card--child" : ""}${picked ? " issue-card--picked" : ""}${selected ? " issue-card--selected" : ""}${fresh ? " issue-card--fresh" : ""}${leaving !== "none" ? " issue-card--done" : ""}${leaving === "shrink" ? " issue-card--leaving" : ""}${issue._sending ? " issue-card--sending" : ""}${issue._failed ? " issue-card--failed" : ""}`}
      onClick={handleCardClick} data-issue={issue.number}
      style={{
        cursor: (onSelect || picking) && !unsent ? "pointer" : "default",
        marginLeft: depth > 0 ? `${Math.min(depth, 3) * 28}px` : undefined,
        // 順に出るときの番号と、並べ替えで動かすときの名前（CSS の --i・--vt-name）
        "--i": index,
        "--vt-name": `issue-${issue.number}`,
      } as CSSProperties}>
      {depth === 0 && <ParentMark issue={issue} />}
      <div className="issue-card-header">
        <div style={{ flex: 1 }}>
          {picking && (
            <input type="checkbox" className="issue-card-pick" checked={picked} disabled={unsent}
              onChange={() => onTogglePick?.(issue.number)} aria-label={`${issueRef(issue.number)} を選ぶ`} />
          )}
          <span className="issue-card-number">{issueRef(issue.number)}</span>
          {issue._pending && <PendingChip />}
          <strong>{issue.title}</strong>
          <IssueSendState issue={issue} />
          {issue.milestone && (
            <span style={{ color: "var(--text-muted)", fontSize: "var(--font-xs)", marginLeft: "8px" }}>
              📌 {issue.milestone.title}
            </span>
          )}
          <SubIssueBadge issue={issue} />
          <DueChip issue={issue} />
          <EstimateChip issue={issue} />
        </div>
        <span className="issue-card-date">{dateStr}</span>
      </div>

      {excerpt && (
        <p className="issue-card-body">
          {excerpt.length > (isMobile ? 70 : 120) ? excerpt.substring(0, isMobile ? 70 : 120) + "..." : excerpt}
        </p>
      )}

      {todoTotal > 0 && (
        <div data-todo-progress style={{ fontSize: "var(--font-xs)", color: "var(--text-muted)", margin: "4px 0" }}>
          {isMobile ? "☑" : "タスク:"} {todoDone}/{todoTotal}
          <div style={{ width: "100px", height: "4px", background: "var(--border-default)", borderRadius: "2px", display: "inline-block", marginLeft: "6px", verticalAlign: "middle" }}>
            <div style={{ width: `${(todoDone / todoTotal) * 100}%`, height: "100%", background: "var(--accent-green)", borderRadius: "2px" }} />
          </div>
        </div>
      )}

      <div className="issue-card-labels">
        {/* 見積もりは上の「📏 3」で出すので、ラベルには並べない */}
        {issue.labels.filter((l) => !l.name.startsWith(ESTIMATE_PREFIX)).map((l) => (
          <LabelBadge key={l.name} name={l.name} color={l.color} short={isMobile} />
        ))}
        {issue.assignees && issue.assignees.length > 0 && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: "2px", marginLeft: "4px" }}>
            {issue.assignees.map((a) => (
              <Avatar key={a.login} login={a.login} url={a.avatar_url} title={a.login} className="avatar-md" />
            ))}
          </span>
        )}
      </div>

      {!picking && !unsent && <div className="issue-card-actions">
        {issue.state === "open" ? (
          <button className="btn-sm" onClick={(e) => finish(e.currentTarget)} disabled={leaving !== "none"}>完了</button>
        ) : (
          <button className="btn-sm" onClick={() => onReopen(issue.number)}>再開</button>
        )}
        {isMemo && issue.state === "open" && (
          <button className="btn-sm" onClick={() => onPromote(issue.number)}>昇華</button>
        )}
        {issue.state === "open" && (
          <select
            className="btn-sm"
            value={currentStatus}
            onChange={(e) => onStatusChange(issue.number, e.target.value)}
            style={{ fontSize: "var(--font-xs)" }}
          >
            <option value="">状態変更...</option>
            <option value="状態:未整理">未整理</option>
            <option value="状態:進行中">進行中</option>
            <option value="状態:ブロック">ブロック</option>
            <option value="状態:いつか">いつか</option>
          </select>
        )}
      </div>}
    </div>
  );
}
