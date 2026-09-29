import { useCallback, useEffect, useMemo, useState } from "react";
import type { GitHubIssue, GitHubUser } from "../../lib/types";
import {
  STATUS_LABELS,
  ago,
  closingIssues,
  listPulls,
  pullRepoInfo,
  pullStatus,
  pullVerdicts,
  type PullDetail as Detail,
  type PullRepoInfo,
  type PullStatus,
  type PullSummary,
  type Verdicts,
} from "../../lib/pulls";
import { withTransition } from "../../lib/motion";
import { PULL_PERMISSIONS, commitsChecks, isPermissionError, type CheckSummary } from "../../lib/actions";
import { PermissionPrompt } from "../actions/PermissionPrompt";
import { PullDetail } from "../pulls/PullDetail";
import { CreatePullDialog } from "../pulls/CreatePullDialog";

type Filter = "open" | "merged" | "closed";
const FILTERS: Filter[] = ["open", "merged", "closed"];
const FILTER_LABELS: Record<Filter, string> = { open: "開いている", merged: "マージ済み", closed: "閉じた" };

const inFilter = (s: PullStatus, f: Filter) => (f === "open" ? s === "open" || s === "draft" : s === f);

interface PullsViewProps {
  owner: string;
  repo: string;
  currentUser: string;
  collaborators: GitHubUser[];
  /** 開いている Issue・閉じた Issue（#45 の題名を出す・つなげる Issue を選ぶ） */
  issues: GitHubIssue[];
  closedIssues: GitHubIssue[];
  onOpenIssue: (n: number) => void;
  /** 見ているプルリク（作業タブから開けるよう、App が持つ） */
  selected: number | null;
  onSelect: (n: number | null) => void;
  /** 作業タブから「プルリクを作る」で来たとき */
  createRequest: { head: string | null; issue: number | null } | null;
  onCreateRequestHandled: () => void;
  /** マージした（Closes で閉じた Issue を読み直す） */
  onMerged: () => void;
  /** 競合を、この PC の作業フォルダで直す（作業フォルダがあるときだけ） */
  onFixLocally?: (pull: Detail) => void;
  /** この PC で今いるブランチ（プルリクを作るときの、はじめの候補） */
  localBranch: string | null;
  /** Actions のその実行を開く（チェックの「ログを見る」） */
  onOpenRun: (runId: number, jobId?: number | null) => void;
}

