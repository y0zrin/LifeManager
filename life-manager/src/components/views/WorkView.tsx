import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import * as gitApi from "../../lib/git";
import type { GitFileChange, GitHubIssue, GitLineStat, GitRun, GitStash, GitStatus } from "../../lib/types";
import type { GitState } from "../../hooks/useGit";
import { OPERATION_NAMES, type GitActions } from "../../hooks/useGitActions";
import { useDismiss } from "../../hooks/useDismiss";
import { LocalFolderSetting } from "../common/LocalFolderSetting";
import { DiffView } from "../git/DiffView";

/** コミット欄の書きかけ（画面を切り替えても消えないよう、App で持つ） */
export interface CommitDraft {
  summary: string;
  body: string;
  /** 要約の末尾に Issue 番号を付ける */
  linkIssue: boolean;
  /** マージされたら Issue を閉じる（Closes #N） */
  closes: boolean;
  amend: boolean;
  allowEmpty: boolean;
}

export const EMPTY_DRAFT: CommitDraft = {
  summary: "",
  body: "",
  linkIssue: true,
  closes: false,
  amend: false,
  allowEmpty: false,
};

interface WorkViewProps {
  owner: string;
  repo: string;
  folder: string | undefined;
  onSetFolder: (path: string | null) => Promise<void>;
  git: GitState;
  actions: GitActions;
  /** 未完了の Issue */
  issues: GitHubIssue[];
  onOpenIssue: (n: number) => void;
  onStartIssue: (n: number) => Promise<void>;
  onCloseIssue: (n: number) => Promise<void>;
  draft: CommitDraft;
  onDraftChange: (draft: CommitDraft) => void;
  /** ツールバーの「コミット…」「空コミット…」から来たとき。コミット欄を開いたら onCommitRequestHandled で消してもらう */
  commitRequest: { empty: boolean } | null;
  onCommitRequestHandled: () => void;
}

type Side = "staged" | "unstaged";
type Selected = { path: string; side: Side };
/** 取り組み中の Issue。"none" は「Issue なしで作業する」を選んだとき、null はまだ選んでいないとき */
type IssueChoice = number | "none" | null;

const STEP_NAMES = ["Issue を選ぶ", "ブランチ", "変更", "コミット", "プッシュ", "完了"];
const IN_PROGRESS = "状態:進行中";

// --- 取り組み中の Issue は、リポジトリごとにこの PC に覚えておく ---

function issueKey(owner: string, repo: string) {
  return `work-issue:${owner}/${repo}`;
}

