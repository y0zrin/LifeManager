import { Fragment, useState, type ReactNode } from "react";
import {
  ago,
  commentPull,
  firstLine,
  reviewPull,
  type PullDetail,
  type PullEvent,
  type PullFile,
  type ReviewEvent,
} from "../../lib/pulls";
import { countOf } from "../../lib/count";

interface PullConversationProps {
  owner: string;
  repo: string;
  pull: PullDetail;
  currentUser: string;
  files: PullFile[] | null;
  /** Issue の題名（#45 を押せるように） */
  issueTitle: (n: number) => string | null;
  onOpenIssue: (n: number) => void;
  onOpenFiles: (file?: string) => void;
  onOpenCommit: (sha: string, subject: string, author: string, date: string) => void;
  onChanged: () => void;
  /** 会話のいちばん下（マージの箱） */
  footer?: ReactNode;
}

/** 本文の #45 を押せるようにする（知っている Issue だけ） */
export function RichText({ text, issueTitle, onOpenIssue }: { text: string; issueTitle: (n: number) => string | null; onOpenIssue: (n: number) => void }) {
  const parts = text.split(/(#\d+)/);
  return (
    <>
      {parts.map((part, i) => {
        const m = /^#(\d+)$/.exec(part);
        const n = m ? Number(m[1]) : null;
        const title = n !== null ? issueTitle(n) : null;
        return title !== null && n !== null ? (
          <button key={i} type="button" className="pr-ref" title={title} onClick={() => onOpenIssue(n)}>
            {part}
          </button>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        );
      })}
    </>
  );
}

function Avatar({ login }: { login: string | undefined }) {
  const name = login ?? "?";
  // 名前から色を決める（同じ人はいつも同じ色）
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return (
    <span className="pr-avatar" style={{ background: `hsl(${h} 45% 42%)` }} aria-hidden="true">
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

const REVIEW_TEXT: Record<string, { text: string; tone: string }> = {
  APPROVED: { text: "✔ 承認しました", tone: "ok" },
  CHANGES_REQUESTED: { text: "✖ 修正を依頼しました", tone: "ng" },
  COMMENTED: { text: "💬 レビューしました", tone: "" },
  DISMISSED: { text: "レビュー（取り下げ）", tone: "muted" },
};

type Item = { kind: "one"; e: PullEvent } | { kind: "commits"; at: string | null; commits: PullEvent[] };

/** 続けて入ったコミットを 1 つにまとめる */
function group(events: PullEvent[]): Item[] {
  const out: Item[] = [];
  for (const e of events) {
    const last = out[out.length - 1];
    if (e.event === "committed") {
      if (last && last.kind === "commits") last.commits.push(e);
      else out.push({ kind: "commits", at: e.at, commits: [e] });
    } else {
      out.push({ kind: "one", e });
    }
  }
  return out;
}

/** 会話（本文・変更の要約・コメント・レビュー・出来事）と、書く欄 */
export function PullConversation(props: PullConversationProps) {
  const { owner, repo, pull, currentUser, files, issueTitle, onOpenIssue, onOpenFiles, onOpenCommit, onChanged, footer } = props;
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const author = pull.user?.login ?? "";
  const mine = author !== "" && author === currentUser;
  const open = pull.state === "open";
  const rich = (text: string) => <RichText text={text} issueTitle={issueTitle} onOpenIssue={onOpenIssue} />;

  async function send(kind: "comment" | ReviewEvent) {
    setBusy(kind);
    setError(null);
    try {
      if (kind === "comment") await commentPull(owner, repo, pull.number, body);
      else await reviewPull(owner, repo, pull.number, kind, body);
      setBody("");
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  const line = (icon: string, text: ReactNode, at: string | null, tone = "") => (
    <div className={`pr-event ${tone}`}>
      <span className="pr-event-icon" aria-hidden="true">{icon}</span>
      <span className="pr-event-text">{text}</span>
      <span className="muted">{ago(at)}</span>
    </div>
  );
  const who = (e: PullEvent) => <b>{e.actor?.login ?? "だれか"}</b>;

  function render(item: Item, i: number) {
    if (item.kind === "commits") {
      return (
        <div key={i} className="pr-commits">
          {line("●", <>{countOf(item.commits.length, "件")}のコミットを足しました</>, item.at)}
          <ul>
            {item.commits.map((c) => (
              <li key={c.sha}>
                <button type="button" className="link-button" onClick={() => onOpenCommit(c.sha ?? "", firstLine(c.message ?? ""), c.author_name ?? "", c.at ?? "")}>
                  <code>{(c.sha ?? "").slice(0, 7)}</code>
                </button>{" "}
                {firstLine(c.message ?? "")}
              </li>
            ))}
          </ul>
        </div>
      );
    }
    const e = item.e;
    switch (e.event) {
      case "commented":
        return (
          <div key={i} className="pr-bubble-row">
            <Avatar login={e.actor?.login} />
            <div className="pr-bubble">
              <div className="pr-bubble-head">
                {who(e)} <span className="muted">{ago(e.at)}</span>
              </div>
              <div className="pr-text">{rich(e.body ?? "")}</div>
            </div>
          </div>
        );
      case "reviewed": {
        const r = REVIEW_TEXT[e.state ?? ""] ?? REVIEW_TEXT.COMMENTED;
        return (
          <div key={i} className={`pr-bubble-row review ${r.tone}`}>
            <Avatar login={e.actor?.login} />
            <div className="pr-bubble">
              <div className="pr-bubble-head">
                {who(e)} が <span className={r.tone}>{r.text}</span> <span className="muted">{ago(e.at)}</span>
              </div>
              {e.body && <div className="pr-text">{rich(e.body)}</div>}
              {(e.comments ?? []).map((c) => (
                <div key={c.id} className="pr-line-comment">
                  <button type="button" className="link-button" onClick={() => onOpenFiles(c.path)} title="変更されたファイルで見る">
                    📄 {c.path}
                    {c.line !== null && `:${c.line}`}
                  </button>
                  {c.outdated && <span className="muted">（そのあと変わった行）</span>}
                  <pre className="pr-hunk">{c.diff_hunk.split("\n").slice(-3).join("\n")}</pre>
                  <div className="pr-text">{c.body}</div>
                </div>
              ))}
            </div>
          </div>
        );
      }
      case "merged":
        return <Fragment key={i}>{line("🟣", <>{who(e)} が <code>{(e.commit_id ?? "").slice(0, 7)}</code> で <code>{pull.base}</code> にマージしました</>, e.at, "merged")}</Fragment>;
      case "closed":
        return <Fragment key={i}>{line("🔴", <>{who(e)} が閉じました</>, e.at)}</Fragment>;
      case "reopened":
        return <Fragment key={i}>{line("🟢", <>{who(e)} が開き直しました</>, e.at)}</Fragment>;
      case "head_ref_deleted":
        return <Fragment key={i}>{line("🗑", <>{who(e)} がブランチ <code>{pull.head}</code> を消しました</>, e.at)}</Fragment>;
      case "head_ref_restored":
        return <Fragment key={i}>{line("↩", <>{who(e)} がブランチ <code>{pull.head}</code> を戻しました</>, e.at)}</Fragment>;
      case "head_ref_force_pushed":
        return <Fragment key={i}>{line("⚠", <>{who(e)} が <code>{pull.head}</code> に強制プッシュしました（コミットを書き換えました）</>, e.at, "warn")}</Fragment>;
      case "review_requested":
        return <Fragment key={i}>{line("👀", <>{who(e)} が <b>{e.reviewer?.login ?? "（チーム）"}</b> にレビューをお願いしました</>, e.at)}</Fragment>;
      case "review_request_removed":
        return <Fragment key={i}>{line("·", <>{who(e)} が <b>{e.reviewer?.login ?? "（チーム）"}</b> へのお願いを取り消しました</>, e.at)}</Fragment>;
      case "review_dismissed":
        return <Fragment key={i}>{line("·", <>{who(e)} がレビューを取り下げました{e.body ? `: ${e.body}` : ""}</>, e.at)}</Fragment>;
      case "ready_for_review":
        return <Fragment key={i}>{line("📣", <>{who(e)} がレビューをお願いできる状態にしました</>, e.at)}</Fragment>;
      case "convert_to_draft":
        return <Fragment key={i}>{line("📝", <>{who(e)} が下書きに戻しました</>, e.at)}</Fragment>;
      case "renamed":
        return <Fragment key={i}>{line("✏️", <>{who(e)} が題名を「{e.from}」から「{e.to}」に変えました</>, e.at)}</Fragment>;
      case "base_ref_changed":
        return <Fragment key={i}>{line("⇄", <>{who(e)} が入れる先のブランチを変えました</>, e.at)}</Fragment>;
      case "cross-referenced": {
        const s = e.source;
        if (!s) return null;
        const here = !s.repo || s.repo.toLowerCase() === `${owner}/${repo}`.toLowerCase();
        return (
          <Fragment key={i}>
            {line(
              "🔗",
              <>
                {who(e)} が{" "}
                {here && !s.pull ? (
                  <button type="button" className="pr-ref" onClick={() => onOpenIssue(s.number)}>
                    #{s.number}
                  </button>
                ) : (
                  <b>{here ? "" : s.repo}#{s.number}</b>
                )}{" "}
                {s.title} で触れました
              </>,
              e.at,
            )}
          </Fragment>
        );
      }
      case "labeled":
      case "unlabeled":
        return <Fragment key={i}>{line("🏷", <>{who(e)} がラベル <b>{e.label?.name}</b> を{e.event === "labeled" ? "付けました" : "外しました"}</>, e.at)}</Fragment>;
      case "assigned":
      case "unassigned":
        return <Fragment key={i}>{line("👤", <>{who(e)} が <b>{e.assignee?.login}</b> を{e.event === "assigned" ? "担当にしました" : "担当から外しました"}</>, e.at)}</Fragment>;
      default:
        return null;
    }
  }

  const added = files?.reduce((n, f) => n + f.additions, 0) ?? pull.additions;
  const deleted = files?.reduce((n, f) => n + f.deletions, 0) ?? pull.deletions;

  return (
    <div className="pr-conversation">
      <div className="pr-bubble-row">
        <Avatar login={author} />
        <div className="pr-bubble">
          <div className="pr-bubble-head">
            <b>{author || "だれか"}</b> <span className="muted">が作りました・{ago(pull.created_at)}</span>
          </div>
          <div className="pr-text">{pull.body.trim() ? rich(pull.body) : <span className="muted">説明はありません。</span>}</div>
        </div>
      </div>

      {/* どのソースをどう変えたか（いちばん大事なので、会話の先頭に） */}
      <div className="pr-files-card">
        <div className="pr-files-card-head">
          <b>変更されたファイル {files?.length ?? pull.changed_files}</b>
          <span className="add">+{added}</span>
          <span className="del">−{deleted}</span>
          <span className="grow" />
          <button type="button" className="btn-sm" onClick={() => onOpenFiles()}>
            差分を見る →
          </button>
        </div>
        {files === null ? (
          <p className="muted">読み込んでいます…</p>
        ) : (
          <ul>
            {files.slice(0, 8).map((f) => (
              <li key={f.filename}>
                <button type="button" className="pr-files-card-item" onClick={() => onOpenFiles(f.filename)} title="このファイルの差分を見る">
                  <span className={`pf-status s-${f.status}`}>{f.status === "added" ? "追加" : f.status === "removed" ? "削除" : f.status === "renamed" ? "名前" : "変更"}</span>
                  <span className="pr-files-card-path">{f.filename}</span>
                  <span className="add">+{f.additions}</span>
                  <span className="del">−{f.deletions}</span>
                </button>
              </li>
            ))}
            {files.length > 8 && <li className="muted">ほか {files.length - 8} ファイル</li>}
          </ul>
        )}
      </div>

      {group(pull.conversation).map(render)}

      <div className="pr-composer">
        <textarea
          rows={3}
          value={body}
          placeholder={open ? "コメントを書く…（承認・修正の依頼にも、ひとこと添えられます）" : "コメントを書く…"}
          onChange={(e) => setBody(e.target.value)}
        />
        {error && <p className="git-dialog-error">{error}</p>}
        <div className="pr-composer-actions">
          {open && mine && <span className="muted">自分のプルリクは承認も修正の依頼もできません</span>}
          <span className="grow" />
          {open && !mine && (
            <>
              <button type="button" className="btn-sm ok" disabled={busy !== null} onClick={() => send("APPROVE")} title="変更を見て、よいと判断したことを伝えます">
                {busy === "APPROVE" ? "送っています…" : "✔ 承認する"}
              </button>
              <button
                type="button"
                className="btn-sm ng"
                disabled={busy !== null || body.trim() === ""}
                onClick={() => send("REQUEST_CHANGES")}
                title={body.trim() === "" ? "何を直してほしいかを書くと押せます" : "直してほしいことを伝えます（直るまでマージしないでほしい）"}
              >
                {busy === "REQUEST_CHANGES" ? "送っています…" : "✖ 修正を依頼する"}
              </button>
            </>
          )}
          <button type="button" className="btn-sm primary" disabled={busy !== null || body.trim() === ""} onClick={() => send("comment")}>
            {busy === "comment" ? "送っています…" : "💬 コメントする"}
          </button>
        </div>
      </div>

      {footer}
    </div>
  );
}
