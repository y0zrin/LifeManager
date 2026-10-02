import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { GitHubIssue, GitHubUser } from "../../lib/types";
import { sparkleNew } from "../../lib/celebrate";
import { isEscape } from "../../lib/keys";
import {
  closingIssues,
  compareBranches,
  createPull,
  firstLine,
  issueOfBranch,
  pullRepoInfo,
  type Comparison,
  type PullRepoInfo,
  type PullSummary,
} from "../../lib/pulls";
import { PullFiles } from "./PullFiles";
import { countOf } from "../../lib/count";

interface CreatePullDialogProps {
  owner: string;
  repo: string;
  currentUser: string;
  /** なければ開いたときに読む */
  info: PullRepoInfo | null;
  collaborators: GitHubUser[];
  /** 開いている Issue（つなげる Issue を選ぶ） */
  issues: GitHubIssue[];
  /** 開いているプルリク（同じブランチのプルリクがもうあるかを見る。わからなければ null） */
  existing: PullSummary[] | null;
  initialHead?: string | null;
  initialIssue?: number | null;
  /** 作った（issue はつないだ Issue。ボードの状態を「チェック待ち」にする） */
  onCreated: (pull: PullSummary, warning: string | null, issue: number | null) => void;
  onOpenExisting?: (n: number) => void;
  onClose: () => void;
}

/** 本文のひな形（何を変えたか・どう確かめたかを書くと、レビューする人が見やすい） */
function template(issue: number | null) {
  return `${issue !== null ? `Closes #${issue}\n\n` : ""}## 何を変えたか\n- \n\n## どう確かめたか\n- \n`;
}

/** 行の数がないファイル（画像・音・3D・フォント・圧縮など） */
const BINARY = /\.(png|jpe?g|gif|bmp|webp|ico|psd|tga|dds|exr|hdr|wav|mp3|ogg|flac|m4a|fbx|obj|glb|gltf|blend|uasset|umap|ttf|otf|woff2?|zip|7z|rar|gz|exe|dll|pdb|lib|a|so|dylib|unitypackage|asset|mp4|mov|pdf)$/i;

