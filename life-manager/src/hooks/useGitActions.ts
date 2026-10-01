import { useCallback, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import * as git from "../lib/git";
import type { GitCommit, GitFileChange, GitOperation, GitStash } from "../lib/types";
import type { BranchEntry } from "../lib/history";
import type { GitDialogSpec } from "../components/git/GitDialog";
import type { MenuItem } from "../components/git/ContextMenu";
import type { GitResult, GitState } from "./useGit";

export const OPERATION_NAMES: Record<GitOperation, string> = {
  merge: "マージ",
  rebase: "リベース",
  "cherry-pick": "チェリーピック",
  revert: "リバート",
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
export function useGitActions(g: GitState, repoOnGitHub: { owner: string; repo: string }) {
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

  function fetch() {
    return g.exec("フェッチしています", git.fetch, "リモートの最新を取得しました");
  }

  function pull() {
    return g.exec("プルしています", git.pull, (run) =>
      /Already up to date/i.test(run.output) ? `${branch} はすでに最新です` : `${st?.upstream ?? "リモート"} から取り込みました`,
    );
  }

  /** 見ているブランチだけを GitHub から読む（ブランチ画面。切り替えない） */
  function fetchBranch(e: BranchEntry) {
    return g.exec("フェッチしています", (p) => git.fetchBranch(p, e.name), `GitHub の ${e.name} を読みました（origin/${e.name}）`);
  }

  /** 見ているブランチを、切り替えずに GitHub の最新にする（ブランチ画面。今のブランチなら、ふつうのプル） */
  function pullBranch(e: BranchEntry) {
    if (e.isCurrent) return pull();
    return g.exec("プルしています", (p) => git.pullBranch(p, e.name), (run) =>
      run.output === "created"
        ? `${e.name} をこの PC に作りました（切り替えていません）`
        : run.output === "local-ahead"
          ? `${e.name} はこの PC の方が進んでいます（まだプッシュしていないコミットがあります）`
          : `${e.name} を GitHub の最新にしました（${branch || "今のブランチ"} のまま）`,
    );
  }

  async function push(): Promise<GitResult> {
    const published = !!st?.upstream;
    const r = await g.exec(
      "プッシュしています",
      git.push,
      published ? `${st?.upstream} に送りました` : `${branch} を GitHub に公開しました`,
    );
    if (r.ok) g.markPush(branch);
    return r;
  }

  async function commit(messages: string[], amend: boolean, allowEmpty: boolean): Promise<GitResult> {
    const r = await g.exec(
      "コミットしています",
      (p) => git.commit(p, messages, amend, allowEmpty),
      allowEmpty ? "空コミットを作りました" : amend ? "直前のコミットを修正しました" : "コミットしました",
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
      g.exec("切り替えています", (p) => git.switchBranch(p, to, false), `${to} に切り替えました`);
      return;
    }
    const from = st.branch || st.head;
    const message = `${from} の作業中`;
    const stashArgs = ["stash", "push", "-u", "-m", message];
    setDialog({
      kind: "choice",
      title: `${to} に切り替える`,
      message: `作業中の変更が ${changes} ファイルあります。どうしますか？`,
      choices: [
        {
          key: "stash",
          title: `変更を ${from} に残して切り替える`,
          detail: "変更は一時退避（スタッシュ）され、あとで「退避中」から戻せます",
          command: `${git.displayCommand(stashArgs)} && ${git.displayCommand(["switch", to])}`,
        },
        {
          key: "bring",
          title: `変更を持って ${to} に切り替える`,
          detail: "作業中の変更をそのまま持っていきます。同じファイルがぶつかると切り替えられません",
          command: git.displayCommand(["switch", to]),
        },
      ],
      submit: (key) => {
        if (key === "bring") {
          return g.exec("切り替えています", (p) => git.switchBranch(p, to, false), `${to} に切り替えました`, { inlineError: true });
        }
        return g.exec(
          "切り替えています",
          async (p) => {
            const stashed = await git.stashPush(p, message);
            try {
              const switched = await git.switchBranch(p, to, false);
              return { command: `${stashed.command} && ${switched.command}`, output: switched.output };
            } catch (e) {
              const { command, message: why } = git.splitGitError(e);
              throw `${stashed.command} && ${command ?? ""}\n${why}\n（変更は stash@{0} に退避してあります。「退避中」から戻せます）`;
            }
          },
          `${to} に切り替えました（変更は退避しました）`,
          { inlineError: true },
        );
      },
    });
  }

  /** ブランチを作って切り替える。start があれば、そのコミットから作る */
  function createBranch(suggested?: string, start?: string) {
    setDialog({
      kind: "input",
      title: "ブランチを作成",
      label: "新しいブランチの名前",
      placeholder: suggested ?? "feature/login-form",
      initial: suggested,
      note: start
        ? `コミット ${short(start)} から新しいブランチを作って、そこに切り替えます。名前に空白は使えません。`
        : `今の ${branch || "コミット"} から新しいブランチを作って、そこに切り替えます。作業中の変更はそのまま持っていきます。名前に空白は使えません。`,
      okLabel: "作成して切り替える",
      commandFor: (name) => git.displayCommand(["switch", "-c", name, ...(start ? [short(start)] : [])]),
      submit: (name) =>
        g.exec(
          "ブランチを作っています",
          (p) => git.switchBranch(p, name, true, start ?? null),
          `${name} を作って切り替えました`,
          { inlineError: true },
        ),
    });
  }

  /** タグを付ける。target がなければ今のコミットに */
  function tag(target?: string) {
    const at = target ? short(target) : st?.head ?? "";
    setDialog({
      kind: "input",
      title: "タグを付ける",
      label: "タグの名前",
      placeholder: "v1.0.0",
      note: `コミット ${at} に名前を付けます。リリースの区切りなどに使います。GitHub に送るには、別に git push origin タグ名 が必要です。`,
      okLabel: "タグを付ける",
      commandFor: (name) => git.displayCommand(["tag", name, ...(target ? [short(target)] : [])]),
      submit: (name) =>
        g.exec("タグを付けています", (p) => git.tag(p, name, target ?? null), `${name} を付けました`, { inlineError: true }),
    });
  }

  function stash() {
    return g.exec("退避しています", (p) => git.stashPush(p, "作業中"), "作業中の変更を退避しました（stash@{0}）");
  }

  function stashPop(index: number) {
    return g.exec("戻しています", (p) => git.stashPop(p, index), `stash@{${index}} を戻しました`);
  }

  function stashDrop(s: GitStash) {
    const ref = `stash@{${s.index}}`;
    setDialog({
      kind: "confirm",
      title: "退避中の変更を削除",
      message:
        `${ref}「${s.message}」を削除します。` +
        (s.files === 0 ? "中身は空なので、消しても失われる変更はありません。" : "退避した変更は失われ、元に戻せません。"),
      okLabel: "削除する",
      danger: s.files !== 0,
      commandFor: () => git.displayCommand(["stash", "drop", ref]),
      submit: () => g.exec("削除しています", (p) => git.stashDrop(p, s.index), "退避中の変更を削除しました", { inlineError: true }),
    });
  }

  function discardAll() {
    const untracked = st?.files.filter((f) => f.unstaged === "?").length ?? 0;
    const restore = git.displayCommand(["restore", "--staged", "--worktree", "--", "."]);
    const clean = git.displayCommand(["clean", "-fd", "--", "."]);
    setDialog({
      kind: "confirm",
      title: "作業中の変更をすべて破棄",
      message: "コミットしていない変更をすべて消して、直前のコミットの状態に戻します。元に戻せません。",
      option: untracked > 0 ? `まだ git に追加していない新しいファイル（${untracked} 個）も消す` : undefined,
      okLabel: "破棄する",
      danger: true,
      commandFor: (withNew) => (withNew ? `${restore} && ${clean}` : restore),
      submit: (withNew) =>
        g.exec("破棄しています", (p) => git.discardAll(p, withNew), "作業中の変更を破棄しました", { inlineError: true }),
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
        "無視する設定をしています",
        (p) => git.ignoreAdd(p, rule.pattern, untrack ? rule.pathspec : null, rule.recursive),
        (run) => run.output,
        { inlineError: untrack || tracked.length > 0 },
      );
    if (tracked.length === 0) return add(false);

    const rm = git.displayCommand(["rm", ...(rule.recursive ? ["-r"] : []), "--cached", "--", rule.pathspec]);
    const kept =
      "ファイルはこの PC に残り、次のコミットで記録から外れます。GitHub からも消えるので、ほかの人がプルすると、その人の手元からも消えます。";
    if (rule.kind === "file") {
      setDialog({
        kind: "confirm",
        title: `${rule.label} を無視する`,
        message: `${rule.pathspec} はすでに git で管理しているファイルです。.gitignore に書くだけでは無視されないので、管理から外します。${kept}`,
        okLabel: "管理から外して無視する",
        commandFor: () => rm,
        submit: () => add(true),
      });
      return;
    }
    const examples = tracked.slice(0, 3).join("、") + (tracked.length > 3 ? " など" : "");
    setDialog({
      kind: "choice",
      title: rule.kind === "ext" ? `拡張子 ${rule.label} のファイルを無視する` : `フォルダ ${rule.label} を無視する`,
      message: `当てはまるファイルのうち ${tracked.length} 個（${examples}）は、すでに git で管理しています。.gitignore に書くだけでは、これらは無視されません。`,
      choices: [
        { key: "untrack", title: "管理しているファイルも外して無視する", detail: kept, command: rm },
        {
          key: "keep",
          title: ".gitignore に書くだけにする",
          detail: "管理しているファイルはこれまでどおり記録されます。まだ管理していないファイルだけが無視されます。",
          command: "",
        },
      ],
      submit: (key) => add(key === "untrack"),
    });
  }

  function editGitignore() {
    if (g.folder) setGitignoreOpen(true);
  }

  function saveGitignore(text: string) {
    return g.exec("保存しています", (p) => git.writeGitignore(p, text), (run) => run.output, { inlineError: true });
  }

  // --- 途中で止まった操作（マージ・リベース・チェリーピック・リバート） ---

  function abortOperation() {
    const op = st?.operation;
    if (!op) return;
    const name = OPERATION_NAMES[op];
    setDialog({
      kind: "confirm",
      title: `${name}を中止`,
      message: `${name}をやめて、始める前の状態に戻します。競合を直した内容も消えます。`,
      okLabel: "中止する",
      danger: true,
      commandFor: () => `git ${op} --abort`,
      submit: () => g.exec(`${name}を中止しています`, (p) => git.abortOperation(p, op), `${name}を中止しました`, { inlineError: true }),
    });
  }

  // --- 競合を直す（マージツール） ---

  /** 選んだ内容を書いて、ステージする（「直した」という合図） */
  function resolveConflict(file: string, text: string) {
    return g.exec("書き込んでいます", (p) => git.resolveConflict(p, file, text), `${file} を直してステージしました`);
  }

  /** ファイルをまるごと片方の内容にする（か所ごとに選ばない。文字でないファイルはこれだけ）。捨てる側があるので確かめる */
  function takeConflictSide(file: string, side: "ours" | "theirs" | "delete", sideLabel: string) {
    const message =
      side === "delete"
        ? `${file} を消したままにします（片方で消されていたファイルです）。`
        : `${file} をまるごと「${sideLabel}」の内容にします。もう一方の変更はこのファイルには入りません。そのブランチやコミットには残るので、あとで要るときは手で入れます。`;
    setDialog({
      kind: "confirm",
      title: side === "delete" ? "消したままにする" : `まるごと${sideLabel}にする`,
      message,
      okLabel: side === "delete" ? "消したままにする" : "この内容にする",
      commandFor: () => (side === "delete" ? git.displayCommand(["rm", "--", file]) : `${git.displayCommand(["checkout", `--${side}`, "--", file])} && ${git.displayCommand(["add", "--", file])}`),
      submit: () => g.exec("書き込んでいます", (p) => git.takeSide(p, file, side), side === "delete" ? `${file} を消したままにしました` : `${file} を${sideLabel}の内容にしてステージしました`, { inlineError: true }),
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
    return g.exec(`${name}を続けています`, (p) => git.continueOperation(p, op), `${name}を続けました`);
  }

  // --- コミットの操作 ---

  function detach(hash: string) {
    return g.exec(
      "取り出しています",
      (p) => git.detach(p, hash),
      `${short(hash)} を取り出しました。どのブランチにも属していない状態です`,
    );
  }

  function cherryPick(hash: string) {
    return g.exec("取り込んでいます", (p) => git.cherryPick(p, hash), `${short(hash)} の変更を ${branch} に取り込みました`);
  }

  function revert(hash: string) {
    return g.exec("打ち消しています", (p) => git.revert(p, hash), `${short(hash)} を打ち消すコミットを作りました`);
  }

  /** 今のブランチをそのコミットまで戻す。どれも履歴が変わるので、確認してから */
  function reset(hash: string, mode: "soft" | "mixed" | "hard") {
    const h = short(hash);
    const how = {
      soft: { title: "ソフト", effect: "その変更はステージに残ります（まとめてコミットし直すときに使います）。" },
      mixed: { title: "混在", effect: "その変更は作業中のファイルに残ります（ステージからは外れます）。" },
      hard: { title: "ハード", effect: "その変更も、今の作業中の変更も、すべて捨てます。元に戻せません。" },
    }[mode];
    const pushed = st?.upstream ? "GitHub に送ってあるコミットは、GitHub の方には残ります（プルすると戻ってきます）。" : "";
    setDialog({
      kind: "confirm",
      title: `ここまで戻す（${how.title}）`,
      message: `${branch} を ${h} まで戻します。${h} より後のコミットはブランチから外れ、${how.effect}${pushed}`,
      okLabel: "戻す",
      danger: mode === "hard",
      commandFor: () => git.displayCommand(["reset", `--${mode}`, h]),
      submit: () => g.exec("戻しています", (p) => git.reset(p, hash, mode), `${branch} を ${h} まで戻しました`, { inlineError: true }),
    });
  }

  async function copyHash(hash: string) {
    try {
      await navigator.clipboard.writeText(hash);
      g.notify("ok", `コミット ${short(hash)} のハッシュをコピーしました`);
    } catch (e) {
      g.notify("error", `コピーできませんでした: ${e}`);
    }
  }

  // --- ブランチの操作 ---

  /** GitHub にだけあるブランチは origin/ を付けて扱う */
  const refOf = (e: BranchEntry) => (e.onPc ? e.name : `origin/${e.name}`);

  function merge(e: BranchEntry) {
    return g.exec("マージしています", (p) => git.merge(p, refOf(e)), `${refOf(e)} を ${branch} に取り込みました`);
  }

  function rebase(e: BranchEntry) {
    const target = refOf(e);
    setDialog({
      kind: "confirm",
      title: "リベース（付け替え）",
      message:
        `${branch} で作ったコミットを ${target} の先に付け替えます。コミットは作り直されるので、履歴が書き換わります。` +
        (st?.upstream ? "すでに GitHub に送ったコミットがあると、送り直すのに強制プッシュが必要になります。" : ""),
      okLabel: "付け替える",
      commandFor: () => git.displayCommand(["rebase", target]),
      submit: () => g.exec("付け替えています", (p) => git.rebase(p, target), `${branch} を ${target} の先に付け替えました`, { inlineError: true }),
    });
  }

  function pushBranch(e: BranchEntry) {
    return g.exec(
      "プッシュしています",
      (p) => git.pushBranch(p, e.name),
      e.onGitHub ? `origin/${e.name} に送りました` : `${e.name} を GitHub に公開しました`,
    );
  }

  function setUpstream(e: BranchEntry) {
    return g.exec("設定しています", (p) => git.setUpstream(p, e.name), `${e.name} の上流を origin/${e.name} にしました`);
  }

  function renameBranch(e: BranchEntry) {
    setDialog({
      kind: "input",
      title: "ブランチの名前を変更",
      label: "新しい名前",
      placeholder: e.name,
      initial: e.name,
      note: e.onGitHub ? "この PC のブランチの名前だけが変わります。GitHub のブランチの名前はそのままです。" : undefined,
      okLabel: "変更する",
      commandFor: (to) => git.displayCommand(["branch", "-m", e.name, to]),
      submit: (to) =>
        g.exec("名前を変えています", (p) => git.renameBranch(p, e.name, to), `${e.name} を ${to} に変えました`, { inlineError: true }),
    });
  }

  function deleteBranch(e: BranchEntry) {
    setDialog({
      kind: "confirm",
      title: `ブランチ ${e.name} を削除`,
      message:
        `この PC のブランチ ${e.name} を削除します。ほかのブランチに取り込んでいない（マージしていない）コミットがあると、git が止めます。` +
        (e.onGitHub ? "GitHub のブランチはそのままです。" : ""),
      option: "マージしていなくても削除する（-D。そのコミットは失われます）",
      okLabel: "削除する",
      danger: true,
      commandFor: (force) => git.displayCommand(["branch", force ? "-D" : "-d", e.name]),
      submit: (force) =>
        g.exec("削除しています", (p) => git.deleteBranch(p, e.name, force), `${e.name} を削除しました`, { inlineError: true }),
    });
  }

  // --- 右クリック・「⋯」のメニュー ---

  // 作業フォルダがない（GitHub から読んだ履歴の）ときは、git の操作は押せない。理由は最初の項目にだけ書く
  const NO_FOLDER_HINT = "この PC の作業フォルダを決めると使えます";
  const toCurrent = branch ? `${branch} に` : "今のブランチに";

  function commitMenu(c: GitCommit, ctx: CommitMenuContext): MenuItem[] {
    const h = short(c.hash);
    const can = ctx.local && !!st;
    const onBranch = can && !!branch;
    // 押せない理由（作業フォルダがないときは出さない。最初の項目に書いてあるので）
    const why = (text: string, show: boolean) => (can && show ? text : undefined);
    return [
      {
        label: "🌿 このコミットからブランチを作成…",
        code: `git switch -c {名前} ${h}`,
        disabled: !can,
        hint: can ? undefined : NO_FOLDER_HINT,
        run: () => createBranch(undefined, c.hash),
      },
      { label: "🏷️ タグを付ける…", code: `git tag {名前} ${h}`, disabled: !can, run: () => tag(c.hash) },
      { label: "⎇ このコミットを取り出す（切り離された HEAD）", code: `git switch --detach ${h}`, disabled: !can, run: () => detach(c.hash) },
      "sep",
      {
        label: `🍒 ${toCurrent}取り込む（チェリーピック）`,
        code: `git cherry-pick ${h}`,
        disabled: !onBranch || ctx.inCurrent,
        hint: why("今のブランチにもう入っています", ctx.inCurrent),
        run: () => cherryPick(c.hash),
      },
      {
        label: "↩ 打ち消すコミットを作る（リバート）",
        code: `git revert --no-edit ${h}`,
        disabled: !onBranch || !ctx.inCurrent,
        hint: why("今のブランチの履歴にあるコミットだけ打ち消せます", !ctx.inCurrent),
        run: () => revert(c.hash),
      },
      ...(["soft", "mixed", "hard"] as const).map((mode) => ({
        label: `⏮ ここまで戻す：${{ soft: "ソフト（変更はステージに残す）", mixed: "混在（変更は作業中に残す）", hard: "ハード（変更を捨てる）" }[mode]}…`,
        code: `git reset --${mode} ${h}`,
        danger: mode === "hard",
        disabled: !onBranch || !ctx.inCurrent,
        hint: why("今のブランチの履歴にあるコミットまでしか戻せません", !ctx.inCurrent),
        run: () => reset(c.hash, mode),
      })),
      "sep",
      // 作業フォルダがなくても、GitHub から読んで見せられる
      { label: "🔍 変更内容を見る", code: `git show ${h}`, run: () => setDetail(c) },
      { label: "📋 ハッシュをコピー", run: () => copyHash(c.hash) },
      { label: "↗ GitHub で開く", run: () => { openUrl(`${githubUrl}/commit/${c.hash}`); } },
    ];
  }

  function branchMenu(e: BranchEntry, local: boolean): MenuItem[] {
    const can = local && !!st;
    const items: MenuItem[] = [];
    if (!e.isCurrent) {
      items.push(
        {
          label: "✔ このブランチに切り替える",
          code: `git switch ${e.name}`,
          disabled: !can,
          hint: can ? undefined : NO_FOLDER_HINT,
          run: () => requestSwitch(e.name),
        },
        {
          label: `⤵ ${toCurrent}取り込む（マージ）`,
          code: `git merge --no-edit ${refOf(e)}`,
          disabled: !can || !branch,
          run: () => merge(e),
        },
        {
          label: `⤳ ${branch || "今のブランチ"}を ${e.name} の先に付け替える（リベース）…`,
          code: `git rebase ${refOf(e)}`,
          disabled: !can || !branch,
          run: () => rebase(e),
        },
        "sep",
      );
    }
    items.push(
      {
        label: "⟳ このブランチをフェッチ",
        code: `git fetch origin ${e.name}`,
        disabled: !can || !e.onGitHub,
        run: () => fetchBranch(e),
      },
      {
        label: e.isCurrent ? "⬇ プル" : "⬇ プル（切り替えずに）",
        code: e.isCurrent ? "git pull" : e.onPc ? `git fetch origin ${e.name}:${e.name}` : `git branch --track ${e.name} origin/${e.name}`,
        disabled: !can || !e.onGitHub,
        run: () => pullBranch(e),
      },
      {
        label: "⬆ プッシュ",
        code: e.onGitHub ? `git push origin ${e.name}` : `git push -u origin ${e.name}`,
        disabled: !can || !e.onPc,
        run: () => pushBranch(e),
      },
      {
        label: "🔗 上流ブランチを設定",
        code: `git branch -u origin/${e.name} ${e.name}`,
        disabled: !can || !e.onPc || !e.onGitHub || !!e.info?.upstream,
        hint: can && e.info?.upstream ? `上流は ${e.info.upstream} に設定済みです` : undefined,
        run: () => setUpstream(e),
      },
      { label: "✎ 名前を変更…", code: `git branch -m ${e.name} {新しい名前}`, disabled: !can || !e.onPc, run: () => renameBranch(e) },
      "sep",
      {
        label: "🗑 削除…",
        code: `git branch -d ${e.name}`,
        danger: true,
        disabled: !can || !e.onPc || e.isCurrent,
        hint: can && e.isCurrent ? "チェックアウト中のブランチは削除できません（先に切り替えます）" : undefined,
        run: () => deleteBranch(e),
      },
      {
        label: "↗ GitHub で開く",
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
    const why = isGitignore ? ".gitignore そのものは無視できません" : conflict ? "競合を直してから使えます" : undefined;
    const items: MenuItem[] = git.ignoreRules(f.path).map((r, i) => ({
      label:
        r.kind === "file" ? `🙈 このファイルを無視する${tracked ? "（管理から外す）…" : ""}`
        : r.kind === "ext" ? `🙈 拡張子 ${r.label} のファイルをすべて無視する`
        : `🙈 フォルダ ${r.label} を無視する`,
      code: `.gitignore に追記: ${r.pattern}`,
      disabled: !!why,
      // 押せない理由は最初の項目にだけ書く
      hint: i === 0 ? why : undefined,
      run: () => { ignore(r); },
    }));
    items.push("sep", { label: "📝 .gitignore を編集…", run: editGitignore });
    return items;
  }

  async function openTerminal() {
    if (!g.folder) return;
    try {
      await git.openTerminal(g.folder);
      g.notify("ok", "ターミナルを開きました。ここで git のコマンドを試せます");
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