/** プルリク: 左に一覧（開いている・マージ済み・閉じた）、右に詳細 */
export function PullsView(props: PullsViewProps) {
  const { owner, repo, currentUser, collaborators, issues, closedIssues, onOpenIssue, selected, onSelect, createRequest, onCreateRequestHandled, onMerged, onFixLocally, localBranch, onOpenRun } = props;
  const [pulls, setPulls] = useState<PullSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [info, setInfo] = useState<PullRepoInfo | null>(null);
  const [verdicts, setVerdicts] = useState<Record<string, Verdicts>>({});
  const [checks, setChecks] = useState<Record<string, CheckSummary>>({});
  const [filter, setFilter] = useState<Filter>("open");
  const [query, setQuery] = useState("");
  const [create, setCreate] = useState<{ head: string | null; issue: number | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await listPulls(owner, repo);
      setPulls(list);
      setError(null);
      const open = list.filter((p) => p.state === "open");
      if (open.length > 0) {
        pullVerdicts(owner, repo, open.map((p) => p.number)).then(setVerdicts).catch(() => {});
        // Checks の権限がなければ、チェックの印は出さない
        commitsChecks(owner, repo, open.map((p) => p.head_sha)).then(setChecks).catch(() => {});
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [owner, repo]);

  useEffect(() => {
    setPulls(null);
    setInfo(null);
    setVerdicts({});
    setChecks({});
    load();
    pullRepoInfo(owner, repo).then(setInfo).catch(() => {});
  }, [owner, repo, load]);

  useEffect(() => {
    if (!createRequest) return;
    setCreate(createRequest);
    onCreateRequestHandled();
  }, [createRequest, onCreateRequestHandled]);

  const allIssues = useMemo(() => new Map([...closedIssues, ...issues].map((i) => [i.number, i.title])), [issues, closedIssues]);
  const issueTitle = useCallback((n: number) => allIssues.get(n) ?? null, [allIssues]);

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { open: 0, merged: 0, closed: 0 };
    for (const p of pulls ?? []) {
      const s = pullStatus(p);
      for (const f of FILTERS) if (inFilter(s, f)) c[f] += 1;
    }
    return c;
  }, [pulls]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/^#/, "");
    return (pulls ?? []).filter((p) => {
      if (!inFilter(pullStatus(p), filter)) return false;
      if (!q) return true;
      return [String(p.number), p.title, p.head, p.base, p.user?.login ?? ""].some((s) => s.toLowerCase().includes(q));
    });
  }, [pulls, filter, query]);

  // 選んだプルリクが別の区分なら、その区分を見せる（作業タブから開いたとき）
  useEffect(() => {
    if (selected === null || !pulls) return;
    const p = pulls.find((x) => x.number === selected);
    if (p && !inFilter(pullStatus(p), filter)) setFilter(FILTERS.find((f) => inFilter(pullStatus(p), f)) ?? "open");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, pulls]);

  function changeFilter(next: Filter) {
    if (next === filter) return;
    const dir = FILTERS.indexOf(next) > FILTERS.indexOf(filter) ? "vt-right" : "vt-left";
    withTransition(() => setFilter(next), ["vt-filter", dir]);
  }

  // 一覧で下のプルリクを選ぶと詳細は下から、上なら上から入れ替わる
  function pick(n: number | null) {
    const from = shown.findIndex((p) => p.number === selected);
    const to = shown.findIndex((p) => p.number === n);
    withTransition(() => onSelect(n), ["vt-pick", ...(from >= 0 && to >= 0 && to < from ? ["vt-up"] : [])]);
  }

  return (
    <div className={`pulls pr-ui${selected !== null ? " has-selection" : ""}`}>
      <div className="pulls-list">
        <div className="pulls-top">
          <span className="grow" />
          <button type="button" className="btn-primary" onClick={() => setCreate({ head: localBranch, issue: null })}>
            ＋ プルリクを作る
          </button>
        </div>
        <div className="pulls-filters" role="tablist">
          {FILTERS.map((f) => (
            <button key={f} type="button" role="tab" aria-selected={filter === f} className={`pulls-filter${filter === f ? " on" : ""}`} onClick={() => changeFilter(f)}>
              {FILTER_LABELS[f]} <b>{pulls ? counts[f] : "…"}</b>
              {filter === f && <span className="tab-active-bar pulls-filter-bar" />}
            </button>
          ))}
        </div>
        <div className="pulls-search">
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="題名・#番号・ブランチ・作った人で探す" aria-label="プルリクを探す" />
          <button type="button" className="btn-sm" onClick={load} disabled={loading} title="読み直す">
            {loading ? "…" : "↻"}
          </button>
        </div>
        {notice && (
          <p className="pulls-notice">
            {notice}
            <button type="button" className="git-notice-close" aria-label="閉じる" onClick={() => setNotice(null)}>
              ×
            </button>
          </p>
        )}
        <div className="pulls-items tab-body" role="list">
          {error ? (
            isPermissionError(error) ? (
              <div className="pulls-empty">
                <PermissionPrompt owner={owner} currentUser={currentUser} need={PULL_PERMISSIONS} message={error} onRetry={load} />
              </div>
            ) : (
              <div className="pulls-empty">
                <p className="git-dialog-error">{error}</p>
                <button type="button" className="btn-sm" onClick={load}>
                  もう一度読み込む
                </button>
              </div>
            )
          ) : !pulls ? (
            <p className="pulls-empty muted">読み込んでいます…</p>
          ) : shown.length === 0 ? (
            <div className="pulls-empty">
              {query ? (
                <p className="muted">見つかりません。</p>
              ) : filter === "open" ? (
                <>
                  <p>開いているプルリクはありません。</p>
                  <p className="hint">ブランチで作業してプッシュしたら、「＋ プルリクを作る」で、その変更を {info?.default_branch ?? "main"} に入れるお願いを出します。</p>
                </>
              ) : (
                <p className="muted">{FILTER_LABELS[filter]}プルリクはありません。</p>
              )}
            </div>
          ) : (
            shown.map((p) => {
              const s = pullStatus(p);
              const v = verdicts[String(p.number)];
              const ck = s === "open" || s === "draft" ? checks[p.head_sha] : undefined;
              const links = closingIssues(p.body);
              return (
                <button
                  key={p.number}
                  type="button"
                  role="listitem"
                  className={`pr-item${selected === p.number ? " on" : ""}`}
                  onClick={() => pick(p.number)}
                >
                  <div className="pr-item-title">
                    <span className="muted">#{p.number}</span> {p.title}
                  </div>
                  <div className="pr-item-meta">
                    <span className={`pr-state s-${s}`}>{STATUS_LABELS[s]}</span>
                    <span className="pr-branch" title={`${p.head} → ${p.base}`}>
                      {p.head} → {p.base}
                    </span>
                    {links.map((n) => (
                      <span key={n} className="pr-item-link" title={issueTitle(n) ?? undefined}>
                        🔗 #{n}
                      </span>
                    ))}
                  </div>
                  <div className="pr-item-meta">
                    {v && v.approved.length > 0 && <span className="ok">✔ 承認 {v.approved.length}</span>}
                    {v && v.changes_requested.length > 0 && <span className="ng">✖ 修正の依頼 {v.changes_requested.length}</span>}
                    {ck && ck.failure > 0 && <span className="ng">✖ チェック {ck.failure}</span>}
                    {ck && ck.failure === 0 && ck.pending > 0 && <span className="t-wait">● チェック中</span>}
                    {ck && ck.failure === 0 && ck.pending === 0 && ck.success > 0 && <span className="ok">✔ チェック</span>}
                    {s === "open" && v && v.approved.length === 0 && v.changes_requested.length === 0 && (
                      <span className="muted">{p.requested_reviewers.length > 0 ? `レビュー待ち（${p.requested_reviewers.map((r) => r.login).join("、")}）` : "レビューまだ"}</span>
                    )}
                    <span className="grow" />
                    <span className="muted">
                      {p.user?.login ?? ""}・{ago(s === "merged" ? p.merged_at : p.updated_at)}
                    </span>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>

      <div className="pulls-detail">
        {selected !== null ? (
          <PullDetail
            key={selected}
            owner={owner}
            repo={repo}
            number={selected}
            currentUser={currentUser}
            collaborators={collaborators}
            info={info}
            issueTitle={issueTitle}
            onOpenIssue={onOpenIssue}
            onBack={() => pick(null)}
            onChanged={load}
            onMerged={onMerged}
            onFixLocally={onFixLocally}
            onOpenRun={onOpenRun}
          />
        ) : (
          <div className="pulls-intro">
            <h3>プルリク（プルリクエスト）とは</h3>
            <p>
              「このブランチの変更を <code>{info?.default_branch ?? "main"}</code> に入れてください」というお願いです。チームの人が変更を見て（レビュー）、
              よければ <b>マージ</b>（合流）します。
            </p>
            <ol className="pulls-steps">
              <li>ブランチで作業して、コミット・プッシュする（作業タブ）</li>
              <li>「＋ プルリクを作る」でお願いを出す（Issue とつなげると、マージで閉じます）</li>
              <li>チームの人が「変更されたファイル」を見て、承認・修正の依頼・コメント</li>
              <li>よければマージ。ブランチを片づけて完了</li>
            </ol>
            <p className="muted">左の一覧から選ぶと、ここに会話・変更されたファイル・コミットが出ます。</p>
          </div>
        )}
      </div>

      {create && (
        <CreatePullDialog
          owner={owner}
          repo={repo}
          currentUser={currentUser}
          info={info}
          collaborators={collaborators}
          issues={issues}
          existing={pulls}
          initialHead={create.head}
          initialIssue={create.issue}
          onOpenExisting={(n) => {
            setCreate(null);
            onSelect(n);
          }}
          onCreated={(p, warning) => {
            setCreate(null);
            setNotice(warning ? `#${p.number} を作りました。${warning}` : null);
            setFilter("open");
            load();
            onSelect(p.number);
          }}
          onClose={() => setCreate(null)}
        />
      )}
    </div>
  );
}
