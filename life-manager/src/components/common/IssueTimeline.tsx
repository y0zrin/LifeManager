import { useContext, useEffect, useState, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { GitHubComment, GitHubIssue, TimelineEvent, TimelineResult } from "../../lib/types";
import { issueRef } from "../../lib/issueRef";
import { isSameRepo } from "../../lib/subIssues";
import { LabelBadge } from "./LabelBadge";
import { PendingChip } from "./PendingChip";
import { IssueIndexContext } from "./SubIssueMarks";
import { closeReasonText } from "./CloseMenu";
import { isHelp, isHelpDone, parseHelp } from "../../lib/help";
import { shortWhen } from "../../lib/history";
import { HelpContextBox } from "../notices/HelpParts";
import { FailedChip, SendingChip } from "./Sending";
import { tr, trx } from "../../lib/i18n";

interface IssueTimelineProps {
  issue: GitHubIssue;
  /** コメント（つながらないときも、最後に読んだものと送信待ちが出る） */
  comments: GitHubComment[];
  loadingComments: boolean;
  listTimeline: (n: number) => Promise<TimelineResult>;
  onOpenIssue: (n: number) => void;
  /** コミットの「変更内容を見る」を開く */
  onShowCommit?: (hash: string, actor: string, date: string) => void;
  /** 並び（新しい順・古い順） */
  order: HistoryOrder;
  onOrderChange: (order: HistoryOrder) => void;
  /** コメントを書く欄。新しい順なら一覧の上、古い順なら一覧の下に出す */
  composer?: ReactNode;
  /** 🆘 のコメントの「返事を書く」「解決した」 */
  onReplyHelp?: (c: GitHubComment) => void;
  onResolveHelp?: (c: GitHubComment) => Promise<void>;
  /** 送れなかったコメントの「もう一度」「書く欄に戻す」 */
  onRetryComment?: (c: GitHubComment) => void;
  onRestoreComment?: (c: GitHubComment) => void;
}

/** コメントと変更の履歴の並び。はじめは新しい順 */
export type HistoryOrder = "newest" | "oldest";

const ORDER_KEY = "issue-history-order";

/** 履歴の並び（この PC に覚える） */
export function useHistoryOrder(): [HistoryOrder, (order: HistoryOrder) => void] {
  const [order, setOrder] = useState<HistoryOrder>(() => {
    try {
      return localStorage.getItem(ORDER_KEY) === "oldest" ? "oldest" : "newest";
    } catch {
      return "newest";
    }
  });
  function change(next: HistoryOrder) {
    setOrder(next);
    try {
      localStorage.setItem(ORDER_KEY, next);
    } catch {
      // 覚えられなくても、今は並べ替える
    }
  }
  return [order, change];
}

/** 並びの切り替え（見出しの右） */
export function HistoryOrderToggle({ order, onChange }: { order: HistoryOrder; onChange: (order: HistoryOrder) => void }) {
  return (
    <span className="issue-timeline-filter" role="group" aria-label={tr("並び")}>
      <button type="button" className={order === "newest" ? "on" : ""} aria-pressed={order === "newest"} onClick={() => onChange("newest")}>
        {tr("新しい順")}
      </button>
      <button type="button" className={order === "oldest" ? "on" : ""} aria-pressed={order === "oldest"} onClick={() => onChange("oldest")}>
        {tr("古い順")}
      </button>
    </span>
  );
}

/** 並べる 1 件（コメント・出来事・続けて付け外ししたラベルのまとまり） */
type Item =
  | { kind: "created"; at: string; actor: string }
  | { kind: "comment"; at: string; comment: GitHubComment }
  | { kind: "event"; at: string; event: TimelineEvent }
  | { kind: "labels"; at: string; actor: string; added: TimelineEvent[]; removed: TimelineEvent[] };

/** 出さない出来事（通知の購読など、画面に出しても役に立たないもの） */
const HIDDEN = new Set(["commented", "mentioned", "subscribed", "unsubscribed", "comment_deleted", "added_to_project", "moved_columns_in_project", "removed_from_project"]);

/** ラベルの付け外しを、同じ人が 2 分以内に続けてしたら 1 行にまとめる（状態の付け替えなど） */
const LABEL_GROUP_MS = 2 * 60 * 1000;

function when(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function buildItems(issue: GitHubIssue, comments: GitHubComment[], events: TimelineEvent[]): Item[] {
  const items: Item[] = [{ kind: "created", at: issue.created_at, actor: issue.user?.login ?? "" }];
  for (const c of comments) items.push({ kind: "comment", at: c.created_at, comment: c });
  const shown = events.filter((e) => e.created_at && !HIDDEN.has(e.event)).sort((a, b) => a.created_at!.localeCompare(b.created_at!));
  for (const e of shown) {
    if (e.event === "labeled" || e.event === "unlabeled") {
      const last = items[items.length - 1];
      const actor = e.actor?.login ?? "";
      if (last?.kind === "labels" && last.actor === actor && Date.parse(e.created_at!) - Date.parse(last.at) <= LABEL_GROUP_MS) {
        (e.event === "labeled" ? last.added : last.removed).push(e);
        continue;
      }
      items.push({ kind: "labels", at: e.created_at!, actor, added: e.event === "labeled" ? [e] : [], removed: e.event === "unlabeled" ? [e] : [] });
      continue;
    }
    items.push({ kind: "event", at: e.created_at!, event: e });
  }
  // 作った日時・コメント・出来事を、時間の順に
  return items.sort((a, b) => a.at.localeCompare(b.at));
}

/** 詳細の「💬 コメントと変更の履歴」。コメントのあいだに、ラベル・担当・閉じた・ほかの Issue やコミットから触れられた などを時間の順に出す */
export function IssueTimeline({ issue, comments, loadingComments, listTimeline, onOpenIssue, onShowCommit, order, onOrderChange, composer, onReplyHelp, onResolveHelp, onRetryComment, onRestoreComment }: IssueTimelineProps) {
  const index = useContext(IssueIndexContext);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  // つながらないときに出した、前に読んだ変更の履歴の読んだ時刻（#274）
  const [cachedAt, setCachedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "comments">("all");
  // 「✅ 解決した」を送っている 🆘 のコメント
  const [resolving, setResolving] = useState<number | null>(null);
  // 🆘 は、あとに「解決しました」のコメントがあれば解決済み
  const lastDone = comments.filter((c) => !c._sending && !c._failed && isHelpDone(c.body)).reduce((at, c) => (c.created_at > at ? c.created_at : at), "");

  // Issue が変わったら（閉じた・ラベルを変えた など）読み直す。まだ送っていない Issue には履歴がない
  useEffect(() => {
    if (issue.number <= 0) return;
    let alive = true;
    listTimeline(issue.number)
      .then((result) => {
        if (!alive) return;
        setEvents(result.events);
        setCachedAt(result.cachedAt);
        setError(null);
      })
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issue.number, issue.updated_at, issue.state]);

  // 時間の順にまとめてから、新しい順なら逆にする
  const chrono = buildItems(issue, comments, events).filter((i) => filter === "all" || i.kind === "comment");
  const items = order === "newest" ? [...chrono].reverse() : chrono;

  // ほかの Issue（同じリポジトリなら詳細を開く、ほかは GitHub で開く）
  const issueLink = (ref: { number: number; title: string; html_url?: string; repository_url?: string; pull_request?: unknown }) => {
    const repo = ref.repository_url?.match(/\/repos\/([^/]+)\/([^/]+)$/);
    const same = !repo || isSameRepo({ owner: repo[1], repo: repo[2] }, index.owner, index.repo);
    const label = `${ref.pull_request ? tr("プルリクエスト ") : ""}${same ? issueRef(ref.number) : `${repo![2]}#${ref.number}`} ${ref.title}`;
    return (
      <button type="button" className="timeline-link" onClick={() => (same && !ref.pull_request ? onOpenIssue(ref.number) : ref.html_url && openUrl(ref.html_url))}>
        {label}
      </button>
    );
  };

  const commitLink = (e: TimelineEvent) => (
    <button type="button" className="timeline-link timeline-commit" title={tr("変更内容を見る")}
      onClick={() => onShowCommit?.(e.commit_id!, e.actor?.login ?? "", e.created_at ?? "")}>
      {e.commit_id!.slice(0, 7)}
    </button>
  );

  function describe(e: TimelineEvent): { icon: string; text: ReactNode } | null {
    const who = <b>{e.actor?.login ?? tr("だれか")}</b>;
    switch (e.event) {
      case "assigned":
        return { icon: "👤", text: e.assignee?.login === e.actor?.login ? <>{trx("{who} が担当になりました", { who })}</> : <>{trx("{who} が <0>{login}</0> を担当にしました", { who, login: e.assignee?.login }, [<b />])}</> };
      case "unassigned":
        return { icon: "👤", text: <>{trx("{who} が <0>{login}</0> を担当から外しました", { who, login: e.assignee?.login }, [<b />])}</> };
      case "milestoned":
        return { icon: "🎯", text: <>{trx("{who} がマイルストーン <0>{title}</0> に入れました", { who, title: e.milestone?.title }, [<b />])}</> };
      case "demilestoned":
        return { icon: "🎯", text: <>{trx("{who} がマイルストーン <0>{title}</0> から外しました", { who, title: e.milestone?.title }, [<b />])}</> };
      case "renamed":
        return { icon: "✏", text: <>{trx("{who} が題名を「{from}」から「{to}」に変えました", { who, from: e.rename?.from, to: e.rename?.to })}</> };
      case "closed":
        return e.commit_id
          ? { icon: "✅", text: <>{trx("コミット {commitLink} で閉じられました", { commitLink: commitLink(e) })}</> }
          : { icon: e.state_reason === "not_planned" ? "⊘" : e.state_reason === "duplicate" ? "🔁" : "✅", text: <>{trx("{who} が{closeReasonText}として閉じました", { who, closeReasonText: closeReasonText(e.state_reason) })}</> };
      case "reopened":
        return { icon: "🔄", text: <>{trx("{who} が開き直しました", { who })}</> };
      case "marked_as_duplicate":
        return { icon: "🔁", text: <>{trx("{who} が重複の印を付けました", { who })}</> };
      case "unmarked_as_duplicate":
        return { icon: "🔁", text: <>{trx("{who} が重複の印を外しました", { who })}</> };
      case "cross-referenced":
        return e.source?.issue ? { icon: "🔗", text: <>{trx("{issueLink} から触れられました", { issueLink: issueLink(e.source.issue) })}</> } : null;
      case "referenced":
        return e.commit_id ? { icon: "🔨", text: <>{trx("コミット {commitLink} から触れられました", { commitLink: commitLink(e) })}</> } : null;
      case "sub_issue_added":
        return { icon: "🧩", text: <>{trx("{who} が子 {issue} を足しました", { who, issue: e.sub_issue ? issueLink(e.sub_issue) : "" })}</> };
      case "sub_issue_removed":
        return { icon: "🧩", text: <>{trx("{who} が子 {issue} を外しました", { who, issue: e.sub_issue ? issueLink(e.sub_issue) : "" })}</> };
      case "parent_issue_added":
        return { icon: "🧩", text: <>{trx("{who} が親 {issue} の子にしました", { who, issue: e.parent_issue ? issueLink(e.parent_issue) : "" })}</> };
      case "parent_issue_removed":
        return { icon: "🧩", text: <>{trx("{who} が親 {issue} から外しました", { who, issue: e.parent_issue ? issueLink(e.parent_issue) : "" })}</> };
      case "locked":
        return { icon: "🔒", text: <>{trx("{who} がコメントできないようにしました", { who })}</> };
      case "unlocked":
        return { icon: "🔓", text: <>{trx("{who} がコメントできるようにしました", { who })}</> };
      case "pinned":
        return { icon: "📌", text: <>{trx("{who} がピン留めしました", { who })}</> };
      case "transferred":
        return { icon: "🚚", text: <>{trx("{who} がほかのリポジトリから移しました", { who })}</> };
      default:
        return null;
    }
  }

  return (
    <div className="issue-timeline">
      <div className="issue-timeline-head">
        <h3 className="section-header">{trx("💬 コメントと変更の履歴 ({length})", { length: comments.length })}</h3>
        <span className="issue-timeline-filter" role="group" aria-label={tr("出すもの")}>
          <button type="button" className={filter === "all" ? "on" : ""} onClick={() => setFilter("all")}>{tr("すべて")}</button>
          <button type="button" className={filter === "comments" ? "on" : ""} onClick={() => setFilter("comments")}>{tr("コメントだけ")}</button>
        </span>
        <HistoryOrderToggle order={order} onChange={onOrderChange} />
      </div>
      {order === "newest" && composer && <div className="issue-timeline-composer">{composer}</div>}
      {loadingComments ? (
        <p className="issue-timeline-note">{tr("読み込み中...")}</p>
      ) : (
        <ul className="timeline">
          {items.map((item, i) => {
            if (item.kind === "comment") {
              const c = item.comment;
              // 🆘 助けを求めるコメント: 呼んだ人・困っていること・添えたようすに整えて、赤く出す
              const help = isHelp(c.body) ? parseHelp(c.body) : null;
              const solved = !!help && lastDone > c.created_at;
              const done = isHelpDone(c.body);
              return (
                <li key={`c${c.id}`} className={`timeline-comment${help ? " help" : ""}${done ? " help-done" : ""}${c._sending ? " sending" : ""}${c._failed ? " failed" : ""}`}>
                  <div className="timeline-comment-head">
                    <span className="timeline-comment-who">
                      {c.user?.login ?? "unknown"}
                      {help && <span className="help-badge">{tr("🆘 助けて")}</span>}
                      {solved && <span className="help-solved">{tr("✅ 解決")}</span>}
                      {c._pending && <PendingChip />}
                    </span>
                    {c._sending ? <SendingChip /> : c._failed ? <FailedChip /> : <span className="timeline-when">{when(c.created_at)}</span>}
                  </div>
                  {help ? (
                    <div className="timeline-comment-body help-body">
                      {help.to.length > 0 && (
                        <div className="help-to">
                          {help.to.map((l) => (
                            <span key={l} className="help-mention">@{l}</span>
                          ))}
                        </div>
                      )}
                      {help.message && <div className="help-msg">{help.message}</div>}
                      <HelpContextBox items={help.items} log={help.log} />
                    </div>
                  ) : (
                    <div className="timeline-comment-body">{done ? c.body.replace(/<!--[\s\S]*?-->/g, "").replace(/\*\*/g, "").trim() : c.body}</div>
                  )}
                  {c._failed && (onRetryComment || onRestoreComment) && (
                    <div className="help-actions">
                      {onRetryComment && (
                        <button type="button" className="btn-primary" onClick={() => onRetryComment(c)}>
                          {tr("もう一度")}
                        </button>
                      )}
                      {onRestoreComment && (
                        <button type="button" className="btn-sm" onClick={() => onRestoreComment(c)}>
                          {tr("書く欄に戻す")}
                        </button>
                      )}
                    </div>
                  )}
                  {help && !solved && !c._pending && !c._sending && !c._failed && (onReplyHelp || onResolveHelp) && (
                    <div className="help-actions">
                      {onReplyHelp && (
                        <button type="button" className="btn-sm" onClick={() => onReplyHelp(c)}>
                          {tr("💬 返事を書く")}
                        </button>
                      )}
                      {onResolveHelp && (
                        <button
                          type="button"
                          className="btn-sm"
                          disabled={resolving !== null}
                          title={tr("「解決しました」のコメントを残し、助けを求めた人と呼ばれた人に知らせます")}
                          onClick={() => {
                            setResolving(c.id);
                            onResolveHelp(c).finally(() => setResolving(null));
                          }}
                        >
                          {resolving === c.id ? tr("送っています…") : tr("✅ 解決した")}
                        </button>
                      )}
                    </div>
                  )}
                </li>
              );
            }
            if (item.kind === "created") {
              return (
                <li key="created" className="timeline-event">
                  📝 {trx("{who} が作りました<0>{when}</0>", { who: item.actor ? <b>{item.actor}</b> : tr("だれか"), when: when(item.at) }, [<span className="timeline-when" />])}
                </li>
              );
            }
            if (item.kind === "labels") {
              const who = item.actor || tr("だれか");
              const removed = <>{item.removed.map((e) => <LabelBadge key={`r${e.label?.name}`} name={e.label?.name ?? ""} color={e.label?.color ?? "cccccc"} />)}</>;
              const added = <>{item.added.map((e) => <LabelBadge key={`a${e.label?.name}`} name={e.label?.name ?? ""} color={e.label?.color ?? "cccccc"} />)}</>;
              return (
                <li key={`l${i}`} className="timeline-event">
                  🏷 {item.removed.length > 0 && item.added.length > 0
                    ? trx("<0>{who}</0> が {removed} を外し、 {added} を付けました", { who, removed, added }, [<b />])
                    : item.removed.length > 0
                      ? trx("<0>{who}</0> が {removed} を外しました", { who, removed }, [<b />])
                      : trx("<0>{who}</0> が {added} を付けました", { who, added }, [<b />])}
                  <span className="timeline-when">{when(item.at)}</span>
                </li>
              );
            }
            const d = describe(item.event);
            if (!d) return null;
            return (
              <li key={`e${item.event.id ?? i}`} className="timeline-event">
                {d.icon} {d.text}
                <span className="timeline-when">{when(item.at)}</span>
              </li>
            );
          })}
          {!loadingComments && comments.length === 0 && filter === "comments" && <li className="issue-timeline-note">{tr("コメントはまだありません")}</li>}
        </ul>
      )}
      {error && filter === "all" && <p className="issue-timeline-note">{trx("変更の履歴は出せませんでした（{error}）", { error })}</p>}
      {!error && cachedAt !== null && filter === "all" && (
        <p className="issue-timeline-note">{cachedAt ? tr("変更の履歴は {when} に読んだものです", { when: shortWhen(cachedAt) }) : tr("変更の履歴は前に読んだものです")}</p>
      )}
      {order === "oldest" && composer && <div className="issue-timeline-composer">{composer}</div>}
    </div>
  );
}
