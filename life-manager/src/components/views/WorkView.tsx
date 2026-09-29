import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import * as gitApi from "../../lib/git";
import type { GitFileChange, GitHubIssue, GitLineStat, GitRun, GitStash, GitStatus } from "../../lib/types";
import type { GitState } from "../../hooks/useGit";
import { OPERATION_NAMES, type GitActions } from "../../hooks/useGitActions";
import { useDismiss } from "../../hooks/useDismiss";
import { LocalFolderSetting } from "../common/LocalFolderSetting";
import { DiffView } from "../git/DiffView";
import { MergeTool } from "../git/MergeTool";
import { withTransition } from "../../lib/motion";
import { celebrateDone } from "../../lib/celebrate";
import { isEnter } from "../../lib/keys";
import { branchPull, type PullSummary } from "../../lib/pulls";

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
  /** 閉じた Issue（マージで閉じた Issue を、完了の段で見せる） */
  closedIssues: GitHubIssue[];
  /** プルリクを作る（プルリクの画面で、作るダイアログを開く） */
  onCreatePull: (head: string | null, issue: number | null) => void;
  onOpenPull: (n: number) => void;
  draft: CommitDraft;
  onDraftChange: (draft: CommitDraft) => void;
  /** ツールバーの「コミット…」「空コミット…」から来たとき。コミット欄を開いたら onCommitRequestHandled で消してもらう */
  commitRequest: { empty: boolean } | null;
  onCommitRequestHandled: () => void;
  /** 使う準備（Git のインストール・コミットに使う名前）のダイアログを開く */
  onOpenSetup: () => void;
  setupVersion: number;
  /** ファイルの右クリックのメニュー（.gitignore で無視する など） */
  onFileMenu: (pos: MenuPos, file: GitFileChange, conflict: boolean) => void;
}

type Side = "staged" | "unstaged";
type MenuPos = { x: number; y: number };
type Selected = { path: string; side: Side };
/** 取り組み中の Issue。"none" は「Issue なしで作業する」を選んだとき、null はまだ選んでいないとき */
type IssueChoice = number | "none" | null;

const STEP_NAMES = ["Issue を選ぶ", "ブランチ", "変更", "コミット", "プッシュ", "プルリク", "マージ", "完了"];
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

// --- 作業の流れ（Issue → ブランチ → 変更 → コミット → プッシュ → プルリク → マージ → 完了） ---

interface Flow {
  step: number;
  labels: string[];
  hint: ReactNode;
  action: { label: string; run: () => void } | null;
  /** もう 1 つのボタン（マージしたあと「main に戻る」など） */
  secondary?: { label: string; run: () => void } | null;
}

/** プルリクのレビューの進み（流れの「マージ」の段の小さな字） */
function reviewLabel(pr: PullSummary): string {
  if (pr.draft) return "下書き";
  const v = pr.verdicts;
  if (v && v.changes_requested.length > 0) return "修正の依頼";
  if (v && v.approved.length > 0) return `承認 ${v.approved.length}`;
  return "レビュー待ち";
}

