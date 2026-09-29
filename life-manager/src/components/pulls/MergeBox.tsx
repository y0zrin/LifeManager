import { useEffect, useState, type ReactNode } from "react";
import { celebrateDone } from "../../lib/celebrate";
import {
  METHOD_LABELS,
  ago,
  deletePullBranch,
  mergePull,
  methodHelp,
  restorePullBranch,
  setPullDraft,
  updatePull,
  updatePullBranch,
  type MergeMethod,
  type PullDetail,
  type PullRepoInfo,
} from "../../lib/pulls";
import type { CommitChecks } from "../../lib/actions";

const METHOD_KEY = "pull-merge-method";

interface MergeBoxProps {
  owner: string;
  repo: string;
  pull: PullDetail;
  info: PullRepoInfo | null;
  currentUser: string;
  /** マージすると閉じる Issue（入れる先が既定のブランチのときだけ） */
  closes: number[];
  /** 読み直す（詳細と一覧） */
  onChanged: () => void;
  /** マージした（Closes で閉じた Issue を読み直す） */
  onMerged?: () => void;
  /** 競合を、この PC の作業フォルダで直す（作業フォルダがあるときだけ） */
  onFixLocally?: () => void;
  /** ブランチの先頭のコミットのチェック（読めないときは null） */
  checks: CommitChecks | null;
  onOpenCheck: (url: string | null | undefined, fallback: string | null | undefined) => void;
}

function loadMethod(): MergeMethod {
  try {
    const v = localStorage.getItem(METHOD_KEY);
    return v === "squash" || v === "rebase" ? v : "merge";
  } catch {
    return "merge";
  }
}