/** ＋ プルリクを作る: どのブランチを、どこに入れたいか。作る前に、入るコミットと変更を見られる */
export function CreatePullDialog(props: CreatePullDialogProps) {
  const { owner, repo, currentUser, collaborators, issues, existing, initialHead, initialIssue, onCreated, onOpenExisting, onClose } = props;
  const [info, setInfo] = useState<PullRepoInfo | null>(props.info);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [base, setBase] = useState(props.info?.default_branch ?? "");
  const [head, setHead] = useState(initialHead ?? "");
  const guessIssue = (branch: string) => {
    const n = initialIssue ?? issueOfBranch(branch);
    return n !== null && issues.some((i) => i.number === n) ? n : null;
  };
  const [issue, setIssue] = useState<number | null>(() => guessIssue(initialHead ?? ""));
  const issueTitle = (n: number | null) => issues.find((i) => i.number === n)?.title ?? "";
  const [title, setTitle] = useState(() => issueTitle(guessIssue(initialHead ?? "")));
  const [body, setBody] = useState(() => template(guessIssue(initialHead ?? "")));
  const [draft, setDraft] = useState(false);
  const [reviewers, setReviewers] = useState<string[]>([]);
  const [cmp, setCmp] = useState<Comparison | null>(null);
  const [cmpError, setCmpError] = useState<string | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 自動で入れた題名・本文（自分で書き換えたら、Issue を選び直しても上書きしない）
  const auto = useRef({ title, body });

  useEffect(() => {
    if (info) return;
    pullRepoInfo(owner, repo)
      .then((i) => {
        setInfo(i);
        setBase((b) => b || i.default_branch);
      })
      .catch((e) => setInfoError(String(e)));
  }, [info, owner, repo]);

  // ブランチが 1 つしかなければ、それを選んでおく
  useEffect(() => {
    if (!info || head) return;
    const others = info.branches.filter((b) => b !== (base || info.default_branch));
    if (others.length === 1) chooseHead(others[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info]);

  useEffect(() => {
    setCmp(null);
    setCmpError(null);
    if (!head || !base || head === base) return;
    let alive = true;
    compareBranches(owner, repo, base, head)
      .then((c) => {
        if (!alive) return;
        setCmp(c);
        // 題名が空なら、いちばん新しいコミットの 1 行目
        const last = c.commits[c.commits.length - 1];
        if (last && auto.current.title === title && title === "") {
          const t = firstLine(last.message);
          auto.current.title = t;
          setTitle(t);
        }
      })
      .catch((e) => alive && setCmpError(String(e)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, repo, base, head]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (isEscape(e) && !busy) onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose]);

  function chooseIssue(n: number | null) {
    setIssue(n);
    if (title === auto.current.title) {
      const t = n !== null ? issueTitle(n) : "";
      auto.current.title = t;
      setTitle(t);
    }
    if (body === auto.current.body) {
      const b = template(n);
      auto.current.body = b;
      setBody(b);
    }
  }

  function chooseHead(branch: string) {
    setHead(branch);
    const n = issueOfBranch(branch);
    if (issue === null && n !== null && issues.some((i) => i.number === n)) chooseIssue(n);
  }

  const already = useMemo(
    () => existing?.find((p) => p.state === "open" && p.head === head && p.base === base) ?? null,
    [existing, head, base],
  );
  const candidates = collaborators.filter((c) => c.login !== currentUser);
  const noDiff = cmp !== null && cmp.ahead_by === 0;
  const canCreate = !!head && !!base && head !== base && title.trim() !== "" && !already && !noDiff && !busy;
  const added = cmp?.files.reduce((n, f) => n + f.additions, 0) ?? 0;
  const deleted = cmp?.files.reduce((n, f) => n + f.deletions, 0) ?? 0;
  // 差分が大きいと、GitHub の比べる API は一部のファイルの行の数を 0 で返す（差分の本文もない）。
  // そのときは「以上」を付ける（正しい数は、作ったあとのプルリクに出る）。画像などは、もともと行の数がない
  const uncounted = cmp?.files.filter((f) => f.additions + f.deletions === 0 && !f.patch && f.status !== "renamed" && !BINARY.test(f.filename)).length ?? 0;

  async function submit(button: HTMLElement) {
    setBusy(true);
    setError(null);
    try {
      // つなげる Issue を選んだのに、本文から「Closes #N」を消していたら足す（欄の「マージすると閉じます」のとおりにする）
      const text = issue !== null && !closingIssues(body).includes(issue) ? `Closes #${issue}\n\n${body}` : body;
      const r = await createPull(owner, repo, { title, head, base, body: text, draft, reviewers });
      sparkleNew(button);
      onCreated(r.pull, r.reviewers_error, issue);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  const branches = info?.branches ?? [];

  return createPortal(
    <div className="palette-overlay git-dialog-back" onClick={() => !busy && onClose()}>
      <div className="git-dialog pr-ui pr-dialog" role="dialog" aria-modal="true" aria-label="プルリクを作る" onClick={(e) => e.stopPropagation()}>
        <h3>＋ プルリクを作る</h3>
        {infoError && <p className="git-dialog-error">{infoError}</p>}

        <div className="pr-dialog-branches">
          <label>
            <span className="git-dialog-label">入れたい変更のあるブランチ</span>
            <select className="select-sm" value={head} onChange={(e) => chooseHead(e.target.value)} disabled={!info}>
              <option value="">{info ? "選んでください" : "読み込んでいます…"}</option>
              {branches
                .filter((b) => b !== base)
                .map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
            </select>
          </label>
          <span className="pr-dialog-arrow" aria-hidden="true">→</span>
          <label>
            <span className="git-dialog-label">入れる先</span>
            <select className="select-sm" value={base} onChange={(e) => setBase(e.target.value)} disabled={!info}>
              {branches.map((b) => (
                <option key={b} value={b}>
                  {b}
                  {b === info?.default_branch ? "（既定）" : ""}
                </option>
              ))}
            </select>
          </label>
        </div>
        {initialHead && info && !branches.includes(initialHead) && (
          <p className="git-dialog-error">ブランチ {initialHead} はまだ GitHub にありません。先にプッシュします。</p>
        )}

        {head && base && head !== base && (
          <div className="pr-dialog-compare">
            {cmpError ? (
              <p className="git-dialog-error">{cmpError}</p>
            ) : !cmp ? (
              <p className="muted">違いを読み込んでいます…</p>
            ) : noDiff ? (
              <p className="git-dialog-error">
                <b>{head}</b> には、<b>{base}</b> に無いコミットがありません。先に変更をコミットしてプッシュします。
              </p>
            ) : (
              <>
                <div className="pr-dialog-summary">
                  <span>
                    <b>{cmp.ahead_by}</b> コミット・<b>{cmp.files.length}</b> ファイル <span className="add">+{added}{uncounted > 0 && " 以上"}</span> <span className="del">−{deleted}{uncounted > 0 && " 以上"}</span>
                  </span>
                  {cmp.behind_by > 0 && <span className="muted">（{base} にはこのブランチに無いコミットが {countOf(cmp.behind_by, "件")}あります）</span>}
                  {uncounted > 0 && <span className="muted">（差分が大きいので、{uncounted} ファイルは行の数を数えていません）</span>}
                  <span className="grow" />
                  <button type="button" className="btn-sm" onClick={() => setShowDiff((v) => !v)} aria-expanded={showDiff}>
                    {showDiff ? "差分をたたむ ▴" : "変更を見る ▾"}
                  </button>
                </div>
                <ul className="pr-dialog-commits">
                  {cmp.commits.slice(-5).map((c) => (
                    <li key={c.sha}>
                      <code>{c.sha.slice(0, 7)}</code> {firstLine(c.message)}
                    </li>
                  ))}
                  {cmp.commits.length > 5 && <li className="muted">ほか {cmp.commits.length - 5} コミット</li>}
                </ul>
                {showDiff && (
                  <div className="pr-dialog-diff">
                    <PullFiles files={cmp.files} viewedKey={null} compact />
                  </div>
                )}
              </>
            )}
            {already && (
              <p className="pr-dialog-exists">
                このブランチのプルリクはもうあります: <b>#{already.number} {already.title}</b>{" "}
                {onOpenExisting && (
                  <button type="button" className="btn-sm" onClick={() => onOpenExisting(already.number)}>
                    開く
                  </button>
                )}
              </p>
            )}
          </div>
        )}

        <label>
          <span className="git-dialog-label">つなげる Issue（マージすると閉じます）</span>
          <select className="select-sm" value={issue ?? ""} onChange={(e) => chooseIssue(e.target.value ? Number(e.target.value) : null)}>
            <option value="">なし</option>
            {issues.map((i) => (
              <option key={i.number} value={i.number}>
                #{i.number} {i.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="git-dialog-label">題名</span>
          <input className="git-dialog-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="何をしたか（例: ボスが画面の外に出ないようにする）" />
        </label>
        <label>
          <span className="git-dialog-label">説明</span>
          <textarea className="git-dialog-input pr-dialog-body" rows={7} value={body} onChange={(e) => setBody(e.target.value)} />
        </label>
        {candidates.length > 0 && (
          <div className="pr-dialog-reviewers">
            <span className="git-dialog-label">レビューをお願いする人</span>
            {candidates.map((c) => (
              <label key={c.login} className="pr-dialog-reviewer">
                <input
                  type="checkbox"
                  checked={reviewers.includes(c.login)}
                  onChange={(e) => setReviewers(e.target.checked ? [...reviewers, c.login] : reviewers.filter((r) => r !== c.login))}
                />
                {c.login}
              </label>
            ))}
          </div>
        )}
        <label className="chk pr-dialog-draft">
          <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} />
          <span>下書きにする</span>
        </label>
        {error && <p className="git-dialog-error">{error}</p>}
        <div className="git-dialog-actions">
          <button type="button" className="btn-sm" disabled={busy} onClick={onClose}>
            やめる
          </button>
          <button type="button" className="btn-primary" disabled={!canCreate} onClick={(e) => submit(e.currentTarget)}>
            {busy ? "作っています…" : draft ? "下書きのプルリクを作る" : "プルリクを作る"}
          </button>
        </div>
      </div>
    </div>,
    document.querySelector("main.app") ?? document.body,
  );
}
