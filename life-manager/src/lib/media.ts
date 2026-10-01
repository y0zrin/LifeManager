// メディアビューワー: ファイルの種類・中身の読み方（この PC の作業フォルダ・この PC の git・GitHub）・スプライトシートの分け方の推測
import { invoke } from "@tauri-apps/api/core";

export type MediaKind = "image" | "audio" | "video" | "model" | "code" | "text" | "csv" | "markdown" | "html" | "pdf" | "other";

const EXT_KIND: Record<string, MediaKind> = {};
function kinds(kind: MediaKind, exts: string) {
  for (const e of exts.split(" ")) EXT_KIND[e] = kind;
}
kinds("image", "png jpg jpeg gif webp bmp svg ico avif");
kinds("audio", "wav mp3 ogg oga flac m4a aac opus");
kinds("video", "mp4 webm m4v ogv mov");
kinds("model", "glb gltf obj fbx stl");
kinds("code", "c h cpp cc cxx hpp hh hxx cs java js mjs cjs ts tsx jsx go rs kt kts swift py rb php lua glsl vert frag hlsl shader cginc compute json jsonc yaml yml toml xml xaml uxml uss ini cfg conf sh bash zsh bat cmd ps1 cmake gradle css scss less sql vue svelte");
kinds("text", "txt log gitignore gitattributes editorconfig env");
kinds("csv", "csv tsv");
kinds("markdown", "md markdown");
kinds("html", "html htm");
kinds("pdf", "pdf");

/** ファイルの名前（パスの最後）と拡張子 */
export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function extOf(path: string): string {
  const name = baseName(path).toLowerCase();
  if (name.startsWith(".") && !name.slice(1).includes(".")) return name.slice(1);
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1) : name === "makefile" || name === "dockerfile" ? "sh" : "";
}

export function kindOf(path: string): MediaKind {
  return EXT_KIND[extOf(path)] ?? "other";
}

export const KIND_LABELS: Record<MediaKind, string> = {
  image: "画像",
  audio: "音",
  video: "動画",
  model: "3D",
  code: "コード",
  text: "テキスト",
  csv: "表",
  markdown: "テキスト",
  html: "HTML",
  pdf: "PDF",
  other: "そのほか",
};

export const KIND_ICONS: Record<MediaKind, string> = {
  image: "🖼",
  audio: "🔊",
  video: "🎬",
  model: "🧊",
  code: "📄",
  text: "📝",
  csv: "📊",
  markdown: "📝",
  html: "🌐",
  pdf: "📕",
  other: "📦",
};

/** 一覧でまとめる順（画像 → 音 → 動画 → 3D → コード・テキスト → そのほか） */
export const KIND_GROUPS: { label: string; kinds: MediaKind[] }[] = [
  { label: "画像", kinds: ["image"] },
  { label: "音", kinds: ["audio"] },
  { label: "動画", kinds: ["video"] },
  { label: "3D", kinds: ["model"] },
  { label: "コード・テキスト", kinds: ["code", "text", "markdown", "csv", "html", "pdf"] },
  { label: "そのほか", kinds: ["other"] },
];

/** 画像・音・動画の MIME（Blob に付ける） */
const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
  svg: "image/svg+xml", ico: "image/x-icon", avif: "image/avif",
  wav: "audio/wav", mp3: "audio/mpeg", ogg: "audio/ogg", oga: "audio/ogg", flac: "audio/flac", m4a: "audio/mp4", aac: "audio/aac", opus: "audio/ogg",
  mp4: "video/mp4", webm: "video/webm", m4v: "video/mp4", ogv: "video/ogg", mov: "video/quicktime",
  pdf: "application/pdf", glb: "model/gltf-binary", gltf: "model/gltf+json",
};

export function mimeOf(path: string): string {
  return MIME[extOf(path)] ?? "application/octet-stream";
}

/** どこから読むか: この PC の作業フォルダの今の中身か、コミットの時点（この PC の git にあればそこから、なければ GitHub から） */
export type MediaSource =
  | { kind: "local"; folder: string }
  | { kind: "commit"; sha: string; folder?: string; owner?: string; repo?: string };

export interface MediaFile {
  path: string;
  source: MediaSource;
  /** added / modified / removed / renamed（コミットから開いたとき） */
  status?: string;
  additions?: number | null;
  deletions?: number | null;
  /** 見出しに出すコミットの説明（「a1b2c3d ジャンプを入れる #11 ・ 佐藤 ・ 3 時間前」） */
  commitLabel?: string;
}

/**
 * コミットの時点の中身は、あとから変わらないので、小さいものを少しだけ覚えておく（成果物のタブを開くたびの見本・ビューワーで、
 * GitHub に同じファイルを何度も聞かない）。古く使ったものから忘れる。作業フォルダの今の中身は変わるので覚えない
 */
