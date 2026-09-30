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
          <span className="muted">{releases ? `${list.length} のリリース` : ""}</span>
          <span className="grow" />
          <button type="button" className="btn-sm" onClick={load} disabled={loading} title="読み直す">
            {loading ? "…" : "↻"}
          </button>
          {canPush && (
            <button type="button" className="btn-primary" onClick={() => setCreate(true)} disabled={!info}>
              ＋ リリースを作る
            </button>
          )}
        </div>
        {notice && (
          <p className="pulls-notice">
            {notice}
            <button type="button" className="git-notice-close" aria-label="閉じる" onClick={() => setNotice(null)}>
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
                  もう一度読み込む
                </button>
              </div>
            )
          ) : !releases ? (
            <p className="pulls-empty muted">読み込んでいます…</p>
          ) : list.length === 0 ? (
            <div className="pulls-empty">
              <p>まだリリースはありません。</p>
              <p className="hint">
                リリースは「この版をみんなに配る」印です。「＋ リリースを作る」で、マイルストーンの閉じた Issue からノートを作り、タグを付けて、配るファイル（インストーラーなど）を添えます。
              </p>
            </div>
          ) : (
            list.map((r) => (
              <button key={r.id} type="button" role="listitem" className={`pr-item${selected?.id === r.id ? " on" : ""}`} onClick={() => pick(r.id)}>
                <div className="pr-item-title">
                  {r.name || r.tag_name}
                  {r.latest && <span className="rl-chip latest">最新</span>}
                  {r.prerelease && <span className="rl-chip pre">試用版</span>}
                  {r.draft && <span className="rl-chip draft">下書き</span>}
                </div>
                <div className="pr-item-meta">
                  <code>{r.tag_name}</code>
                  <span className="muted">
                    {r.author?.login ?? ""}・{ago(r.published_at ?? r.created_at)}
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
                ← 一覧
              </button>
              {editing ? (
                <input className="pr-title-input" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} aria-label="題名" />
              ) : (
                <h2 className="pr-title">{selected.name || selected.tag_name}</h2>
              )}
              {selected.latest && <span className="rl-chip latest">最新</span>}
              {selected.prerelease && <span className="rl-chip pre">試用版</span>}
              {selected.draft && <span className="rl-chip draft">下書き</span>}
              <span className="grow" />
              {canPush && selected.draft && !editing && (
                <button
                  type="button"
                  className="btn-sm primary"
                  disabled={busy !== null}
                  onClick={() =>
                    act("公開しています…", async () => {
                      await updateRelease(owner, repo, selected.id, { draft: false });
                      const ms = closeMs ? draftMilestone : null;
                      if (ms) {
                        await closeMilestone(owner, repo, ms.number);
                        setMilestones(null);
                        onMilestonesChanged();
                      }
                      setNotice(`${selected.tag_name} を公開しました${ms ? `（マイルストーン ${ms.title} も閉じました）` : ""}`);
                      await load();
                    })
                  }
                >
                  公開する
                </button>
              )}
              {canPush && selected.draft && !editing && draftMilestone && (
                <label className="rl-publish-ms">
                  <input type="checkbox" checked={closeMs} onChange={(e) => setCloseMs(e.target.checked)} /> マイルストーン {draftMilestone.title} も閉じる
                </label>
              )}
              {canPush && !editing && (
                <button type="button" className="btn-sm" onClick={() => setEditing({ name: selected.name ?? "", body: selected.body })}>
                  ✏️ 編集
                </button>
              )}
              <button type="button" className="btn-sm" onClick={() => openUrl(selected.html_url).catch(() => {})}>
                GitHub で開く ↗
              </button>
            </div>
            <div className="pr-flow">
              <code>{selected.tag_name}</code> → <code className="pr-branch">{selected.target_commitish}</code>・{selected.author?.login ?? ""}・
              {selected.draft ? "下書き（書き込める人にだけ見えます）" : ago(selected.published_at ?? selected.created_at)}
            </div>
            {editing ? (
              <div className="pr-edit">
                <textarea rows={12} value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} aria-label="ノート" />
                <div className="pr-edit-actions">
                  <button type="button" className="btn-sm" onClick={() => setEditing(null)}>
                    やめる
                  </button>
                  <button
                    type="button"
                    className="btn-sm primary"
                    disabled={busy !== null}
                    onClick={() => act("保存しています…", async () => { await updateRelease(owner, repo, selected.id, { name: editing.name, body: editing.body }); setEditing(null); await load(); })}
                  >
                    保存する
                  </button>
                </div>
              </div>
            ) : (
              <div className="rl-notes">
                {selected.body.trim() ? (
                  <MiniMarkdown text={notesText} renderText={(t) => <RichText text={t} issueTitle={issueTitle} onOpenIssue={onOpenIssue} />} />
                ) : (
                  <span className="muted">ノートはありません。</span>
                )}
              </div>
            )}
            <div className="rl-assets">
              <div className="rl-assets-head">
                <b>添えたファイル {selected.assets.length}</b>
                <span className="grow" />
                {canPush && (
                  <button
                    type="button"
                    className="btn-sm"
                    disabled={busy !== null}
                    onClick={() =>
                      act("ファイルを送っています…", async () => {
                        const picked = await openDialog({ multiple: true, directory: false, title: `${selected.tag_name} に添えるファイルを選ぶ` });
                        const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
                        const failed: string[] = [];
                        for (const [i, p] of paths.entries()) {
                          setBusy(`${baseName(p)} を送っています（${i + 1}/${paths.length}）…`);
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
                    📎 ファイルを添える…
                  </button>
                )}
              </div>
              {selected.assets.length === 0 ? (
                <p className="muted">まだファイルはありません（GitHub が、ソースコードの zip・tar.gz は自動で付けます）。</p>
              ) : (
                selected.assets.map((a) => (
                  <div key={a.id} className="rl-asset">
                    <span>{a.name.endsWith(".exe") || a.name.endsWith(".msi") ? "📦" : "📄"}</span>
                    <button type="button" className="pr-ref" onClick={() => openUrl(a.browser_download_url).catch(() => {})} title="ダウンロードする">
                      {a.name}
                    </button>
                    <span className="grow" />
                    <span className="muted">
                      {formatSize(a.size)}・↓ {a.download_count}
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
            <h3>リリースとは</h3>
            <p>「この版をみんなに配る」印です。コミットに付ける名前（タグ。例: 1.0.0）に、何が変わったか（ノート）と、配るファイル（インストーラーなど）をまとめます。</p>
            <ol className="pulls-steps">
              <li>マイルストーンの Issue を終えて、main にまとめる（プルリクをマージ）</li>
              <li>「＋ リリースを作る」でマイルストーンを選ぶと、閉じた Issue からノートができる（新しい機能・直した不具合）</li>
              <li>タグを決め、ファイルを添えて「リリースする」。マイルストーンも閉じられる</li>
            </ol>
            <p className="muted">左の一覧から選ぶと、ここにノートと添えたファイルが出ます。</p>
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
            setNotice(warnings.length > 0 ? `${r.tag_name} を作りました。${warnings.join(" ")}` : null);
            setReleases([r, ...list.filter((x) => x.id !== r.id)]);
            setPicked(r.id);
            window.setTimeout(load, 1500);
          }}
        />
      )}
    </div>
  );
}