function loadIssueChoice(owner: string, repo: string): IssueChoice {
  try {
    const v = localStorage.getItem(issueKey(owner, repo));
    if (v === "none") return "none";
    const n = Number(v);
    return v && Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

function saveIssueChoice(owner: string, repo: string, choice: IssueChoice) {
  try {
    if (choice === null) localStorage.removeItem(issueKey(owner, repo));
    else localStorage.setItem(issueKey(owner, repo), String(choice));
  } catch {
    // 覚えられなくても、今は選んだ Issue で作業できる
  }
}

// --- 表示の小物 ---

const STATUS_TITLES: Record<string, string> = {
  A: "追加したファイル",
  M: "変更したファイル",
  D: "削除したファイル",
  R: "名前を変えたファイル",
  C: "コピーしたファイル",
  T: "種類が変わったファイル",
  U: "競合（コンフリクト）しているファイル",
  "?": "まだ git が追跡していない新しいファイル",
};

function formatWhen(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function issueMeta(issue: GitHubIssue) {
  return issue.labels.map((l) => l.name).concat(issue.milestone ? [issue.milestone.title] : []).join(" · ");
}

function FilePath({ path, orig }: { path: string; orig?: string | null }) {
  const cut = path.lastIndexOf("/") + 1;
  return (
    <span className="fp" title={orig ? `${orig} → ${path}` : path}>
      {orig && <span className="fp-dir">{orig} → </span>}
      <span className="fp-dir">{path.slice(0, cut)}</span>
      <span className="fp-name">{path.slice(cut)}</span>
    </span>
  );
}

function Lines({ lines }: { lines: GitLineStat | null }) {
  return (
    <>
      <span className="add">{lines ? `+${lines.added}` : ""}</span>
      <span className="del">{lines && lines.deleted > 0 ? `−${lines.deleted}` : ""}</span>
    </>
  );
}

// --- 作業の流れ（Issue → ブランチ → 変更 → コミット → プッシュ → 完了） ---

interface Flow {
  step: number;
  labels: string[];
  hint: ReactNode;
  action: { label: string; run: () => void } | null;
}

export function WorkView(props: WorkViewProps) {
  const { owner, repo, folder, onSetFolder, git: g } = props;

  if (!folder) {
    return (
      <div className="content">
        <div className="work-setup">
          <h2>作業を始める準備</h2>
          <p>
            作業タブでは、取り組む Issue を決めて、ファイルの変更 → コミット → プッシュ までを、実行する git
            のコマンドを見ながら進められます。まず、このリポジトリを置く、この PC 上のフォルダを決めましょう。
          </p>
          <LocalFolderSetting owner={owner} repo={repo} folder={undefined} onSetFolder={onSetFolder} />
        </div>
      </div>
    );
  }

  if (g.loadError) {
    return (
      <div className="content">
        <div className="work-setup">
          <h2>作業フォルダを読めませんでした</h2>
          <p className="local-folder-message local-folder-message--error">{g.loadError}</p>
          <p>フォルダを移動したり消したりした場合は、選び直してください。</p>
          <LocalFolderSetting owner={owner} repo={repo} folder={folder} onSetFolder={onSetFolder} />
        </div>
      </div>
    );
  }

  if (!g.status) {
    return (
      <div className="content">
        <p className="work-loading">読み込んでいます…</p>
      </div>
    );
  }

  return <Workspace {...props} status={g.status} folder={folder} />;
}

function Workspace({
  owner,
  repo,
  folder,
  git: g,
  actions,
  issues,
  onOpenIssue,
  onStartIssue,
  onCloseIssue,
  draft,
  onDraftChange,
  commitRequest,
  onCommitRequestHandled,
  status: st,
}: WorkViewProps & { status: GitStatus; folder: string }) {
  const [choice, setChoiceState] = useState<IssueChoice>(() => loadIssueChoice(owner, repo));
  const [pickerOpen, setPickerOpen] = useState(false);
  const [tab, setTab] = useState<"changes" | "stash">("changes");
  const [selected, setSelected] = useState<Selected | null>(null);
  const [summaryError, setSummaryError] = useState(false);
  const summaryRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setChoiceState(loadIssueChoice(owner, repo));
  }, [owner, repo]);

  function setChoice(c: IssueChoice) {
    setChoiceState(c);
    saveIssueChoice(owner, repo, c);
  }

  const issue = typeof choice === "number" ? issues.find((i) => i.number === choice) ?? null : null;

  // --- ファイルの分類 ---
  const files = st.files;
  const conflicts = files.filter((f) => f.staged === "U");
  const staged = files.filter((f) => f.staged && f.staged !== "U");
  const unstaged = files.filter((f) => f.unstaged && f.staged !== "U");
  const changeCount = files.length;

  // 選んでいたファイルが見えなくなったら（ステージを変えた・コミットした）、同じファイルのもう一方か、先頭を選ぶ
  const all: Selected[] = [
    ...conflicts.map((f) => ({ path: f.path, side: "unstaged" as Side })),
    ...staged.map((f) => ({ path: f.path, side: "staged" as Side })),
    ...unstaged.map((f) => ({ path: f.path, side: "unstaged" as Side })),
  ];
  const current =
    all.find((s) => s.path === selected?.path && s.side === selected.side) ??
    all.find((s) => s.path === selected?.path) ??
    all[0] ??
    null;
  const currentFile = current ? files.find((f) => f.path === current.path) ?? null : null;

  // --- コミット欄を開く（ツールバーの「コミット…」「空コミット…」、流れの「コミット欄へ」） ---
  const focusCommit = useCallback((empty?: boolean) => {
    setTab("changes");
    if (empty !== undefined) onDraftChange({ ...draft, allowEmpty: empty });
    window.setTimeout(() => summaryRef.current?.focus(), 50);
  }, [draft, onDraftChange]);

  useEffect(() => {
    if (!commitRequest) return;
    focusCommit(commitRequest.empty);
    onCommitRequestHandled();
  }, [commitRequest, focusCommit, onCommitRequestHandled]);

  // --- 作業の流れ ---
  const published = !!st.upstream;
  const needsPush = published ? st.ahead > 0 : st.unpushed > 0;
  const defaultBranch = st.default_branch ?? (g.branches.some((b) => b.name === "main") ? "main" : "master");
  const onDefault = !!st.branch && st.branch === defaultBranch;
  const lastCommit = g.lastCommit?.branch === st.branch ? g.lastCommit : null;
  const lastPush = g.lastPush?.branch === st.branch ? g.lastPush : null;
  const committedHere = lastCommit !== null;
  const pushedAfterCommit = lastCommit !== null && lastPush !== null && lastPush.at > lastCommit.at;

  const flow: Flow = (() => {
    let step: number;
    if (choice === null || (typeof choice === "number" && !issue)) step = 1;
    else if (changeCount > 0) step = staged.length > 0 ? 4 : 3;
    else if (needsPush) step = 5;
    else if (issue && pushedAfterCommit) step = 6;
    else if (issue && onDefault) step = 2;
    else step = 3;

    const labels = [
      "",
      issue ? `#${issue.number}` : choice === "none" ? "なし" : "未選択",
      st.branch || `切り離し ${st.head}`,
      changeCount ? `${changeCount} ファイル` : "なし",
      changeCount ? `ステージ ${staged.length}` : committedHere ? "済み" : "—",
      !published ? (st.unpushed > 0 ? "未公開" : "—") : st.ahead > 0 ? `↑${st.ahead}` : "済み",
      "Issue を閉じる",
    ];

    const hints: Record<number, ReactNode> = {
      1: <>最初に、何をするか（Issue）を選びます。タスク管理と git の作業が、ここでつながります。</>,
      2: (
        <>
          今は <b>{st.branch}</b> にいます。ブランチは作業する場所です。Issue ごとに分けると、ほかの作業と混ざりません（
          <code>git switch -c</code>）。
        </>
      ),
      3: <>ファイルを編集して、次のコミットに入れる変更にチェックを入れます（<code>git add</code>）。</>,
      4: <>要約を書いて「コミット」を押すと、変更が履歴に記録されます（<code>git commit</code>）。</>,
      5:
        st.behind > 0 ? (
          <>GitHub 側に新しいコミットがあります。先に「プル」で取り込んでから、プッシュします（<code>git pull</code>）。</>
        ) : (
          <>「プッシュ」で、記録したコミットを GitHub に送ります（<code>git push</code>）。</>
        ),
      6: <>GitHub に送れました。Issue を閉じて完了にします。</>,
    };

    let action: Flow["action"] = null;
    if (step === 1) action = { label: "Issue を選ぶ", run: () => setPickerOpen(true) };
    else if (step === 2 && issue) action = { label: "ブランチを作る…", run: () => actions.createBranch(`issue-${issue.number}`) };
    else if (step === 4) action = { label: "コミット欄へ", run: () => focusCommit() };
    else if (step === 5) action = st.behind > 0 ? { label: "プルする", run: actions.pull } : { label: "プッシュする", run: actions.push };
    else if (step === 6 && issue) {
      action = {
        label: `#${issue.number} を完了にする`,
        run: async () => {
          await onCloseIssue(issue.number);
          setChoice(null);
        },
      };
    }
    return { step, labels, hint: hints[step], action };
  })();

  return (
    <div className={`wview${changeCount === 0 ? " no-changes" : ""}${draft.allowEmpty ? " empty" : ""}`}>
      <IssueBar
        issues={issues}
        issue={issue}
        choice={choice}
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onChoose={(c) => { setChoice(c); setPickerOpen(false); }}
        onOpenIssue={onOpenIssue}
        onStartIssue={onStartIssue}
      />

      <ol className="w-flow" aria-label="作業の流れ">
        {STEP_NAMES.map((name, i) => {
          const n = i + 1;
          return (
            <li key={n} className={n < flow.step ? "done" : n === flow.step ? "now" : ""}>
              <i>{n < flow.step ? "✓" : n}</i>
              <b>{name}</b>
              <small>{flow.labels[n]}</small>
            </li>
          );
        })}
      </ol>
      <div className="w-flow-hint">
        <p className="hint">{flow.hint}</p>
        {flow.action && (
          <button type="button" className="btn-sm" disabled={g.busy !== null} onClick={flow.action.run}>
            {flow.action.label}
          </button>
        )}
      </div>

      {(st.conflicted || st.operation) && (
        <div className="w-banner warn">
          <span>
            {st.operation && <b>{OPERATION_NAMES[st.operation]}の途中です。</b>}
            {st.conflicted ? (
              <>
                ⚠ 競合（コンフリクト）しているファイルがあります。エディタで <code>{"<<<<<<<"}</code> と{" "}
                <code>{">>>>>>>"}</code> の間を直して保存し、チェックを入れます（<code>git add</code>）。
              </>
            ) : (
              "競合はすべて直してあります。"
            )}
            {st.operation === "merge"
              ? "そのあとコミットすると、マージが完了します。"
              : st.operation
                ? <>そのあと「続ける」を押します（<code>git {st.operation} --continue</code>）。</>
                : "そのあとコミットします。"}
          </span>
          {st.operation && st.operation !== "merge" && (
            <button type="button" className="btn-sm" disabled={st.conflicted || g.busy !== null} onClick={actions.continueOperation}>
              続ける
            </button>
          )}
          {st.operation && (
            <button type="button" className="btn-sm" disabled={g.busy !== null} onClick={actions.abortOperation}>
              {OPERATION_NAMES[st.operation]}を中止…
            </button>
          )}
        </div>
      )}
      {!st.branch && st.head && (
        <div className="w-banner">
          <span>
            ブランチから切り離された状態です（<code>{st.head}</code>）。ここでコミットしても、どのブランチにも属しません。
          </span>
          <button type="button" className="btn-sm" onClick={() => actions.createBranch()}>
            ここからブランチを作成…
          </button>
        </div>
      )}

      <div className="w-body">
        <div className="w-left">
          <div className="w-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === "changes"} className={`w-tab${tab === "changes" ? " on" : ""}`} onClick={() => setTab("changes")}>
              変更 <span className="count">{changeCount}</span>
            </button>
            <button type="button" role="tab" aria-selected={tab === "stash"} className={`w-tab${tab === "stash" ? " on" : ""}`} onClick={() => setTab("stash")}>
              退避中 <span className="count">{g.stashes.length}</span>
            </button>
          </div>

          {tab === "changes" ? (
            <ChangesPane
              conflicts={conflicts}
              staged={staged}
              unstaged={unstaged}
              selected={current}
              onSelect={setSelected}
              actions={actions}
              lastCommand={g.lastCommand}
              onEmptyCommit={() => focusCommit(true)}
            />
          ) : (
            <StashPane stashes={g.stashes} actions={actions} busy={g.busy !== null} />
          )}

          <CommitForm
            status={st}
            issue={issue}
            stagedCount={staged.length}
            hasConflicts={conflicts.length > 0}
            draft={draft}
            onDraftChange={(d) => { setSummaryError(false); onDraftChange(d); }}
            summaryRef={summaryRef}
            summaryError={summaryError}
            busy={g.busy !== null}
            onCommit={async (messages, push) => {
              if (!draft.summary.trim()) {
                setSummaryError(true);
                summaryRef.current?.focus();
                return;
              }
              const r = await actions.commit(messages, draft.amend, draft.allowEmpty);
              if (!r.ok) return;
              onDraftChange({ ...draft, summary: "", body: "", closes: false, amend: false, allowEmpty: false });
              if (push) await actions.push();
            }}
          />
        </div>

        <div className="w-right">
          {current && currentFile ? (
            <FileDiff folder={folder} file={currentFile} side={current.side} />
          ) : (
            <div className="w-right-empty">表示する差分はありません</div>
          )}
        </div>
      </div>
    </div>
  );
}

// --- 取り組み中の Issue ---

interface IssueBarProps {
  issues: GitHubIssue[];
  issue: GitHubIssue | null;
  choice: IssueChoice;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChoose: (choice: IssueChoice) => void;
  onOpenIssue: (n: number) => void;
  onStartIssue: (n: number) => Promise<void>;
}

function IssueBar({ issues, issue, choice, open, onOpenChange, onChoose, onOpenIssue, onStartIssue }: IssueBarProps) {
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  useDismiss(ref, open, close);

  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  const q = query.trim().toLowerCase().replace(/^#/, "");
  const inProgress = (i: GitHubIssue) => i.labels.some((l) => l.name === IN_PROGRESS);
  // 進行中を先に、あとは新しい順
  const list = [...issues]
    .sort((a, b) => Number(inProgress(b)) - Number(inProgress(a)) || b.number - a.number)
    .filter((i) => !q || String(i.number).startsWith(q) || i.title.toLowerCase().includes(q));

  const missing = typeof choice === "number" && !issue;

  return (
    <div className="w-issue">
      <span className="wi-label">取り組み中の Issue</span>
      <div className="wi-pick" ref={ref}>
        <button
          type="button"
          className={`wi-btn${open ? " open" : ""}`}
          title={issue ? issueMeta(issue) : ""}
          onClick={() => onOpenChange(!open)}
        >
          <span className="wi-num">{issue ? `#${issue.number}` : missing ? `#${choice}` : "—"}</span>
          <span className="wi-title">
            {issue ? issue.title : missing ? "（閉じられたか、見つかりません）" : choice === "none" ? "Issue なしで作業中" : "Issue を選んでください"}
          </span>
          <span className="wi-caret">▾</span>
        </button>
        {open && (
          <div className="wi-panel popover">
            <input
              className="input-full bsw-filter"
              placeholder="番号やタイトルで絞り込む"
              autoFocus
              autoComplete="off"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && list[0]) onChoose(list[0].number); }}
            />
            <div className="bsw-group">未完了の Issue</div>
            {list.map((i) => (
              <button key={i.number} type="button" className={`wi-item${i.number === choice ? " on" : ""}`} onClick={() => onChoose(i.number)}>
                <span className="wi-num">#{i.number}</span>
                <span className="wi-t">{i.title}</span>
                <span className="wi-m">{inProgress(i) ? "進行中" : i.milestone?.title ?? ""}</span>
              </button>
            ))}
            {list.length === 0 && <div className="bsw-empty">一致する Issue はありません</div>}
            <hr />
            <button type="button" className={`wi-item${choice === "none" ? " on" : ""}`} onClick={() => onChoose("none")}>
              <span className="wi-num">—</span>
              <span className="wi-t">Issue なしで作業する</span>
              <span />
            </button>
          </div>
        )}
      </div>
      {issue && <span className="wi-meta">{issueMeta(issue)}</span>}
      {issue && (
        <span className="wi-actions">
          <button type="button" className="btn-sm" onClick={() => onOpenIssue(issue.number)}>
            Issue を開く
          </button>
          {!inProgress(issue) && (
            <button type="button" className="btn-sm" onClick={() => onStartIssue(issue.number)}>
              進行中にする
            </button>
          )}
        </span>
      )}
    </div>
  );
}

