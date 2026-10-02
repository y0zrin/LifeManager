import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import * as gitApi from "../../lib/git";
import type { GitFileChange, GitHubComment, GitHubIssue, GitHubMilestone, GitLineStat, GitRun, GitStash, GitStatus } from "../../lib/types";
import type { GitState } from "../../hooks/useGit";
import { OPERATION_NAMES, type GitActions } from "../../hooks/useGitActions";
import { LocalFolderSetting } from "../common/LocalFolderSetting";
import { DiffView } from "../git/DiffView";
import { MergeTool } from "../git/MergeTool";
import { withTransition } from "../../lib/motion";
import { celebrateDone } from "../../lib/celebrate";
import { isEnter } from "../../lib/keys";
import { branchPull, type PullSummary } from "../../lib/pulls";
import { countOf } from "../../lib/count";
import { commentPreview } from "../../lib/help";

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
  /** 自分（GitHub のアカウント名）。担当の見分けに使う */
  currentUser: string;
  onOpenIssue: (n: number) => void;
  /** 作業を始める: 自分が担当でなければ自分を担当にし、状態を「進行中」にする（ボードと合わせる） */
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
  /** マイルストーン（① で Issue を選ぶときの絞り込み） */
  milestones: GitHubMilestone[];
  /** Issue のコメントを読む・書く（② 作業報告） */
  onListComments: (n: number) => Promise<GitHubComment[]>;
  onComment: (n: number, body: string) => Promise<GitHubComment | null>;
}

type Side = "staged" | "unstaged";
type MenuPos = { x: number; y: number };
type Selected = { path: string; side: Side };
/** 取り組み中の Issue（null はまだ選んでいないとき）。コミットは必ず Issue につなげるので「Issue なし」はない */
type IssueChoice = number | null;

// 作業をする（#218）: ① 選ぶ → ② 作業報告 → ③ コミット・プッシュ。② と ③ は、④ 完了にする（Issue を閉じる）までくり返す。
// 閉じるまでを 1 つの作業とする
const STEP_NAMES = ["作業を選ぶ", "作業報告", "コミット・プッシュ", "完了"];
/** 上の 1 行の段に出す短い名前 */
const STEP_SHORT = ["選ぶ", "作業報告", "コミット・プッシュ", "完了"];
const IN_PROGRESS = "状態:進行中";

// --- 取り組み中の Issue は、リポジトリごとにこの PC に覚えておく ---

function issueKey(owner: string, repo: string) {
  return `work-issue:${owner}/${repo}`;
}

