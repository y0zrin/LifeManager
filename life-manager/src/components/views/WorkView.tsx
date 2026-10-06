import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import * as gitApi from "../../lib/git";
import type { GitFileChange, GitHubComment, GitHubIssue, GitHubMilestone, GitLineStat, GitRun, GitStash, GitStatus, WatchFinding } from "../../lib/types";
import type { GitState } from "../../hooks/useGit";
import { OPERATION_NAMES, type GitActions } from "../../hooks/useGitActions";
import { LocalFolderSetting } from "../common/LocalFolderSetting";
import { DiffView } from "../git/DiffView";
import { MergeTool } from "../git/MergeTool";
import { withTransition } from "../../lib/motion";
import { celebrateDone } from "../../lib/celebrate";
import { isEnter } from "../../lib/keys";
import { branchPull, deletePullBranch, pullRepoInfo, type PullSummary } from "../../lib/pulls";
import { countOf } from "../../lib/count";
import { commentPreview } from "../../lib/help";
import { branchNameFor, rememberWorkBranch, workBranchOf } from "../../lib/branchName";
import { tr, trx } from "../../lib/i18n";

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
  /** ① に Issue がないとき（#247）: マイルストーンの画面を開く・このマイルストーンで絞ったボードでタスクを足す */
  onOpenMilestones: () => void;
  onAddOnBoard: (milestone: number | null) => void;
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
  /** 完了の知らせの「元に戻す」（#232） */
  onReopenIssue: (n: number) => Promise<void>;
  /** 閉じた Issue（マージで閉じた Issue を、完了の段で見せる） */
  closedIssues: GitHubIssue[];
  /** プルリクを作る（プルリクの画面で、作るダイアログを開く） */
  onCreatePull: (head: string | null, issue: number | null) => void;
  onOpenPull: (n: number) => void;
  draft: CommitDraft;
  onDraftChange: (draft: CommitDraft) => void;
  /** ツールバーの「コミット…」「空コミット…」から来たとき。コミット欄を開いたら onCommitRequestHandled で消してもらう */
  commitRequest: { empty?: boolean } | null;
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
  /** チームのメンバー（引き継ぐ相手を選ぶ） */
  members: { login: string }[];
  /** 作業を止める: 状態を「未着手」に戻す（担当はそのまま） */
  onStopIssue: (n: number) => Promise<void>;
  /** 引き継ぐ: 担当を相手にする */
  onHandOverIssue: (n: number, to: string) => Promise<void>;
}

type Side = "staged" | "unstaged";
type MenuPos = { x: number; y: number };
type Selected = { path: string; side: Side };
/** 取り組み中の Issue（null はまだ選んでいないとき）。コミットは必ず Issue につなげるので「Issue なし」はない */
type IssueChoice = number | null;

// 作業をする（#218）: ① 選ぶ → ② 作業報告 → ③ コミット・プッシュ。② と ③ は、④ 完了にする（Issue を閉じる）までくり返す。
// 閉じるまでを 1 つの作業とする
const STEP_NAMES = [tr("作業を選ぶ"), tr("作業報告"), tr("コミット・プッシュ"), tr("完了")];
/** 上の 1 行の段に出す短い名前 */
const STEP_SHORT = [tr("選ぶ"), tr("作業報告"), tr("コミット・プッシュ"), tr("完了")];
const IN_PROGRESS = "状態:進行中";
/** 作業を止めた・引き継いだときに Issue に書くコメントの、続きのブランチのところ（受け取る人は、このブランチで続ける） */
const CONTINUE_ON = /続きはブランチ「([^」]+)」にあります。/;

/** コメントから読んだ名前が、git のブランチの名前として正しいか（git check-ref-format のきまり）。
 *  - で始まる名前は git のオプションに、: を含む名前はフェッチの「取り込み先」に読まれてしまうので使わない */