// --- 変更のあるファイル ---

interface ChangesPaneProps {
  conflicts: GitFileChange[];
  staged: GitFileChange[];
  unstaged: GitFileChange[];
  selected: Selected | null;
  onSelect: (s: Selected) => void;
  actions: GitActions;
  lastCommand: string | null;
  onEmptyCommit: () => void;
}

function ChangesPane({ conflicts, staged, unstaged, selected, onSelect, actions, lastCommand, onEmptyCommit }: ChangesPaneProps) {
  const total = conflicts.length + staged.length + unstaged.length;

  const row = (f: GitFileChange, side: Side, conflict = false) => {
    const letter = conflict ? "U" : side === "staged" ? f.staged : f.unstaged;
    const lines = side === "staged" ? f.staged_lines : f.unstaged_lines;
    const isSel = selected?.path === f.path && selected.side === side;
    // ステージから外すときは、名前の変更の元のパスも一緒に戻す
    const toggle = () =>
      side === "staged"
        ? actions.unstage(f.orig_path ? [f.path, f.orig_path] : [f.path])
        : actions.stage([f.path]);
    return (
      <div key={`${side}:${f.path}`} className={`fr${isSel ? " sel" : ""}`} onClick={() => onSelect({ path: f.path, side })}>
        <input
          type="checkbox"
          checked={side === "staged"}
          aria-label={side === "staged" ? "ステージから外す" : conflict ? "直したので、ステージする" : "ステージする"}
          onClick={(e) => e.stopPropagation()}
          onChange={toggle}
        />
        <span className={`st st-${letter === "?" ? "N" : letter}`} title={STATUS_TITLES[letter] ?? letter}>
          {letter}
        </span>
        <FilePath path={f.path} orig={f.orig_path} />
        <Lines lines={lines} />
      </div>
    );
  };

  return (
    <div className="w-pane">
      <p className="hint">
        チェックを入れたファイル（ステージ済み）が、次のコミットに入ります。チェックを入れるのは <code>git add</code>、外すのは{" "}
        <code>git restore --staged</code> にあたります。
      </p>
      {total === 0 ? (
        <div className="ws-none">
          作業中の変更はありません。ファイルを編集すると、ここに表示されます。
          <button type="button" className="btn-sm" onClick={onEmptyCommit}>
            空コミット…
          </button>
        </div>
      ) : (
        <div className="dr-files">
          {conflicts.length > 0 && (
            <>
              <div className="dr-sec warn">競合<span className="count">{conflicts.length}</span></div>
              {conflicts.map((f) => row(f, "unstaged", true))}
            </>
          )}
          <div className="dr-sec">
            ステージ済み<span className="count">{staged.length}</span>
            {staged.length > 0 && (
              <button type="button" className="sec-btn" onClick={() => actions.unstage(["."])} title="git restore --staged -- .">
                すべて外す
              </button>
            )}
          </div>
          {staged.map((f) => row(f, "staged"))}
          <div className="dr-sec">
            未ステージ<span className="count">{unstaged.length}</span>
            {unstaged.length > 0 && (
              <button type="button" className="sec-btn" onClick={() => actions.stage(["."])} title="git add -- .">
                すべてステージ
              </button>
            )}
          </div>
          {unstaged.map((f) => row(f, "unstaged"))}
          <div className="dr-empty-note">空コミットでは、ファイルの変更は含めません</div>
        </div>
      )}
      {lastCommand && (
        <p className="hint w-last-cmd">
          直前に実行したコマンド: <code>{lastCommand}</code>
        </p>
      )}
    </div>
  );
}

