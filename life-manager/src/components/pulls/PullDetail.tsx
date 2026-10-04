import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { GitHubUser } from "../../lib/types";
import { withTransition } from "../../lib/motion";
import { commitChecks, duration, resultOf, runOfCheck, type CommitChecks } from "../../lib/actions";
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
import { tr, trx } from "../../lib/i18n";

type Tab = "conversation" | "files" | "commits" | "checks";
const TABS: Tab[] = ["conversation", "files", "commits", "checks"];

const STATUS_RESULT: Record<string, { status: string; conclusion: string | null }> = {
  success: { status: "completed", conclusion: "success" },
  failure: { status: "completed", conclusion: "failure" },
  error: { status: "completed", conclusion: "failure" },
  pending: { status: "in_progress", conclusion: null },
};

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
  /** Actions のその実行を開く（チェックの「ログを見る」） */
  onOpenRun: (runId: number, jobId?: number | null) => void;
}

/** プルリクの詳細: 見出し・レビューをお願いする人・会話 / 変更されたファイル / コミット */
export function PullDetail(props: PullDetailProps) {
  const { owner, repo, number, currentUser, collaborators, info, issueTitle, onOpenIssue, onBack, onChanged, onMerged, onFixLocally, onOpenRun } = props;
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
  const [checks, setChecks] = useState<CommitChecks | null>(null);
  const [checksError, setChecksError] = useState<string | null>(null);
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

  // チェック（ブランチの先頭のコミット）。動いているあいだは読み直す
  const headSha = detail?.head_sha ?? "";
  const loadChecks = useCallback(() => {
    if (!headSha) return;
    commitChecks(owner, repo, headSha)
      .then((c) => {
        setChecks(c);
        setChecksError(null);
      })
      .catch((e) => setChecksError(String(e)));
  }, [owner, repo, headSha]);
  useEffect(() => {
    setChecks(null);
    setChecksError(null);
    loadChecks();
  }, [loadChecks]);
  const checksPending = !!checks && (checks.checks.some((c) => c.status !== "completed") || checks.statuses.some((s) => s.state === "pending"));
  useEffect(() => {
    if (!checksPending) return;
    const t = window.setInterval(loadChecks, 15000);
    return () => window.clearInterval(t);
  }, [checksPending, loadChecks]);

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
          {tr("← 一覧")}
        </button>
        <p className="git-dialog-error">{error}</p>
        <button type="button" className="btn-sm" onClick={loadDetail}>
          {tr("もう一度読み込む")}
        </button>
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="pr-detail">
        <p className="muted">{trx("#{number} を読み込んでいます…", { number })}</p>
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
  const failedChecks = checks
    ? checks.checks.filter((c) => c.status === "completed" && ["failure", "timed_out", "action_required", "startup_failure"].includes(c.conclusion ?? "")).length +
      checks.statuses.filter((s) => s.state === "failure" || s.state === "error").length
    : 0;
  // チェックの「ログを見る」: GitHub Actions なら Actions の画面で、そうでなければ GitHub の画面で
  const openCheck = (url: string | null | undefined, fallback: string | null | undefined) => {
    const target = runOfCheck(url);
    if (target) onOpenRun(target.runId, target.jobId);
    else if (url || fallback) openUrl((url || fallback)!).catch(() => {});
  };
  // 見出しの下の 1 行（だれが、どのブランチのいくつのコミットを、どこに）
  const flow = { who: author || tr("だれか"), head: detail.head, n: detail.commits, base: detail.base };
  const flowTags = [<b />, <code className="pr-branch" />, <code className="pr-branch" />];
  // 本文の Closes でつながる Issue（押すと開く）
  const closeLinks = (
    <>
      {closes.map((n, i) => (
        <span key={n}>
          {i > 0 && tr("・")}
          <button type="button" className="pr-ref" onClick={() => onOpenIssue(n)}>
            #{n} {issueTitle(n) ?? ""}
          </button>
        </span>
      ))}
    </>
  );

  return (
    <div className="pr-detail">
      <div className="pr-head">
        <button type="button" className="btn-sm pr-back" onClick={onBack}>
          {tr("← 一覧")}
        </button>
        <span className={`pr-state s-${status}`}>{STATUS_LABELS[status]}</span>
        {editing ? (
          <input className="pr-title-input" value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} aria-label={tr("題名")} />
        ) : (
          <h2 className="pr-title">
            {detail.title} <span className="muted">#{detail.number}</span>
          </h2>
        )}
        <span className="grow" />
        {!editing && (mine || canPush) && (
          <button type="button" className="btn-sm" onClick={() => setEditing({ title: detail.title, body: detail.body })}>
            {tr("✏️ 編集")}
          </button>
        )}
        <button type="button" className="btn-sm" onClick={() => openUrl(detail.html_url).catch(() => {})} title={tr("GitHub の画面で開く")}>
          {tr("GitHub で開く ↗")}
        </button>
      </div>
      {editing && (
        <div className="pr-edit">
          <textarea rows={8} value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} aria-label={tr("説明")} />
          {editError && <p className="git-dialog-error">{editError}</p>}
          <div className="pr-edit-actions">
            <button type="button" className="btn-sm" onClick={() => setEditing(null)}>
              {tr("やめる")}
            </button>
            <button type="button" className="btn-sm primary" onClick={saveEdit}>
              {tr("保存する")}
            </button>
          </div>
        </div>
      )}

      <div className="pr-flow">
        {detail.merged
          ? trx("<0>{who}</0> が <1>{head}</1> の {n} コミットを <2>{base}</2> に入れました", flow, flowTags)
          : status === "closed"
            ? trx("<0>{who}</0> が <1>{head}</1> の {n} コミットを <2>{base}</2> に入れようとしました", flow, flowTags)
            : trx("<0>{who}</0> が <1>{head}</1> の {n} コミットを <2>{base}</2> に入れたいと言っています", flow, flowTags)}
        {!detail.same_repo && <span className="muted">{tr("（フォーク {repo} から）", { repo: detail.head_repo ?? tr("（消されました）") })}</span>}
      </div>
      {closes.length > 0 && (
        <div className="pr-link">
          🔗 {toDefault
            ? detail.merged
              ? trx("マージで {issues} が閉じました", { issues: closeLinks })
              : trx("マージすると {issues} が閉じます", { issues: closeLinks })
            : detail.merged
              ? trx("マージで {issues} <0>（{base} は既定のブランチではないので、自動では閉じません）</0>", { issues: closeLinks, base: detail.base }, [<span className="muted" />])
              : trx("マージすると {issues} <0>（{base} は既定のブランチではないので、自動では閉じません）</0>", { issues: closeLinks, base: detail.base }, [<span className="muted" />])}
          <span className="muted">{tr("（本文の Closes）")}</span>
        </div>
      )}

      <div className="pr-reviewers">
        <span className="muted">{tr("レビュー:")}</span>
        {people.length === 0 && <span className="muted">{tr("まだお願いしていません")}</span>}
        {people.map((login) => {
          const verdict = detail.verdicts.approved.includes(login) ? "ok" : detail.verdicts.changes_requested.includes(login) ? "ng" : "wait";
          return (
            <span key={login} className={`pr-reviewer ${verdict}`} title={verdict === "ok" ? tr("承認しました") : verdict === "ng" ? tr("修正を依頼しました") : tr("レビューを待っています")}>
              {verdict === "ok" ? "✔" : verdict === "ng" ? "✖" : "⏳"} {login}
              {waiting.includes(login) && canPush && detail.state === "open" && (
                <button type="button" className="pr-reviewer-x" aria-label={tr("{login} へのお願いを取り消す", { login })} onClick={() => changeReviewers([], [login])}>
                  ×
                </button>
              )}
            </span>
          );
        })}
        {canPush && detail.state === "open" && candidates.length > 0 && (
          <span className="pr-picker">
            <button type="button" className="btn-sm" onClick={() => setPicking((v) => !v)} aria-expanded={picking}>
              {tr("＋ お願いする ▾")}
            </button>
            {picking && (
              <span className="pr-picker-menu" role="menu">
                {candidates.map((c) => (
                  <button key={c.login} type="button" role="menuitem" onClick={() => changeReviewers([c.login], [])}>
                    {c.login}
                    {reviewed.includes(c.login) && <span className="muted">{tr("（もう一度）")}</span>}
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
          {tr("会話")}
          {tab === "conversation" && <span className="tab-active-bar" />}
        </button>
        <button type="button" role="tab" aria-selected={tab === "files"} className={`pr-tab pr-tab--files${tab === "files" ? " on" : ""}`} onClick={() => changeTab("files")}>
          {tr("変更されたファイル")}{" "} <b>{files?.length ?? detail.changed_files}</b> <span className="add">+{added}</span> <span className="del">−{deleted}</span>
          {tab === "files" && <span className="tab-active-bar" />}
        </button>
        <button type="button" role="tab" aria-selected={tab === "commits"} className={`pr-tab${tab === "commits" ? " on" : ""}`} onClick={() => changeTab("commits")}>
          {tr("コミット")}{" "} <b>{commits?.length ?? detail.commits}</b>
          {tab === "commits" && <span className="tab-active-bar" />}
        </button>
        <button type="button" role="tab" aria-selected={tab === "checks"} className={`pr-tab${tab === "checks" ? " on" : ""}`} onClick={() => changeTab("checks")}>
          {tr("チェック")}{" "}
          {checks &&
            (failedChecks > 0 ? (
              <b className="ng">✖ {failedChecks}</b>
            ) : checksPending ? (
              <b className="t-wait">●</b>
            ) : checks.checks.length + checks.statuses.length > 0 ? (
              <b className="ok">✔</b>
            ) : null)}
          {tab === "checks" && <span className="tab-active-bar" />}
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
                checks={checks}
                onOpenCheck={openCheck}
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
        {tab === "checks" &&
          (checksError ? (
            <p className="git-dialog-error">{checksError}</p>
          ) : !checks ? (
            <p className="muted">{tr("チェックを読み込んでいます…")}</p>
          ) : checks.checks.length + checks.statuses.length === 0 ? (
            <div className="pulls-empty">
              <p>{tr("このコミットにはチェックがありません。")}</p>
            </div>
          ) : (
            <>
              <div className="pr-checks">
                {checks.checks.map((c) => {
                  const r = resultOf(c);
                  return (
                    <div key={c.id} className={`pr-check t-${r.tone}`}>
                      <span className={`ac-icon t-${r.tone}`} title={r.label}>
                        {r.icon}
                      </span>
                      <span className="pr-check-name">
                        <b>{c.name}</b> <span className="muted">{c.app ?? ""}</span>
                        {c.title && <span className="pr-check-title">{c.title}</span>}
                      </span>
                      <span className="muted">{duration(c.started_at, c.completed_at)}</span>
                      <button type="button" className="btn-sm" onClick={() => openCheck(c.details_url, c.html_url)}>
                        {runOfCheck(c.details_url) ? tr("ログを見る →") : tr("開く ↗")}
                      </button>
                    </div>
                  );
                })}
                {checks.statuses.map((s) => {
                  const r = resultOf(STATUS_RESULT[s.state] ?? { status: "completed", conclusion: null });
                  return (
                    <div key={s.context} className={`pr-check t-${r.tone}`}>
                      <span className={`ac-icon t-${r.tone}`} title={r.label}>
                        {r.icon}
                      </span>
                      <span className="pr-check-name">
                        <b>{s.context}</b>
                        {s.description && <span className="pr-check-title">{s.description}</span>}
                      </span>
                      {s.target_url && (
                        <button type="button" className="btn-sm" onClick={() => openUrl(s.target_url!).catch(() => {})}>
                          {tr("開く ↗")}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          ))}
        {tab === "commits" &&
          (commitsError ? (
            <p className="git-dialog-error">{commitsError}</p>
          ) : !commits ? (
            <p className="muted">{tr("コミットを読み込んでいます…")}</p>
          ) : (
            <>
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
                        {c.author?.login ?? c.author_name}{trx("・{ago}", { ago: ago(c.date) })}
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