const MEMO_BYTES = 48 * 1024 * 1024;
const MEMO_ONE = 8 * 1024 * 1024;
const memo = new Map<string, ArrayBuffer>();
let memoBytes = 0;

function remember(key: string, bytes: ArrayBuffer) {
  if (bytes.byteLength > MEMO_ONE || memo.has(key)) return;
  memo.set(key, bytes);
  memoBytes += bytes.byteLength;
  for (const [k, b] of memo) {
    if (memoBytes <= MEMO_BYTES) break;
    memo.delete(k);
    memoBytes -= b.byteLength;
  }
}

/** ファイルの中身（バイト列） */
export async function readMediaBytes(file: MediaFile): Promise<ArrayBuffer> {
  const s = file.source;
  if (s.kind === "local") return invoke<ArrayBuffer>("media_read_local", { path: s.folder, file: file.path });
  const key = `${s.owner ?? ""}/${s.repo ?? ""}|${s.folder ?? ""}@${s.sha}|${file.path}`;
  const known = memo.get(key);
  if (known) {
    // 使ったものは新しい側へ（古く使ったものから忘れる）
    memo.delete(key);
    memo.set(key, known);
    return known;
  }
  const bytes = await readCommitBytes(file, s);
  remember(key, bytes);
  return bytes;
}

async function readCommitBytes(file: MediaFile, s: Extract<MediaSource, { kind: "commit" }>): Promise<ArrayBuffer> {
  if (s.folder) {
    try {
      return await invoke<ArrayBuffer>("media_read_commit", { path: s.folder, sha: s.sha, file: file.path });
    } catch (e) {
      // この PC の git にそのコミットがない（まだ取ってきていない）ときは GitHub から。LFS・大きすぎるとき・GitHub を知らないときは、そのまま知らせる
      const msg = String(e);
      if (msg.includes("LFS") || msg.includes("大きすぎる") || !s.owner || !s.repo) throw e;
    }
  }
  if (!s.owner || !s.repo) throw new Error("ファイルを読む場所がありません");
  return invoke<ArrayBuffer>("media_read_github", { owner: s.owner, repo: s.repo, sha: s.sha, file: file.path });
}

/** 中身を、画像・音などで使える URL に（使い終わったら URL.revokeObjectURL） */
export function blobUrl(bytes: ArrayBuffer, path: string): string {
  return URL.createObjectURL(new Blob([bytes], { type: mimeOf(path) }));
}

/** 「1.2 MB」「35 KB」 */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 文字として読む（UTF-8。だめなら Shift_JIS。Windows で作ったテキストのため） */
export function decodeText(bytes: ArrayBuffer): string {
  const u8 = new Uint8Array(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(u8).replace(/^﻿/, "");
  } catch {
    try {
      return new TextDecoder("shift_jis").decode(u8);
    } catch {
      return new TextDecoder("utf-8").decode(u8);
    }
  }
}

/** 文字のファイルか（0 のバイトがないか。はじめの 8KB を見る） */
export function looksLikeText(bytes: ArrayBuffer): boolean {
  const u8 = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 8192));
  return !u8.includes(0);
}

/**
 * スプライトシートの分け方の推測: 横長・縦長の帯で、長いほうが短いほうの整数倍（3 コマ以上、または 2 コマで小さなコマ）なら、正方形のコマ。
 * それ以外（ふつうの横長の絵・格子）は null（ボタンでスプライトシートにして、自分で分け方を決める）
 */
export function guessSprite(width: number, height: number): { cols: number; rows: number } | null {
  if (width <= 0 || height <= 0) return null;
  const strip = (long: number, short: number) => long % short === 0 && long / short <= 64 && (long / short >= 3 || (long / short === 2 && short <= 64));
  if (width > height && strip(width, height)) return { cols: width / height, rows: 1 };
  if (height > width && strip(height, width)) return { cols: 1, rows: height / width };
  return null;
}

/** スプライトシートにしたときの、はじめの分け方（推測できないとき。横長なら横に、縦長なら縦に並べる） */
export function defaultSprite(width: number, height: number): { cols: number; rows: number } {
  const guess = guessSprite(width, height);
  if (guess) return guess;
  if (width > height) return { cols: Math.max(1, Math.round(width / height)), rows: 1 };
  if (height > width) return { cols: 1, rows: Math.max(1, Math.round(height / width)) };
  return { cols: 1, rows: 1 };
}

/** CSV・TSV を表に（引用符の中のカンマ・改行も） */
export function parseCsv(text: string, sep: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"' && cell === "") {
      quoted = true;
    } else if (c === sep) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}