// --- 退避中の変更 ---

function StashPane({ stashes, actions, busy }: { stashes: GitStash[]; actions: GitActions; busy: boolean }) {
  return (
    <div className="w-pane">
      <p className="hint">
        退避（スタッシュ）は、コミットせずに変更を一時的にしまっておく機能です。ブランチを切り替えるときなどに使います（
        <code>git stash</code>）。
      </p>
      <div className="ws-stash">
        {stashes.length === 0 && <span className="ws-stash-none">退避中の変更はありません</span>}
        {stashes.map((s) => (
          <div key={s.index} className="ws-stash-item">
            <div className="ws-stash-msg" title={s.message}>{s.message}</div>
            <div className="ws-stash-row">
              <span className="ws-stash-ref">stash@{`{${s.index}}`}</span>
              <span className="ws-stash-when">{formatWhen(s.date)}</span>
              {s.files !== null && <span className="chip muted">{s.files === 0 ? "中身は空" : `${s.files} ファイル`}</span>}
              <span className="ws-stash-actions">
                <button type="button" className="btn-sm" disabled={busy} onClick={() => actions.stashPop(s.index)} title={`git stash pop stash@{${s.index}}`}>
                  戻す
                </button>
                <button type="button" className="btn-sm" disabled={busy} onClick={() => actions.stashDrop(s)}>
                  削除…
                </button>
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// --- コミット欄 ---

interface CommitFormProps {
  status: GitStatus;
  issue: GitHubIssue | null;
  stagedCount: number;
  hasConflicts: boolean;
  draft: CommitDraft;
  onDraftChange: (draft: CommitDraft) => void;
  summaryRef: RefObject<HTMLInputElement | null>;
  summaryError: boolean;
  busy: boolean;
  onCommit: (messages: string[], push: boolean) => void;
}

function CommitForm({
  status: st,
  issue,
  stagedCount,
  hasConflicts,
  draft,
  onDraftChange,
  summaryRef,
  summaryError,
  busy,
  onCommit,
}: CommitFormProps) {
  const set = (patch: Partial<CommitDraft>) => onDraftChange({ ...draft, ...patch });

  // 要約に Issue 番号を付ける（自分で書いてあれば付けない）
  const summary = draft.summary.trim();
  const tag = issue ? `#${issue.number}` : "";
  const withIssue = issue && draft.linkIssue && !summary.includes(tag) ? `${summary} (${tag})` : summary;
  const messages = [withIssue, draft.body.trim(), issue && draft.closes ? `Closes ${tag}` : ""].filter(Boolean);
  const preview = gitApi.displayCommand(
    gitApi.commitArgs(summary ? messages : [issue && draft.linkIssue ? `… (${tag})` : "…", ...messages.slice(1)], draft.amend, draft.allowEmpty),
  );

  // プッシュ済みのコミットを修正すると、送り直すのに強制プッシュが要る。学ぶ段階ではできないようにしておく
  const lastPushed = !!st.head && (st.upstream ? st.ahead === 0 : st.unpushed === 0);
  const nothingToCommit = stagedCount === 0 && !draft.amend && !draft.allowEmpty;
  const blocked = busy || nothingToCommit || hasConflicts || (draft.amend && !st.head);

  return (
    <div className="dr-form">
      <p className="hint">
        コミットは、ステージ済みの変更に要約を付けて、履歴に記録することです（<code>git commit</code>）。
      </p>
      <input
        ref={summaryRef}
        className="input-full"
        placeholder={draft.allowEmpty ? "空コミットの目的（例: CI を動かす、区切りを付ける）" : "変更の要約（必須）"}
        autoComplete="off"
        value={draft.summary}
        onChange={(e) => set({ summary: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !blocked) onCommit(messages, false);
        }}
      />
      {summaryError && <div className="field-err">要約を入力してください</div>}
      <textarea
        className="input-full"
        placeholder="説明（任意）"
        rows={2}
        value={draft.body}
        onChange={(e) => set({ body: e.target.value })}
      />
      <div className="chk-grid">
        {issue && (
          <label className="chk">
            <input type="checkbox" checked={draft.linkIssue} onChange={(e) => set({ linkIssue: e.target.checked })} />
            要約の末尾に Issue 番号（{tag}）を付ける
          </label>
        )}
        {issue && (
          <label className="chk">
            <input type="checkbox" checked={draft.closes} onChange={(e) => set({ closes: e.target.checked })} />
            マージされたら {tag} を閉じる（Closes {tag}）
          </label>
        )}
        <label
          className="chk"
          title={lastPushed ? "直前のコミットはもう GitHub に送ってあるので、修正できません（送り直すには強制プッシュが必要になります）" : "直前のコミットに、今の変更と要約を入れ直します"}
        >
          <input type="checkbox" checked={draft.amend} disabled={lastPushed} onChange={(e) => set({ amend: e.target.checked })} />
          直前のコミットを修正する（amend）
        </label>
        <label className="chk">
          <input type="checkbox" checked={draft.allowEmpty} onChange={(e) => set({ allowEmpty: e.target.checked })} />
          変更なしでコミットする（空コミット）
        </label>
      </div>
      {st.head && (
        <div className="w-last" title="amend で修正されるのはこのコミット">
          直前のコミット：<span className="w-last-msg">{st.last_subject}</span> <code>{st.head}</code>
        </div>
      )}
      <div className="cmd-preview">
        <span>実行するコマンド</span>
        <code>{preview}</code>
      </div>
      {nothingToCommit && !hasConflicts && (
        <p className="w-form-note">コミットするファイルにチェックを入れてください（または「空コミット」にします）</p>
      )}
      {hasConflicts && <p className="w-form-note">競合しているファイルを直して、ステージしてからコミットします</p>}
      <div className="dr-actions">
        <button type="button" className="btn-primary" disabled={blocked} onClick={() => onCommit(messages, false)}>
          コミット
        </button>
        <button type="button" className="btn-sm" disabled={blocked || !st.branch} onClick={() => onCommit(messages, true)}>
          コミットしてプッシュ
        </button>
      </div>
    </div>
  );
}

// --- 差分 ---

function FileDiff({ folder, file, side }: { folder: string; file: GitFileChange; side: Side }) {
  const [run, setRun] = useState<GitRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const untracked = file.unstaged === "?";
  const lines = side === "staged" ? file.staged_lines : file.unstaged_lines;
  // 中身が変わったら読み直す（行数と状態で見分ける）
  const signature = `${file.staged}${file.unstaged}:${lines?.added ?? ""}:${lines?.deleted ?? ""}`;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    gitApi
      .fileDiff(folder, file.path, side === "staged", untracked && side === "unstaged")
      .then((r) => { if (alive) { setRun(r); setError(null); } })
      .catch((e) => { if (alive) { setRun(null); setError(gitApi.splitGitError(e).message); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [folder, file.path, side, untracked, signature]);

  return <DiffView title={file.path} lines={lines} run={run} error={error} loading={loading} />;
}
