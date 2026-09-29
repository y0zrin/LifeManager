// リリース（一覧・作る・直す・ファイルを添える・ノートを作る）
import { invoke } from "@tauri-apps/api/core";
import type { Person } from "./pulls";

export interface ReleaseAsset {
  id: number;
  name: string;
  size: number;
  download_count: number;
  browser_download_url: string;
  content_type: string;
  created_at: string;
}

export interface Release {
  id: number;
  tag_name: string;
  name: string | null;
  body: string;
  draft: boolean;
  prerelease: boolean;
  /** GitHub の「最新」 */
  latest: boolean;
  created_at: string;
  published_at: string | null;
  author: Person | null;
  html_url: string;
  target_commitish: string;
  assets: ReleaseAsset[];
}

export interface ReleaseMilestone {
  number: number;
  title: string;
  state: "open" | "closed";
  open_issues: number;
  closed_issues: number;
  due_on: string | null;
  closed_at: string | null;
}

export interface MilestoneIssue {
  number: number;
  title: string;
  labels: string[];
  /** completed / not_planned / duplicate など */
  state_reason: string | null;
  assignees: string[];
  user: string;
  closed_at: string | null;
}

export const listReleases = (owner: string, repo: string) => invoke<Release[]>("list_releases", { owner, repo });
export const releaseMilestones = (owner: string, repo: string) => invoke<ReleaseMilestone[]>("release_milestones", { owner, repo });
export const milestoneClosedIssues = (owner: string, repo: string, number: number) =>
  invoke<MilestoneIssue[]>("milestone_closed_issues", { owner, repo, number });
export const generateReleaseNotes = (owner: string, repo: string, tag: string, target: string, previous: string | null) =>
  invoke<{ name: string; body: string }>("generate_release_notes", { owner, repo, tag, target, previous });
export const createRelease = (
  owner: string,
  repo: string,
  r: { tag: string; target: string; name: string; body: string; draft: boolean; prerelease: boolean; latest: boolean },
) => invoke<Release>("create_release", { owner, repo, ...r });
export const updateRelease = (
  owner: string,
  repo: string,
  id: number,
  change: { name?: string; body?: string; draft?: boolean; prerelease?: boolean; latest?: boolean },
) => invoke<Release>("update_release", { owner, repo, id, ...change });
export const uploadReleaseAsset = (owner: string, repo: string, releaseId: number, path: string) =>
  invoke<ReleaseAsset>("upload_release_asset", { owner, repo, releaseId, path });
export const closeMilestone = (owner: string, repo: string, number: number) => invoke<void>("close_milestone", { owner, repo, number });

/** 「4.9 MB」「820 KB」 */
export function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** タグに使えない名前か（git の決まり: 空白・~ ^ : ? * [ \ ・.. ・最後の . や / など） */
export function badTag(tag: string): string | null {
  const t = tag.trim();
  if (!t) return "タグの名前を入れてください";
  if (/[\s~^:?*[\\]/.test(t) || t.includes("..") || t.endsWith(".") || t.endsWith("/") || t.startsWith("-") || t.includes("@{")) {
    return "タグの名前に使えない文字があります（空白や ~ ^ : ? * [ \\ など）";
  }
  return null;
}

// Issue のラベル（種別:）で、ノートの見出しを分ける
const FEATURE_LABELS = ["種別:イシュー", "種別:機能", "enhancement", "feature"];
const FIX_LABELS = ["種別:バグ", "bug"];
// リリースノートに入れないもの（メモ・ルーチンで自動に作ったもの）
const SKIP_LABELS = ["種別:メモ", "種別:ルーチン"];

/** リリースノートに入れる Issue（予定なし・重複で閉じたもの、メモ・ルーチンは入れない） */
export const releasable = (i: MilestoneIssue) =>
  i.state_reason !== "not_planned" && i.state_reason !== "duplicate" && !i.labels.some((l) => SKIP_LABELS.includes(l));

/**
 * マイルストーンの閉じた Issue から、リリースノートを作る。
 * 新しい機能（種別:イシュー など）・直した不具合（種別:バグ など）・そのほか に分け、最後に手伝った人（担当、なければ作った人）
 */
export function notesFromIssues(issues: MilestoneIssue[], milestone: string): string {
  const list = issues.filter(releasable).sort((a, b) => a.number - b.number);
  const features = list.filter((i) => i.labels.some((l) => FEATURE_LABELS.includes(l)));
  const fixes = list.filter((i) => !features.includes(i) && i.labels.some((l) => FIX_LABELS.includes(l)));
  const others = list.filter((i) => !features.includes(i) && !fixes.includes(i));
  const section = (title: string, items: MilestoneIssue[]) => (items.length ? `### ${title}\n${items.map((i) => `- ${i.title} (#${i.number})`).join("\n")}\n` : "");
  const people = [...new Set(list.flatMap((i) => (i.assignees.length > 0 ? i.assignees : [i.user])))];
  const parts = [
    `## ${milestone}`,
    "",
    section("新しい機能", features),
    section("直した不具合", fixes),
    section("そのほか", others),
    people.length ? `ありがとう: ${people.map((p) => `@${p}`).join("・")}` : "",
  ];
  return parts.filter((p, i) => p !== "" || i === 1).join("\n").trim() + "\n";
}

/** マイルストーンの名前が版の名前（0.9.0・v1.2 など）なら、それをタグの候補にする */
export const tagFromMilestone = (title: string) => (/^v?\d+(\.\d+)*([-.][0-9A-Za-z.]+)?$/.test(title.trim()) ? title.trim() : "");