function loadIssueChoice(owner: string, repo: string): IssueChoice {
  try {
    const v = localStorage.getItem(issueKey(owner, repo));
    const n = Number(v);
    return v && Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

/** 作業タブで取り組んでいる Issue（ボードの「✏️ 作業中」の印に使う） */
export function loadWorkIssue(owner: string, repo: string): number | null {
  return loadIssueChoice(owner, repo);
}

function saveIssueChoice(owner: string, repo: string, choice: IssueChoice) {
  try {
    if (choice === null) localStorage.removeItem(issueKey(owner, repo));
    else localStorage.setItem(issueKey(owner, repo), String(choice));
  } catch {
    // 覚えられなくても、今は選んだ Issue で作業できる
  }
}

// --- 作業報告を書いた回数: Issue ごとに、この PC に覚えておく（段の「作業報告 2 回」に出す。完了にしたら消す） ---

function reportsKey(owner: string, repo: string) {
  return `work-reports:${owner}/${repo}`;
}

function loadReports(owner: string, repo: string): Record<string, number> {
  try {
    const v = JSON.parse(localStorage.getItem(reportsKey(owner, repo)) ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

function saveReports(owner: string, repo: string, map: Record<string, number>) {
  try {
    localStorage.setItem(reportsKey(owner, repo), JSON.stringify(map));
  } catch {
    // 覚えられなくても、作業報告は書き込める
  }
}

// --- ① で選んでいるマイルストーン（"all" は全部、"none" はマイルストーンなし、ほかは番号）。リポジトリごとに覚える ---

function milestoneKey(owner: string, repo: string) {
  return `work-milestone:${owner}/${repo}`;
}

function loadMilestone(owner: string, repo: string): string | null {
  try {
    return localStorage.getItem(milestoneKey(owner, repo));
  } catch {
    return null;
  }
}

function saveMilestone(owner: string, repo: string, value: string) {
  try {
    localStorage.setItem(milestoneKey(owner, repo), value);
  } catch {
    // 覚えられなくても、今は選んだマイルストーンで絞れる
  }
}

/** はじめに選んでおくマイルストーン: 期限のいちばん近い開いたマイルストーン（なければ全部） */
function nearestMilestone(milestones: GitHubMilestone[]): string {
  const open = milestones.filter((m) => m.state !== "closed").sort((a, b) => (a.due_on ?? "9999").localeCompare(b.due_on ?? "9999"));
  return open[0] ? String(open[0].number) : "all";
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

// --- 作業の流れ（① 選ぶ → ② 作業報告 → ③ コミット・プッシュ → ④ 完了。② と ③ は完了までくり返す） ---

interface Flow {
  step: number;
  /** 段に出す名前（今の数など） */
  labels: string[];
}

/** プルリクのレビューの進み（流れの「マージ」の段の小さな字） */
function reviewLabel(pr: PullSummary): string {
  if (pr.draft) return "下書き";
  if (pr.checks && pr.checks.failure > 0) return "✖ チェック";
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
            「作業をする」では、マイルストーンと Issue を選び、作業報告とコミット・プッシュを、Issue を完了にするまでくり返します。そのあいだ、実行する git のコマンドが見られます。まず、このリポジトリをこの PC のどのフォルダに置くかを決めましょう。
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
  currentUser,
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
  milestones,
  onListComments,
  onComment,
  status: st,
}: WorkViewProps & { status: GitStatus; folder: string }) {
  const [choice, setChoiceState] = useState<IssueChoice>(() => loadIssueChoice(owner, repo));
  const [tab, setTab] = useState<"changes" | "stash">("changes");
  // 横に並んだタブなので、右（退避中）へは右から・左（変更）へは左から入れ替わる
  function changeTab(next: "changes" | "stash") {
    if (next === tab) return;
    withTransition(() => setTab(next), ["vt-tab", next === "stash" ? "vt-right" : "vt-left"]);
  }
  const [selected, setSelected] = useState<Selected | null>(null);
  const [summaryError, setSummaryError] = useState(false);
  const summaryRef = useRef<HTMLInputElement>(null);
  // 見ている段（null なら今の段）。上の段を押すと、その段の画面を見られる
  const [viewStep, setViewStep] = useState<number | null>(null);
  // 作業報告を書いた回数（Issue ごと）
  const [reportCounts, setReportCounts] = useState<Record<string, number>>(() => loadReports(owner, repo));

  useEffect(() => {
    setChoiceState(loadIssueChoice(owner, repo));
    setViewStep(null);
    setReportCounts(loadReports(owner, repo));
  }, [owner, repo]);

  function bumpReports(n: number) {
    setReportCounts((cur) => {
      const next = { ...cur, [String(n)]: (cur[String(n)] ?? 0) + 1 };
      saveReports(owner, repo, next);
      return next;
    });
  }

  function clearReports(n: number) {
    setReportCounts((cur) => {
      const next = { ...cur };
      delete next[String(n)];
      saveReports(owner, repo, next);
      return next;
    });
  }

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
    setViewStep(3);
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

  // 今の段: 選んでいない → ①。選んでいた Issue が閉じられた → ④。変更か、まだ送っていないコミットがあれば ③、なければ ②
  const flow: Flow = (() => {
    let step: number;
    if (choice === null || (typeof choice === "number" && !issue && !closedIssue)) step = 1;
    else if (closedIssue) step = 4;
    else if (changeCount > 0 || needsPush) step = 3;
    else step = 2;
    const reports = issue ? reportCounts[String(issue.number)] ?? 0 : 0;
    const labels = [
      "",
      issue ? `#${issue.number} ${issue.title}` : closedIssue ? `#${closedIssue.number}` : "選ぶ",
      reports > 0 ? `作業報告 ${reports} 回` : "作業報告",
      changeCount ? `コミット・プッシュ（${changeCount} ファイル）` : needsPush ? `コミット・プッシュ（${published ? `↑${st.ahead}` : "未公開"}）` : "コミット・プッシュ",
      closedIssue
        ? "完了（閉じました）"
        : onBranch && pr
          ? `完了（#${pr.number} ${pr.merged ? "マージ済み" : pr.state === "open" ? reviewLabel(pr) : "閉じた"}）`
          : "完了",
    ];
    return { step, labels };
  })();

  // 完了にする（Issue を閉じる。前と同じ）
  const finish = (n: number) => async () => {
    await onCloseIssue(n);
    celebrateDone(`#${n}`);
    clearReports(n);
    setChoice(null);
  };
  // マージしたあと: このブランチで続ける（既定のブランチの最新を取り込む）か、既定のブランチに戻って最新にする
  const branchAfter: StepButton[] =
    onBranch && pr?.merged
      ? [
          {
            label: `このブランチで続ける（${defaultBranch} の最新を取り込む）`,
            run: async () => {
              const fetched = await g.exec("GitHub から読んでいます", gitApi.fetch, "GitHub から読みました");
              if (fetched.ok) await g.exec("取り込んでいます", (p) => gitApi.merge(p, `origin/${defaultBranch}`), `${defaultBranch} の最新を ${st.branch} に取り込みました`);
            },
          },
          {
            label: `${defaultBranch} に戻って最新にする`,
            run: async () => {
              const switched = await g.exec("切り替えています", (p) => gitApi.switchBranch(p, defaultBranch, false), `${defaultBranch} に切り替えました`);
              if (switched.ok) await g.exec("プルしています", gitApi.pull, `${defaultBranch} を最新にしました`);
            },
          },
        ]
      : [];
  const reloadPr = () =>
    branchPull(owner, repo, st.branch)
      .then((pull) => setBranchPr({ branch: st.branch, pull, error: null }))
      .catch(() => {});

  // ④ 完了の画面: ブランチで作業していれば、プルリク → マージ → 閉じる。既定のブランチで直接なら、そのまま閉じる
  const unsentNote =
    changeCount > 0 || needsPush ? <span className="w-flow-warn">まだコミット・プッシュしていない変更があります（③ コミット・プッシュ）。</span> : null;
  const complete: { hint: ReactNode; buttons: StepButton[] } = (() => {
    if (closedIssue) {
      return {
        hint: (
          <>
            #{closedIssue.number} は閉じられました{pr?.merged ? `（#${pr.number} のマージで）` : ""}。
            {onBranch && pr?.merged && <> このブランチで続けるときは、{defaultBranch} の最新を取り込みます。{defaultBranch} に戻ってもかまいません。</>}
          </>
        ),
        buttons: [
          {
            label: "完了（次の作業へ）",
            run: () => {
              celebrateDone(`#${closedIssue.number}`);
              clearReports(closedIssue.number);
              setChoice(null);
            },
            primary: true,
          },
          ...branchAfter,
        ],
      };
    }
    if (!issue) return { hint: <>先に ① で、取り組む Issue を選びます。</>, buttons: [{ label: "① 作業を選ぶ", run: () => setViewStep(1), primary: true }] };
    const done: StepButton = { label: `#${issue.number} を完了にする`, run: finish(issue.number) };
    if (onBranch && hasOwnCommits) {
      if (!published || needsPush) {
        return {
          hint: (
            <>
              このブランチ（<b>{st.branch}</b>）のコミットを、まだ GitHub に送っていません。③ でプッシュしてから、プルリクを出します。
              {unsentNote}
            </>
          ),
          buttons: [{ label: "③ コミット・プッシュへ", run: () => setViewStep(3), primary: true }, { label: "このまま完了にする", run: done.run }],
        };
      }
      if (pr?.merged) {
        return {
          hint: (
            <>
              プルリク <b>#{pr.number}</b> はマージ済みです。Issue を閉じて完了にします。マージしたあとも、このブランチで続けてかまいません（{defaultBranch}{" "}
              の最新を取り込みます）。
              {unsentNote}
            </>
          ),
          buttons: [{ ...done, primary: true }, ...branchAfter],
        };
      }
      if (pr?.state === "open") {
        return {
          hint: (
            <>
              プルリク <b>#{pr.number}</b> を出しています（{reviewLabel(pr)}）。レビューしてもらい、よければマージしてから完了にします。ひとりなら、差分を自分で確かめてマージしてかまいません。直すときは
              ③ でコミット・プッシュすると、プルリクに足されます。
              {pr.checks && pr.checks.failure > 0 && (
                <span className="w-flow-warn">
                  ✖ チェック（Actions のテストなど）が {countOf(pr.checks.failure, "件")}失敗しています。プルリクの「チェック」か Actions で、どこで失敗したかを見られます。
                </span>
              )}
              {unsentNote}
            </>
          ),
          buttons: [
            { label: `#${pr.number} を開く（レビュー・マージ）`, run: () => onOpenPull(pr.number), primary: true },
            { label: "もう一度読む", run: reloadPr },
            { label: "マージせずに完了にする", run: done.run },
          ],
        };
      }
      return {
        hint: (
          <>
            <b>{st.branch}</b> の変更を <b>{defaultBranch}</b> に入れるお願い（プルリク）を出し、マージしてから完了にします。チームの人が変更を見て（レビュー）、よければマージします。
            {pr && pr.state === "closed" && !pr.merged && <> 前のプルリク #{pr.number} はマージせずに閉じられています。</>}
            {prError && <span className="w-flow-warn">{prError}</span>}
            {unsentNote}
          </>
        ),
        buttons: [
          { label: "プルリクを作る…", run: () => onCreatePull(st.branch, issue.number), primary: true },
          { label: "プルリクを出さずに完了にする", run: done.run },
        ],
      };
    }
    return {
      hint: (
        <>
          {onDefault ? (
            <>
              既定のブランチ（<b>{st.branch}</b>）で作業しました。
            </>
          ) : null}
          Issue を閉じて完了にします。
          {unsentNote}
        </>
      ),
      buttons: [{ ...done, primary: true }],
    };
  })();

  // 進んだら（今の段が変わったら）、その段の画面に切り替える
  useEffect(() => {
    setViewStep(null);
  }, [flow.step]);
  const shown = viewStep ?? flow.step;

  return (
    <div className={`wview${changeCount === 0 ? " no-changes" : ""}${draft.allowEmpty ? " empty" : ""}`}>
      <ol className="w-steps" aria-label="作業の流れ">
        {STEP_SHORT.map((name, i) => {
          const n = i + 1;
          // 済みの印は ① だけ（② と ③ は完了までくり返す）
          const done = n === 1 && flow.step > 1 && !!(issue ?? closedIssue);
          return (
            <Fragment key={n}>
              {n === 4 && (
                <li className="w-steps-loop" title="完了にするまで、② 作業報告と ③ コミット・プッシュをくり返します">
                  ↻ 完了までくり返す
                </li>
              )}
              <li>
                <button
                  type="button"
                  className={`w-step${done ? " done" : n === flow.step ? " now" : ""}${n === shown ? " shown" : ""}`}
                  aria-current={n === flow.step ? "step" : undefined}
                  title={`${n}. ${STEP_NAMES[i]}：${flow.labels[n]}`}
                  onClick={() => setViewStep(n === flow.step ? null : n)}
                >
                  <i>{done ? "✓" : n}</i>
                  <span>{flow.labels[n] || name}</span>
                </button>
              </li>
            </Fragment>
          );
        })}
      </ol>

      {(st.conflicted || st.operation) && (
        <div className="w-banner warn">
          <span>
            {st.operation && <b>{OPERATION_NAMES[st.operation]}の途中です。</b>}
            {st.conflicted ? (
              <>
                ⚠ 競合（コンフリクト）しているファイルがあります。ファイルを選ぶと右に「競合を直す」が出ます。か所ごとに使う方を選んで「直したのでステージする」を押します（<code>git add</code>）。
              </>
            ) : (
              "競合はすべて直してあります。"
            )}
            {st.operation === "merge"
              ? "そのあとコミットするとマージが完了します。"
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

      {shown === 1 ? (
        <IssueStep
          issues={issues}
          milestones={milestones}
          owner={owner}
          repo={repo}
          issue={issue}
          closedIssue={closedIssue}
          choice={choice}
          currentUser={currentUser}
          branch={st.branch}
          onDefault={onDefault}
          localBranches={g.branches.map((b) => b.name)}
          onStart={(n, how) => {
            setChoice(n);
            setViewStep(null);
            // 自分を担当にして「進行中」に（ボードの自分のタスク・進行中に出る）
            void onStartIssue(n);
            if (how === "create") actions.createBranch(`issue-${n}`);
            else if (how === "switch") actions.requestSwitch(`issue-${n}`);
          }}
          onOpenIssue={onOpenIssue}
          note={
            flow.step === 1 && onBranch && pr?.merged ? (
              <>
                このブランチ（<b>{st.branch}</b>）のプルリク <b>#{pr.number}</b> はマージ済みです。このブランチで続けるときは {defaultBranch}{" "}
                の最新を取り込み、別に始めるときは {defaultBranch} に戻ります。
              </>
            ) : null
          }
          extras={flow.step === 1 ? branchAfter : []}
          busy={g.busy !== null}
        />
      ) : shown === 2 ? (
        <ReportStep
          issue={issue}
          onOpenIssue={onOpenIssue}
          onListComments={onListComments}
          onComment={onComment}
          onReported={() => issue && bumpReports(issue.number)}
          changesWaiting={changeCount > 0 || needsPush}
          onGoCommit={() => setViewStep(3)}
          onGoComplete={() => setViewStep(4)}
          onPickIssue={() => setViewStep(1)}
        />
      ) : shown === 4 ? (
        <StepPanel n={4} current={flow.step === 4} hint={complete.hint} status={null} buttons={complete.buttons} busy={g.busy !== null} />
      ) : (
      <>
      {/* ③ コミット・プッシュ: 今のブランチと、変更がないときのプッシュ（またはプル） */}
      <div className="w-cp-strip">
        <span className="w-cp-branch">
          ブランチ <b>{st.branch || `切り離し ${st.head}`}</b>
          {onDefault && <small>（既定のブランチに直接コミットします）</small>}
        </span>
        {onDefault && issue && (
          <button type="button" className="btn-sm" disabled={g.busy !== null} onClick={() => actions.createBranch(`issue-${issue.number}`)}>
            ブランチを分ける…
          </button>
        )}
        <span className="w-cp-right">
          {changeCount === 0 && needsPush ? (
            st.behind > 0 ? (
              <button type="button" className="btn-primary" disabled={g.busy !== null} onClick={actions.pull}>
                プルする（GitHub に新しいコミットがあります）
              </button>
            ) : (
              <button type="button" className="btn-primary" disabled={g.busy !== null} onClick={actions.push}>
                プッシュする（{published ? `↑${st.ahead}` : "はじめて送る"}）
              </button>
            )
          ) : changeCount === 0 ? (
            <span className="w-cp-none">変更はありません。ファイルを編集すると、ここに出ます</span>
          ) : (
            <span className="w-cp-none">変更にチェックを入れ、要約を書いて「コミットしてプッシュ」（<code>git add</code> → <code>git commit</code> → <code>git push</code>）</span>
          )}
        </span>
      </div>
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
            onPickIssue={() => setViewStep(1)}
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
      </>
      )}
    </div>
  );
}

// --- 段の画面（④ 完了） ---

type StepButton = { label: string; run: () => void; primary?: boolean };

function StepPanel({ n, current, hint, status, buttons, busy }: { n: number; current: boolean; hint: ReactNode; status: string | null; buttons: StepButton[]; busy: boolean }) {
  return (
    <div className="w-step-panel">
      <h4 className="w-step-title">
        <i>{n}</i>
        {STEP_NAMES[n - 1]}
        {!current && status && <span className="w-step-status">{status}</span>}
      </h4>
      <p className="hint">{hint}</p>
      {buttons.length > 0 && (
        <div className="w-step-actions">
          {buttons.map((b) => (
            <button key={b.label} type="button" className={b.primary ? "btn-primary" : "btn-sm"} disabled={busy} onClick={b.run}>
              {b.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// --- ① 作業を選ぶ（マイルストーンと Issue。始めるときにブランチを決める） ---

interface IssueStepProps {
  issues: GitHubIssue[];
  milestones: GitHubMilestone[];
  owner: string;
  repo: string;
  issue: GitHubIssue | null;
  /** 選んでいた Issue が閉じられたとき（プルリクのマージで閉じたなど） */
  closedIssue: GitHubIssue | null;
  choice: IssueChoice;
  currentUser: string;
  /** 今いるブランチ（「今のブランチで始める」に出す） */
  branch: string;
  onDefault: boolean;
  /** この PC にあるブランチ（前に作った issue-N があれば、それに切り替えて始める） */
  localBranches: string[];
  /** 始める: create = issue-N を作る、switch = 前に作った issue-N に切り替える、here = 今のブランチのまま */
  onStart: (n: number, how: "create" | "switch" | "here") => void;
  onOpenIssue: (n: number) => void;
  /** マージ済みのブランチにいるときの知らせと、そのボタン（このブランチで続ける・既定のブランチに戻る） */
  note: ReactNode;
  extras: StepButton[];
  busy: boolean;
}

function IssueStep({ issues, milestones, owner, repo, issue, closedIssue, choice, currentUser, branch, onDefault, localBranches, onStart, onOpenIssue, note, extras, busy }: IssueStepProps) {
  const [query, setQuery] = useState("");
  const [ms, setMs] = useState<string>(() => loadMilestone(owner, repo) ?? nearestMilestone(milestones));
  // ブランチを決めているところの Issue（行の下に、始め方を出す）
  const [picking, setPicking] = useState<number | null>(null);
  const q = query.trim().toLowerCase().replace(/^#/, "");
  const inProgress = (i: GitHubIssue) => i.labels.some((l) => l.name === IN_PROGRESS);
  const mine = (i: GitHubIssue) => !!currentUser && !!i.assignees?.some((a) => a.login === currentUser);
  const inMilestone = (i: GitHubIssue) => (ms === "all" ? true : ms === "none" ? !i.milestone : String(i.milestone?.number ?? "") === ms);
  // 自分の担当を先に、その中は進行中を先に、あとは新しい順
  const list = [...issues]
    .filter(inMilestone)
    .sort((a, b) => Number(mine(b)) - Number(mine(a)) || Number(inProgress(b)) - Number(inProgress(a)) || b.number - a.number)
    .filter((i) => !q || String(i.number).startsWith(q) || i.title.toLowerCase().includes(q));
  const missing = typeof choice === "number" && !issue && !closedIssue;
  const now = issue ?? closedIssue;
  const others = (i: GitHubIssue) => (i.assignees ?? []).map((a) => a.login).filter((l) => l !== currentUser);
  const openMs = milestones.filter((m) => m.state !== "closed");
  const closedMs = milestones.filter((m) => m.state === "closed");

  function changeMs(value: string) {
    setMs(value);
    saveMilestone(owner, repo, value);
  }

  return (
    <div className="w-issue-step">
      <h4 className="w-step-title">
        <i>1</i>
        作業を選ぶ
      </h4>
      <p className="hint">
        マイルストーンと Issue を選び、どのブランチで作業するかを決めて始めます。始めると自分が担当になり、状態が「進行中」になります（ボードにも出ます）。そのあとは、② 作業報告と ③ コミット・プッシュを、④ 完了にするまでくり返します。
      </p>
      {note && (
        <div className="w-step-note">
          <span>{note}</span>
          {extras.map((b) => (
            <button key={b.label} type="button" className="btn-sm" disabled={busy} onClick={b.run}>
              {b.label}
            </button>
          ))}
        </div>
      )}
      {(now || missing) && (
        <div className="w-issue-now">
          <span className="w-issue-now-k">今の作業</span>
          <span className="wi-num">#{now ? now.number : choice}</span>
          <span className="wi-t">{now ? `${now.title}${closedIssue ? "（クローズ済み）" : ""}` : "（クローズされたか、見つかりません）"}</span>
          {issue && <span className="wi-meta">{issueMeta(issue)}</span>}
          {issue && (
            <span className="wi-actions">
              <button type="button" className="btn-sm" onClick={() => onOpenIssue(issue.number)}>
                Issue を開く
              </button>
            </span>
          )}
        </div>
      )}
      <div className="w-pick-bar">
        <select className="select-sm w-ms-select" value={ms} onChange={(e) => changeMs(e.target.value)} aria-label="マイルストーン">
          <option value="all">マイルストーン: すべて</option>
          {openMs.map((m) => (
            <option key={m.number} value={String(m.number)}>
              🎯 {m.title}
              {m.due_on ? `（期限 ${formatWhen(m.due_on).split(" ")[0]}）` : ""}
            </option>
          ))}
          {closedMs.length > 0 && (
            <optgroup label="閉じたマイルストーン">
              {closedMs.map((m) => (
                <option key={m.number} value={String(m.number)}>
                  {m.title}
                </option>
              ))}
            </optgroup>
          )}
          <option value="none">マイルストーンなし</option>
        </select>
        <input
          className="input-full w-issue-search"
          placeholder="番号やタイトルで探す"
          autoComplete="off"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (isEnter(e) && list[0]) setPicking(list[0].number);
          }}
        />
      </div>
      <div className="w-issue-list">
        {list.map((i) => {
          const chosen = i.number === choice;
          const who = others(i);
          const own = `issue-${i.number}`;
          const hasOwn = localBranches.includes(own) && branch !== own;
          return (
            <Fragment key={i.number}>
              <button
                type="button"
                className={`w-issue-row${chosen ? " on" : ""}${picking === i.number ? " picking" : ""}`}
                title={issueMeta(i)}
                onClick={() => setPicking(chosen ? null : picking === i.number ? null : i.number)}
              >
                <span className="wi-num">#{i.number}</span>
                <span className="wi-t">{i.title}</span>
                {inProgress(i) && <span className="w-issue-chip">進行中</span>}
                <span className={`w-issue-who${mine(i) ? " mine" : ""}`}>{mine(i) ? "自分" : who.length > 0 ? `担当: ${who.join("・")}` : "担当なし"}</span>
                {i.milestone && <span className="wi-m">🎯 {i.milestone.title}</span>}
                <span className="w-issue-go">{chosen ? "今の作業" : mine(i) ? "始める" : "自分に割り当てて始める"}</span>
              </button>
              {picking === i.number && !chosen && (
                <div className="w-start-choice">
                  <div className="w-start-q">#{i.number} を、どのブランチで作業しますか？</div>
                  <div className="w-step-actions">
                    {branch === own ? (
                      <button type="button" className="btn-primary" disabled={busy} onClick={() => onStart(i.number, "here")}>
                        {own}（今のブランチ）で始める
                      </button>
                    ) : (
                      <>
                        {hasOwn ? (
                          <button type="button" className={onDefault ? "btn-primary" : "btn-sm"} disabled={busy} onClick={() => onStart(i.number, "switch")}>
                            {own} に切り替えて始める
                          </button>
                        ) : (
                          <button type="button" className={onDefault ? "btn-primary" : "btn-sm"} disabled={busy} onClick={() => onStart(i.number, "create")}>
                            ブランチ {own} を作って始める
                          </button>
                        )}
                        <button type="button" className={onDefault ? "btn-sm" : "btn-primary"} disabled={busy} onClick={() => onStart(i.number, "here")}>
                          今のブランチ（{branch || "切り離し"}）で始める
                        </button>
                      </>
                    )}
                    <button type="button" className="btn-sm" onClick={() => setPicking(null)}>
                      やめる
                    </button>
                  </div>
                  <p className="w-start-note">
                    ブランチを分けると、ほかの作業と混ざりません（<code>git switch -c {own}</code>）。自分用のブランチで続けて作業しているときは、今のブランチで始めます。
                    {onDefault && <> 今は既定のブランチ（{branch}）にいるので、ここで始めると既定のブランチに直接コミットします。</>}
                  </p>
                </div>
              )}
            </Fragment>
          );
        })}
        {list.length === 0 && (
          <div className="bsw-empty">{issues.length === 0 ? "未完了の Issue はありません" : ms !== "all" && issues.some((i) => !inMilestone(i)) ? "このマイルストーンに、当てはまる Issue はありません" : "一致する Issue はありません"}</div>
        )}
      </div>
    </div>
  );
}

// --- ② 作業報告（Issue にコメントとして書き込む） ---

interface ReportStepProps {
  issue: GitHubIssue | null;
  onOpenIssue: (n: number) => void;
  onListComments: (n: number) => Promise<GitHubComment[]>;
  onComment: (n: number, body: string) => Promise<GitHubComment | null>;
  /** 書き込めたとき（段の「作業報告 2 回」を数える） */
  onReported: () => void;
  /** コミット・プッシュしていない変更がある（③ へのボタンを出す） */
  changesWaiting: boolean;
  onGoCommit: () => void;
  onGoComplete: () => void;
  onPickIssue: () => void;
}

/** 作業報告の下に出す、前のコメントの数 */
const PAST_REPORTS = 4;

function ReportStep({ issue, onOpenIssue, onListComments, onComment, onReported, changesWaiting, onGoCommit, onGoComplete, onPickIssue }: ReportStepProps) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [comments, setComments] = useState<GitHubComment[] | null>(null);
  const n = issue?.number ?? null;
  // 読む関数は、画面を描き直すたびに作り直される。Issue が変わったときだけ読み直すよう、ref で持つ
  const listRef = useRef(onListComments);
  listRef.current = onListComments;
  const load = useCallback(() => {
    if (n === null) return;
    listRef
      .current(n)
      .then((c) => setComments(c))
      .catch(() => setComments([]));
  }, [n]);
  useEffect(() => {
    setComments(null);
    setNote(null);
    load();
  }, [load]);

  if (!issue) {
    return (
      <div className="w-step-panel">
        <h4 className="w-step-title">
          <i>2</i>
          作業報告
        </h4>
        <p className="hint">先に ① で、取り組む Issue を選びます。</p>
        <div className="w-step-actions">
          <button type="button" className="btn-primary" onClick={onPickIssue}>
            ① 作業を選ぶ
          </button>
        </div>
      </div>
    );
  }

  async function send() {
    const body = text.trim();
    if (!body || sending || !issue) return;
    setSending(true);
    setNote(null);
    try {
      await onComment(issue.number, body);
      setText("");
      setNote({ ok: true, text: `#${issue.number} に書き込みました` });
      onReported();
      load();
    } catch (e) {
      setNote({ ok: false, text: `書き込めませんでした（${String(e)}）` });
    } finally {
      setSending(false);
    }
  }

  const past = (comments ?? []).slice(-PAST_REPORTS);
  return (
    <div className="w-step-panel w-report">
      <h4 className="w-step-title">
        <i>2</i>
        作業報告
      </h4>
      <p className="hint">
        やったこと、わかったこと、次にやることを書いて、Issue に書き込みます（Issue のコメントになります）。変更があれば ③ でコミット・プッシュします。完了にするまで、この 2 つをくり返します。
      </p>
      <div className="w-issue-now">
        <span className="w-issue-now-k">今の作業</span>
        <span className="wi-num">#{issue.number}</span>
        <span className="wi-t">{issue.title}</span>
        <span className="wi-actions">
          <button type="button" className="btn-sm" onClick={() => onOpenIssue(issue.number)}>
            Issue を開く
          </button>
        </span>
      </div>
      <textarea
        className="w-report-text"
        rows={5}
        value={text}
        placeholder="例: ジャンプの高さを調整した。着地の判定がずれるので、次は当たり判定を直す"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (isEnter(e) && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <div className="w-step-actions">
        <button type="button" className="btn-primary" disabled={!text.trim() || sending} onClick={() => void send()}>
          {sending ? "書き込んでいます…" : "Issue に書き込む"}
        </button>
        {changesWaiting && (
          <button type="button" className="btn-sm" onClick={onGoCommit}>
            ③ コミット・プッシュへ
          </button>
        )}
        <button type="button" className="btn-sm" onClick={onGoComplete}>
          ④ 完了へ
        </button>
        <span className="w-report-key">Ctrl+Enter でも書き込めます</span>
      </div>
      {note && <p className={`w-report-note${note.ok ? "" : " err"}`}>{note.text}</p>}
      <div className="w-report-past">
        <h5>この Issue のコメント{comments ? `（${comments.length}）` : ""}</h5>
        {comments === null ? (
          <p className="muted">読み込んでいます…</p>
        ) : comments.length === 0 ? (
          <p className="muted">まだありません</p>
        ) : (
          past.map((c) => (
            <div key={c.id} className="w-report-item">
              <span className="w-report-who">{c.user.login}</span>
              <span className="w-report-when">{formatWhen(c.created_at)}</span>
              <p>{commentPreview(c.body).slice(0, 240)}</p>
            </div>
          ))
        )}
        {comments && comments.length > past.length && <p className="muted">ほか {comments.length - past.length} 件は、Issue を開くと見られます</p>}
      </div>
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
          aria-label={side === "staged" ? "ステージから外す" : conflict ? "直したのでステージする" : "ステージする"}
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
        <code>git restore --staged</code> にあたります。記録しないファイルは右クリックで <code>.gitignore</code> に書いて無視できます。
      </p>
      {total === 0 ? (
        <div className="ws-none">
          作業中の変更はありません。ファイルを編集するとここに表示されます。
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
          <div className="dr-empty-note">空コミットではファイルの変更は含めません</div>
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
        退避（スタッシュ）はコミットせずに変更を一時的にしまっておく機能です。ブランチを切り替えるときなどに使います（
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
  /** ① 作業を選ぶ画面へ */
  onPickIssue: () => void;
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
  onPickIssue,
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
  // マージの途中で競合を直し終えたら、変更がなくてもコミットでマージを終える（競合を「今のブランチの方」で直すと、変更は 0 になる）
  const concludingMerge = st.operation === "merge" && !hasConflicts;
  const nothingToCommit = stagedCount === 0 && !draft.amend && !draft.allowEmpty && !concludingMerge;
  // コミットは必ず Issue につなげる（マージを終えるコミット・直前のコミットの修正は別）
  const needsIssue = !issue && !concludingMerge && !draft.amend;
  const blocked = busy || nothingToCommit || hasConflicts || needsIssue || (draft.amend && !st.head);

  return (
    <div className="dr-form">
      <p className="hint">
        コミットはステージ済みの変更に要約を付けて、履歴に記録することです（<code>git commit</code>）。
      </p>
      <input
        ref={summaryRef}
        className="input-full"
        placeholder={draft.allowEmpty ? "空コミットの目的（例: CI を動かす、区切りを付ける）" : "変更の要約（必須）"}
        autoComplete="off"
        value={draft.summary}
        onChange={(e) => set({ summary: e.target.value })}
        onKeyDown={(e) => {
          if (isEnter(e) && (e.ctrlKey || e.metaKey) && !blocked) onCommit(messages, !!st.branch);
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
          title={lastPushed ? "直前のコミットはもう GitHub に送ってあるので、修正できません。送り直すには強制プッシュが必要になります" : "直前のコミットに今の変更と要約を入れ直します"}
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
      {needsIssue && (
        <p className="w-form-note">
          コミットは Issue につなげます。先に取り組む Issue を選びます。{" "}
          <button type="button" className="link-button" onClick={onPickIssue}>
            ① 作業を選ぶ
          </button>
        </p>
      )}
      {nothingToCommit && !hasConflicts && !needsIssue && (
        <p className="w-form-note">コミットするファイルにチェックを入れてください（または「空コミット」にします）</p>
      )}
      {hasConflicts && <p className="w-form-note">競合しているファイルを直して、ステージしてからコミットします</p>}
      <div className="dr-actions">
        <button type="button" className="btn-primary" disabled={blocked || !st.branch} onClick={() => onCommit(messages, true)}>
          コミットしてプッシュ
        </button>
        <button type="button" className="btn-sm" disabled={blocked} onClick={() => onCommit(messages, false)}>
          コミットだけ
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
