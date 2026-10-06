import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { celebrateDone } from "../../lib/celebrate";
import { isEscape } from "../../lib/keys";
import type { PullRepoInfo } from "../../lib/pulls";
import {
  badTag,
  closeMilestone,
  createRelease,
  generateReleaseNotes,
  milestoneClosedIssues,
  notesFromIssues,
  releasable,
  releaseMilestones,
  tagFromMilestone,
  uploadReleaseAsset,
  type MilestoneIssue,
  type Release,
  type ReleaseAsset,
  type ReleaseMilestone,
} from "../../lib/releases";
import { tr, trx } from "../../lib/i18n";

type Source = "milestone" | "github" | "manual";

interface CreateReleaseDialogProps {
  owner: string;
  repo: string;
  info: PullRepoInfo;
  releases: Release[];
  onCreated: (release: Release, warnings: string[]) => void;
  /** マイルストーンを閉じた（マイルストーンの一覧を読み直す） */
  onMilestoneClosed: () => void;
  onClose: () => void;
}

const MANUAL = (tag: string) => tr("## {tag}\n\n### 新しい機能\n- \n\n### 直した不具合\n- \n", { tag });
const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** ＋ リリースを作る: マイルストーンの閉じた Issue から（か GitHub のプルリクから・自分で書く）ノートを作り、タグを付けて、ファイルを添える */
export function CreateReleaseDialog({ owner, repo, info, releases, onCreated, onMilestoneClosed, onClose }: CreateReleaseDialogProps) {
  const [source, setSource] = useState<Source>("milestone");
  const [milestones, setMilestones] = useState<ReleaseMilestone[] | null>(null);
  const [milestone, setMilestone] = useState<number | null>(null);
  const [issues, setIssues] = useState<MilestoneIssue[] | null>(null);
  const previousDefault = releases.find((r) => !r.draft && !r.prerelease)?.tag_name ?? releases.find((r) => !r.draft)?.tag_name ?? "";
  const [tag, setTag] = useState("");
  const [target, setTarget] = useState(info.default_branch);
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [previous, setPrevious] = useState(previousDefault);
  const [draft, setDraft] = useState(false);
  const [prerelease, setPrerelease] = useState(false);
  const [latest, setLatest] = useState(true);
  const [files, setFiles] = useState<string[]>([]);
  const [closeMs, setCloseMs] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 自動で入れた値（自分で書き換えたら、上書きしない）
  const auto = useRef({ tag: "", name: "", body: "" });

  useEffect(() => {
    releaseMilestones(owner, repo)
      .then((m) => {
        setMilestones(m);
        // 版の名前のマイルストーンのうち、まだ開いているもの（なければいちばん新しく閉じたもの）
        const versions = m.filter((x) => tagFromMilestone(x.title));
        const pick = versions.find((x) => x.state === "open" && x.closed_issues > 0) ?? versions[0] ?? m[0];
        if (pick) setMilestone(pick.number);
        else setSource("github");
      })
      .catch(() => {
        setMilestones([]);
        setSource("github");
      });
  }, [owner, repo]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (isEscape(e) && !busy) onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose]);

  // 自動の値を入れる（自分で書き換えていなければ）
  function fill(next: { tag?: string; name?: string; body?: string }) {
    if (next.tag !== undefined && tag === auto.current.tag) {
      auto.current.tag = next.tag;
      setTag(next.tag);
    }
    if (next.name !== undefined && name === auto.current.name) {
      auto.current.name = next.name;
      setName(next.name);
    }
    if (next.body !== undefined && body === auto.current.body) {
      auto.current.body = next.body;
      setBody(next.body);
    }
  }

  const ms = milestones?.find((m) => m.number === milestone) ?? null;
  useEffect(() => {
    if (source !== "milestone" || !ms) return;
    setIssues(null);
    let alive = true;
    milestoneClosedIssues(owner, repo, ms.number)
      .then((list) => {
        if (!alive) return;
        setIssues(list);
        const t = tagFromMilestone(ms.title) || tag;
        fill({ tag: t, name: `${repo} ${t || ms.title}`, body: notesFromIssues(list, ms.title) });
      })
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, milestone, milestones]);

  useEffect(() => {
    if (source === "manual") fill({ body: MANUAL(tag || tr("新しい版")) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  async function fromGitHub() {
    setBusy(tr("GitHub がノートを作っています…"));
    setError(null);
    try {
      const notes = await generateReleaseNotes(owner, repo, tag.trim(), target, previous || null);
      auto.current.body = notes.body;
      setBody(notes.body);
      if (!name.trim()) setName(notes.name);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function pickFiles() {
    const picked = await openDialog({ multiple: true, directory: false, title: tr("リリースに添えるファイルを選ぶ（setup.exe・latest.json など）") });
    const list = Array.isArray(picked) ? picked : picked ? [picked] : [];
    setFiles((f) => [...f, ...list.filter((p) => !f.includes(p))]);
  }

  const tagProblem = badTag(tag);
  const duplicate = releases.some((r) => r.tag_name === tag.trim());
  const canCreate = !tagProblem && !duplicate && !busy;
  const used = issues?.filter(releasable).length ?? 0;

  async function submit(button: HTMLElement) {
    setError(null);
    const warnings: string[] = [];
    try {
      setBusy(tr("リリースを作っています…"));
      const created = await createRelease(owner, repo, { tag: tag.trim(), target, name: name.trim() || tag.trim(), body, draft, prerelease, latest });
      const uploaded: ReleaseAsset[] = [];
      for (let i = 0; i < files.length; i++) {
        setBusy(tr("{baseName} を送っています（{v}/{length}）…", { baseName: baseName(files[i]), v: i + 1, length: files.length }));
        try {
          uploaded.push(await uploadReleaseAsset(owner, repo, created.id, files[i]));
        } catch (e) {
          warnings.push(String(e));
        }
      }
      const release: Release = { ...created, assets: [...created.assets.filter((a) => !uploaded.some((u) => u.id === a.id)), ...uploaded] };
      if (source === "milestone" && ms && ms.state === "open" && closeMs && !draft) {
        try {
          await closeMilestone(owner, repo, ms.number);
          onMilestoneClosed();
        } catch (e) {
          warnings.push(String(e));
        }
      }
      celebrateDone(release.tag_name, button, tr("{v} を{v2}", { v: release.name || release.tag_name, v2: draft ? tr("下書きにしました") : tr("出しました") }));
      onCreated(release, warnings);
    } catch (e) {
      setError(String(e));
      setBusy(null);
    }
  }

  return createPortal(
    <div className="palette-overlay git-dialog-back" onClick={() => !busy && onClose()}>
      <div className="git-dialog pr-ui pr-dialog rl-dialog" role="dialog" aria-modal="true" aria-label={tr("リリースを作る")} onClick={(e) => e.stopPropagation()}>
        <h3>{tr("🏷️ ＋ リリースを作る")}</h3>

        <div className="rl-sources" role="radiogroup" aria-label={tr("ノートのもと")}>
          <label className={source === "milestone" ? "on" : ""}>
            <input type="radio" checked={source === "milestone"} onChange={() => setSource("milestone")} disabled={milestones?.length === 0} />
            {tr("マイルストーンから")}
          </label>
          <label className={source === "github" ? "on" : ""}>
            <input type="radio" checked={source === "github"} onChange={() => setSource("github")} />
            {tr("GitHub のプルリクから")}
          </label>
          <label className={source === "manual" ? "on" : ""}>
            <input type="radio" checked={source === "manual"} onChange={() => setSource("manual")} />
            {tr("自分で書く")}
          </label>
        </div>

        {source === "milestone" && (
          <label>
            <span className="git-dialog-label">{tr("マイルストーン（閉じた Issue を種別: のラベルで「新しい機能」「直した不具合」に分けます）")}</span>
            <select className="select-sm" value={milestone ?? ""} onChange={(e) => setMilestone(Number(e.target.value))} disabled={!milestones}>
              {!milestones && <option value="">{tr("読み込んでいます…")}</option>}
              {milestones?.map((m) => (
                <option key={m.number} value={m.number}>
                  {m.title}（{m.state === "open" ? tr("開いている") : tr("閉じた")}{trx("・閉じた Issue {closed_issues}", { closed_issues: m.closed_issues })}{m.open_issues > 0 ? tr("・まだの Issue {open_issues}", { open_issues: m.open_issues }) : ""}）
                </option>
              ))}
            </select>
            {ms && ms.open_issues > 0 && <span className="mb-note">{trx("まだ終わっていない Issue が {open_issues} あります（ノートには入りません）", { open_issues: ms.open_issues })}</span>}
            {issues && <span className="muted">{trx("ノートに入れる Issue: {used}（予定なし・重複・メモ・ルーチンは入れません）", { used })}</span>}
          </label>
        )}

        <div className="pr-dialog-branches">
          <label>
            <span className="git-dialog-label">{tr("タグ（版の名前）")}</span>
            <input
              className="git-dialog-input"
              value={tag}
              onChange={(e) => {
                const next = e.target.value;
                // 題名を自分で書き換えていなければ、タグに合わせる
                if (name === auto.current.name) {
                  auto.current.name = `${repo} ${next.trim()}`;
                  setName(auto.current.name);
                }
                setTag(next);
              }}
              placeholder={tr("例: 1.0.0")}
            />
          </label>
          <span className="pr-dialog-arrow" aria-hidden="true">→</span>
          <label>
            <span className="git-dialog-label">{tr("付けるところ（このブランチの今のコミット）")}</span>
            <select className="select-sm" value={target} onChange={(e) => setTarget(e.target.value)}>
              {(info.branches.length > 0 ? info.branches : [info.default_branch]).map((b) => (
                <option key={b} value={b}>
                  {b}
                  {b === info.default_branch ? tr("（既定）") : ""}
                </option>
              ))}
            </select>
          </label>
        </div>
        {tag && tagProblem && <p className="git-dialog-error">{tagProblem}</p>}
        {duplicate && <p className="git-dialog-error">{trx("タグ {tag} のリリースはもうあります。", { tag })}</p>}

        <label>
          <span className="git-dialog-label">{tr("題名")}</span>
          <input className="git-dialog-input" value={name} onChange={(e) => setName(e.target.value)} placeholder={tr("例: {repo} 1.0.0", { repo })} />
        </label>
        {source === "github" && (
          <div className="rl-generate">
            <label>
              <span className="git-dialog-label">{tr("前の版（ここから今までのプルリクを並べます）")}</span>
              <select className="select-sm" value={previous} onChange={(e) => setPrevious(e.target.value)}>
                <option value="">{tr("（はじめから）")}</option>
                {releases
                  .filter((r) => !r.draft)
                  .map((r) => (
                    <option key={r.id} value={r.tag_name}>
                      {r.tag_name}
                    </option>
                  ))}
              </select>
            </label>
            <button type="button" className="btn-sm" disabled={!!tagProblem || busy !== null} onClick={fromGitHub}>
              {tr("GitHub にノートを作ってもらう")}
            </button>
          </div>
        )}
        <label>
          <span className="git-dialog-label">{tr("ノート（何が変わったか）")}</span>
          <textarea className="git-dialog-input pr-dialog-body" rows={9} value={body} onChange={(e) => setBody(e.target.value)} />
        </label>

        <div className="rl-files">
          <span className="git-dialog-label">{tr("添えるファイル（インストーラー・latest.json など）")}</span>
          {files.map((f) => (
            <span key={f} className="rl-file">
              📎 {baseName(f)}
              <button type="button" className="pr-reviewer-x" aria-label={tr("{baseName} を外す", { baseName: baseName(f) })} onClick={() => setFiles(files.filter((x) => x !== f))}>
                ×
              </button>
            </span>
          ))}
          <button type="button" className="btn-sm" disabled={busy !== null} onClick={pickFiles}>
            {tr("ファイルを選ぶ…")}
          </button>
        </div>

        <div className="rl-flags">
          <label>
            <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} /> {" "}{tr("下書き（まだ見せない）")}
          </label>
          <label>
            <input type="checkbox" checked={prerelease} onChange={(e) => setPrerelease(e.target.checked)} /> {" "}{tr("試用版（pre-release）")}
          </label>
          <label>
            <input type="checkbox" checked={latest && !draft && !prerelease} disabled={draft || prerelease} onChange={(e) => setLatest(e.target.checked)} /> {" "}{tr("最新にする")}
          </label>
          {source === "milestone" && ms?.state === "open" && (
            <label>
              <input type="checkbox" checked={closeMs && !draft} disabled={draft} onChange={(e) => setCloseMs(e.target.checked)} /> {" "}{trx("マイルストーン {title} を閉じる", { title: ms.title })}
            </label>
          )}
        </div>

        {busy && <p className="git-dialog-running">{busy}</p>}
        {error && <p className="git-dialog-error">{error}</p>}
        <div className="git-dialog-actions">
          <button type="button" className="btn-sm" disabled={busy !== null} onClick={onClose}>
            {tr("やめる")}
          </button>
          <button type="button" className="btn-primary" disabled={!canCreate} onClick={(e) => submit(e.currentTarget)}>
            {draft ? tr("下書きを作る") : tr("リリースする")}
          </button>
        </div>
      </div>
    </div>,
    document.querySelector("main.app") ?? document.body,
  );
}