/** マージの箱（会話のいちばん下）。マージできるか・レビューの判断・マージの仕方・閉じる。マージしたあとは、ブランチの片づけ */
export function MergeBox({ owner, repo, pull, info, currentUser, closes, onChanged, onMerged, onFixLocally, checks, onOpenCheck }: MergeBoxProps) {
  const [method, setMethodState] = useState<MergeMethod>(loadMethod);
  const [deleteBranch, setDeleteBranch] = useState(true);
  const [confirming, setConfirming] = useState<"merge" | "close" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    setConfirming(null);
    setError(null);
    setNote(null);
  }, [pull.number]);

  const allowed: MergeMethod[] = info
    ? (["merge", "squash", "rebase"] as MergeMethod[]).filter((m) =>
        m === "merge" ? info.allow_merge_commit : m === "squash" ? info.allow_squash_merge : info.allow_rebase_merge,
      )
    : ["merge", "squash", "rebase"];
  const chosen = allowed.includes(method) ? method : allowed[0] ?? "merge";
  const author = pull.user?.login ?? "";
  const mine = author !== "" && author === currentUser;
  const canPush = info?.can_push ?? false;
  const canDeleteBranch = pull.same_repo && pull.head !== info?.default_branch;

  function setMethod(m: MergeMethod) {
    setMethodState(m);
    try {
      localStorage.setItem(METHOD_KEY, m);
    } catch {
      // 覚えられなくても、今は選べる
    }
  }

  async function run(label: string, task: () => Promise<void>) {
    setBusy(label);
    setError(null);
    setNote(null);
    try {
      await task();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
      setConfirming(null);
    }
  }

  const merge = (button: HTMLElement) =>
    run("マージしています…", async () => {
      const autoDelete = info?.delete_branch_on_merge ?? false;
      const result = await mergePull(owner, repo, pull.number, chosen, pull.head_sha, canDeleteBranch && deleteBranch && !autoDelete ? pull.head : null);
      const also = closes.length > 0 ? `（${closes.map((n) => `#${n}`).join("・")} も閉じました）` : "";
      celebrateDone(`#${pull.number}`, button, `#${pull.number} をマージしました${also}`);
      if (result.branch_error) setNote(`マージしました。${result.branch_error}`);
      onChanged();
      onMerged?.();
    });

  // --- マージしたあと・閉じたあと ---

  if (pull.merged) {
    return (
      <div className="mb mb--merged">
        <div className="mb-status">
          <span className="mb-icon" aria-hidden="true">🟣</span>
          <div>
            <b>マージしました</b>
            <div className="muted">
              {ago(pull.merged_at)}、{pull.merged_by?.login ?? "だれか"} が <code>{pull.head}</code> を <code>{pull.base}</code> に入れました
              {pull.merge_commit_sha && <>（<code>{pull.merge_commit_sha.slice(0, 7)}</code>）</>}
            </div>
          </div>
        </div>
        {pull.same_repo && pull.head_exists === true && (
          <div className="mb-row">
            <span>ブランチ <code>{pull.head}</code> は GitHub に残っています。もう使わなければ、消して片づけます（この PC のブランチは残ります）。</span>
            {canPush && (
              <button type="button" className="btn-sm" disabled={busy !== null} onClick={() => run("消しています…", async () => { await deletePullBranch(owner, repo, pull.head); onChanged(); })}>
                ブランチを消す
              </button>
            )}
          </div>
        )}
        {pull.same_repo && pull.head_exists === false && (
          <div className="mb-row">
            <span className="muted">ブランチ <code>{pull.head}</code> は GitHub から消してあります。</span>
            {canPush && (
              <button type="button" className="btn-sm" disabled={busy !== null} onClick={() => run("戻しています…", async () => { await restorePullBranch(owner, repo, pull.head, pull.head_sha); onChanged(); })}>
                ブランチを戻す
              </button>
            )}
          </div>
        )}
        <p className="hint">
          この PC では、<code>{pull.base}</code> に切り替えてプルすると、この変更が入ります（<code>git switch {pull.base}</code> → <code>git pull</code>）。
        </p>
        {busy && <p className="muted">{busy}</p>}
        {note && <p className="mb-note">{note}</p>}
        {error && <p className="git-dialog-error">{error}</p>}
      </div>
    );
  }

  if (pull.state === "closed") {
    return (
      <div className="mb mb--closed">
        <div className="mb-status">
          <span className="mb-icon" aria-hidden="true">🔴</span>
          <div>
            <b>マージせずに閉じました</b>
            <div className="muted">{ago(pull.closed_at)}。変更は <code>{pull.base}</code> に入っていません。</div>
          </div>
        </div>
        {(canPush || mine) && pull.head_exists !== false && (
          <div className="mb-row">
            <span className="grow" />
            <button type="button" className="btn-sm" disabled={busy !== null} onClick={() => run("開き直しています…", async () => { await updatePull(owner, repo, pull.number, { pullState: "open" }); onChanged(); })}>
              開き直す
            </button>
          </div>
        )}
        {pull.head_exists === false && <p className="muted">ブランチ <code>{pull.head}</code> が消されているので、開き直すには先にブランチを戻します。</p>}
        {error && <p className="git-dialog-error">{error}</p>}
      </div>
    );
  }

  // --- 開いている ---

  const { approved, changes_requested } = pull.verdicts;
  const waiting = pull.requested_reviewers.map((p) => p.login);
  const state = pull.mergeable_state;
  const checking = pull.mergeable === null || state === "unknown";
  const conflict = state === "dirty" || pull.mergeable === false;

  let status: { icon: string; tone: string; title: string; text: ReactNode };
  if (pull.draft) {
    status = { icon: "📝", tone: "draft", title: "下書きです", text: "仕上がったら「レビューをお願いする」にします。下書きのあいだはマージできません。" };
  } else if (checking) {
    status = { icon: "⏳", tone: "wait", title: "マージできるか、GitHub が調べています…", text: "少し待つと表示されます。" };
  } else if (conflict) {
    status = {
      icon: "⚠",
      tone: "bad",
      title: "競合（コンフリクト）があります",
      text: (
        <>
          <code>{pull.base}</code> でも同じところが変わっています。この PC で <code>{pull.base}</code> を <code>{pull.head}</code> に取り込み、
          競合を直してコミット・プッシュすると、マージできるようになります（<code>git switch {pull.head}</code> → <code>git pull</code> →{" "}
          <code>git merge origin/{pull.base}</code> → 直す → コミット → プッシュ）。
        </>
      ),
    };
  } else if (state === "behind") {
    status = {
      icon: "↻",
      tone: "warn",
      title: `${pull.base} に新しいコミットがあります`,
      text: <>先に取り込んで（ブランチを更新して）から、マージします。</>,
    };
  } else if (state === "blocked") {
    status = {
      icon: "🔒",
      tone: "warn",
      title: "まだマージできません",
      text: "ブランチの保護ルールで、承認や、チェックの成功が必要です。",
    };
  } else if (state === "unstable") {
    status = { icon: "⚠", tone: "warn", title: "失敗したチェックがあります", text: "マージはできますが、先に確かめておくと安心です。" };
  } else {
    status = { icon: "✔", tone: "ok", title: "マージできます", text: "競合はありません。" };
  }

  const blocked = pull.draft || checking || conflict;
  const FAILED = ["failure", "timed_out", "action_required", "startup_failure"];
  const failedChecks = checks
    ? [
        ...checks.checks.filter((c) => c.status === "completed" && FAILED.includes(c.conclusion ?? "")).map((c) => ({ name: c.name, url: c.details_url, fallback: c.html_url })),
        ...checks.statuses.filter((s) => s.state === "failure" || s.state === "error").map((s) => ({ name: s.context, url: s.target_url, fallback: s.target_url })),
      ]
    : [];
  const pendingChecks = checks ? checks.checks.filter((c) => c.status !== "completed").length + checks.statuses.filter((s) => s.state === "pending").length : 0;
  const help = methodHelp(chosen, pull.head, pull.base);

  return (
    <div className="mb" id="merge-box">
      <div className="mb-reviews">
        {approved.length > 0 && <span className="ok">✔ 承認: {approved.join("、")}</span>}
        {changes_requested.length > 0 && <span className="ng">✖ 修正の依頼: {changes_requested.join("、")}</span>}
        {approved.length === 0 && changes_requested.length === 0 && (
          <span className="muted">
            {waiting.length > 0
              ? `レビューを待っています（${waiting.join("、")}）`
              : "まだ誰もレビューしていません。ひとりで作っているなら、差分を自分で確かめてからマージしてかまいません。"}
          </span>
        )}
      </div>
      <div className={`mb-status tone-${status.tone}`}>
        <span className="mb-icon" aria-hidden="true">{status.icon}</span>
        <div>
          <b>{status.title}</b>
          <div className="muted">{status.text}</div>
        </div>
      </div>
      {failedChecks.length > 0 && (
        <div className="mb-checks">
          <b className="ng">⚠ 失敗したチェックがあります</b>
          {failedChecks.slice(0, 4).map((c) => (
            <span key={c.name} className="mb-check-item">
              ✖ {c.name}
              <button type="button" className="btn-sm" onClick={() => onOpenCheck(c.url, c.fallback)}>
                ログを見る →
              </button>
            </span>
          ))}
          <span className="muted">
            {state === "blocked" ? "保護ルールで、チェックの成功が決まっています。直すまでマージできません。" : "マージはできますが、先に直すと安心です。"}
          </span>
        </div>
      )}
      {failedChecks.length === 0 && pendingChecks > 0 && <p className="mb-pending">● チェックが動いています（{pendingChecks}）。終わってからマージすると安心です。</p>}
      {conflict && onFixLocally && (
        <div className="mb-row">
          <span>この PC の作業フォルダで取り込むと、作業タブの「競合を直す」で直せます。</span>
          <button type="button" className="btn-sm" onClick={onFixLocally}>
            この PC で直す
          </button>
        </div>
      )}
      {state === "behind" && canPush && (
        <div className="mb-row">
          <span className="muted">GitHub の上で <code>{pull.base}</code> を <code>{pull.head}</code> に取り込みます（マージコミットができます）。</span>
          <button
            type="button"
            className="btn-sm"
            disabled={busy !== null}
            onClick={() => run("更新しています…", async () => { await updatePullBranch(owner, repo, pull.number, pull.head_sha); setNote("ブランチを更新しています。少しすると反映されます。"); window.setTimeout(onChanged, 2500); })}
          >
            ブランチを更新する
          </button>
        </div>
      )}
      {pull.draft && (canPush || mine) && (
        <div className="mb-row">
          <span className="grow" />
          <button type="button" className="btn-sm primary" disabled={busy !== null} onClick={() => run("切り替えています…", async () => { await setPullDraft(pull.node_id, false); onChanged(); })}>
            レビューをお願いする（下書きをやめる）
          </button>
        </div>
      )}

      {canPush && !pull.draft && (
        <div className="mb-merge">
          <div className="mb-methods" role="radiogroup" aria-label="マージの仕方">
            {allowed.map((m) => (
              <label key={m} className={`mb-method${chosen === m ? " on" : ""}`}>
                <input type="radio" name="merge-method" checked={chosen === m} onChange={() => setMethod(m)} />
                {METHOD_LABELS[m]}
              </label>
            ))}
          </div>
          <p className="hint">
            {help.text}。手元でするなら <code>{help.command}</code>
          </p>
          {canDeleteBranch &&
            (info?.delete_branch_on_merge ? (
              <p className="muted">マージすると、ブランチ <code>{pull.head}</code> は GitHub の設定で自動で消えます。</p>
            ) : (
              <label className="mb-check">
                <input type="checkbox" checked={deleteBranch} onChange={(e) => setDeleteBranch(e.target.checked)} />
                マージしたら GitHub のブランチ <code>{pull.head}</code> を消す（あとで戻せます）
              </label>
            ))}
          {closes.length > 0 && <p className="mb-closes">🔗 マージすると {closes.map((n) => `#${n}`).join("・")} も閉じます（本文の Closes）</p>}
          <div className="mb-actions">
            {confirming === "merge" ? (
              <>
                <span className="mb-confirm">
                  <code>{pull.head}</code> を <code>{pull.base}</code> に入れます（{METHOD_LABELS[chosen]}）。よいですか？
                </span>
                <button type="button" className="btn-sm" disabled={busy !== null} onClick={() => setConfirming(null)}>
                  やめる
                </button>
                <button type="button" className="btn-sm merge" disabled={busy !== null} onClick={(e) => merge(e.currentTarget)}>
                  {busy ?? "マージする"}
                </button>
              </>
            ) : (
              <>
                <span className="grow" />
                <button
                  type="button"
                  className="btn-sm merge"
                  disabled={blocked || busy !== null}
                  title={blocked ? "今はマージできません（上の説明を見てください）" : undefined}
                  onClick={() => setConfirming("merge")}
                >
                  マージする…
                </button>
              </>
            )}
          </div>
        </div>
      )}
      {!canPush && info && <p className="muted">マージできるのは、このリポジトリに書き込める人です。</p>}

      {(canPush || mine) && (
        <div className="mb-close">
          {confirming === "close" ? (
            <>
              <span>マージせずに閉じます（あとで開き直せます）。よいですか？</span>
              <button type="button" className="btn-sm" onClick={() => setConfirming(null)}>
                やめる
              </button>
              <button type="button" className="btn-sm danger" disabled={busy !== null} onClick={() => run("閉じています…", async () => { await updatePull(owner, repo, pull.number, { pullState: "closed" }); onChanged(); })}>
                閉じる
              </button>
            </>
          ) : (
            <button type="button" className="link-button" onClick={() => setConfirming("close")}>
              マージせずに閉じる…
            </button>
          )}
        </div>
      )}
      {busy && confirming === null && <p className="muted">{busy}</p>}
      {note && <p className="mb-note">{note}</p>}
      {error && <p className="git-dialog-error">{error}</p>}
    </div>
  );
}
