import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { GitHubUser } from "../../lib/types";
import { withTransition } from "../../lib/motion";
import {
  STATUS_LABELS,
  ago,
  closingIssues,
  commentPullLine,
  firstLine,
  pullCommits,
  pullDetail,
  pullFiles,
  pullStatus,
  setPullReviewers,
  updatePull,
  type PullCommit,
  type PullDetail as Detail,
  type PullFile,
  type PullRepoInfo,
} from "../../lib/pulls";
import { CommitDetail } from "../git/CommitDetail";
import { MergeBox } from "./MergeBox";
import { PullConversation } from "./PullConversation";
import { PullFiles, type LineCommentDraft } from "./PullFiles";

type Tab = "conversation" | "files" | "commits";
const TABS: Tab[] = ["conversation", "files", "commits"];

interface PullDetailProps {
  owner: string;
  repo: string;
  number: number;
  currentUser: string;
  collaborators: GitHubUser[];
  info: PullRepoInfo | null;
  issueTitle: (n: number) => string | null;
  onOpenIssue: (n: number) => void;
  /** 一覧へ戻る（狭い画面） */
  onBack: () => void;
  /** 一覧を読み直す */
  onChanged: () => void;
  /** マージした（Issue を読み直す） */
  onMerged: () => void;
  onFixLocally?: (pull: Detail) => void;
}

