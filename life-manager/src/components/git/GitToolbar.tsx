import { useCallback, useRef, useState } from "react";
import { useDismiss } from "../../hooks/useDismiss";
import { displayCommand } from "../../lib/git";
import type { GitBranch } from "../../lib/types";
import type { GitState } from "../../hooks/useGit";
import type { GitActions } from "../../hooks/useGitActions";
import { isEnter } from "../../lib/keys";
import { tr, trx } from "../../lib/i18n";

interface GitToolbarProps {
  git: GitState;
  actions: GitActions;
  /** 「コミット…」「空コミット…」: 作業タブのコミット欄を開く */
  onOpenCommit: (empty: boolean) => void;
}

/** 上のバーに置く git の操作（ブランチの切り替え・フェッチ・プル・プッシュ・その他） */
export function GitToolbar({ git: g, actions, onOpenCommit }: GitToolbarProps) {
  const st = g.status;
  if (!st) return null;
  const busy = g.busy !== null;
  const published = !!st.upstream;

  return (
    <div className="git-toolbar">
      {g.busy && (
        <span className="tb-busy" role="status" title={`${g.busy}…`}>
          <i className="spinner" aria-hidden="true" />
          <span className="tb-lb">{g.busy}…</span>
        </span>
      )}
      <BranchSwitcher git={g} actions={actions} disabled={busy} />
      <button
        type="button"
        className="tbtn"
        disabled={busy}
        onClick={actions.fetch}
        title={tr("git fetch --all --prune（GitHub の最新の状態を取ってくる）")}
      >
        {trx("⟳<0> フェッチ</0>", undefined, [<span className="tb-lb" />])}
      </button>
      <button
        type="button"
        className="tbtn"
        disabled={busy || !published}
        onClick={actions.pull}
        title={published ? tr("git pull --no-rebase（GitHub の新しいコミットを取り込む）") : tr("このブランチはまだ GitHub にありません")}
      >
        {trx("⬇<0> プル</0>", undefined, [<span className="tb-lb" />])}
        {st.behind > 0 && <span className="tb-cnt">{st.behind}</span>}
      </button>
      <button
        type="button"
        className="tbtn"
        disabled={busy || !st.branch}
        onClick={actions.push}
        title={
          published
            ? tr("git push（コミットを GitHub に送る）")
            : tr("{displayCommand}（このブランチを GitHub に公開する）", { displayCommand: displayCommand(["push", "-u", "origin", st.branch]) })
        }
      >
        {trx("⬆<0> プッシュ</0>", undefined, [<span className="tb-lb" />])}
        {!published && st.branch ? (
          <span className="tb-cnt">{tr("未公開")}</span>
        ) : (
          st.ahead > 0 && <span className="tb-cnt">{st.ahead}</span>
        )}
      </button>
      <MoreMenu git={g} actions={actions} disabled={busy} onOpenCommit={onOpenCommit} />
    </div>
  );
}

/** 今のブランチを先頭に、次に既定のブランチ、あとは新しい順 */
function sortBranches(list: GitBranch[], defaultBranch: string | null): GitBranch[] {
  const rank = (b: GitBranch) => (b.current ? 0 : b.name === defaultBranch ? 1 : 2);
  return [...list].sort((a, b) => rank(a) - rank(b) || b.date.localeCompare(a.date));
}

export function branchSyncLabel(b: GitBranch): string {
  if (b.gone) return tr("GitHub で削除済み");
  if (!b.upstream) return tr("未公開");
  return [b.ahead ? `↑${b.ahead}` : "", b.behind ? `↓${b.behind}` : ""].filter(Boolean).join(" ");
}