function isBranchName(s: string): boolean {
  return s.length > 0 && s.length <= 250 && s !== "@" && !/^[-.]|[\x00-\x20\x7f:~^?*[\\]|\.\.|@\{|\/\/|\/\.|\.lock$|[/.]$/.test(s);
}

/** チームの人（持ち主・メンバー・コラボレーター）が書いたコメントか */
const TEAM_ROLES = ["OWNER", "MEMBER", "COLLABORATOR"];

// --- 取り組み中の Issue は、リポジトリとアカウントごとにこの PC に覚えておく
//     （同じ PC でアカウントを切り替えたとき、前のアカウントの作業が今の作業にならないように） ---

function issueKey(owner: string, repo: string, login: string) {
  return `work-issue:${owner}/${repo}:${login.toLowerCase()}`;
}

/** 0.9 まではリポジトリごとに覚えていた。その覚えは、先に開いたアカウントのものにする */
function adoptOld(oldKey: string, key: string) {
  const old = localStorage.getItem(oldKey);
  if (old === null) return;
  if (localStorage.getItem(key) === null) localStorage.setItem(key, old);
  localStorage.removeItem(oldKey);
}

function loadIssueChoice(owner: string, repo: string, login: string): IssueChoice {
  if (!login) return null;
  try {
    adoptOld(`work-issue:${owner}/${repo}`, issueKey(owner, repo, login));
    const v = localStorage.getItem(issueKey(owner, repo, login));
    const n = Number(v);
    return v && Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

/** 作業タブで取り組んでいる Issue（ボードの「✏️ 作業中」の印・上のバーの 🆘 に使う） */
export function loadWorkIssue(owner: string, repo: string, login: string): number | null {
  return loadIssueChoice(owner, repo, login);
}

function saveIssueChoice(owner: string, repo: string, login: string, choice: IssueChoice) {
  if (!login) return;
  try {
    if (choice === null) localStorage.removeItem(issueKey(owner, repo, login));
    else localStorage.setItem(issueKey(owner, repo, login), String(choice));
  } catch {
    // 覚えられなくても、今は選んだ Issue で作業できる
  }
}

// --- 作業報告を書いた回数: Issue ごとに、この PC にアカウントごとに覚えておく（段の「作業報告 2 回」に出す。完了にしたら消す） ---

function reportsKey(owner: string, repo: string, login: string) {
  return `work-reports:${owner}/${repo}:${login.toLowerCase()}`;
}

function loadReports(owner: string, repo: string, login: string): Record<string, number> {
  if (!login) return {};
  try {
    adoptOld(`work-reports:${owner}/${repo}`, reportsKey(owner, repo, login));
    const v = JSON.parse(localStorage.getItem(reportsKey(owner, repo, login)) ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

function saveReports(owner: string, repo: string, login: string, map: Record<string, number>) {
  if (!login) return;
  try {
    localStorage.setItem(reportsKey(owner, repo, login), JSON.stringify(map));
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
  A: tr("追加したファイル"),
  M: tr("変更したファイル"),
  D: tr("削除したファイル"),
  R: tr("名前を変えたファイル"),
  C: tr("コピーしたファイル"),
  T: tr("種類が変わったファイル"),
  U: tr("競合（コンフリクト）しているファイル"),
  "?": tr("まだ git が追跡していない新しいファイル"),
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
  if (pr.draft) return tr("下書き");
  if (pr.checks && pr.checks.failure > 0) return tr("✖ チェック");
  const v = pr.verdicts;
  if (v && v.changes_requested.length > 0) return tr("修正の依頼");
  if (v && v.approved.length > 0) return tr("承認 {length}", { length: v.approved.length });
  return tr("レビュー待ち");
}

export function WorkView(props: WorkViewProps) {
  const { owner, repo, folder, onSetFolder, git: g, onOpenSetup, setupVersion, currentUser } = props;

  if (!folder) {
    return (
      <div className="content">
        <div className="work-setup">
          <h2>{tr("作業を始める準備")}</h2>
          <p>
            {tr("「作業をする」では、マイルストーンと Issue を選び、作業報告とコミット・プッシュを、Issue を完了にするまでくり返します。そのあいだ、実行する git のコマンドが見られます。まず、このリポジトリをこの PC のどのフォルダに置くかを決めましょう。")}
          </p>
          <LocalFolderSetting
            owner={owner}
            repo={repo}
            folder={undefined}
            onSetFolder={onSetFolder}
            onOpenSetup={onOpenSetup}
            setupVersion={setupVersion}
            login={currentUser}
          />
        </div>
      </div>
    );
  }

  if (g.loadError) {
    return (
      <div className="content">
        <div className="work-setup">
          <h2>{tr("作業フォルダを読めませんでした")}</h2>
          <p className="local-folder-message local-folder-message--error">{g.loadError}</p>
          <p>{tr("フォルダを移動したり消したりした場合は、選び直してください。")}</p>
          <LocalFolderSetting
            owner={owner}
            repo={repo}
            folder={folder}
            onSetFolder={onSetFolder}
            onOpenSetup={onOpenSetup}
            setupVersion={setupVersion}
            login={currentUser}
          />
        </div>
      </div>
    );
  }

  if (!g.status) {
    return (
      <div className="content">
        <p className="work-loading">{tr("読み込んでいます…")}</p>
      </div>
    );
  }

  return <Workspace {...props} status={g.status} folder={folder} />;
}

function Workspace({
  onOpenMilestones,
  onAddOnBoard,
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
  onReopenIssue,
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
  members,
  onStopIssue,
  onHandOverIssue,
  status: st,
}: WorkViewProps & { status: GitStatus; folder: string }) {
  const [choice, setChoiceState] = useState<IssueChoice>(() => loadIssueChoice(owner, repo, currentUser));
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
  const [reportCounts, setReportCounts] = useState<Record<string, number>>(() => loadReports(owner, repo, currentUser));

  useEffect(() => {
    setChoiceState(loadIssueChoice(owner, repo, currentUser));
    setViewStep(null);
    setReportCounts(loadReports(owner, repo, currentUser));
  }, [owner, repo, currentUser]);

  function bumpReports(n: number) {
    setReportCounts((cur) => {
      const next = { ...cur, [String(n)]: (cur[String(n)] ?? 0) + 1 };
      saveReports(owner, repo, currentUser, next);
      return next;
    });
  }

  function clearReports(n: number) {
    setReportCounts((cur) => {
      const next = { ...cur };
      delete next[String(n)];
      saveReports(owner, repo, currentUser, next);
      return next;
    });
  }

  function setChoice(c: IssueChoice) {
    setChoiceState(c);
    saveIssueChoice(owner, repo, currentUser, c);
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

  // --- コミットの前の見張り（#234）: 大きすぎるファイル・ツールが作るフォルダ（Unity の Library など） ---
  // 消したもの（.gitignore に足して管理から外したものも）は、記録から外れるだけなので見張らない
  const isGone = (f: GitFileChange) => f.staged === "D" || f.unstaged === "D";
  const [watch, setWatch] = useState<WatchFinding[]>([]);
  // （Unity の Library のように、何万ものファイルがあっても、打つたびに作り直さない）
  const watchKey = useMemo(() => files.filter((f) => !isGone(f)).map((f) => f.path).join("\n"), [files]);
  useEffect(() => {
    const folder = g.folder;
    if (!folder || !watchKey) {
      setWatch([]);
      return;
    }
    let alive = true;
    gitApi
      .commitWatch(folder, watchKey.split("\n"))
      .then((found) => { if (alive) setWatch(found); })
      .catch(() => { if (alive) setWatch([]); });
    return () => { alive = false; };
  }, [g.folder, watchKey]);
  // チェックを入れた（ステージした）ものがあるあいだは、コミットできない
  const watchStaged = (f: WatchFinding) =>
    staged.some((s) => !isGone(s) && (f.kind === "large" ? s.path === f.path : s.path.startsWith(`${f.path}/`)));
  const watchBlocked = watch.some(watchStaged);

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
  // この Issue の作業に使っているブランチを覚える（題名を変えても、このブランチで続けられるように。#251）
  const workingIssue = issue?.number ?? null;
  useEffect(() => {
    if (workingIssue !== null && onBranch) rememberWorkBranch(owner, repo, workingIssue, st.branch);
  }, [workingIssue, onBranch, st.branch, owner, repo]);

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
      issue ? `#${issue.number} ${issue.title}` : closedIssue ? `#${closedIssue.number}` : tr("選ぶ"),
      reports > 0 ? tr("作業報告 {reports} 回", { reports }) : tr("作業報告"),
      changeCount ? tr("コミット・プッシュ（{changeCount} ファイル）", { changeCount }) : needsPush ? tr("コミット・プッシュ（{v}）", { v: published ? `↑${st.ahead}` : tr("未公開") }) : tr("コミット・プッシュ"),
      closedIssue
        ? tr("完了（閉じました）")
        : onBranch && pr
          ? tr("完了（#{number} {v}）", { number: pr.number, v: pr.merged ? tr("マージ済み") : pr.state === "open" ? reviewLabel(pr) : tr("閉じた") })
          : tr("完了"),
    ];
    return { step, labels };
  })();

  // 完了にする（Issue を閉じる。前と同じ）
  const finish = (n: number) => async () => {
    await onCloseIssue(n);
    // 「元に戻す」: 開き直して、また同じ作業に戻る
    celebrateDone(`#${n}`, undefined, undefined, () => {
      void onReopenIssue(n);
      setChoice(n);
    });
    clearReports(n);
    setChoice(null);
  };
  // 既定のブランチに戻って最新にする
  const backToDefault = async () => {
    const switched = await g.exec(tr("切り替えています"), (p) => gitApi.switchBranch(p, defaultBranch, false), tr("{defaultBranch} に切り替えました", { defaultBranch }));
    if (switched.ok) await g.exec(tr("プルしています"), gitApi.pull, tr("{defaultBranch} を最新にしました", { defaultBranch }));
    return switched.ok;
  };
  // 終えたブランチを消す（先に既定のブランチに戻る）。pc = この PC から（GitHub には残す）、both = この PC と GitHub から
  const [dropAsk, setDropAsk] = useState<"pc" | "both" | null>(null);
  useEffect(() => setDropAsk(null), [st.branch]);
  // GitHub のブランチを消せるのはリーダー（リポジトリの管理者）だけ。メンバーは送ってから、この PC から消す（作業は GitHub に残る）
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    let alive = true;
    setIsAdmin(false);
    pullRepoInfo(owner, repo)
      .then((info) => alive && setIsAdmin(!!info.is_admin))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [owner, repo]);
  const dropBranch = async (mode: "pc" | "both") => {
    const name = st.branch;
    const onGitHub = mode === "both" && published && isAdmin;
    setDropAsk(null);
    // PC からだけ消すときは、作業が GitHub に残るよう、送っていないコミットを先に送る
    if (mode === "pc" && (!published || needsPush)) {
      const pushed = await g.exec(tr("プッシュしています"), gitApi.push, tr("{name} を GitHub に送りました", { name }));
      if (!pushed.ok) return;
    }
    if (!(await backToDefault())) return;
    const removed = await g.exec(tr("削除しています"), (p) => gitApi.deleteBranch(p, name, true), tr("{name} を削除しました", { name }));
    if (!removed.ok || !onGitHub) return;
    try {
      await deletePullBranch(owner, repo, name);
      g.notify("ok", tr("GitHub のブランチ {name} も消しました", { name }));
    } catch (e) {
      // マージのときに GitHub で消してあれば、もうない
      if (!/Reference does not exist|Not Found|404|422/i.test(String(e))) g.notify("error", String(e));
    }
    // この PC の控え（origin/…）も片づける（ブランチの画面に「GitHub にだけある」と残らないように）
    await g.exec(tr("GitHub から読んでいます"), gitApi.fetch, "", { quiet: true, inlineError: true });
  };
  const toDefault: StepButton = { label: tr("{defaultBranch} に戻って最新にする", { defaultBranch }), run: () => void backToDefault() };
  // GitHub からも消せるのはリーダー（リポジトリの管理者）だけ。リーダーは 2 つから選ぶ
  const askDrops: StepButton[] = [
    { label: tr("このブランチを PC から消す…"), run: () => setDropAsk("pc") },
    ...(isAdmin ? [{ label: tr("このブランチを PC と GitHub から消す…"), run: () => setDropAsk("both") }] : []),
  ];
  // マージしたあと: このブランチで続ける（既定のブランチの最新を取り込む）か、既定のブランチに戻って最新にする
  const branchAfter: StepButton[] =
    onBranch && pr?.merged
      ? [
          {
            label: tr("このブランチで続ける（{defaultBranch} の最新を取り込む）", { defaultBranch }),
            run: async () => {
              const fetched = await g.exec(tr("GitHub から読んでいます"), gitApi.fetch, tr("GitHub から読みました"));
              if (fetched.ok) await g.exec(tr("取り込んでいます"), (p) => gitApi.merge(p, `origin/${defaultBranch}`), tr("{defaultBranch} の最新を {branch} に取り込みました", { defaultBranch, branch: st.branch }));
            },
          },
          toDefault,
        ]
      : [];
  // 作業を止める・引き継ぐ（① の「今の作業」）: 送っていないコミットを送り、Issue を変えてコメントを残し、既定のブランチに戻る
  const [leaveMode, setLeaveMode] = useState<"stop" | "hand" | null>(null);
  const others = members.filter((m) => m.login !== currentUser);
  const [handTo, setHandTo] = useState("");
  useEffect(() => setLeaveMode(null), [issue?.number]);
  const leaveWork = async (mode: "stop" | "hand") => {
    if (!issue || changeCount > 0) return;
    const n = issue.number;
    const branchName = onBranch ? st.branch : "";
    const to = mode === "hand" ? handTo || others[0]?.login || "" : "";
    if (mode === "hand" && !to) return;
    // 作業のブランチは必ず GitHub に送る（受け取る人が、そのブランチでコミットの履歴ごと続けられるように）。
    // 送るコミットがなくても送る（GitHub で消されていれば作り直す）。既定のブランチでも、送っていないコミットは送る
    if (onBranch || needsPush) {
      const pushed = await g.exec(tr("プッシュしています"), gitApi.push, tr("プッシュしました"));
      if (!pushed.ok) return;
    }
    // Issue に書く文は日本語のまま（チームの中で同じ形で読めるように）
    if (mode === "stop") {
      await onStopIssue(n);
      await onComment(n, branchName ? `作業を止めました。続きはブランチ「${branchName}」にあります。` : "作業を止めました。");
    } else {
      await onHandOverIssue(n, to);
      await onComment(n, branchName ? `@${to} さんに引き継ぎます。続きはブランチ「${branchName}」にあります。` : `@${to} さんに引き継ぎます。`);
    }
    setLeaveMode(null);
    setChoice(null);
    if (onBranch) await backToDefault();
  };
  const nowActions: StepButton[] = issue
    ? [
        { label: tr("作業を止める…"), run: () => setLeaveMode("stop") },
        { label: tr("引き継ぐ…"), run: () => setLeaveMode("hand") },
      ]
    : [];
  const leavePanel: ReactNode =
    !issue || !leaveMode ? null : changeCount > 0 ? (
      <div className="w-step-note">
        <span className="w-step-note-text">{tr("コミットしていない変更があります。③ でコミットしてプッシュしてから、もう一度押します。")}</span>
        <span className="w-step-note-actions">
          <button type="button" className="btn-sm" onClick={() => { setLeaveMode(null); setViewStep(3); }}>{tr("③ コミット・プッシュへ")}</button>
          <button type="button" className="btn-sm" onClick={() => setLeaveMode(null)}>{tr("やめる")}</button>
        </span>
      </div>
    ) : leaveMode === "stop" ? (
      <div className="w-step-note">
        <span className="w-step-note-text">{tr("#{number} の作業を止めて、状態を「未着手」に戻します。", { number: issue.number })}</span>
        <span className="w-step-note-actions">
          <button type="button" className="btn-primary" disabled={g.busy !== null} onClick={() => void leaveWork("stop")}>{tr("止める")}</button>
          <button type="button" className="btn-sm" onClick={() => setLeaveMode(null)}>{tr("やめる")}</button>
        </span>
      </div>
    ) : others.length === 0 ? (
      <div className="w-step-note">
        <span className="w-step-note-text">{tr("引き継げるメンバーがいません。")}</span>
        <span className="w-step-note-actions">
          <button type="button" className="btn-sm" onClick={() => setLeaveMode(null)}>{tr("やめる")}</button>
        </span>
      </div>
    ) : (
      <div className="w-step-note">
        <span className="w-step-note-text">
          <label className="w-hand-to">
            {tr("引き継ぐ相手")}{" "}
            <select className="select-sm" value={handTo || others[0].login} onChange={(e) => setHandTo(e.target.value)}>
              {others.map((m) => (
                <option key={m.login} value={m.login}>{m.login}</option>
              ))}
            </select>
          </label>
        </span>
        <span className="w-step-note-actions">
          <button type="button" className="btn-primary" disabled={g.busy !== null} onClick={() => void leaveWork("hand")}>{tr("引き継ぐ")}</button>
          <button type="button" className="btn-sm" onClick={() => setLeaveMode(null)}>{tr("やめる")}</button>
        </span>
      </div>
    );
  // GitHub にこのブランチがあるか（引き継いだ作業を、受け取る人がそのブランチで続けられるように）。g は描くたびに変わるので ref で持つ
  const gRef = useRef(g);
  gRef.current = g;
  const checkRemote = useCallback(
    async (name: string) => (await gRef.current.exec(tr("GitHub を調べています"), (p) => gitApi.fetchBranch(p, name), "", { quiet: true, inlineError: true })).ok,
    [],
  );
  // 止めた・引き継いだときのコメント（「続きはブランチ「…」にあります。」）から、続きのブランチを読む（いちばん新しいもの）。
  // チームの人が書いたものだけ（公開のリポジトリには、だれでもコメントを書けるので）
  const listRef = useRef(onListComments);
  listRef.current = onListComments;
  const membersRef = useRef(members);
  membersRef.current = members;
  const handedBranch = useCallback(async (n: number) => {
    const comments = await listRef.current(n);
    const team = new Set(membersRef.current.map((m) => m.login.toLowerCase()));
    const byTeam = (c: GitHubComment) => !!c._pending || team.has(c.user.login.toLowerCase()) || TEAM_ROLES.includes(c.author_association ?? "");
    for (let k = comments.length - 1; k >= 0; k--) {
      const m = CONTINUE_ON.exec(comments[k].body);
      if (m && isBranchName(m[1]) && byTeam(comments[k])) return m[1];
    }
    return null;
  }, []);
  // ① で、既定のブランチでないブランチにいる（前の作業のブランチ）: 戻る・消す。作業を選ぶ前か、今の作業が閉じたあとに出す
  const showLeftover = onBranch && (flow.step === 1 || !!closedIssue);
  const leftoverButtons: StepButton[] = pr?.merged ? [...branchAfter, ...askDrops] : pr?.state === "open" ? [toDefault] : [toDefault, ...askDrops];
  const dropLosesWork = hasOwnCommits && !pr?.merged;
  const dropConfirm: ReactNode = (
    <>
      {dropAsk !== "both"
        ? trx("ブランチ <0>{branch}</0> を、この PC から消します。GitHub のブランチは残ります。", { branch: st.branch }, [<b />])
        : published
          ? dropLosesWork
            ? trx("ブランチ <0>{branch}</0> を、この PC と GitHub から消します。マージしていないコミットは消え、戻せません。", { branch: st.branch }, [<b />])
            : trx("ブランチ <0>{branch}</0> を、この PC と GitHub から消します。", { branch: st.branch }, [<b />])
          : dropLosesWork
            ? trx("ブランチ <0>{branch}</0> を、この PC から消します。マージしていないコミットは消え、戻せません。", { branch: st.branch }, [<b />])
            : trx("ブランチ <0>{branch}</0> を、この PC から消します。", { branch: st.branch }, [<b />])}{" "}
      <button type="button" className="btn-danger" disabled={g.busy !== null} onClick={() => void dropBranch(dropAsk ?? "pc")}>{tr("消す")}</button>{" "}
      <button type="button" className="btn-sm" onClick={() => setDropAsk(null)}>{tr("やめる")}</button>
    </>
  );
  const leftoverNote: ReactNode = dropAsk ? (
    dropConfirm
  ) : pr?.merged ? (
    trx("このブランチ（<0>{branch}</0>）のプルリク <1>#{number}</1> はマージ済みです。", { branch: st.branch, number: pr.number }, [<b />, <b />])
  ) : pr?.state === "open" ? (
    trx("このブランチ（<0>{branch}</0>）のプルリク <1>#{number}</1> は、まだマージしていません。", { branch: st.branch, number: pr.number }, [<b />, <b />])
  ) : hasOwnCommits ? (
    trx("ブランチ <0>{branch}</0> にいます。マージしていないコミットがあります。", { branch: st.branch }, [<b />])
  ) : (
    trx("ブランチ <0>{branch}</0> にいます。", { branch: st.branch }, [<b />])
  );
  const reloadPr = () =>
    branchPull(owner, repo, st.branch)
      .then((pull) => setBranchPr({ branch: st.branch, pull, error: null }))
      .catch(() => {});

  // ④ 完了の画面: ブランチで作業していれば、プルリク → マージ → 閉じる。既定のブランチで直接なら、そのまま閉じる
  const unsentNote =
    changeCount > 0 || needsPush ? <span className="w-flow-warn">{tr("まだコミット・プッシュしていない変更があります（③ コミット・プッシュ）。")}</span> : null;
  const complete: { hint: ReactNode; buttons: StepButton[] } = (() => {
    if (closedIssue) {
      if (dropAsk && onBranch) return { hint: dropConfirm, buttons: [] };
      return {
        hint: (
          <>
            {pr?.merged
              ? tr("#{number} は閉じられました（#{pr} のマージで）。", { number: closedIssue.number, pr: pr.number })
              : tr("#{number} は閉じられました。", { number: closedIssue.number })}
          </>
        ),
        buttons: [
          {
            label: tr("完了（次の作業へ）"),
            run: () => {
              celebrateDone(`#${closedIssue.number}`);
              clearReports(closedIssue.number);
              setChoice(null);
            },
            primary: true,
          },
          ...branchAfter,
          ...(onBranch && pr?.state !== "open" ? askDrops : []),
        ],
      };
    }
    if (!issue) return { hint: <>{tr("先に ① で、取り組む Issue を選びます。")}</>, buttons: [{ label: tr("① 作業を選ぶ"), run: () => setViewStep(1), primary: true }] };
    const done: StepButton = { label: tr("#{number} を完了にする", { number: issue.number }), run: finish(issue.number) };
    if (onBranch && hasOwnCommits) {
      if (!published || needsPush) {
        return {
          hint: (
            <>
              {trx("このブランチ（<0>{branch}</0>）のコミットを、まだ GitHub に送っていません。{unsentNote}", { branch: st.branch, unsentNote }, [<b />])}
            </>
          ),
          buttons: [{ label: tr("③ コミット・プッシュへ"), run: () => setViewStep(3), primary: true }, { label: tr("このまま完了にする"), run: done.run }],
        };
      }
      if (pr?.merged) {
        return {
          hint: (
            <>
              {trx("プルリク <0>#{number}</0> はマージ済みです。{unsentNote}", { number: pr.number, unsentNote }, [<b />])}
            </>
          ),
          buttons: [{ ...done, primary: true }, ...branchAfter],
        };
      }
      if (pr?.state === "open") {
        return {
          hint: (
            <>
              {trx("プルリク <0>#{number}</0> を出しています（{reviewLabel}）。", { number: pr.number, reviewLabel: reviewLabel(pr) }, [<b />])}
              {pr.checks && pr.checks.failure > 0 && (
                <span className="w-flow-warn">
                  {tr("✖ チェック（Actions のテストなど）が {n}失敗しています。", { n: countOf(pr.checks.failure, tr("件")) })}
                </span>
              )}
              {unsentNote}
            </>
          ),
          buttons: [
            { label: tr("#{number} を開く（レビュー・マージ）", { number: pr.number }), run: () => onOpenPull(pr.number), primary: true },
            { label: tr("もう一度読む"), run: reloadPr },
            { label: tr("マージせずに完了にする"), run: done.run },
          ],
        };
      }
      return {
        hint:
          (pr && pr.state === "closed" && !pr.merged) || prError || unsentNote ? (
            <>
              {pr && pr.state === "closed" && !pr.merged && <>{trx("前のプルリク #{number} はマージせずに閉じられています。", { number: pr.number })}</>}
              {prError && <span className="w-flow-warn">{prError}</span>}
              {unsentNote}
            </>
          ) : null,
        buttons: [
          { label: tr("プルリクを作る…"), run: () => onCreatePull(st.branch, issue.number), primary: true },
          { label: tr("プルリクを出さずに完了にする"), run: done.run },
        ],
      };
    }
    return {
      hint: (
        <>
          {onDefault ? (
            <>
              {trx("既定のブランチ（<0>{branch}</0>）で作業しました。", { branch: st.branch }, [<b />])}
            </>
          ) : null}
          {trx("Issue を閉じて完了にします。{unsentNote}", { unsentNote })}
        </>
      ),
      buttons: [{ ...done, primary: true }],
    };
  })();

  // ④ のボタンの最後に「Issue を開く」（消す前の確かめを出しているときは出さない）
  const completeIssue = issue ?? closedIssue;
  const completeButtons: StepButton[] =
    completeIssue && complete.buttons.length > 0 ? [...complete.buttons, { label: tr("Issue を開く"), run: () => onOpenIssue(completeIssue.number) }] : complete.buttons;

  // 進んだら（今の段が変わったら）、その段の画面に切り替える
  useEffect(() => {
    setViewStep(null);
  }, [flow.step]);
  const shown = viewStep ?? flow.step;

  return (
    <div className={`wview${changeCount === 0 ? " no-changes" : ""}${draft.allowEmpty ? " empty" : ""}`}>
      <ol className="w-steps" aria-label={tr("作業の流れ")}>
        {STEP_SHORT.map((name, i) => {
          const n = i + 1;
          // 済みの印は ① だけ（② と ③ は完了までくり返す）
          const done = n === 1 && flow.step > 1 && !!(issue ?? closedIssue);
          return (
            <Fragment key={n}>
              {n === 4 && (
                <li className="w-steps-loop" title={tr("完了にするまで、② 作業報告と ③ コミット・プッシュをくり返します")}>
                  {trx("↻<0> 完了までくり返す</0>", undefined, [<span className="w-loop-lb" />])}
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
            {st.operation && <b>{trx("{OPERATION_NAMES}の途中です。", { OPERATION_NAMES: OPERATION_NAMES[st.operation] })}</b>}
            {st.conflicted ? (
              <>
                {trx("⚠ 競合（コンフリクト）しているファイルがあります。ファイルを選ぶと右に「競合を直す」が出ます。か所ごとに使う方を選んで「直したのでステージする」を押します（<0>git add</0>）。", undefined, [<code />])}
              </>
            ) : (
              tr("競合はすべて直してあります。")
            )}
            {st.operation === "merge"
              ? tr("そのあとコミットするとマージが完了します。")
              : st.operation
                ? <>{trx("そのあと「続ける」を押します（<0>git {operation} --continue</0>）。", { operation: st.operation }, [<code />])}</>
                : tr("そのあとコミットします。")}
          </span>
          {st.operation && st.operation !== "merge" && (
            <button type="button" className="btn-sm" disabled={st.conflicted || g.busy !== null} onClick={actions.continueOperation}>
              {tr("続ける")}
            </button>
          )}
          {st.operation && (
            <button type="button" className="btn-sm" disabled={g.busy !== null} onClick={actions.abortOperation}>
              {trx("{OPERATION_NAMES}を中止…", { OPERATION_NAMES: OPERATION_NAMES[st.operation] })}
            </button>
          )}
        </div>
      )}
      {!st.branch && st.head && (
        <div className="w-banner">
          <span>
            {trx("ブランチから切り離された状態です（<0>{head}</0>）。ここでコミットしても、どのブランチにも属しません。", { head: st.head }, [<code />])}
          </span>
          <button type="button" className="btn-sm" onClick={() => actions.createBranch()}>
            {tr("ここからブランチを作成…")}
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
          onStart={(n, how, own) => {
            setChoice(n);
            setViewStep(null);
            // 自分を担当にして「進行中」に（ボードの自分のタスク・進行中に出る）
            void onStartIssue(n);
            // ブランチの名前は Issue の題名から（#251）
            // 作ったブランチは、作業の始まりのコミット（「〇〇 が作業開始しました」）を付けてすぐ GitHub に送る。
            // 途中で引き継いでも、受け取る人がそのブランチで続けられるように
            const announce = async (name: string) => {
              if (staged.length === 0) {
                const who = currentUser || "だれか";
                await g.exec(tr("作業の始まりを記録しています"), (p) => gitApi.commit(p, [`${who} が作業開始しました (#${n})`], false, true), tr("作業の始まりを記録しました"));
              }
              await g.exec(tr("プッシュしています"), gitApi.push, tr("{name} を GitHub に送りました", { name }));
            };
            // 別の作業のブランチにいるときは、既定のブランチの最新から作る（前の作業のコミットが混ざらないように）
            if (how === "create" && onBranch) {
              void g
                .exec(tr("GitHub から読んでいます"), gitApi.fetch, tr("GitHub から読みました"), { quiet: true })
                .then((r) => actions.createBranch(own, r.ok ? `origin/${defaultBranch}` : defaultBranch, announce));
            } else if (how === "create") actions.createBranch(own, undefined, announce);
            else if (how === "switch") actions.requestSwitch(own);
            else if (how === "continue") {
              // 続きのブランチ（引き継いだ作業など）: GitHub の最新にしてから切り替える。この PC になければ、GitHub のブランチを追いかけて作る
              if (own === st.branch) void actions.pull();
              else {
                const local = g.branches.some((b) => b.name === own);
                void g.exec(tr("GitHub から読んでいます"), (p) => gitApi.pullBranch(p, own), "", { quiet: true }).then((r) => {
                  // この PC のブランチと GitHub のブランチが分かれていても切り替える（③ でプルして取り込む）
                  if (r.ok || local) actions.requestSwitch(own);
                });
              }
            }
          }}
          onOpenIssue={onOpenIssue}
          onOpenMilestones={onOpenMilestones}
          onAddOnBoard={onAddOnBoard}
          note={showLeftover ? leftoverNote : null}
          extras={showLeftover && !dropAsk ? leftoverButtons : []}
          nowActions={nowActions}
          nowPanel={leavePanel}
          checkRemote={checkRemote}
          handedBranch={handedBranch}
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
        <StepPanel n={4} current={flow.step === 4} hint={complete.hint} status={null} buttons={completeButtons} busy={g.busy !== null} />
      ) : (
      <>
      {/* ③ コミット・プッシュ: 今のブランチと、変更がないときのプッシュ（またはプル） */}
      <div className="w-cp-strip">
        <span className="w-cp-branch">
          {tr("ブランチ")}{" "} <b>{st.branch || tr("切り離し {head}", { head: st.head })}</b>
          {onDefault && <small>{tr("（既定のブランチに直接コミットします）")}</small>}
        </span>
        {onDefault && issue && (
          <button type="button" className="btn-sm" disabled={g.busy !== null} onClick={() => actions.createBranch(branchNameFor(issue))}>
            {tr("ブランチを分ける…")}
          </button>
        )}
        {issue && (
          <button type="button" className="btn-sm" onClick={() => onOpenIssue(issue.number)}>
            {tr("Issue を開く")}
          </button>
        )}
        <span className="w-cp-right">
          {changeCount === 0 && needsPush ? (
            st.behind > 0 ? (
              <button type="button" className="btn-primary" disabled={g.busy !== null} onClick={actions.pull}>
                {tr("プルする（GitHub に新しいコミットがあります）")}
              </button>
            ) : (
              <button type="button" className="btn-primary" disabled={g.busy !== null} onClick={actions.push}>
                {published ? tr("プッシュする（↑{n}）", { n: st.ahead }) : tr("プッシュする（はじめて送る）")}
              </button>
            )
          ) : changeCount === 0 ? (
            <span className="w-cp-none">{tr("変更はありません")}</span>
          ) : (
            <span className="w-cp-none">{trx("変更にチェックを入れ、要約を書いて「コミットしてプッシュ」（<0>git add</0> → <1>git commit</1> → <2>git push</2>）", undefined, [<code />, <code />, <code />])}</span>
          )}
        </span>
      </div>
      <div className="w-body">
        <div className="w-left">
          <div className="w-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === "changes"} className={`w-tab${tab === "changes" ? " on" : ""}`} onClick={() => changeTab("changes")}>
              {trx("変更 <0>{changeCount}</0>", { changeCount }, [<span className="count" />])}
              {tab === "changes" && <span className="tab-active-bar" aria-hidden="true" />}
            </button>
            <button type="button" role="tab" aria-selected={tab === "stash"} className={`w-tab${tab === "stash" ? " on" : ""}`} onClick={() => changeTab("stash")}>
              {trx("退避中 <0>{length}</0>", { length: g.stashes.length }, [<span className="count" />])}
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
            watch={<CommitWatch found={watch} isStaged={watchStaged} actions={actions} busy={g.busy !== null} />}
            watchBlocked={watchBlocked}
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
            <div className="w-right-empty">{tr("表示する差分はありません")}</div>
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
      {hint && <p className="hint">{hint}</p>}
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
  /** 始める: create = ブランチを作る、switch = この PC のブランチに切り替える、here = 今のブランチのまま、
   *  continue = 続きのブランチ（引き継いだ作業など）を GitHub の最新にして切り替える */
  /** own: この Issue の作業のブランチ（続きのブランチ・覚えたもの・前の issue-12・題名から作った名前。#251） */
  onStart: (n: number, how: "create" | "switch" | "here" | "continue", own: string) => void;
  onOpenIssue: (n: number) => void;
  onOpenMilestones: () => void;
  onAddOnBoard: (milestone: number | null) => void;
  /** 今の作業の行のボタン（作業を止める・引き継ぐ）と、押したときに行の下に出すもの */
  nowActions: StepButton[];
  nowPanel: ReactNode;
  /** GitHub にそのブランチがあるか（引き継いだ作業を、そのブランチで続ける） */
  checkRemote: (name: string) => Promise<boolean>;
  /** 止めた・引き継いだときのコメントにある、続きのブランチ（なければ null） */
  handedBranch: (n: number) => Promise<string | null>;
  /** マージ済みのブランチにいるときの知らせと、そのボタン（このブランチで続ける・既定のブランチに戻る） */
  note: ReactNode;
  extras: StepButton[];
  busy: boolean;
}

function IssueStep({ issues, milestones, owner, repo, issue, closedIssue, choice, currentUser, branch, onDefault, localBranches, onStart, onOpenIssue, onOpenMilestones, onAddOnBoard, nowActions, nowPanel, checkRemote, handedBranch, note, extras, busy }: IssueStepProps) {
  const [query, setQuery] = useState("");
  const [ms, setMs] = useState<string>(() => loadMilestone(owner, repo) ?? nearestMilestone(milestones));
  // ブランチを決めているところの Issue（行の下に、始め方を出す）
  const [picking, setPicking] = useState<number | null>(null);
  // 選んだ Issue のブランチが、この PC になく GitHub にあるか（name → あるか。調べている途中は undefined）
  const [onRemote, setOnRemote] = useState<Record<string, boolean>>({});
  // 1 つの名前は 1 回だけ調べる（localBranches は描くたびに新しい配列なので、効果は何度も走る）
  const askedRemote = useRef(new Set<string>());
  // 選んだ Issue の続きのブランチ（止めた・引き継いだときのコメントから。読んでいる途中は undefined、なければ null）
  const [handed, setHanded] = useState<Record<number, string | null>>({});
  const askedHanded = useRef(new Set<number>());
  const pickedIssue = picking !== null ? issues.find((i) => i.number === picking) ?? null : null;
  useEffect(() => {
    if (!pickedIssue || askedHanded.current.has(pickedIssue.number)) return;
    const n = pickedIssue.number;
    askedHanded.current.add(n);
    void handedBranch(n)
      .catch(() => null)
      .then((name) => setHanded((m) => ({ ...m, [n]: name })));
  }, [pickedIssue, handedBranch]);
  const handedName = pickedIssue ? handed[pickedIssue.number] : undefined;
  const handedLocal = !!handedName && localBranches.includes(handedName);
  // 続きのブランチが、この PC にも GitHub にもない（消された）: ふつうに始める
  const handedGone = !!handedName && !handedLocal && onRemote[handedName] === false;
  // 続きのブランチで続ける（ほかの始め方は出さない。コミットの履歴を引き継ぐため）
  const continueOn: string | null = handedName && (handedLocal || onRemote[handedName]) ? handedName : null;
  const pickedOwn = !pickedIssue || handedName === undefined ? null : handedName && !handedGone ? handedName : workBranchOf(owner, repo, pickedIssue, localBranches);
  const pickedLocal = pickedOwn !== null && localBranches.includes(pickedOwn);
  // 始め方を決めるために調べている途中（コメントを読んでいる・続きのブランチが GitHub にあるかを調べている）
  const pickedReading = !!pickedIssue && (handedName === undefined || (!!handedName && !handedLocal && !(handedName in onRemote)));
  useEffect(() => {
    if (!pickedOwn || pickedLocal || askedRemote.current.has(pickedOwn)) return;
    askedRemote.current.add(pickedOwn);
    void checkRemote(pickedOwn).then((ok) => setOnRemote((m) => ({ ...m, [pickedOwn]: ok })));
  }, [pickedOwn, pickedLocal, checkRemote]);
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
        {trx("<0>1</0>作業を選ぶ", undefined, [<i />])}
      </h4>
      {note && (
        <div className="w-step-note">
          <span className="w-step-note-text">{note}</span>
          {extras.length > 0 && (
            <span className="w-step-note-actions">
              {extras.map((b) => (
                <button key={b.label} type="button" className="btn-sm" disabled={busy} onClick={b.run}>
                  {b.label}
                </button>
              ))}
            </span>
          )}
        </div>
      )}
      {(now || missing) && (
        <div className="w-issue-now">
          <span className="w-issue-now-k">{tr("今の作業")}</span>
          <span className="wi-num">#{now ? now.number : choice}</span>
          <span className="wi-t">{now ? `${now.title}${closedIssue ? tr("（クローズ済み）") : ""}` : tr("（クローズされたか、見つかりません）")}</span>
          {issue && <span className="wi-meta">{issueMeta(issue)}</span>}
          {issue && (
            <span className="wi-actions">
              <button type="button" className="btn-sm" onClick={() => onOpenIssue(issue.number)}>
                {tr("Issue を開く")}
              </button>
              {nowActions.map((b) => (
                <button key={b.label} type="button" className="btn-sm" disabled={busy} onClick={b.run}>
                  {b.label}
                </button>
              ))}
            </span>
          )}
        </div>
      )}
      {nowPanel}
      <div className="w-pick-bar">
        <select className="select-sm w-ms-select" value={ms} onChange={(e) => changeMs(e.target.value)} aria-label={tr("マイルストーン")}>
          <option value="all">{tr("マイルストーン: すべて")}</option>
          {openMs.map((m) => (
            <option key={m.number} value={String(m.number)}>
              🎯 {m.title}
              {m.due_on ? tr("（期限 {v}）", { v: formatWhen(m.due_on).split(" ")[0] }) : ""}
            </option>
          ))}
          {closedMs.length > 0 && (
            <optgroup label={tr("閉じたマイルストーン")}>
              {closedMs.map((m) => (
                <option key={m.number} value={String(m.number)}>
                  {m.title}
                </option>
              ))}
            </optgroup>
          )}
          <option value="none">{tr("マイルストーンなし")}</option>
        </select>
        <input
          className="input-full w-issue-search"
          placeholder={tr("番号やタイトルで探す")}
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
                {inProgress(i) && <span className="w-issue-chip">{tr("進行中")}</span>}
                <span className={`w-issue-who${mine(i) ? " mine" : ""}`}>{mine(i) ? tr("自分") : who.length > 0 ? tr("担当: {join}", { join: who.join(tr("・")) }) : tr("担当なし")}</span>
                {i.milestone && <span className="wi-m">🎯 {i.milestone.title}</span>}
                <span className="w-issue-go">{chosen ? tr("今の作業") : mine(i) ? tr("始める") : tr("自分に割り当てて始める")}</span>
              </button>
              {picking === i.number && !chosen && (
                <div className="w-start-choice">
                  <div className="w-start-q">{trx("#{number} を、どのブランチで作業しますか？", { number: i.number })}</div>
                  <div className="w-step-actions">
                    {pickedReading || !pickedOwn ? null : continueOn ? (
                      // 続きのブランチがある（止めた・引き継いだ作業）: そのブランチで続ける。GitHub の最新にしてから切り替える
                      <button type="button" className="btn-primary" disabled={busy} onClick={() => onStart(i.number, "continue", continueOn)}>
                        {branch === continueOn
                          ? trx("「{own}」（今のブランチ）で始める", { own: continueOn })
                          : handedLocal
                            ? trx("「{own}」に切り替えて始める", { own: continueOn })
                            : trx("GitHub のブランチ「{own}」で続ける", { own: continueOn })}
                      </button>
                    ) : branch === pickedOwn ? (
                      <button type="button" className="btn-primary" disabled={busy} onClick={() => onStart(i.number, "here", pickedOwn)}>
                        {trx("「{own}」（今のブランチ）で始める", { own: pickedOwn })}
                      </button>
                    ) : (
                      <>
                        {pickedLocal ? (
                          <button type="button" className={onDefault ? "btn-primary" : "btn-sm"} disabled={busy} onClick={() => onStart(i.number, "switch", pickedOwn)}>
                            {trx("「{own}」に切り替えて始める", { own: pickedOwn })}
                          </button>
                        ) : onRemote[pickedOwn] ? (
                          // GitHub にだけあるブランチ（前に同じ名前で始めた作業など）: GitHub の最新を持ってきて続ける
                          <button type="button" className="btn-primary" disabled={busy} onClick={() => onStart(i.number, "continue", pickedOwn)}>
                            {trx("GitHub のブランチ「{own}」で続ける", { own: pickedOwn })}
                          </button>
                        ) : (
                          <button type="button" className={onDefault ? "btn-primary" : "btn-sm"} disabled={busy || !(pickedOwn in onRemote)} onClick={() => onStart(i.number, "create", pickedOwn)}>
                            {trx("ブランチ「{own}」を作って始める", { own: pickedOwn })}
                          </button>
                        )}
                        <button type="button" className={onDefault ? "btn-sm" : "btn-primary"} disabled={busy} onClick={() => onStart(i.number, "here", pickedOwn)}>
                          {branch ? tr("今のブランチ（{branch}）で始める", { branch }) : tr("今のブランチ（切り離し）で始める")}
                        </button>
                      </>
                    )}
                    <button type="button" className="btn-sm" onClick={() => onOpenIssue(i.number)}>
                      {tr("Issue を開く")}
                    </button>
                    <button type="button" className="btn-sm" onClick={() => setPicking(null)}>
                      {tr("やめる")}
                    </button>
                  </div>
                  {handedGone && <p className="w-start-note">{trx("続きのブランチ「{name}」は、GitHub にもうありません。", { name: handedName })}</p>}
                  {onDefault && !continueOn && !pickedReading && <p className="w-start-note">{trx("今は既定のブランチ（{branch}）にいるので、ここで始めると既定のブランチに直接コミットします。", { branch })}</p>}
                </div>
              )}
            </Fragment>
          );
        })}
        {list.length === 0 && (
          <div className="bsw-empty">
            {issues.length === 0 ? tr("未完了の Issue はありません") : ms !== "all" && issues.some((i) => !inMilestone(i)) ? tr("このマイルストーンに、当てはまる Issue はありません") : tr("一致する Issue はありません")}
            {/* 作るところへ（#247）: マイルストーンがなければマイルストーンから。あれば、そのマイルストーンのボードでタスクを足す */}
            {!q && (
              <div className="w-empty-actions">
                {openMs.length === 0 ? (
                  <button type="button" className="btn-primary" onClick={onOpenMilestones}>
                    {tr("🎯 マイルストーンを作る")}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={() => onAddOnBoard(ms === "all" || ms === "none" ? null : Number(ms))}
                  >
                    {tr("📊 ボードでタスクを足す")}
                  </button>
                )}
              </div>
            )}
          </div>
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
          {trx("<0>2</0>作業報告", undefined, [<i />])}
        </h4>
        <p className="hint">{tr("先に ① で、取り組む Issue を選びます。")}</p>
        <div className="w-step-actions">
          <button type="button" className="btn-primary" onClick={onPickIssue}>
            {tr("① 作業を選ぶ")}
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
      setNote({ ok: true, text: tr("#{number} に書き込みました", { number: issue.number }) });
      onReported();
      load();
    } catch (e) {
      setNote({ ok: false, text: tr("書き込めませんでした（{String}）", { String: String(e) }) });
    } finally {
      setSending(false);
    }
  }

  const past = (comments ?? []).slice(-PAST_REPORTS);
  return (
    <div className="w-step-panel w-report">
      <h4 className="w-step-title">
        {trx("<0>2</0>作業報告", undefined, [<i />])}
      </h4>
      <div className="w-issue-now">
        {trx("<0>今の作業</0><1>#{number}</1><2>{title}</2>", { number: issue.number, title: issue.title }, [<span className="w-issue-now-k" />, <span className="wi-num" />, <span className="wi-t" />])}
        <span className="wi-actions">
          <button type="button" className="btn-sm" onClick={() => onOpenIssue(issue.number)}>
            {tr("Issue を開く")}
          </button>
        </span>
      </div>
      <textarea
        className="w-report-text"
        rows={5}
        value={text}
        placeholder={tr("例: ジャンプの高さを調整した。着地の判定がずれるので、次は当たり判定を直す")}
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
          {sending ? tr("書き込んでいます…") : tr("Issue に書き込む")}
        </button>
        {changesWaiting && (
          <button type="button" className="btn-sm" onClick={onGoCommit}>
            {tr("③ コミット・プッシュへ")}
          </button>
        )}
        <button type="button" className="btn-sm" onClick={onGoComplete}>
          {tr("④ 完了へ")}
        </button>
        <span className="w-report-key">{tr("Ctrl+Enter でも書き込めます")}</span>
      </div>
      {note && <p className={`w-report-note${note.ok ? "" : " err"}`}>{note.text}</p>}
      <div className="w-report-past">
        <h5>{tr("この Issue のコメント")}{comments ? `（${comments.length}）` : ""}</h5>
        {comments === null ? (
          <p className="muted">{tr("読み込んでいます…")}</p>
        ) : comments.length === 0 ? (
          <p className="muted">{tr("まだありません")}</p>
        ) : (
          past.map((c) => (
            <div key={c.id} className="w-report-item">
              <span className="w-report-who">{c.user.login}</span>
              <span className="w-report-when">{formatWhen(c.created_at)}</span>
              <p>{commentPreview(c.body).slice(0, 240)}</p>
            </div>
          ))
        )}
        {comments && comments.length > past.length && <p className="muted">{tr("ほか {n} 件は、Issue を開くと見られます", { n: comments.length - past.length })}</p>}
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
  onEmptyCommit: () => void;
  onFileMenu: (pos: MenuPos, file: GitFileChange, conflict: boolean) => void;
}

function ChangesPane({ conflicts, staged, unstaged, selected, onSelect, actions, onEmptyCommit, onFileMenu }: ChangesPaneProps) {
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
          aria-label={side === "staged" ? tr("ステージから外す") : conflict ? tr("直したのでステージする") : tr("ステージする")}
          title={gitApi.displayCommand(side === "staged" ? ["restore", "--staged", "--", f.path, ...(f.orig_path ? [f.orig_path] : [])] : ["add", "--", f.path])}
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
      {total === 0 ? (
        <div className="ws-none">
          {tr("作業中の変更はありません。")}
          <button type="button" className="btn-sm" onClick={onEmptyCommit}>
            {tr("空コミット…")}
          </button>
        </div>
      ) : (
        <div className="dr-files">
          {conflicts.length > 0 && (
            <>
              <div className="dr-sec warn">{trx("競合<0>{length}</0>", { length: conflicts.length }, [<span className="count" />])}</div>
              {conflicts.map((f) => row(f, "unstaged", true))}
            </>
          )}
          <div className="dr-sec">
            {trx("ステージ済み<0>{length}</0>", { length: staged.length }, [<span className="count" />])}
            {staged.length > 0 && (
              <button type="button" className="sec-btn" onClick={() => actions.unstage(["."])} title="git restore --staged -- .">
                {tr("すべて外す")}
              </button>
            )}
          </div>
          {staged.map((f) => row(f, "staged"))}
          <div className="dr-sec">
            {trx("未ステージ<0>{length}</0>", { length: unstaged.length }, [<span className="count" />])}
            {unstaged.length > 0 && (
              <button type="button" className="sec-btn" onClick={() => actions.stage(["."])} title="git add -- .">
                {tr("すべてステージ")}
              </button>
            )}
          </div>
          {unstaged.map((f) => row(f, "unstaged"))}
          <div className="dr-empty-note">{tr("空コミットではファイルの変更は含めません")}</div>
        </div>
      )}
    </div>
  );
}

// --- 退避中の変更 ---

function StashPane({ stashes, actions, busy }: { stashes: GitStash[]; actions: GitActions; busy: boolean }) {
  return (
    <div className="w-pane">
      <div className="ws-stash">
        {stashes.length === 0 && <span className="ws-stash-none">{tr("退避中の変更はありません")}</span>}
        {stashes.map((s) => (
          <div key={s.index} className="ws-stash-item">
            <div className="ws-stash-msg" title={s.message}>{s.message}</div>
            <div className="ws-stash-row">
              <span className="ws-stash-ref">stash@{`{${s.index}}`}</span>
              <span className="ws-stash-when">{formatWhen(s.date)}</span>
              {s.files !== null && <span className="chip muted">{s.files === 0 ? tr("中身は空") : tr("{files} ファイル", { files: s.files })}</span>}
              <span className="ws-stash-actions">
                <button type="button" className="btn-sm" disabled={busy} onClick={() => actions.stashPop(s.index)} title={`git stash pop stash@{${s.index}}`}>
                  {tr("戻す")}
                </button>
                <button type="button" className="btn-sm" disabled={busy} onClick={() => actions.stashDrop(s)}>
                  {tr("削除…")}
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
  /** コミットの前の見張り（#234）。チェックの入ったものがあれば、コミットできない */
  watch: ReactNode;
  watchBlocked: boolean;
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
  watch,
  watchBlocked,
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
  const blocked = busy || nothingToCommit || hasConflicts || needsIssue || watchBlocked || (draft.amend && !st.head);

  return (
    <div className="dr-form">
      {watch}
      <input
        ref={summaryRef}
        className="input-full"
        placeholder={draft.allowEmpty ? tr("空コミットの目的（例: CI を動かす、区切りを付ける）") : tr("変更の要約（必須）")}
        autoComplete="off"
        value={draft.summary}
        onChange={(e) => set({ summary: e.target.value })}
        onKeyDown={(e) => {
          if (isEnter(e) && (e.ctrlKey || e.metaKey) && !blocked) onCommit(messages, !!st.branch);
        }}
      />
      {summaryError && <div className="field-err">{tr("要約を入力してください")}</div>}
      <textarea
        className="input-full"
        placeholder={tr("説明（任意）")}
        rows={2}
        value={draft.body}
        onChange={(e) => set({ body: e.target.value })}
      />
      <div className="chk-grid">
        {issue && (
          <label className="chk">
            <input type="checkbox" checked={draft.linkIssue} onChange={(e) => set({ linkIssue: e.target.checked })} />
            {trx("要約の末尾に Issue 番号（{tag}）を付ける", { tag })}
          </label>
        )}
        {issue && (
          <label className="chk">
            <input type="checkbox" checked={draft.closes} onChange={(e) => set({ closes: e.target.checked })} />
            {trx("マージされたら {tag} を閉じる（Closes {tag}）", { tag })}
          </label>
        )}
        <label
          className="chk"
          title={lastPushed ? tr("直前のコミットはもう GitHub に送ってあるので、修正できません。送り直すには強制プッシュが必要になります") : tr("直前のコミットに今の変更と要約を入れ直します")}
        >
          <input type="checkbox" checked={draft.amend} disabled={lastPushed} onChange={(e) => set({ amend: e.target.checked })} />
          {tr("直前のコミットを修正する（amend）")}
        </label>
        <label className="chk">
          <input type="checkbox" checked={draft.allowEmpty} onChange={(e) => set({ allowEmpty: e.target.checked })} />
          {tr("変更なしでコミットする（空コミット）")}
        </label>
      </div>
      {st.head && (
        <div className="w-last" title={tr("amend で修正されるのはこのコミット")}>
          {trx("直前のコミット：<0>{last_subject}</0> <1>{head}</1>", { last_subject: st.last_subject, head: st.head }, [<span className="w-last-msg" />, <code />])}
        </div>
      )}
      <div className="cmd-preview">
        {trx("<0>実行するコマンド</0><1>{preview}</1>", { preview }, [<span />, <code />])}
      </div>
      {needsIssue && (
        <p className="w-form-note">
          {tr("先に取り組む Issue を選びます。")}{" "}
          <button type="button" className="link-button" onClick={onPickIssue}>
            {tr("① 作業を選ぶ")}
          </button>
        </p>
      )}
      {nothingToCommit && !hasConflicts && !needsIssue && (
        <p className="w-form-note">{tr("コミットするファイルにチェックを入れてください（または「空コミット」にします）")}</p>
      )}
      {hasConflicts && <p className="w-form-note">{tr("競合しているファイルを直して、ステージしてからコミットします")}</p>}
      <div className="dr-actions">
        <button type="button" className="btn-primary" disabled={blocked || !st.branch} onClick={() => onCommit(messages, true)}>
          {tr("コミットしてプッシュ")}
        </button>
        <button type="button" className="btn-sm" disabled={blocked} onClick={() => onCommit(messages, false)}>
          {tr("コミットだけ")}
        </button>
      </div>
    </div>
  );
}

// --- コミットの前の見張り（#234） ---

/** 大きさ（MB。小さいものは小数 1 けた） */
function megabytes(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb).toLocaleString()} MB`;
}

/** コミットしない方がよいもの（大きすぎるファイル・ツールが作るフォルダ）と、.gitignore に足すボタン */
function CommitWatch({ found, isStaged, actions, busy }: { found: WatchFinding[]; isStaged: (f: WatchFinding) => boolean; actions: GitActions; busy: boolean }) {
  if (found.length === 0) return null;
  const blocked = found.some(isStaged);
  return (
    <div className={`w-watch${blocked ? " is-blocked" : ""}`} role="alert">
      <b className="w-watch-title">{tr("⚠ コミットしない方がよいものがあります")}</b>
      <ul>
        {found.map((f) => {
          const rule = f.kind === "large" ? gitApi.ignoreRules(f.path)[0] : gitApi.folderIgnoreRule(f.path);
          return (
            <li key={f.path}>
              <div
                className="w-watch-what"
                title={
                  f.kind === "large"
                    ? tr("GitHub は 100 MB をこえるファイルを受け取らないので、プッシュが断られます。記録するなら Git LFS を使います")
                    : tr("消しても {tool} がまた作るので、記録しません", { tool: f.tool })
                }
              >
                <code>{f.kind === "large" ? f.path : `${f.path}/`}</code>
                <span>{f.kind === "large" ? tr("{megabytes}（GitHub は 100 MB まで）", { megabytes: megabytes(f.size ?? 0) }) : tr("{tool} が作るフォルダ（ファイル {n}）", { tool: f.tool, n: countOf(f.files, tr("個")) })}</span>
              </div>
              <button
                type="button"
                className="btn-sm"
                disabled={busy}
                title={tr(".gitignore に {pattern} を書き足します。チェックを入れたものは外します（{displayCommand}）", { pattern: rule.pattern, displayCommand: gitApi.displayCommand(["rm", ...(rule.recursive ? ["-r"] : []), "--cached", "--", rule.pathspec]) })}
                onClick={() => void actions.ignoreNow(rule)}
              >
                {tr(".gitignore に足す")}
              </button>
            </li>
          );
        })}
      </ul>
      {blocked && <p className="w-watch-note">{tr("チェックが入っているあいだは、コミットできません")}</p>}
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
