import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { showCommit, showGitHubCommit } from "../../lib/git";
import { ago } from "../../lib/pulls";
import { baseName, blobUrl, guessSprite, KIND_GROUPS, KIND_ICONS, KIND_LABELS, kindOf, readMediaBytes, type MediaFile } from "../../lib/media";
import { patchFor } from "../../lib/showFiles";
import { MediaViewer } from "./MediaViewer";

interface ArtifactCommit {
  sha: string;
  message: string;
  author: string;
  date: string;
  pull: number | null;
  local: boolean;
}

interface ArtifactFile {
  path: string;
  status: string;
  previous: string | null;
  additions: number | null;
  deletions: number | null;
  sha: string;
  commits: number;
}

interface Artifacts {
  commits: ArtifactCommit[];
  files: ArtifactFile[];
}

interface ArtifactsTabProps {
  owner: string;
  repo: string;
  number: number;
  /** この PC の作業フォルダ（あれば、この PC の git からも探す・読む） */
  folder?: string;
  /** 見つかったファイルの数（タブの数） */
  onCount?: (n: number) => void;
}

/** 縮めて見せる画像の数（GitHub から読むことがあるので、はじめのいくつかだけ） */
const MAX_THUMBS = 12;

/** 画像の見本（読み込んで縮める。スプライトシートらしければ印） */
function Thumb({ file }: { file: MediaFile }) {
  const [url, setUrl] = useState<string | null>(null);
  const [sprite, setSprite] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    let made: string | null = null;
    readMediaBytes(file)
      .then((b) => {
        if (!alive) return;
        made = blobUrl(b, file.path);
        setUrl(made);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [file]);
  if (failed || !url) return <span className="af-thumb-icon" aria-hidden="true">{failed ? "🖼" : "…"}</span>;
  return (
    <>
      <img className="af-thumb-img" src={url} alt="" onLoad={(e) => setSprite(!!guessSprite(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight))} />
      {sprite && <span className="af-kind sprite">スプライト</span>}
    </>
  );
}

/**
 * Issue の詳細の「成果物」: その Issue につながるコミット（メッセージで #11 に触れた・その Issue に触れたプルリクのコミットなど）で
 * 変わったファイルを、種類ごとに見本つきで並べる。押すとメディアビューワー
 */
export function ArtifactsTab({ owner, repo, number, folder, onCount }: ArtifactsTabProps) {
  const [data, setData] = useState<Artifacts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // 鳴らしている音の URL（止めたら返す）と、最後に押した ▶ の番号（読むあいだに別の ▶ を押したら、前のは鳴らさない）
  const audioUrl = useRef<string | null>(null);
  const playToken = useRef(0);
  const shows = useRef(new Map<string, Promise<string>>());

  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    invoke<Artifacts>("issue_artifacts", { owner, repo, number, folder: folder ?? null })
      .then((d) => {
        if (!alive) return;
        setData(d);
        onCount?.(d.files.length);
      })
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, repo, number, folder]);

  useEffect(() => () => stopAudio(), []);

  const commitOf = useMemo(() => new Map((data?.commits ?? []).map((c) => [c.sha, c])), [data]);

  // 種類ごとの並び（画像 → 音 → … → そのほか）
  const files: MediaFile[] = useMemo(() => {
    const list = data?.files ?? [];
    const ordered: ArtifactFile[] = [];
    for (const g of KIND_GROUPS) ordered.push(...list.filter((f) => g.kinds.includes(kindOf(f.path))));
    return ordered.map((f) => {
      const c = commitOf.get(f.sha);
      return {
        path: f.path,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        source: { kind: "commit" as const, sha: f.sha, folder, owner, repo },
        commitLabel: c ? `${c.sha.slice(0, 7)} ${c.message}${c.author ? ` ・ ${c.author}` : ""}${c.date ? ` ・ ${ago(c.date)}` : ""}` : f.sha.slice(0, 7),
      };
    });
  }, [data, commitOf, folder, owner, repo]);

  // コードの「このコミットの変更」: そのコミットの中身を読んで、そのファイルの差分を取り出す
  const loadPatch = useCallback(
    async (file: MediaFile) => {
      if (file.source.kind !== "commit") return null;
      const sha = file.source.sha;
      const local = commitOf.get(sha)?.local && folder;
      const key = `${local ? "local" : "github"}|${sha}`;
      let show = shows.current.get(key);
      if (!show) {
        show = (local ? showCommit(folder!, sha) : showGitHubCommit(owner, repo, sha)).then((r) => r.output);
        shows.current.set(key, show);
      }
      return patchFor(await show, file.path);
    },
    [commitOf, folder, owner, repo],
  );

  function stopAudio() {
    audioRef.current?.pause();
    audioRef.current = null;
    if (audioUrl.current) URL.revokeObjectURL(audioUrl.current);
    audioUrl.current = null;
  }

  async function playAudio(file: MediaFile) {
    const token = ++playToken.current;
    const again = playing === file.path;
    stopAudio();
    if (again) {
      setPlaying(null);
      return;
    }
    setPlaying(file.path);
    try {
      const bytes = await readMediaBytes(file);
      if (token !== playToken.current) return; // 読んでいるあいだに、別の ▶ を押した
      const url = blobUrl(bytes, file.path);
      const audio = new Audio(url);
      audioRef.current = audio;
      audioUrl.current = url;
      audio.onended = () => {
        if (token !== playToken.current) return;
        stopAudio();
        setPlaying(null);
      };
      await audio.play();
    } catch {
      if (token === playToken.current) setPlaying(null);
    }
  }

  if (error) return <p className="af-note error">成果物を探せませんでした: {error}</p>;
  if (!data) return <p className="af-note"><i className="spinner" aria-hidden="true" /> つながるコミットを探しています…</p>;
  if (data.commits.length === 0) {
    return (
      <div className="af-note">
        <p>この Issue につながるコミットはまだありません。</p>
        <p className="muted">コミットのメッセージに「#{number}」と書くと、そのコミットで変えたファイルがここに出ます（例: <code>git commit -m "ジャンプを入れる #{number}"</code>）。作業タブでこの Issue を選んでコミットすると、自動で付きます。</p>
      </div>
    );
  }

  let thumbs = 0;
  return (
    <div className="af">
      <div className="af-commits">
        <span className="muted">つながるコミット {data.commits.length}:</span>
        {data.commits.slice(0, 6).map((c) => (
          <span key={c.sha} className="af-commit" title={`${c.message}${c.author ? ` ・ ${c.author}` : ""}`}>
            <code>{c.sha.slice(0, 7)}</code> {c.message}
            {c.pull !== null && <span className="af-pull">🔃 #{c.pull}</span>}
          </span>
        ))}
        {data.commits.length > 6 && <span className="muted">ほか {data.commits.length - 6}</span>}
      </div>
      {files.length === 0 ? (
        <p className="af-note">つながるコミットで変わったファイルはありません。</p>
      ) : (
        <div className="af-grid">
          {files.map((f, i) => {
            const kind = kindOf(f.path);
            const removed = f.status === "removed";
            const showThumb = kind === "image" && !removed && thumbs++ < MAX_THUMBS;
            const detail =
              f.additions != null && f.deletions != null && (f.additions > 0 || f.deletions > 0)
                ? `+${f.additions} −${f.deletions}`
                : KIND_LABELS[kind];
            return (
              <div key={f.path} className={`af-card${removed ? " removed" : ""}`}>
                <button type="button" className="af-open" onClick={() => setOpen(i)} title={`${f.path} を見る`}>
                  <span className={`af-thumb k-${kind}`}>
                    <span className="af-kind">{KIND_LABELS[kind]}</span>
                    {showThumb ? <Thumb file={f} /> : <span className="af-thumb-icon" aria-hidden="true">{removed ? "🗑" : KIND_ICONS[kind]}</span>}
                  </span>
                  <span className="af-body">
                    <b>{baseName(f.path)}</b>
                    <small>
                      {detail}
                      <span className={`af-st st-${f.status}`}>{f.status === "added" ? "足した" : f.status === "removed" ? "消した" : f.status === "renamed" ? "名前を変えた" : "変えた"}</span>
                    </small>
                  </span>
                </button>
                {kind === "audio" && !removed && (
                  <button type="button" className={`af-play${playing === f.path ? " on" : ""}`} onClick={() => playAudio(f)} aria-label={playing === f.path ? "止める" : "鳴らす"}>
                    {playing === f.path ? "⏸" : "▶"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      {open !== null && (
        <MediaViewer files={files} start={open} title={`#${number} の成果物`} onClose={() => setOpen(null)} loadPatch={loadPatch} />
      )}
    </div>
  );
}
