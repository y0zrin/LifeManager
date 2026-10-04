import { useCallback, useEffect, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { ago, pullRepoInfo, type PullRepoInfo } from "../../lib/pulls";
import {
  closeMilestone,
  formatSize,
  listReleases,
  releaseMilestones,
  updateRelease,
  uploadReleaseAsset,
  type Release,
  type ReleaseMilestone,
} from "../../lib/releases";
import { isPermissionError } from "../../lib/actions";
import { withTransition } from "../../lib/motion";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { MiniMarkdown } from "../common/MiniMarkdown";
import { RichText } from "../pulls/PullConversation";
import { PermissionPrompt } from "../actions/PermissionPrompt";
import { CreateReleaseDialog } from "../releases/CreateReleaseDialog";
import { tr, trx } from "../../lib/i18n";

interface ReleasesViewProps {
  owner: string;
  repo: string;
  currentUser: string;
  issueTitle: (n: number) => string | null;
  onOpenIssue: (n: number) => void;
  /** マイルストーンを閉じた（一覧を読み直す） */
  onMilestonesChanged: () => void;
}

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** リリース: 左に一覧（最新・試用版・下書き）、右に中身（ノート・添えたファイル） */
export function ReleasesView({ owner, repo, currentUser, issueTitle, onOpenIssue, onMilestonesChanged }: ReleasesViewProps) {
  const [releases, setReleases] = useState<Release[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [info, setInfo] = useState<PullRepoInfo | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const [create, setCreate] = useState(false);
  const [editing, setEditing] = useState<{ name: string; body: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // 下書きを公開するとき、同じ版の名前の開いているマイルストーンも閉じる（作るときの「マイルストーンを閉じる」と同じ）
  const [milestones, setMilestones] = useState<ReleaseMilestone[] | null>(null);
  const [closeMs, setCloseMs] = useState(true);
  const wide = useMediaQuery("(min-width: 901px)");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setReleases(await listReleases(owner, repo));
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [owner, repo]);

  useEffect(() => {
    setReleases(null);
    setPicked(null);
    setInfo(null);
    load();
    pullRepoInfo(owner, repo).then(setInfo).catch(() => {});
  }, [owner, repo, load]);

  const list = releases ?? [];
  // はじめは「最新」のリリース（なければいちばん上）
  const selected = list.find((r) => r.id === picked) ?? (wide ? list.find((r) => r.latest) ?? list[0] : undefined) ?? null;
  const canPush = info?.can_push ?? false;

  useEffect(() => {
    setEditing(null);
    setActionError(null);
    setCloseMs(true);
  }, [selected?.id]);

  // 下書きを選んだら、同じ版の名前のマイルストーンがあるかを見る
  const draftSelected = !!selected?.draft;
  useEffect(() => {
    if (draftSelected && milestones === null) releaseMilestones(owner, repo).then(setMilestones).catch(() => setMilestones([]));
  }, [draftSelected, milestones, owner, repo]);
  useEffect(() => setMilestones(null), [owner, repo]);
  const draftMilestone =
    selected?.draft && milestones
      ? milestones.find((m) => m.state === "open" && (m.title === selected.tag_name || m.title === selected.tag_name.replace(/^v/i, ""))) ?? null
      : null;

  function pick(id: number | null) {
    const from = list.findIndex((r) => r.id === selected?.id);
    const to = list.findIndex((r) => r.id === id);
    withTransition(() => setPicked(id), ["vt-pick", ...(from >= 0 && to >= 0 && to < from ? ["vt-up"] : [])]);
  }

  async function act(label: string, task: () => Promise<void>) {
    setBusy(label);
    setActionError(null);
    try {
      await task();
    } catch (e) {
      setActionError(String(e));
    } finally {
      setBusy(null);
    }
  }

  // GitHub のノートにある PR の URL は、#12 にして押せるようにする
  const notesText = useMemo(
    () => (selected ? selected.body.replace(new RegExp(`https://github\\.com/${owner}/${repo}/(?:pull|issues)/(\\d+)`, "gi"), "#$1") : ""),
    [selected, owner, repo],
  );
  const downloads = (r: Release) => r.assets.reduce((n, a) => n + a.download_count, 0);

  return (
    <div className={`pulls releases pr-ui${picked !== null ? " has-selection" : ""}`}>
      <div className="pulls-list">
        <div className="pulls-top">
          <span className="muted">{releases ? tr("{length} のリリース", { length: list.length }) : ""}</span>
          <span className="grow" />
          <button type="button" className="btn-sm" onClick={load} disabled={loading} title={tr("読み直す")}>
            {loading ? "…" : "↻"}
          </button>
          {canPush && (
            <button type="button" className="btn-primary" onClick={() => setCreate(true)} disabled={!info}>
              {tr("＋ リリースを作る")}
            </button>
          )}
        </div>
        {notice && (
          <p className="pulls-notice">
            {notice}
            <button type="button" className="git-notice-close" aria-label={tr("閉じる")} onClick={() => setNotice(null)}>
              ×
            </button>
          </p>
        )}
        <div className="pulls-items" role="list">
          {error ? (
            isPermissionError(error) ? (
              <div className="pulls-empty">
                <PermissionPrompt owner={owner} currentUser={currentUser} need={[{ key: "contents", name: "Contents", access: "write" }]} message={error} onRetry={load} />
              </div>
            ) : (
              <div className="pulls-empty">
                <p className="git-dialog-error">{error}</p>
                <button type="button" className="btn-sm" onClick={load}>
                  {tr("もう一度読み込む")}
                </button>
              </div>
            )
          ) : !releases ? (
            <p className="pulls-empty muted">{tr("読み込んでいます…")}</p>
          ) : list.length === 0 ? (
            <div className="pulls-empty">
              <p>{tr("まだリリースはありません。")}</p>
            </div>
          ) : (
            list.map((r) => (
              <button key={r.id} type="button" role="listitem" className={`pr-item${selected?.id === r.id ? " on" : ""}`} onClick={() => pick(r.id)}>
                <div className="pr-item-title">
                  {r.name || r.tag_name}
                  {r.latest && <span className="rl-chip latest">{tr("最新")}</span>}
                  {r.prerelease && <span className="rl-chip pre">{tr("試用版")}</span>}
                  {r.draft && <span className="rl-chip draft">{tr("下書き")}</span>}
                </div>
                <div className="pr-item-meta">
                  <code>{r.tag_name}</code>
                  <span className="muted">
                    {r.author?.login ?? ""}{trx("・{ago}", { ago: ago(r.published_at ?? r.created_at) })}
                  </span>
                  {r.assets.length > 0 && <span className="muted">↓ {downloads(r)}</span>}
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      <div className="pulls-detail">
        {selected ? (
          <div className="pr-detail">
            <div className="pr-head">
              <button type="button" className="btn-sm pr-back" onClick={() => pick(null)}>
                {tr("← 一覧")}
              </button>
              {editing ? (
                <input className="pr-title-input" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} aria-label={tr("題名")} />
              ) : (
                <h2 className="pr-title">{selected.name || selected.tag_name}</h2>
              )}
              {selected.latest && <span className="rl-chip latest">{tr("最新")}</span>}
              {selected.prerelease && <span className="rl-chip pre">{tr("試用版")}</span>}
              {selected.draft && <span className="rl-chip draft">{tr("下書き")}</span>}
              <span className="grow" />
              {canPush && selected.draft && !editing && (
                <button
                  type="button"
                  className="btn-sm primary"
                  disabled={busy !== null}
                  onClick={() =>
                    act(tr("公開しています…"), async () => {
                      await updateRelease(owner, repo, selected.id, { draft: false });
                      const ms = closeMs ? draftMilestone : null;
                      if (ms) {
                        await closeMilestone(owner, repo, ms.number);
                        setMilestones(null);
                        onMilestonesChanged();
                      }
                      setNotice(tr("{tag_name} を公開しました{v}", { tag_name: selected.tag_name, v: ms ? tr("（マイルストーン {title} も閉じました）", { title: ms.title }) : "" }));
                      await load();
                    })
                  }
                >
                  {tr("公開する")}
                </button>
              )}
              {canPush && selected.draft && !editing && draftMilestone && (
                <label className="rl-publish-ms">
                  <input type="checkbox" checked={closeMs} onChange={(e) => setCloseMs(e.target.checked)} /> {" "}{trx("マイルストーン {title} も閉じる", { title: draftMilestone.title })}
                </label>
              )}
              {canPush && !editing && (
                <button type="button" className="btn-sm" onClick={() => setEditing({ name: selected.name ?? "", body: selected.body })}>
                  {tr("✏️ 編集")}
                </button>
              )}
              <button type="button" className="btn-sm" onClick={() => openUrl(selected.html_url).catch(() => {})}>
                {tr("GitHub で開く ↗")}
              </button>
            </div>
            <div className="pr-flow">
              {trx("<0>{tag_name}</0> → <1>{target_commitish}</1>・", { tag_name: selected.tag_name, target_commitish: selected.target_commitish }, [<code />, <code className="pr-branch" />])}{selected.author?.login ?? ""}{tr("・")}
              {selected.draft ? tr("下書き（書き込める人にだけ見えます）") : ago(selected.published_at ?? selected.created_at)}
            </div>
            {editing ? (
              <div className="pr-edit">
                <textarea rows={12} value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} aria-label={tr("ノート")} />
                <div className="pr-edit-actions">
                  <button type="button" className="btn-sm" onClick={() => setEditing(null)}>
                    {tr("やめる")}
                  </button>
                  <button
                    type="button"
                    className="btn-sm primary"
                    disabled={busy !== null}
                    onClick={() => act(tr("保存しています…"), async () => { await updateRelease(owner, repo, selected.id, { name: editing.name, body: editing.body }); setEditing(null); await load(); })}
                  >
                    {tr("保存する")}
                  </button>
                </div>
              </div>
            ) : (
              <div className="rl-notes">
                {selected.body.trim() ? (
                  <MiniMarkdown text={notesText} renderText={(t) => <RichText text={t} issueTitle={issueTitle} onOpenIssue={onOpenIssue} />} />
                ) : (
                  <span className="muted">{tr("ノートはありません。")}</span>
                )}
              </div>
            )}
            <div className="rl-assets">
              <div className="rl-assets-head">
                <b>{trx("添えたファイル {length}", { length: selected.assets.length })}</b>
                <span className="grow" />
                {canPush && (
                  <button
                    type="button"
                    className="btn-sm"
                    disabled={busy !== null}
                    onClick={() =>
                      act(tr("ファイルを送っています…"), async () => {
                        const picked = await openDialog({ multiple: true, directory: false, title: tr("{tag_name} に添えるファイルを選ぶ", { tag_name: selected.tag_name }) });
                        const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
                        const failed: string[] = [];
                        for (const [i, p] of paths.entries()) {
                          setBusy(tr("{baseName} を送っています（{v}/{length}）…", { baseName: baseName(p), v: i + 1, length: paths.length }));
                          try {
                            await uploadReleaseAsset(owner, repo, selected.id, p);
                          } catch (e) {
                            failed.push(String(e));
                          }
                        }
                        if (paths.length > 0) await load();
                        if (failed.length > 0) throw failed.join("\n");
                      })
                    }
                  >
                    {tr("📎 ファイルを添える…")}
                  </button>
                )}
              </div>
              {selected.assets.length === 0 ? (
                <p className="muted">{tr("まだファイルはありません。")}</p>
              ) : (
                selected.assets.map((a) => (
                  <div key={a.id} className="rl-asset">
                    <span>{a.name.endsWith(".exe") || a.name.endsWith(".msi") ? "📦" : "📄"}</span>
                    <button type="button" className="pr-ref" onClick={() => openUrl(a.browser_download_url).catch(() => {})} title={tr("ダウンロードする")}>
                      {a.name}
                    </button>
                    <span className="grow" />
                    <span className="muted">
                      {trx("{formatSize}・↓ {download_count}", { formatSize: formatSize(a.size), download_count: a.download_count })}
                    </span>
                  </div>
                ))
              )}
            </div>
            {busy && <p className="muted">{busy}</p>}
            {actionError && <p className="git-dialog-error">{actionError}</p>}
          </div>
        ) : (
          <div className="pulls-intro">
            <ol className="pulls-steps">
              <li>{tr("マイルストーンの Issue を終えて、main にまとめる（プルリクをマージ）")}</li>
              <li>{tr("「＋ リリースを作る」でマイルストーンを選ぶと、閉じた Issue からノートができる（新しい機能・直した不具合）")}</li>
              <li>{tr("タグを決め、ファイルを添えて「リリースする」。マイルストーンも閉じられる")}</li>
            </ol>
          </div>
        )}
      </div>

      {create && info && releases && (
        <CreateReleaseDialog
          owner={owner}
          repo={repo}
          info={info}
          releases={releases}
          onClose={() => setCreate(false)}
          onMilestoneClosed={onMilestonesChanged}
          onCreated={(r, warnings) => {
            setCreate(false);
            setNotice(warnings.length > 0 ? tr("{tag_name} を作りました。{join}", { tag_name: r.tag_name, join: warnings.join(" ") }) : null);
            setReleases([r, ...list.filter((x) => x.id !== r.id)]);
            setPicked(r.id);
            window.setTimeout(load, 1500);
          }}
        />
      )}
    </div>
  );
}
