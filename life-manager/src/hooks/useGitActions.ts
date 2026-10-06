import { useCallback, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import * as git from "../lib/git";
import type { GitCommit, GitFileChange, GitOperation, GitStash } from "../lib/types";
import type { BranchEntry } from "../lib/history";
import type { GitDialogSpec } from "../components/git/GitDialog";
import type { MenuItem } from "../components/git/ContextMenu";
import type { GitExecOptions, GitResult, GitState } from "./useGit";
import { tr, listSep } from "../lib/i18n";

export const OPERATION_NAMES: Record<GitOperation, string> = {
  merge: tr("マージ"),
  rebase: tr("リベース"),
  "cherry-pick": tr("チェリーピック"),
  revert: tr("リバート"),
};

/** コミットのメニューを出すときの状況 */
export interface CommitMenuContext {
  /** この PC の git で操作できる（GitHub から読んだ履歴のときは false） */
  local: boolean;
  /** 今のブランチ（HEAD）からたどれるコミット（＝今のブランチの履歴にある） */
  inCurrent: boolean;
}

const short = (hash: string) => hash.slice(0, 7);

/**
 * git の操作の入口。すぐ実行するもの・名前を聞くもの・確認してから実行するものを、ここでまとめて扱う。
 * ツールバー・作業タブ・ブランチ画面・全体図から同じものを使う
 */
export function useGitActions(g: GitState, repoOnGitHub: { owner: string; repo: string; login?: string }) {
  const [dialog, setDialog] = useState<GitDialogSpec | null>(null);
  const closeDialog = useCallback(() => setDialog(null), []);
  // 「変更内容を見る」で開くコミット
  const [detail, setDetail] = useState<GitCommit | null>(null);
  const closeDetail = useCallback(() => setDetail(null), []);
  // 「.gitignore を編集」を開いているか
  const [gitignoreOpen, setGitignoreOpen] = useState(false);
  const closeGitignore = useCallback(() => setGitignoreOpen(false), []);

  const st = g.status;
  const branch = st?.branch ?? "";
  const githubUrl = `https://github.com/${repoOnGitHub.owner}/${repoOnGitHub.repo}`;

  function fetch(): Promise<GitResult> {
    return g.exec(tr("フェッチしています"), git.fetch, tr("リモートの最新を取得しました"), { failNotice: accountNotice(fetch) });
  }

  function pull(): Promise<GitResult> {
    return g.exec(
      tr("プルしています"),
      git.pull,
      (run) => (/Already up to date/i.test(run.output) ? tr("{branch} はすでに最新です", { branch }) : tr("{v} から取り込みました", { v: st?.upstream ?? tr("リモート") })),
      { failNotice: accountNotice(pull) },
    );
  }

  // GitHub に断られたわけが、この PC の git のアカウントらしいとき（別のアカウントで行った。#245）:
  // 何が起きたかを言い、「アプリのアカウントで行くようにする」→ もう一度
  const accountNotice = (retry: () => Promise<unknown>): GitExecOptions["failNotice"] => (message) => {
    const login = repoOnGitHub.login;
    const line = git.accountProblemLine(message);
    if (!login || line === null) return undefined;
    return {
      text: tr("GitHub に断られました。この PC の git が、{owner}/{repo} を使えない別の GitHub アカウントで行ったようです", { owner: repoOnGitHub.owner, repo: repoOnGitHub.repo }),
      output: line,
      action: { label: tr("{login} で行くようにする", { login }), run: () => void switchAccountThen(login, retry) },
    };
  };

  /** origin をアプリのアカウントで行く URL にしてから、断られた操作をもう一度 */
  async function switchAccountThen(login: string, retry: () => Promise<unknown>) {
    const r = await g.exec(tr("アカウントを切り替えています"), (p) => git.switchAccount(p, login), (run) => run.output);
    if (r.ok) await retry();
  }

  /** 見ているブランチだけを GitHub から読む（ブランチ画面。切り替えない） */
  function fetchBranch(e: BranchEntry) {
    return g.exec(tr("フェッチしています"), (p) => git.fetchBranch(p, e.name), tr("GitHub の {name} を読みました（origin/{name}）", { name: e.name }));
  }

  /** 見ているブランチを、切り替えずに GitHub の最新にする（ブランチ画面。今のブランチなら、ふつうのプル） */
  function pullBranch(e: BranchEntry) {
    if (e.isCurrent) return pull();
    return g.exec(tr("プルしています"), (p) => git.pullBranch(p, e.name), (run) =>
      run.output === "created"
        ? tr("{name} をこの PC に作りました（切り替えていません）", { name: e.name })
        : run.output === "local-ahead"
          ? tr("{name} はこの PC の方が進んでいます（まだプッシュしていないコミットがあります）", { name: e.name })
          : tr("{name} を GitHub の最新にしました（{v} のまま）", { name: e.name, v: branch || tr("今のブランチ") }),
    );
  }

  async function push(): Promise<GitResult> {
    const published = !!st?.upstream;
    const r = await g.exec(
      tr("プッシュしています"),
      git.push,
      published ? tr("{upstream} に送りました", { upstream: st?.upstream }) : tr("{branch} を GitHub に公開しました", { branch }),
      { failNotice: (m) => behindNotice?.(m) ?? accountNotice(push)?.(m) },
    );
    if (r.ok) g.markPush(branch);
    return r;
  }

  // プッシュを断られた（GitHub 側に、この PC にないコミットがある）ときは、何が起きたかを日本語で言い、
  // 「プルしてからプッシュ」を付ける（#233）
  const behindNotice: GitExecOptions["failNotice"] = (message) => {
    const line = git.pushBehindLine(message);
    if (line === null) return undefined;
    return {
      text: tr("プッシュを断られました。GitHub の {branch} に、この PC にないコミットがあります", { branch }),
      output: line || undefined,
      action: { label: tr("プルしてからプッシュ"), run: () => void pullThenPush() },
    };
  };

  /** プルで取り込んでから、もう一度プッシュする。プルが競合などで止まったら、そこでやめる（#233） */
  async function pullThenPush(): Promise<GitResult> {
    const p = await pull();
    if (!p.ok) return p;
    return push();
  }

  async function commit(messages: string[], amend: boolean, allowEmpty: boolean): Promise<GitResult> {
    const r = await g.exec(
      tr("コミットしています"),
      (p) => git.commit(p, messages, amend, allowEmpty),
      allowEmpty ? tr("空コミットを作りました") : amend ? tr("直前のコミットを修正しました") : tr("コミットしました"),
    );
    if (r.ok) g.markCommit(branch);
    return r;
  }

  function stage(files: string[]) {
    return g.exec("", (p) => git.stage(p, files), "", { quiet: true });
  }

  function unstage(files: string[]) {
    return g.exec("", (p) => git.unstage(p, files), "", { quiet: true });
  }

  /** ブランチを切り替える。作業中の変更があれば、退避するか持っていくかを選んでもらう */
  function requestSwitch(to: string) {
    if (!st || to === st.branch) return;
    const changes = st.files.length;
    if (changes === 0) {
      g.exec(tr("切り替えています"), (p) => git.switchBranch(p, to, false), tr("{to} に切り替えました", { to }));
      return;
    }
    const from = st.branch || st.head;
    const message = tr("{from} の作業中", { from });
    const stashArgs = ["stash", "push", "-u", "-m", message];
    setDialog({
      kind: "choice",
      title: tr("{to} に切り替える", { to }),
      message: tr("作業中の変更が {changes} ファイルあります。どうしますか？", { changes }),
      choices: [
        {
          key: "stash",
          title: tr("変更を {from} に残して切り替える", { from }),
          detail: tr("変更は一時退避（スタッシュ）され、あとで「退避中」から戻せます"),
          command: `${git.displayCommand(stashArgs)} && ${git.displayCommand(["switch", to])}`,
        },
        {
          key: "bring",
          title: tr("変更を持って {to} に切り替える", { to }),
          detail: tr("作業中の変更をそのまま持っていきます。同じファイルがぶつかると切り替えられません"),
          command: git.displayCommand(["switch", to]),
        },
      ],
      submit: (key) => {
        if (key === "bring") {
          return g.exec(tr("切り替えています"), (p) => git.switchBranch(p, to, false), tr("{to} に切り替えました", { to }), { inlineError: true });
        }
        return g.exec(
          tr("切り替えています"),
          async (p) => {
            const stashed = await git.stashPush(p, message);
            try {
              const switched = await git.switchBranch(p, to, false);
              return { command: `${stashed.command} && ${switched.command}`, output: switched.output };
            } catch (e) {
              const { command, message: why } = git.splitGitError(e);
              throw tr("{command} && {v}\n{why}\n（変更は stash@{0} に退避してあります。「退避中」から戻せます）", { command: stashed.command, v: command ?? "", why });
            }
          },
          tr("{to} に切り替えました（変更は退避しました）", { to }),
          { inlineError: true },
        );
      },
    });
  }

  /**
   * ブランチを作って切り替える。start があれば、そのコミット（または origin/main などのブランチ）から作る。
   * after は、作れたあとに続けてすること（作業をする: 作業の始まりのコミットとプッシュ）
   */
  function createBranch(suggested?: string, start?: string, after?: (name: string) => Promise<void>) {
    setDialog({
      kind: "input",
      title: tr("ブランチを作成"),
      label: tr("新しいブランチの名前"),
      placeholder: suggested ?? "feature/login-form",
      initial: suggested,
      note: start
        ? tr("名前に空白は使えません。")
        : tr("作業中の変更はそのまま持っていきます。名前に空白は使えません。"),
      okLabel: tr("作成して切り替える"),
      commandFor: (name) => git.displayCommand(["switch", "-c", name, ...(start ? [/^[0-9a-f]{7,40}$/i.test(start) ? short(start) : start] : [])]),
      submit: async (name) => {
        const made = await g.exec(
          tr("ブランチを作っています"),
          (p) => git.switchBranch(p, name, true, start ?? null),
          tr("{name} を作って切り替えました", { name }),
          { inlineError: true },
        );
        if (made.ok && after) await after(name);
        return made;
      },
    });
  }

  /** タグを付ける。target がなければ今のコミットに */
  function tag(target?: string) {
    setDialog({
      kind: "input",
      title: tr("タグを付ける"),
      label: tr("タグの名前"),
      placeholder: "v1.0.0",
      note: tr("GitHub に送るには、別に git push origin タグ名 が必要です。"),
      okLabel: tr("タグを付ける"),
      commandFor: (name) => git.displayCommand(["tag", name, ...(target ? [short(target)] : [])]),
      submit: (name) =>
        g.exec(tr("タグを付けています"), (p) => git.tag(p, name, target ?? null), tr("{name} を付けました", { name }), { inlineError: true }),
    });
  }

  function stash() {
    return g.exec(tr("退避しています"), (p) => git.stashPush(p, tr("作業中")), tr("作業中の変更を退避しました（stash@{0}）"));
  }

  function stashPop(index: number) {
    return g.exec(tr("戻しています"), (p) => git.stashPop(p, index), tr("stash@{{index}} を戻しました", { index }));
  }

  function stashDrop(s: GitStash) {
    const ref = `stash@{${s.index}}`;
    setDialog({
      kind: "confirm",
      title: tr("退避中の変更を削除"),
      message:
        tr("{ref}「{message}」を削除します。", { ref, message: s.message }) +
        (s.files === 0 ? tr("中身は空なので、消しても失われる変更はありません。") : tr("退避した変更は失われ、元に戻せません。")),
      okLabel: tr("削除する"),
      danger: s.files !== 0,
      commandFor: () => git.displayCommand(["stash", "drop", ref]),
      submit: () => g.exec(tr("削除しています"), (p) => git.stashDrop(p, s.index), tr("退避中の変更を削除しました"), { inlineError: true }),
    });
  }

  function discardAll() {
    const untracked = st?.files.filter((f) => f.unstaged === "?").length ?? 0;
    const restore = git.displayCommand(["restore", "--staged", "--worktree", "--", "."]);
    const clean = git.displayCommand(["clean", "-fd", "--", "."]);
    setDialog({
      kind: "confirm",
      title: tr("作業中の変更をすべて破棄"),
      message: tr("コミットしていない変更をすべて消して、直前のコミットの状態に戻します。元に戻せません。"),
      option: untracked > 0 ? tr("まだ git に追加していない新しいファイル（{untracked} 個）も消す", { untracked }) : undefined,
      okLabel: tr("破棄する"),
      danger: true,
      commandFor: (withNew) => (withNew ? `${restore} && ${clean}` : restore),
      submit: (withNew) =>
        g.exec(tr("破棄しています"), (p) => git.discardAll(p, withNew), tr("作業中の変更を破棄しました"), { inlineError: true }),
    });
  }

  // --- 無視するファイル（.gitignore） ---

  /**
   * .gitignore に 1 行書き足して無視する。すでに git で管理しているファイルが当てはまるときは、
   * 書くだけでは無視されないので、管理から外すか（git rm --cached）を聞く
   */
  async function ignore(rule: git.IgnoreRule) {
    const folder = g.folder;
    if (!folder) return;
    let tracked: string[];
    try {
      tracked = await git.ignoreTracked(folder, rule.pattern);
    } catch (e) {
      const { command, message } = git.splitGitError(e);
      g.notify("error", message, command);
      return;
    }
    const add = (untrack: boolean) =>
      g.exec(
        tr("無視する設定をしています"),
        (p) => git.ignoreAdd(p, rule.pattern, untrack ? rule.pathspec : null, rule.recursive),
        (run) => run.output,
        { inlineError: untrack || tracked.length > 0 },
      );
    if (tracked.length === 0) return add(false);

    const rm = git.displayCommand(["rm", ...(rule.recursive ? ["-r"] : []), "--cached", "--", rule.pathspec]);
    const kept =
      tr("ファイルはこの PC に残り、次のコミットで記録から外れます。GitHub からも消えるので、ほかの人がプルすると、その人の手元からも消えます。");
    if (rule.kind === "file") {
      setDialog({
        kind: "confirm",
        title: tr("{label} を無視する", { label: rule.label }),
        message: tr("{pathspec} はすでに git で管理しているファイルです。.gitignore に書くだけでは無視されないので、管理から外します。{kept}", { pathspec: rule.pathspec, kept }),
        okLabel: tr("管理から外して無視する"),
        commandFor: () => rm,
        submit: () => add(true),
      });
      return;
    }
    const examples = tracked.slice(0, 3).join(listSep()) + (tracked.length > 3 ? tr(" など") : "");
    setDialog({
      kind: "choice",
      title: rule.kind === "ext" ? tr("拡張子 {label} のファイルを無視する", { label: rule.label }) : tr("フォルダ {label} を無視する", { label: rule.label }),
      message: tr("当てはまるファイルのうち {length} 個（{examples}）は、すでに git で管理しています。.gitignore に書くだけでは、これらは無視されません。", { length: tracked.length, examples }),
      choices: [
        { key: "untrack", title: tr("管理しているファイルも外して無視する"), detail: kept, command: rm },
        {
          key: "keep",
          title: tr(".gitignore に書くだけにする"),
          detail: tr("管理しているファイルはこれまでどおり記録されます。まだ管理していないファイルだけが無視されます。"),
          command: "",
        },
      ],
      submit: (key) => add(key === "untrack"),
    });
  }

  /**
   * コミットの前の見張りから（#234）: .gitignore に書き足す。チェックを入れた（ステージした）ものや、管理しているものは、聞かずに外す
   * （ツールが作るフォルダ・GitHub が受け取らない大きなファイルは、記録しないのが正しいので）
   */
  async function ignoreNow(rule: git.IgnoreRule) {
    const folder = g.folder;
    if (!folder) return;
    let tracked: string[];
    try {
      tracked = await git.ignoreTracked(folder, rule.pattern);
    } catch (e) {
      const { command, message } = git.splitGitError(e);
      g.notify("error", message, command);
      return;
    }
    return g.exec(
      tr("無視する設定をしています"),
      (p) => git.ignoreAdd(p, rule.pattern, tracked.length > 0 ? rule.pathspec : null, rule.recursive),
      (run) => run.output,
    );
  }

  function editGitignore() {
    if (g.folder) setGitignoreOpen(true);
  }

  function saveGitignore(text: string) {
    return g.exec(tr("保存しています"), (p) => git.writeGitignore(p, text), (run) => run.output, { inlineError: true });
  }

  // --- 途中で止まった操作（マージ・リベース・チェリーピック・リバート） ---

  function abortOperation() {
    const op = st?.operation;
    if (!op) return;
    const name = OPERATION_NAMES[op];
    setDialog({
      kind: "confirm",
      title: tr("{name}を中止", { name }),
      message: tr("{name}をやめて、始める前の状態に戻します。競合を直した内容も消えます。", { name }),
      okLabel: tr("中止する"),
      danger: true,
      commandFor: () => `git ${op} --abort`,
      submit: () => g.exec(tr("{name}を中止しています", { name }), (p) => git.abortOperation(p, op), tr("{name}を中止しました", { name }), { inlineError: true }),
    });
  }

  // --- 競合を直す（マージツール） ---

  /** 選んだ内容を書いて、ステージする（「直した」という合図） */
  function resolveConflict(file: string, text: string) {
    return g.exec(tr("書き込んでいます"), (p) => git.resolveConflict(p, file, text), tr("{file} を直してステージしました", { file }));
  }

  /** ファイルをまるごと片方の内容にする（か所ごとに選ばない。文字でないファイルはこれだけ）。捨てる側があるので確かめる */
  function takeConflictSide(file: string, side: "ours" | "theirs" | "delete", sideLabel: string) {
    const message =
      side === "delete"
        ? tr("{file} を消したままにします（片方で消されていたファイルです）。", { file })
        : tr("{file} をまるごと「{sideLabel}」の内容にします。もう一方の変更はこのファイルには入りません。", { file, sideLabel });
    setDialog({
      kind: "confirm",
      title: side === "delete" ? tr("消したままにする") : tr("まるごと{sideLabel}にする", { sideLabel }),
      message,
      okLabel: side === "delete" ? tr("消したままにする") : tr("この内容にする"),
      commandFor: () => (side === "delete" ? git.displayCommand(["rm", "--", file]) : `${git.displayCommand(["checkout", `--${side}`, "--", file])} && ${git.displayCommand(["add", "--", file])}`),
      submit: () => g.exec(tr("書き込んでいます"), (p) => git.takeSide(p, file, side), side === "delete" ? tr("{file} を消したままにしました", { file }) : tr("{file} を{sideLabel}の内容にしてステージしました", { file, sideLabel }), { inlineError: true }),
    });
  }

  async function openFile(file: string) {
    if (!g.folder) return;
    try {
      await git.openFile(g.folder, file);
    } catch (e) {
      g.notify("error", String(e));
    }
  }

  /** 競合を直してステージしたあと、先へ進める（マージはコミットで完了するので対象外） */
  function continueOperation() {
    const op = st?.operation;
    if (!op || op === "merge") return;
    const name = OPERATION_NAMES[op];
    return g.exec(tr("{name}を続けています", { name }), (p) => git.continueOperation(p, op), tr("{name}を続けました", { name }));
  }

  // --- コミットの操作 ---

  function detach(hash: string) {
    return g.exec(
      tr("取り出しています"),
      (p) => git.detach(p, hash),
      tr("{short} を取り出しました。どのブランチにも属していない状態です", { short: short(hash) }),
    );
  }

  function cherryPick(hash: string) {
    return g.exec(tr("取り込んでいます"), (p) => git.cherryPick(p, hash), tr("{short} の変更を {branch} に取り込みました", { short: short(hash), branch }));
  }

  function revert(hash: string) {
    return g.exec(tr("打ち消しています"), (p) => git.revert(p, hash), tr("{short} を打ち消すコミットを作りました", { short: short(hash) }));
  }

  /** 今のブランチをそのコミットまで戻す。どれも履歴が変わるので、確認してから */
  function reset(hash: string, mode: "soft" | "mixed" | "hard") {
    const h = short(hash);
    const how = {
      soft: { title: tr("ソフト"), effect: tr("その変更はステージに残ります。") },
      mixed: { title: tr("混在"), effect: tr("その変更は作業中のファイルに残ります（ステージからは外れます）。") },
      hard: { title: tr("ハード"), effect: tr("その変更も、今の作業中の変更も、すべて捨てます。元に戻せません。") },
    }[mode];
    const pushed = st?.upstream ? tr("GitHub に送ってあるコミットは、GitHub の方には残ります（プルすると戻ってきます）。") : "";
    setDialog({
      kind: "confirm",
      title: tr("ここまで戻す（{title}）", { title: how.title }),
      message: tr("{branch} を {h} まで戻します。{h} より後のコミットはブランチから外れ、{effect}{pushed}", { branch, h, effect: how.effect, pushed }),
      okLabel: tr("戻す"),
      danger: mode === "hard",
      commandFor: () => git.displayCommand(["reset", `--${mode}`, h]),
      submit: () => g.exec(tr("戻しています"), (p) => git.reset(p, hash, mode), tr("{branch} を {h} まで戻しました", { branch, h }), { inlineError: true }),
    });
  }

  async function copyHash(hash: string) {
    try {
      await navigator.clipboard.writeText(hash);
      g.notify("ok", tr("コミット {short} のハッシュをコピーしました", { short: short(hash) }));
    } catch (e) {
      g.notify("error", tr("コピーできませんでした: {e}", { e }));
    }
  }

  // --- ブランチの操作 ---

  /** GitHub にだけあるブランチは origin/ を付けて扱う */
  const refOf = (e: BranchEntry) => (e.onPc ? e.name : `origin/${e.name}`);

  function merge(e: BranchEntry) {
    return g.exec(tr("マージしています"), (p) => git.merge(p, refOf(e)), tr("{refOf} を {branch} に取り込みました", { refOf: refOf(e), branch }));
  }

  function rebase(e: BranchEntry) {
    const target = refOf(e);
    setDialog({
      kind: "confirm",
      title: tr("リベース（付け替え）"),
      message:
        tr("{branch} で作ったコミットを {target} の先に付け替えます。コミットは作り直されるので、履歴が書き換わります。", { branch, target }) +
        (st?.upstream ? tr("すでに GitHub に送ったコミットがあると、送り直すのに強制プッシュが必要になります。") : ""),
      okLabel: tr("付け替える"),
      commandFor: () => git.displayCommand(["rebase", target]),
      submit: () => g.exec(tr("付け替えています"), (p) => git.rebase(p, target), tr("{branch} を {target} の先に付け替えました", { branch, target }), { inlineError: true }),
    });
  }

  function pushBranch(e: BranchEntry) {
    return g.exec(
      tr("プッシュしています"),
      (p) => git.pushBranch(p, e.name),
      e.onGitHub ? tr("origin/{name} に送りました", { name: e.name }) : tr("{name} を GitHub に公開しました", { name: e.name }),
    );
  }

  function setUpstream(e: BranchEntry) {
    return g.exec(tr("設定しています"), (p) => git.setUpstream(p, e.name), tr("{name} の上流を origin/{name} にしました", { name: e.name }));
  }

  function renameBranch(e: BranchEntry) {
    setDialog({
      kind: "input",
      title: tr("ブランチの名前を変更"),
      label: tr("新しい名前"),
      placeholder: e.name,
      initial: e.name,
      note: e.onGitHub ? tr("この PC のブランチの名前だけが変わります。GitHub のブランチの名前はそのままです。") : undefined,
      okLabel: tr("変更する"),
      commandFor: (to) => git.displayCommand(["branch", "-m", e.name, to]),
      submit: (to) =>
        g.exec(tr("名前を変えています"), (p) => git.renameBranch(p, e.name, to), tr("{name} を {to} に変えました", { name: e.name, to }), { inlineError: true }),
    });
  }

  function deleteBranch(e: BranchEntry) {
    setDialog({
      kind: "confirm",
      title: tr("ブランチ {name} を削除", { name: e.name }),
      message:
        tr("この PC のブランチ {name} を削除します。ほかのブランチに取り込んでいない（マージしていない）コミットがあると、git が止めます。", { name: e.name }) +
        (e.onGitHub ? tr("GitHub のブランチはそのままです。") : ""),
      option: tr("マージしていなくても削除する（-D。そのコミットは失われます）"),
      okLabel: tr("削除する"),
      danger: true,
      commandFor: (force) => git.displayCommand(["branch", force ? "-D" : "-d", e.name]),
      submit: (force) =>
        g.exec(tr("削除しています"), (p) => git.deleteBranch(p, e.name, force), tr("{name} を削除しました", { name: e.name }), { inlineError: true }),
    });
  }

  // --- 右クリック・「⋯」のメニュー ---

  // 作業フォルダがない（GitHub から読んだ履歴の）ときは、git の操作は押せない。理由は最初の項目にだけ書く
  const NO_FOLDER_HINT = tr("この PC の作業フォルダを決めると使えます");

  function commitMenu(c: GitCommit, ctx: CommitMenuContext): MenuItem[] {
    const h = short(c.hash);
    const can = ctx.local && !!st;
    const onBranch = can && !!branch;
    // 押せない理由（作業フォルダがないときは出さない。最初の項目に書いてあるので）
    const why = (text: string, show: boolean) => (can && show ? text : undefined);
    return [
      {
        label: tr("🌿 このコミットからブランチを作成…"),
        code: tr("git switch -c {名前} {h}", { 名前: tr("名前"), h }),
        disabled: !can,
        hint: can ? undefined : NO_FOLDER_HINT,
        run: () => createBranch(undefined, c.hash),
      },
      { label: tr("🏷️ タグを付ける…"), code: tr("git tag {名前} {h}", { 名前: tr("名前"), h }), disabled: !can, run: () => tag(c.hash) },
      { label: tr("⎇ このコミットを取り出す（切り離された HEAD）"), code: `git switch --detach ${h}`, disabled: !can, run: () => detach(c.hash) },
      "sep",
      {
        label: branch ? tr("🍒 {branch} に取り込む（チェリーピック）", { branch }) : tr("🍒 今のブランチに取り込む（チェリーピック）"),
        code: `git cherry-pick ${h}`,
        disabled: !onBranch || ctx.inCurrent,
        hint: why(tr("今のブランチにもう入っています"), ctx.inCurrent),
        run: () => cherryPick(c.hash),
      },
      {
        label: tr("↩ 打ち消すコミットを作る（リバート）"),
        code: `git revert --no-edit ${h}`,
        disabled: !onBranch || !ctx.inCurrent,
        hint: why(tr("今のブランチの履歴にあるコミットだけ打ち消せます"), !ctx.inCurrent),
        run: () => revert(c.hash),
      },
      ...(["soft", "mixed", "hard"] as const).map((mode) => ({
        label: tr("⏮ ここまで戻す：{v}…", { v: { soft: tr("ソフト（変更はステージに残す）"), mixed: tr("混在（変更は作業中に残す）"), hard: tr("ハード（変更を捨てる）") }[mode] }),
        code: `git reset --${mode} ${h}`,
        danger: mode === "hard",
        disabled: !onBranch || !ctx.inCurrent,
        hint: why(tr("今のブランチの履歴にあるコミットまでしか戻せません"), !ctx.inCurrent),
        run: () => reset(c.hash, mode),
      })),
      "sep",
      // 作業フォルダがなくても、GitHub から読んで見せられる
      { label: tr("🔍 変更内容を見る"), code: `git show ${h}`, run: () => setDetail(c) },
      { label: tr("📋 ハッシュをコピー"), run: () => copyHash(c.hash) },
      { label: tr("↗ GitHub で開く"), run: () => { openUrl(`${githubUrl}/commit/${c.hash}`); } },
    ];
  }

  function branchMenu(e: BranchEntry, local: boolean): MenuItem[] {
    const can = local && !!st;
    const items: MenuItem[] = [];
    if (!e.isCurrent) {
      items.push(
        {
          label: tr("✔ このブランチに切り替える"),
          code: `git switch ${e.name}`,
          disabled: !can,
          hint: can ? undefined : NO_FOLDER_HINT,
          run: () => requestSwitch(e.name),
        },
        {
          label: branch ? tr("⤵ {branch} に取り込む（マージ）", { branch }) : tr("⤵ 今のブランチに取り込む（マージ）"),
          code: `git merge --no-edit ${refOf(e)}`,
          disabled: !can || !branch,
          run: () => merge(e),
        },
        {
          label: tr("⤳ {v}を {name} の先に付け替える（リベース）…", { v: branch || tr("今のブランチ"), name: e.name }),
          code: `git rebase ${refOf(e)}`,
          disabled: !can || !branch,
          run: () => rebase(e),
        },
        "sep",
      );
    }
    items.push(
      {
        label: tr("⟳ このブランチをフェッチ"),
        code: `git fetch origin ${e.name}`,
        disabled: !can || !e.onGitHub,
        run: () => fetchBranch(e),
      },
      {
        label: e.isCurrent ? tr("⬇ プル") : tr("⬇ プル（切り替えずに）"),
        code: e.isCurrent ? "git pull" : e.onPc ? `git fetch origin ${e.name}:${e.name}` : `git branch --track ${e.name} origin/${e.name}`,
        disabled: !can || !e.onGitHub,
        run: () => pullBranch(e),
      },
      {
        label: tr("⬆ プッシュ"),
        code: e.onGitHub ? `git push origin ${e.name}` : `git push -u origin ${e.name}`,
        disabled: !can || !e.onPc,
        run: () => pushBranch(e),
      },
      {
        label: tr("🔗 上流ブランチを設定"),
        code: `git branch -u origin/${e.name} ${e.name}`,
        disabled: !can || !e.onPc || !e.onGitHub || !!e.info?.upstream,
        hint: can && e.info?.upstream ? tr("上流は {upstream} に設定済みです", { upstream: e.info.upstream }) : undefined,
        run: () => setUpstream(e),
      },
      { label: tr("✎ 名前を変更…"), code: tr("git branch -m {name} {新しい名前}", { name: e.name, 新しい名前: tr("新しい名前") }), disabled: !can || !e.onPc, run: () => renameBranch(e) },
      "sep",
      {
        label: tr("🗑 削除…"),
        code: `git branch -d ${e.name}`,
        danger: true,
        disabled: !can || !e.onPc || e.isCurrent,
        hint: can && e.isCurrent ? tr("チェックアウト中のブランチは削除できません（先に切り替えます）") : undefined,
        run: () => deleteBranch(e),
      },
      {
        label: tr("↗ GitHub で開く"),
        disabled: !e.onGitHub,
        run: () => { openUrl(`${githubUrl}/tree/${encodeURI(e.name)}`); },
      },
    );
    return items;
  }

  /** 作業タブのファイルの右クリック: .gitignore で無視する（このファイル・同じ拡張子・フォルダ）、.gitignore の編集 */
  function fileMenu(f: GitFileChange, conflict: boolean): MenuItem[] {
    // 管理している（索引にある）ファイルは、書くだけでは無視されないので、管理から外すかを聞く（…）
    const tracked = f.unstaged !== "?";
    const isGitignore = f.path === ".gitignore" || f.path.endsWith("/.gitignore");
    const why = isGitignore ? tr(".gitignore そのものは無視できません") : conflict ? tr("競合を直してから使えます") : undefined;
    const items: MenuItem[] = git.ignoreRules(f.path).map((r, i) => ({
      label:
        r.kind === "file" ? tr("🙈 このファイルを無視する{v}", { v: tracked ? tr("（管理から外す）…") : "" })
        : r.kind === "ext" ? tr("🙈 拡張子 {label} のファイルをすべて無視する", { label: r.label })
        : tr("🙈 フォルダ {label} を無視する", { label: r.label }),
      code: tr(".gitignore に追記: {pattern}", { pattern: r.pattern }),
      disabled: !!why,
      // 押せない理由は最初の項目にだけ書く
      hint: i === 0 ? why : undefined,
      run: () => { ignore(r); },
    }));
    items.push("sep", { label: tr("📝 .gitignore を編集…"), run: editGitignore });
    return items;
  }

  async function openTerminal() {
    if (!g.folder) return;
    try {
      await git.openTerminal(g.folder);
      g.notify("ok", tr("ターミナルを開きました"));
    } catch (e) {
      g.notify("error", String(e));
    }
  }

  const actions = {
    fetch,
    pull,
    fetchBranch,
    pullBranch,
    push,
    commit,
    stage,
    unstage,
    requestSwitch,
    createBranch,
    tag,
    stash,
    stashPop,
    stashDrop,
    discardAll,
    abortOperation,
    continueOperation,
    resolveConflict,
    takeConflictSide,
    openFile,
    detach,
    cherryPick,
    revert,
    reset,
    merge,
    rebase,
    pushBranch,
    setUpstream,
    renameBranch,
    deleteBranch,
    ignore,
    ignoreNow,
    editGitignore,
    saveGitignore,
    commitMenu,
    branchMenu,
    fileMenu,
    showCommit: setDetail,
    openTerminal,
    refresh: g.refresh,
  };

  return { actions, dialog, closeDialog, detail, closeDetail, gitignoreOpen, closeGitignore };
}

export type GitActions = ReturnType<typeof useGitActions>["actions"];