function BranchSwitcher({ git: g, actions, disabled }: { git: GitState; actions: GitActions; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);

  const st = g.status;
  if (!st) return null;
  const q = query.trim().toLowerCase();
  const list = sortBranches(g.branches, st.default_branch).filter((b) => !q || b.name.toLowerCase().includes(q));

  function choose(name: string) {
    setOpen(false);
    actions.requestSwitch(name);
  }

  return (
    <div className="bsw" ref={ref}>
      <button
        type="button"
        className={`tbtn bsw-btn${open ? " open" : ""}`}
        disabled={disabled}
        onClick={() => { setQuery(""); setOpen(!open); }}
        title={tr("ブランチを切り替える（git switch）")}
      >
        <span className="bsw-label">{tr("現在のブランチ")}</span>
        <b>{st.branch || tr("切り離し {head}", { head: st.head })}</b> ▾
      </button>
      {open && (
        <div className="bsw-panel popover">
          <input
            className="input-full bsw-filter"
            placeholder={tr("ブランチを探す")}
            autoFocus
            autoComplete="off"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (isEnter(e) && list[0]) choose(list[0].name); }}
          />
          <div className="bsw-group">{tr("ローカルのブランチ")}</div>
          {list.map((b) => (
            <button key={b.name} type="button" className={`bsw-item${b.current ? " on" : ""}`} onClick={() => choose(b.name)}>
              <span className="bsw-check">{b.current ? "✔" : ""}</span>
              <span className="bsw-name">{b.name}</span>
              <span className="bsw-meta">{branchSyncLabel(b)}</span>
            </button>
          ))}
          {list.length === 0 && <div className="bsw-empty">{tr("一致するブランチはありません")}</div>}
          <hr />
          <button type="button" className="bsw-item bsw-new" onClick={() => { setOpen(false); actions.createBranch(); }}>
            {trx("<0>＋</0><1>新しいブランチを作成…</1>", undefined, [<span className="bsw-check" />, <span className="bsw-name" />])}
            <span />
          </button>
        </div>
      )}
    </div>
  );
}

interface MoreMenuProps {
  git: GitState;
  actions: GitActions;
  disabled: boolean;
  onOpenCommit: (empty: boolean) => void;
}

function MoreMenu({ git: g, actions, disabled, onOpenCommit }: MoreMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);

  const st = g.status;
  if (!st) return null;
  const changes = st.files.length;

  // 選んだらメニューを閉じてから実行する
  const item = (label: string, run: () => void, opts: { code?: string; off?: boolean; danger?: boolean } = {}) => (
    <button
      type="button"
      className={`mi${opts.danger ? " danger" : ""}`}
      disabled={opts.off}
      onClick={() => { setOpen(false); run(); }}
    >
      <span>{label}</span>
      {opts.code && <code>{opts.code}</code>}
    </button>
  );

  return (
    <div className="tb-more" ref={ref}>
      <button type="button" className={`tbtn${open ? " open" : ""}`} disabled={disabled} onClick={() => setOpen(!open)} title={tr("その他")}>
        {trx("<0>⋯</0><1>その他 ▾</1>", undefined, [<span className="tb-more-ic" aria-hidden="true" />, <span className="tb-lb" />])}
      </button>
      {open && (
        <div className="menu popover">
          {item(tr("✎ コミット…"), () => onOpenCommit(false))}
          {item(tr("◌ 空コミット…"), () => onOpenCommit(true))}
          {item(tr("📦 変更を一時退避（スタッシュ）"), actions.stash, {
            code: displayCommand(["stash", "push", "-u", "-m", tr("作業中")]),
            off: changes === 0,
          })}
          {item(tr("📦 退避した変更を戻す"), () => actions.stashPop(0), {
            code: "git stash pop stash@{0}",
            off: g.stashes.length === 0,
          })}
          {item(tr("🌿 ブランチを作成…"), () => actions.createBranch(), { code: tr("git switch -c {名前}", { 名前: tr("名前") }) })}
          {item(tr("🏷️ 今のコミットにタグを付ける…"), actions.tag, { code: tr("git tag {名前}", { 名前: tr("名前") }), off: !st.head })}
          {item(tr("📝 .gitignore を編集…"), actions.editGitignore)}
          <hr />
          {item(tr("🗑 作業中の変更をすべて破棄…"), actions.discardAll, {
            code: "git restore --staged --worktree -- .",
            off: changes === 0,
            danger: true,
          })}
          {item(tr("⌨ このフォルダでターミナルを開く"), actions.openTerminal)}
          {item(tr("↻ 表示を更新"), actions.refresh)}
        </div>
      )}
    </div>
  );
}