export function WorkView(props: WorkViewProps) {
  const { owner, repo, folder, onSetFolder, git: g, onOpenSetup, setupVersion } = props;

  if (!folder) {
    return (
      <div className="content">
        <div className="work-setup">
          <h2>作業を始める準備</h2>
          <p>
            作業タブでは、取り組む Issue を決めて、ファイルの変更 → コミット → プッシュ までを、実行する git
            のコマンドを見ながら進められます。まず、このリポジトリを置く、この PC 上のフォルダを決めましょう。
          </p>
          <LocalFolderSetting
            owner={owner}
            repo={repo}
            folder={undefined}
            onSetFolder={onSetFolder}
            onOpenSetup={onOpenSetup}
            setupVersion={setupVersion}
          />
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
          <LocalFolderSetting
            owner={owner}
            repo={repo}
            folder={folder}
            onSetFolder={onSetFolder}
            onOpenSetup={onOpenSetup}
            setupVersion={setupVersion}
          />
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
  closedIssues,
  onCreatePull,
  onOpenPull,
  draft,
  onDraftChange,
  commitRequest,
  onCommitRequestHandled,
  onFileMenu,
  status: st,
}: WorkViewProps & { status: GitStatus; folder: string }) {
  const [choice, setChoiceState] = useState<IssueChoice>(() => loadIssueChoice(owner, repo));
  const [pickerOpen, setPickerOpen] = useState(false);
  const [tab, setTab] = useState<"changes" | "stash">("changes");
  // 横に並んだタブなので、右（退避中）へは右から・左（変更）へは左から入れ替わる
  function changeTab(next: "changes" | "stash") {
    if (next === tab) return;
    withTransition(() => setTab(next), ["vt-tab", next === "stash" ? "vt-right" : "vt-left"]);
  }
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
  // 選んでいた Issue が閉じられた（プルリクのマージの Closes など）
  const closedIssue = typeof choice === "number" && !issue ? closedIssues.find((i) => i.number === choice) ?? null : null;

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
  // 既定のブランチと先頭が違えば、このブランチで作ったコミットがある（アプリを開き直したあとも、プルリクの段に進めるように）
  const defaultHead = g.branches.find((b) => b.name === defaultBranch)?.head ?? "";
  const sameHead = (a: string, b: string) => a !== "" && b !== "" && (a.startsWith(b) || b.startsWith(a));
  const hasOwnCommits = committedHere || (st.head !== "" && defaultHead !== "" && !sameHead(st.head, defaultHead));
  const onBranch = !!st.branch && !onDefault;

  // このブランチから出したプルリク（GitHub に聞く。画面に戻ったとき・1 分ごとにも読み直す）
  const [branchPr, setBranchPr] = useState<{ branch: string; pull: PullSummary | null; error: string | null } | null>(null);
  useEffect(() => {
    const branch = st.branch;
    if (!branch || onDefault || !published) {
      setBranchPr(null);
      return;
    }
    let alive = true;
    const load = () =>
      branchPull(owner, repo, branch)
        .then((pull) => alive && setBranchPr({ branch, pull, error: null }))
        .catch((e) => alive && setBranchPr({ branch, pull: null, error: String(e) }));
    load();
    window.addEventListener("focus", load);
    const timer = window.setInterval(load, 60000);
    return () => {
      alive = false;
      window.removeEventListener("focus", load);
      window.clearInterval(timer);
    };
  }, [owner, repo, st.branch, onDefault, published, lastPush?.at]);
  const pr = branchPr && branchPr.branch === st.branch ? branchPr.pull : null;
  const prError = branchPr && branchPr.branch === st.branch ? branchPr.error : null;

  const flow: Flow = (() => {
    let step: number;
    if (choice === null || (typeof choice === "number" && !issue && !closedIssue)) step = 1;
    else if (changeCount > 0) step = staged.length > 0 ? 4 : 3;
    else if (needsPush) step = 5;
    else if (onBranch && pr?.state === "open") step = 7;
    else if (onBranch && pr?.merged) step = 8;
    else if (closedIssue) step = 8;
    // 既定のブランチで直接コミットしたときは、プルリク・マージの段はとばす
    else if (onDefault && issue && pushedAfterCommit) step = 8;
    else if (onBranch && published && (pushedAfterCommit || hasOwnCommits)) step = 6;
    else if (issue && onDefault) step = 2;
    else step = 3;
    const direct = onDefault && step === 8;

    const labels = [
      "",
      issue ? `#${issue.number}` : closedIssue ? `#${closedIssue.number}` : choice === "none" ? "なし" : "未選択",
      st.branch || `切り離し ${st.head}`,
      changeCount ? `${changeCount} ファイル` : "なし",
      changeCount ? `ステージ ${staged.length}` : committedHere ? "済み" : "—",
      !published ? (st.unpushed > 0 ? "未公開" : "—") : st.ahead > 0 ? `↑${st.ahead}` : "済み",
      direct ? "なし（直接）" : pr ? `#${pr.number}${pr.state === "closed" && !pr.merged ? " 閉じた" : ""}` : "—",
      direct ? "なし（直接）" : pr?.merged ? "済み" : pr?.state === "open" ? reviewLabel(pr) : "—",
      closedIssue ? "閉じました" : issue ? "Issue を閉じる" : "—",
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
      6: (
        <>
          GitHub に送れました。「プルリクを作る」で、この変更を <b>{defaultBranch}</b> に入れるお願いを出します。チームの人が変更を見て
          （レビュー）、よければマージします。
          {pr && pr.state === "closed" && !pr.merged && <> 前のプルリク #{pr.number} は、マージせずに閉じられています。</>}
          {prError && <span className="w-flow-warn">{prError}</span>}
        </>
      ),
      7: pr ? (
        <>
          プルリク <b>#{pr.number}</b> を出しました。レビューしてもらい、よければマージします（ひとりなら、差分を自分で確かめてマージしてかまいません）。
          直すときは、このブランチでコミット・プッシュすると、プルリクに足されます。
        </>
      ) : null,
      8: direct ? (
        <>GitHub に送れました。Issue を閉じて完了にします。</>
      ) : closedIssue ? (
        <>
          #{closedIssue.number} は閉じられました{pr?.merged ? `（#${pr.number} のマージで）` : ""}。
          {onBranch && <> 次の作業は <b>{defaultBranch}</b> に戻ってから始めます（<code>git switch {defaultBranch}</code> → <code>git pull</code>）。</>}
        </>
      ) : (
        <>
          マージできました。{issue ? "Issue を閉じて完了にします。" : ""}
          {onBranch && <> 次の作業は <b>{defaultBranch}</b> に戻ってから始めます（<code>git switch {defaultBranch}</code> → <code>git pull</code>）。</>}
        </>
      ),
    };

    let action: Flow["action"] = null;
    if (step === 1) action = { label: "Issue を選ぶ", run: () => setPickerOpen(true) };
    else if (step === 2 && issue) action = { label: "ブランチを作る…", run: () => actions.createBranch(`issue-${issue.number}`) };
    else if (step === 4) action = { label: "コミット欄へ", run: () => focusCommit() };
    else if (step === 5) action = st.behind > 0 ? { label: "プルする", run: actions.pull } : { label: "プッシュする", run: actions.push };
    else if (step === 6) action = { label: "プルリクを作る…", run: () => onCreatePull(st.branch, issue?.number ?? null) };
    else if (step === 7 && pr) action = { label: `#${pr.number} を開く（レビュー・マージ）`, run: () => onOpenPull(pr.number) };
    else if (step === 8 && issue) {
      action = {
        label: `#${issue.number} を完了にする`,
        run: async () => {
          await onCloseIssue(issue.number);
          celebrateDone(`#${issue.number}`);
          setChoice(null);
        },
      };
    } else if (step === 8 && closedIssue) {
      action = {
        label: "完了（次の Issue へ）",
        run: () => {
          celebrateDone(`#${closedIssue.number}`);
          setChoice(null);
        },
      };
    } else if (step === 8) action = { label: "次の作業へ", run: () => setChoice(null) };
    // マージしたあと: 既定のブランチに戻って、最新にする
    const secondary =
      step === 8 && onBranch
        ? {
            label: `${defaultBranch} に戻って最新にする`,
            run: async () => {
              const switched = await g.exec("切り替えています", (p) => gitApi.switchBranch(p, defaultBranch, false), `${defaultBranch} に切り替えました`);
              if (switched.ok) await g.exec("プルしています", gitApi.pull, `${defaultBranch} を最新にしました`);
            },
          }
        : step === 7 && pr
          ? { label: "もう一度読む", run: () => branchPull(owner, repo, st.branch).then((pull) => setBranchPr({ branch: st.branch, pull, error: null })).catch(() => {}) }
          : null;
    return { step, labels, hint: hints[step], action, secondary };
  })();

  return (
    <div className={`wview${changeCount === 0 ? " no-changes" : ""}${draft.allowEmpty ? " empty" : ""}`}>
      <IssueBar
        issues={issues}
        issue={issue}
        closedIssue={closedIssue}
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
        {flow.secondary && (
          <button type="button" className="btn-sm" disabled={g.busy !== null} onClick={flow.secondary.run}>
            {flow.secondary.label}
          </button>
        )}
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
                ⚠ 競合（コンフリクト）しているファイルがあります。ファイルを選ぶと右に「競合を直す」が出るので、
                か所ごとに使う方を選んで「直したので、ステージする」を押します（<code>git add</code>）。
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
            <button type="button" role="tab" aria-selected={tab === "changes"} className={`w-tab${tab === "changes" ? " on" : ""}`} onClick={() => changeTab("changes")}>
              変更 <span className="count">{changeCount}</span>
              {tab === "changes" && <span className="tab-active-bar" aria-hidden="true" />}
            </button>
            <button type="button" role="tab" aria-selected={tab === "stash"} className={`w-tab${tab === "stash" ? " on" : ""}`} onClick={() => changeTab("stash")}>
              退避中 <span className="count">{g.stashes.length}</span>
              {tab === "stash" && <span className="tab-active-bar" aria-hidden="true" />}
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
              onFileMenu={onFileMenu}
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
            // 競合しているファイルは、差分の代わりにマージツール（か所ごとに使う方を選ぶ）
            currentFile.staged === "U" ? (
              <MergeTool folder={folder} file={currentFile.path} status={st} actions={actions} busy={g.busy !== null} />
            ) : (
              <FileDiff folder={folder} file={currentFile} side={current.side} />
            )
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
  /** 選んでいた Issue が閉じられたとき（プルリクのマージで閉じたなど） */
  closedIssue: GitHubIssue | null;
  choice: IssueChoice;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChoose: (choice: IssueChoice) => void;
  onOpenIssue: (n: number) => void;
  onStartIssue: (n: number) => Promise<void>;
}

function IssueBar({ issues, issue, closedIssue, choice, open, onOpenChange, onChoose, onOpenIssue, onStartIssue }: IssueBarProps) {
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

  const missing = typeof choice === "number" && !issue && !closedIssue;

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
          <span className="wi-num">{issue ? `#${issue.number}` : closedIssue ? `#${closedIssue.number}` : missing ? `#${choice}` : "—"}</span>
          <span className="wi-title">
            {issue
              ? issue.title
              : closedIssue
                ? `${closedIssue.title}（閉じました）`
                : missing
                  ? "（閉じられたか、見つかりません）"
                  : choice === "none"
                    ? "Issue なしで作業中"
                    : "Issue を選んでください"}
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
              onKeyDown={(e) => { if (isEnter(e) && list[0]) onChoose(list[0].number); }}
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
  onFileMenu: (pos: MenuPos, file: GitFileChange, conflict: boolean) => void;
}

function ChangesPane({ conflicts, staged, unstaged, selected, onSelect, actions, lastCommand, onEmptyCommit, onFileMenu }: ChangesPaneProps) {
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
      <div
        key={`${side}:${f.path}`}
        className={`fr${isSel ? " sel" : ""}`}
        onClick={() => onSelect({ path: f.path, side })}
        onContextMenu={(e) => {
          e.preventDefault();
          onSelect({ path: f.path, side });
          onFileMenu({ x: e.clientX, y: e.clientY }, f, conflict);
        }}
      >
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
        <code>git restore --staged</code> にあたります。記録しないファイルは、右クリックで <code>.gitignore</code> に書いて無視できます。
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
          if (isEnter(e) && (e.ctrlKey || e.metaKey) && !blocked) onCommit(messages, false);
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