/** プルリクの詳細: 見出し・レビューをお願いする人・会話 / 変更されたファイル / コミット */
export function PullDetail(props: PullDetailProps) {
  const { owner, repo, number, currentUser, collaborators, info, issueTitle, onOpenIssue, onBack, onChanged, onMerged, onFixLocally } = props;
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<PullFile[] | null>(null);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [commits, setCommits] = useState<PullCommit[] | null>(null);
  const [commitsError, setCommitsError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("conversation");
  const [focus, setFocus] = useState<{ file: string; nonce: number } | null>(null);
  const [commit, setCommit] = useState<{ hash: string; subject: string; author: string; date: string } | null>(null);
  const [editing, setEditing] = useState<{ title: string; body: string } | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [reviewerError, setReviewerError] = useState<string | null>(null);
  const polls = useRef(0);
  const current = useRef(number);
  current.current = number;

  const loadDetail = useCallback(async () => {
    try {
      const d = await pullDetail(owner, repo, number);
      if (current.current === number) {
        setDetail(d);
        setError(null);
      }
    } catch (e) {
      if (current.current === number) setError(String(e));
    }
  }, [owner, repo, number]);

  const loadRest = useCallback(() => {
    pullFiles(owner, repo, number)
      .then((f) => current.current === number && (setFiles(f), setFilesError(null)))
      .catch((e) => current.current === number && setFilesError(String(e)));
    pullCommits(owner, repo, number)
      .then((c) => current.current === number && (setCommits(c), setCommitsError(null)))
      .catch((e) => current.current === number && setCommitsError(String(e)));
  }, [owner, repo, number]);

  useEffect(() => {
    setDetail(null);
    setError(null);
    setFiles(null);
    setFilesError(null);
    setCommits(null);
    setCommitsError(null);
    setTab("conversation");
    setEditing(null);
    setPicking(false);
    polls.current = 0;
    loadDetail();
    loadRest();
  }, [loadDetail, loadRest]);

  // マージできるかを GitHub が調べているあいだは、少し待って読み直す
  useEffect(() => {
    if (!detail || detail.state !== "open" || detail.draft) return;
    if (detail.mergeable !== null && detail.mergeable_state !== "unknown") return;
    if (polls.current >= 6) return;
    polls.current += 1;
    const t = window.setTimeout(loadDetail, 2500);
    return () => window.clearTimeout(t);
  }, [detail, loadDetail]);

  const reload = useCallback(() => {
    loadDetail();
    loadRest();
    onChanged();
  }, [loadDetail, loadRest, onChanged]);

  function changeTab(next: Tab) {
    if (next === tab) return;
    const dir = TABS.indexOf(next) > TABS.indexOf(tab) ? "vt-right" : "vt-left";
    withTransition(() => setTab(next), ["vt-tab", dir]);
  }

  function openFiles(file?: string) {
    changeTab("files");
    if (file) setFocus({ file, nonce: Date.now() });
  }

  const lineComments = useMemo(() => (detail?.conversation ?? []).flatMap((e) => e.comments ?? []), [detail]);

  async function postLineComment(c: LineCommentDraft) {
    if (!detail) return;
    await commentPullLine(owner, repo, number, { commitId: detail.head_sha, path: c.path, line: c.line, side: c.side, body: c.body });
    await loadDetail();
  }

  async function saveEdit() {
    if (!editing) return;
    setEditError(null);
    try {
      await updatePull(owner, repo, number, { title: editing.title, body: editing.body });
      setEditing(null);
      reload();
    } catch (e) {
      setEditError(String(e));
    }
  }

  async function changeReviewers(add: string[], remove: string[]) {
    setReviewerError(null);
    try {
      await setPullReviewers(owner, repo, number, add, remove);
      setPicking(false);
      reload();
    } catch (e) {
      setReviewerError(String(e));
    }
  }

  if (error && !detail) {
    return (
      <div className="pr-detail">
        <button type="button" className="btn-sm pr-back" onClick={onBack}>
          ← 一覧
        </button>
        <p className="git-dialog-error">{error}</p>
        <button type="button" className="btn-sm" onClick={loadDetail}>
          もう一度読み込む
        </button>
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="pr-detail">
        <p className="muted">#{number} を読み込んでいます…</p>
      </div>
    );
  }

  const status = pullStatus(detail);
  const author = detail.user?.login ?? "";
  const mine = author !== "" && author === currentUser;
  const canPush = info?.can_push ?? false;
  const toDefault = !info || detail.base === info.default_branch;
  const closes = closingIssues(detail.body);
  const waiting = detail.requested_reviewers.map((p) => p.login);
  const reviewed = [...detail.verdicts.approved, ...detail.verdicts.changes_requested];
  const people = [...new Set([...reviewed, ...waiting])];
  const candidates = collaborators.filter((c) => c.login !== author && !waiting.includes(c.login));
  const added = files?.reduce((n, f) => n + f.additions, 0) ?? detail.additions;
  const deleted = files?.reduce((n, f) => n + f.deletions, 0) ?? detail.deletions;

  return (
    <div className="pr-detail">
      <div className="pr-head">
        <button type="button" className="btn-sm pr-back" onClick={onBack}>
          ← 一覧
        </button>
        <span className={`pr-state s-${status}`}>{STATUS_LABELS[status]}</span>
        {editing ? (
          <input className="pr-title-input" value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} aria-label="題名" />
        ) : (
          <h2 className="pr-title">
            {detail.title} <span className="muted">#{detail.number}</span>
          </h2>
        )}
        <span className="grow" />
        {!editing && (mine || canPush) && (
          <button type="button" className="btn-sm" onClick={() => setEditing({ title: detail.title, body: detail.body })}>
            ✏️ 編集
          </button>
        )}
        <button type="button" className="btn-sm" onClick={() => openUrl(detail.html_url).catch(() => {})} title="GitHub の画面で開く">
          GitHub で開く ↗
        </button>
      </div>
      {editing && (
        <div className="pr-edit">
          <textarea rows={8} value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} aria-label="説明" />
          {editError && <p className="git-dialog-error">{editError}</p>}
          <div className="pr-edit-actions">
            <button type="button" className="btn-sm" onClick={() => setEditing(null)}>
              やめる
            </button>
            <button type="button" className="btn-sm primary" onClick={saveEdit}>
              保存する
            </button>
          </div>
        </div>
      )}

      <div className="pr-flow">
        <b>{author || "だれか"}</b> が <code className="pr-branch">{detail.head}</code> の {detail.commits} コミットを{" "}
        <code className="pr-branch">{detail.base}</code> に{detail.merged ? "入れました" : status === "closed" ? "入れようとしました" : "入れたいと言っています"}
        {!detail.same_repo && <span className="muted">（フォーク {detail.head_repo ?? "（消されました）"} から）</span>}
      </div>
      {closes.length > 0 && (
        <div className="pr-link">
          🔗 {detail.merged ? "マージで" : "マージすると"}{" "}
          {closes.map((n, i) => (
            <span key={n}>
              {i > 0 && "・"}
              <button type="button" className="pr-ref" onClick={() => onOpenIssue(n)}>
                #{n} {issueTitle(n) ?? ""}
              </button>
            </span>
          ))}{" "}
          {toDefault ? (detail.merged ? "が閉じました" : "が閉じます") : <span className="muted">（{detail.base} は既定のブランチではないので、自動では閉じません）</span>}
          <span className="muted">（本文の Closes）</span>
        </div>
      )}

      <div className="pr-reviewers">
        <span className="muted">レビュー:</span>
        {people.length === 0 && <span className="muted">まだお願いしていません</span>}
        {people.map((login) => {
          const verdict = detail.verdicts.approved.includes(login) ? "ok" : detail.verdicts.changes_requested.includes(login) ? "ng" : "wait";
          return (
            <span key={login} className={`pr-reviewer ${verdict}`} title={verdict === "ok" ? "承認しました" : verdict === "ng" ? "修正を依頼しました" : "レビューを待っています"}>
              {verdict === "ok" ? "✔" : verdict === "ng" ? "✖" : "⏳"} {login}
              {waiting.includes(login) && canPush && detail.state === "open" && (
                <button type="button" className="pr-reviewer-x" aria-label={`${login} へのお願いを取り消す`} onClick={() => changeReviewers([], [login])}>
                  ×
                </button>
              )}
            </span>
          );
        })}
        {canPush && detail.state === "open" && candidates.length > 0 && (
          <span className="pr-picker">
            <button type="button" className="btn-sm" onClick={() => setPicking((v) => !v)} aria-expanded={picking}>
              ＋ お願いする ▾
            </button>
            {picking && (
              <span className="pr-picker-menu" role="menu">
                {candidates.map((c) => (
                  <button key={c.login} type="button" role="menuitem" onClick={() => changeReviewers([c.login], [])}>
                    {c.login}
                    {reviewed.includes(c.login) && <span className="muted">（もう一度）</span>}
                  </button>
                ))}
              </span>
            )}
          </span>
        )}
        {reviewerError && <span className="git-dialog-error">{reviewerError}</span>}
      </div>

      <div className="pr-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "conversation"} className={`pr-tab${tab === "conversation" ? " on" : ""}`} onClick={() => changeTab("conversation")}>
          会話
          {tab === "conversation" && <span className="tab-active-bar" />}
        </button>
        <button type="button" role="tab" aria-selected={tab === "files"} className={`pr-tab pr-tab--files${tab === "files" ? " on" : ""}`} onClick={() => changeTab("files")}>
          変更されたファイル <b>{files?.length ?? detail.changed_files}</b> <span className="add">+{added}</span> <span className="del">−{deleted}</span>
          {tab === "files" && <span className="tab-active-bar" />}
        </button>
        <button type="button" role="tab" aria-selected={tab === "commits"} className={`pr-tab${tab === "commits" ? " on" : ""}`} onClick={() => changeTab("commits")}>
          コミット <b>{commits?.length ?? detail.commits}</b>
          {tab === "commits" && <span className="tab-active-bar" />}
        </button>
      </div>

      <div className="pr-tab-body">
        {tab === "conversation" && (
          <PullConversation
            owner={owner}
            repo={repo}
            pull={detail}
            currentUser={currentUser}
            files={files}
            issueTitle={issueTitle}
            onOpenIssue={onOpenIssue}
            onOpenFiles={openFiles}
            onOpenCommit={(hash, subject, author, date) => setCommit({ hash, subject, author, date })}
            onChanged={reload}
            footer={
              <MergeBox
                owner={owner}
                repo={repo}
                pull={detail}
                info={info}
                currentUser={currentUser}
                closes={toDefault ? closes : []}
                onChanged={reload}
                onMerged={onMerged}
                onFixLocally={onFixLocally && detail.same_repo ? () => onFixLocally(detail) : undefined}
              />
            }
          />
        )}
        {tab === "files" && (
          <PullFiles
            files={files}
            error={filesError}
            comments={lineComments}
            onComment={detail.state === "open" ? postLineComment : undefined}
            viewedKey={`pull-viewed:${owner}/${repo}#${number}`}
            focus={focus}
          />
        )}
        {tab === "commits" &&
          (commitsError ? (
            <p className="git-dialog-error">{commitsError}</p>
          ) : !commits ? (
            <p className="muted">コミットを読み込んでいます…</p>
          ) : (
            <>
              <p className="hint">押すと、そのコミットで何を変えたかを見られます（古い順）。</p>
              <ol className="pr-commit-list">
                {commits.map((c) => (
                  <li key={c.sha}>
                    <button
                      type="button"
                      className="pr-commit"
                      onClick={() => setCommit({ hash: c.sha, subject: firstLine(c.message), author: c.author?.login ?? c.author_name, date: c.date })}
                    >
                      <code>{c.sha.slice(0, 7)}</code>
                      <span className="pr-commit-subject">{firstLine(c.message)}</span>
                      <span className="muted">
                        {c.author?.login ?? c.author_name}・{ago(c.date)}
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            </>
          ))}
      </div>

      {commit &&
        createPortal(
          <CommitDetail
            source={{ owner, repo }}
            commit={{ hash: commit.hash, parents: [], author: commit.author, date: commit.date, subject: commit.subject }}
            onClose={() => setCommit(null)}
          />,
          document.querySelector("main.app") ?? document.body,
        )}
    </div>
  );
}
