import { useContext, useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { GitHubIssue } from "../../lib/types";
import { issueRef } from "../../lib/issueRef";
import { githubMessage, isSameRepo, repoOf } from "../../lib/subIssues";
import { IssueIndexContext, useParentOf } from "./SubIssueMarks";

/** サブイシューの読み書き（useGitHub のもの） */
export interface SubIssueApi {
  list: (parent: number) => Promise<GitHubIssue[]>;
  create: (parent: GitHubIssue, title: string) => Promise<GitHubIssue>;
  add: (parent: number, child: GitHubIssue) => Promise<void>;
  remove: (parent: number, child: GitHubIssue) => Promise<void>;
}

interface SubIssuesProps {
  issue: GitHubIssue;
  /** 「既存の Issue をつなぐ」の候補（開いている・閉じた Issue） */
  allIssues: GitHubIssue[];
  api: SubIssueApi;
  /** 子の詳細を開く（一覧にまだない子のときは、その子の中身も渡す） */
  onOpenIssue: (n: number, fallback?: GitHubIssue) => void;
  onCloseIssue: (n: number) => Promise<void>;
  onReopenIssue: (n: number) => Promise<void>;
}

/** 詳細のいちばん上の「↑ 親」。押すと親の詳細へ（ほかのリポジトリの親は GitHub で開く） */
export function ParentCrumb({ issue, onOpenIssue }: { issue: GitHubIssue; onOpenIssue: (n: number) => void }) {
  const parent = useParentOf(issue);
  if (!parent) return null;
  return (
    <button
      type="button"
      className="parent-crumb"
      title={parent.sameRepo ? "親の Issue を開く" : "親の Issue を GitHub で開く"}
      onClick={() => (parent.sameRepo ? onOpenIssue(parent.number) : openUrl(parent.htmlUrl))}
    >
      ↑ 親：{parent.label} {parent.title}
    </button>
  );
}

/** Issue の詳細の「🧩 サブイシュー」：子の一覧と進み具合。子を作る・既存の Issue をつなぐ・外す */
export function SubIssues({ issue, allIssues, api, onOpenIssue, onCloseIssue, onReopenIssue }: SubIssuesProps) {
  const index = useContext(IssueIndexContext);
  const [children, setChildren] = useState<GitHubIssue[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);

  const known = issue.sub_issues_summary?.total;
  useEffect(() => {
    let alive = true;
    setMessage(null);
    setLoadError(null);
    // 子がいないと分かっているときは、聞きに行かない
    if (known === 0) {
      setChildren([]);
      return;
    }
    setChildren(null);
    api
      .list(issue.number)
      .then((list) => alive && setChildren(list))
      .catch((e) => {
        if (!alive) return;
        setChildren([]);
        setLoadError(githubMessage(e));
      });
    return () => {
      alive = false;
    };
    // 開いた Issue が変わったときだけ読み直す（子の数は、つないだ・外したときに手元で合わせる）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issue.number]);

  const list = children ?? [];
  const inThisRepo = (c: GitHubIssue) => {
    const r = repoOf(c);
    return !r || isSameRepo(r, index.owner, index.repo);
  };
  // 同じリポジトリの子は、手元の一覧の内容（閉じた・開いたをすぐ映す）を使う
  const rows = list.map((c) => (inThisRepo(c) ? { ...c, ...(index.find(c.number) ?? {}) } : c));
  const done = rows.filter((c) => c.state === "closed").length;
  const percent = rows.length ? Math.round((done / rows.length) * 100) : 0;

  const query = text.trim().toLowerCase();
  const numberQuery = query.match(/^#?(\d+)$/)?.[1];
  const candidates = linking && query
    ? allIssues
        .filter((i) => i.number > 0 && i.number !== issue.number && !list.some((c) => c.number === i.number && inThisRepo(c)))
        .filter((i) => (numberQuery ? String(i.number).includes(numberQuery) : i.title.toLowerCase().includes(query)))
        .slice(0, 6)
    : [];

  async function run(work: () => Promise<string>) {
    setBusy(true);
    setMessage(null);
    try {
      setMessage({ text: await work() });
    } catch (e) {
      setMessage({ text: githubMessage(e), error: true });
    } finally {
      setBusy(false);
    }
  }

  function create() {
    const title = text.trim();
    if (!title || busy) return;
    run(async () => {
      const child = await api.create(issue, title);
      setChildren((prev) => [...(prev ?? []), child]);
      setText("");
      return `${issueRef(child.number)} を作って、子にしました`;
    });
  }

  function link(candidate: GitHubIssue) {
    run(async () => {
      await api.add(issue.number, candidate);
      setChildren((prev) => [...(prev ?? []), candidate]);
      setText("");
      return `${issueRef(candidate.number)} を子にしました`;
    });
  }

  function unlink(child: GitHubIssue) {
    run(async () => {
      await api.remove(issue.number, child);
      setChildren((prev) => (prev ?? []).filter((c) => c.id !== child.id));
      return `${issueRef(child.number)} を子から外しました（Issue はそのまま残ります）`;
    });
  }

  function toggle(child: GitHubIssue) {
    run(async () => {
      if (child.state === "closed") await onReopenIssue(child.number);
      else await onCloseIssue(child.number);
      const state = child.state === "closed" ? "open" : "closed";
      setChildren((prev) => (prev ?? []).map((c) => (c.number === child.number ? { ...c, state } : c)));
      return state === "closed" ? `${issueRef(child.number)} をクローズしました` : `${issueRef(child.number)} をリオープンしました`;
    });
  }

  return (
    <div className="sub-issues">
      <div className="sub-issues-head">
        🧩 サブイシュー
        {rows.length > 0 && (
          <span className="sub-issues-count">
            {done} / {rows.length} 完了
          </span>
        )}
      </div>
      {rows.length > 0 && (
        <div className="sub-issues-bar">
          <i style={{ width: `${percent}%` }} />
        </div>
      )}

      {children === null && <p className="sub-issues-note">読み込み中…</p>}
      {loadError && <p className="sub-issues-note sub-issues-note--error">{loadError}</p>}
      {rows.length > 0 && (
        <ul className="sub-issues-list">
          {rows.map((c) => {
            const same = inThisRepo(c);
            const status = c.labels?.find((l) => l.name.startsWith("状態:"))?.name.split(":")[1];
            return (
              <li key={c.id ?? c.number} className={`sub-issue${c.state === "closed" ? " sub-issue--closed" : ""}`}>
                <button
                  type="button"
                  className="sub-issue-state"
                  disabled={busy || !same}
                  title={c.state === "closed" ? "リオープンする" : "クローズする"}
                  onClick={() => toggle(c)}
                >
                  {c.state === "closed" ? "✔" : "○"}
                </button>
                <span className="sub-issue-number">{same ? issueRef(c.number) : `${repoOf(c)?.repo ?? ""}#${c.number}`}</span>
                <button
                  type="button"
                  className="sub-issue-title"
                  title={same ? "この子の詳細を開く" : "GitHub で開く（ほかのリポジトリの Issue）"}
                  onClick={() => (same ? onOpenIssue(c.number, c) : c.html_url && openUrl(c.html_url))}
                >
                  {c.title}
                </button>
                {status && c.state !== "closed" && <span className="sub-issue-status">{status}</span>}
                <button
                  type="button"
                  className="sub-issue-remove"
                  disabled={busy}
                  title="親子のつながりを外す（Issue は消えません）"
                  aria-label={`${issueRef(c.number)} を子から外す`}
                  onClick={() => unlink(c)}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="sub-issues-add">
        <input
          className="input-full"
          value={text}
          disabled={busy}
          placeholder={linking ? "番号かタイトルで探す（例：#42）" : "子の Issue を作る（タイトルを入れて Enter）"}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (linking) {
                if (candidates.length === 1) link(candidates[0]);
              } else create();
            }
          }}
        />
        <button
          type="button"
          className="link-button"
          disabled={busy}
          onClick={() => {
            setLinking((v) => !v);
            setText("");
          }}
        >
          {linking ? "新しく作る" : "既存の Issue をつなぐ…"}
        </button>
        {candidates.length > 0 && (
          <div className="suggestion-dropdown sub-issues-suggest">
            {candidates.map((s) => {
              const other = otherParentOf(s, issue.number);
              return (
                <button key={s.number} type="button" className="suggestion-item" onMouseDown={(e) => e.preventDefault()} onClick={() => link(s)}>
                  <span className={`suggestion-state suggestion-state--${s.state}`}>{s.state === "open" ? "●" : "○"}</span>
                  <span className="suggestion-number">{issueRef(s.number)}</span>
                  <span className="suggestion-title">{s.title}</span>
                  {other && <span className="sub-issues-moving">{other} の子 → 付け替え</span>}
                </button>
              );
            })}
          </div>
        )}
      </div>
      {busy && (
        <p className="sub-issues-note">
          <i className="spinner" aria-hidden="true" /> GitHub に送っています…
        </p>
      )}
      {message && <p className={`sub-issues-note${message.error ? " sub-issues-note--error" : " sub-issues-note--ok"}`}>{message.text}</p>}
      <p className="hint">
        <b>サブイシュー</b>は、大きな Issue を小さく分けた「子」の Issue です。GitHub の画面でも同じ親子で見えます。× は親子のつながりを外すだけで、Issue
        は消えません。子を全部クローズしても、親は自動では閉じません。
      </p>
    </div>
  );
}

/** つなごうとしている Issue に、ほかの親があるなら、その番号（付け替えになることを見せる） */
function otherParentOf(candidate: GitHubIssue, parent: number): string | null {
  const m = candidate.parent_issue_url?.match(/\/issues\/(\d+)$/);
  if (!m || Number(m[1]) === parent) return null;
  return `#${m[1]}`;
}
