// ヒストリー: リポジトリで起きたこと（チームの動き）と、「あなたがすること」（GitHub の通知の代わり）。
// GitHub の通知（ベル）そのものは、GitHub の決まりで App の鍵では読めないので、Issue・プルリク・Actions から集める
import { invoke } from "@tauri-apps/api/core";
import type { GitHubIssue } from "./types";
import type { Verdicts } from "./pulls";
import type { CheckSummary, Stack } from "./actions";
import { daysUntil, dueOf } from "./due";
import { countOf } from "./count";

export interface ActivityEvent {
  id: string;
  /** PushEvent / PullRequestEvent / IssuesEvent / IssueCommentEvent / CreateEvent / ReleaseEvent など */
  type: string;
  actor: string;
  at: string;
  action: string | null;
  ref?: string | null;
  size?: number | null;
  commits?: { sha: string; message: string }[];
  number?: number | null;
  title?: string | null;
  merged?: boolean;
  review_state?: string | null;
  body?: string | null;
  /** コメントで「@名前」と呼ばれた人（小文字。本文まるごとから数えたもの。body は頭しかないことがある） */
  mentions?: string[] | null;
  /** コメントの番号（コメントは id も「c番号」。最近のコメントの一覧から拾ったものと、同じものになる） */
  comment_id?: number | null;
  pull?: boolean;
  state_reason?: string | null;
  assignee?: string | null;
  label?: string | null;
  ref_type?: string | null;
  prerelease?: boolean | null;
  member?: string | null;
}

export interface ActivityPull {
  number: number;
  title: string;
  user: string;
  draft: boolean;
  head_sha: string;
  updated_at: string;
  requested_reviewers: string[];
}

export interface ActivityFeed {
  events: ActivityEvent[];
  /** 開いているプルリク（プルリクの権限がなければ null） */
  pulls: ActivityPull[] | null;
}

export const activityFeed = (owner: string, repo: string) => invoke<ActivityFeed>("activity_feed", { owner, repo });

/** 文の一部: 文字か、押せる Issue・プルリクの番号 */
export type Part = string | { kind: "issue" | "pull"; number: number; title?: string | null };

export type ActivityKind = "issue" | "pull" | "push" | "release" | "other";

export const KIND_LABELS: Record<ActivityKind, string> = {
  issue: "Issue",
  pull: "プルリク",
  push: "プッシュ",
  release: "リリース・タグ",
  other: "そのほか",
};

export function kindOf(e: ActivityEvent): ActivityKind {
  if (e.type === "PushEvent") return "push";
  if (e.type.startsWith("PullRequest")) return "pull";
  if (e.type === "IssuesEvent" || e.type === "IssueCommentEvent") return e.pull ? "pull" : "issue";
  if (e.type === "ReleaseEvent" || (e.type === "CreateEvent" && e.ref_type === "tag")) return "release";
  return "other";
}

export interface Described {
  icon: string;
  parts: Part[];
  /** 下に小さく（コメントの初め） */
  detail?: string;
  commits?: { sha: string; message: string }[];
}

const ref = (e: ActivityEvent, pull = !!e.pull): Part => ({ kind: pull ? "pull" : "issue", number: e.number ?? 0, title: e.title });

/** 起きたこと 1 つを、日本語の文にする（出さないものは null） */
export function describe(e: ActivityEvent): Described | null {
  switch (e.type) {
    case "PushEvent": {
      // 今の GitHub はコミットの数を入れないので、比べて足せなかったときは数を出さない
      const count = e.size ?? (e.commits?.length || null);
      return { icon: "⬆", parts: [count ? `が ${e.ref} に ${count} コミットをプッシュ` : `が ${e.ref} にプッシュしました`], commits: e.commits ?? [] };
    }
    case "PullRequestEvent": {
      const r = ref(e, true);
      if (e.action === "opened") return { icon: "🔃", parts: ["がプルリク ", r, " を作りました"] };
      // マージは、前は closed と merged、今の GitHub は merged で来る
      if (e.action === "merged" || (e.action === "closed" && e.merged)) return { icon: "🟣", parts: ["が ", r, " をマージしました"] };
      if (e.action === "closed") return { icon: "🔴", parts: ["がプルリク ", r, " を閉じました"] };
      if (e.action === "reopened") return { icon: "🟢", parts: ["がプルリク ", r, " を開き直しました"] };
      if (e.action === "ready_for_review") return { icon: "📣", parts: ["が ", r, " をレビューをお願いできる状態にしました"] };
      return null;
    }
    case "PullRequestReviewEvent": {
      const r = ref(e, true);
      if (e.review_state === "approved") return { icon: "✔", parts: ["が ", r, " を承認しました"] };
      if (e.review_state === "changes_requested") return { icon: "✏️", parts: ["が ", r, " に修正を依頼しました"] };
      return { icon: "💬", parts: ["が ", r, " をレビューしました"] };
    }
    case "PullRequestReviewCommentEvent":
      return { icon: "💬", parts: ["が ", ref(e, true), " の行にコメントしました"], detail: e.body ?? undefined };
    case "IssuesEvent": {
      const r = ref(e);
      if (e.action === "opened") return { icon: "📝", parts: ["が ", r, " を作りました"] };
      if (e.action === "closed") {
        if (e.state_reason === "not_planned") return { icon: "⊘", parts: ["が ", r, " を閉じました（予定なし）"] };
        if (e.state_reason === "duplicate") return { icon: "⊘", parts: ["が ", r, " を閉じました（重複）"] };
        return { icon: "✅", parts: ["が ", r, " を完了にしました"] };
      }
      if (e.action === "reopened") return { icon: "↺", parts: ["が ", r, " を開き直しました"] };
      if (e.action === "assigned" && e.assignee) return { icon: "👤", parts: ["が ", r, ` の担当を ${e.assignee} にしました`] };
      return null;
    }
    case "IssueCommentEvent":
      if (e.action !== "created") return null;
      return { icon: "💬", parts: ["が ", ref(e), " にコメントしました"], detail: e.body ?? undefined };
    case "CreateEvent":
      if (e.ref_type === "branch") return { icon: "🌿", parts: [`がブランチ ${e.ref} を作りました`] };
      if (e.ref_type === "tag") return { icon: "🏷️", parts: [`がタグ ${e.ref} を付けました`] };
      if (e.ref_type === "repository") return { icon: "📦", parts: ["がリポジトリを作りました"] };
      return null;
    case "DeleteEvent":
      return { icon: "🗑", parts: [`が${e.ref_type === "tag" ? "タグ" : "ブランチ"} ${e.ref} を消しました`] };
    case "ReleaseEvent":
      if (e.action !== "published") return null;
      return { icon: "🏷️", parts: [`が${e.prerelease ? "試用版" : "リリース"} ${e.title ?? e.ref} を出しました`] };
    case "MemberEvent":
      return e.action === "added" ? { icon: "👥", parts: [`が ${e.member} をメンバーに入れました`] } : null;
    case "ForkEvent":
      return { icon: "🍴", parts: ["がフォークしました"] };
    case "WatchEvent":
      return { icon: "⭐", parts: ["がスターを付けました"] };
    default:
      return null;
  }
}

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

/** 「今日」「きのう」「9/27（土）」 */
export function dayLabel(iso: string, today = new Date()): string {
  const d = new Date(iso);
  const days = daysUntil(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`, today);
  if (days === 0) return "今日";
  if (days === -1) return "きのう";
  return `${d.getMonth() + 1}/${d.getDate()}（${WEEKDAYS[d.getDay()]}）`;
}

/** 「14:02」 */
export const timeOf = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

// --- あなたがすること ---

/** 「助けを求める」のコメントの印（GitHub の画面では見えない）と、その解決の印 */
export const HELP_MARK = "<!-- lm:help -->";
export const HELP_DONE_MARK = "<!-- lm:help-done -->";

export interface Todo {
  /** 見た印の鍵（中身が変わると鍵も変わり、また出る） */
  key: string;
  icon: string;
  tone: "ng" | "warn" | "ok" | "";
  parts: Part[];
  detail?: string;
  at: string | null;
  /** 押すと開くもの */
  target: { kind: "pull" | "issue"; number: number } | { kind: "run"; runId: number };
  /** 並べる順（小さいほど上） */
  order: number;
}

const MENTION_DAYS = 14;

const same = (a: string | null | undefined, b: string) => !!a && a.toLowerCase() === b.toLowerCase();

/**
 * 「あなたがすること」を集める:
 * 自分のプルリクのチェックの失敗・修正を頼まれた、レビューを頼まれた、担当の Issue の期限（3 日以内・過ぎた）、
 * 自分のプルリクが承認された（マージできる）、自分がプッシュしたブランチの Actions の失敗、名前を呼ばれた・担当になった（14 日以内）
 */
export function buildTodos(o: {
  me: string;
  pulls: ActivityPull[] | null;
  verdicts: Record<string, Verdicts>;
  checks: Record<string, CheckSummary>;
  issues: GitHubIssue[];
  events: ActivityEvent[];
  stack: Stack | null;
  now?: number;
}): Todo[] {
  const { me } = o;
  if (!me) return [];
  const now = o.now ?? Date.now();
  const out: Todo[] = [];
  const pr = (p: ActivityPull): Part => ({ kind: "pull", number: p.number, title: p.title });

  for (const p of o.pulls ?? []) {
    if (!same(p.user, me) && p.requested_reviewers.some((r) => same(r, me))) {
      out.push({ key: `review:${p.number}:${p.updated_at}`, icon: "👀", tone: "", parts: [pr(p), " のレビューを頼まれています"], at: p.updated_at, target: { kind: "pull", number: p.number }, order: 2 });
    }
    if (!same(p.user, me)) continue;
    const ck = o.checks[p.head_sha];
    if (ck && ck.failure > 0) {
      out.push({ key: `checks:${p.number}:${p.head_sha}`, icon: "✖", tone: "ng", parts: ["あなたのプルリク ", pr(p), ` のチェックが ${countOf(ck.failure, "件")}失敗しています`], at: p.updated_at, target: { kind: "pull", number: p.number }, order: 0 });
    }
    const v = o.verdicts[String(p.number)];
    if (v && v.changes_requested.length > 0) {
      out.push({ key: `changes:${p.number}:${p.updated_at}`, icon: "✏️", tone: "warn", parts: [pr(p), ` で修正を頼まれています（${v.changes_requested.join("、")}）`], at: p.updated_at, target: { kind: "pull", number: p.number }, order: 1 });
    } else if (v && v.approved.length > 0 && !p.draft && !(ck && ck.failure > 0)) {
      out.push({ key: `approved:${p.number}:${p.updated_at}`, icon: "✔", tone: "ok", parts: [pr(p), ` が承認されました（${v.approved.join("、")}）。マージできます`], at: p.updated_at, target: { kind: "pull", number: p.number }, order: 4 });
    }
  }

  for (const i of o.issues) {
    if (!i.assignees.some((a) => same(a.login, me))) continue;
    const due = dueOf(i);
    if (!due) continue;
    const days = daysUntil(due.date, new Date(now));
    if (days > 3) continue;
    const ref: Part = { kind: "issue", number: i.number, title: i.title };
    const when = days < 0 ? ` の期限が ${-days} 日過ぎています` : days === 0 ? " の期限が今日です" : days === 1 ? " の期限が明日です" : ` の期限まであと ${days} 日です`;
    // もうすぐ・今日・過ぎた、の段階ごとに鍵を変える（段階が変わると、また出る・また知らせる）
    const stage = days < 0 ? "over" : days === 0 ? "today" : "soon";
    out.push({ key: `due:${i.number}:${due.date}:${stage}`, icon: "📅", tone: days < 0 ? "ng" : days <= 1 ? "warn" : "", parts: ["担当の ", ref, when], at: null, target: { kind: "issue", number: i.number }, order: days < 0 ? 1 : 3 });
  }

  for (const c of o.stack?.cards ?? []) {
    if (c.kind !== "run" || !c.run || c.level > 3 || c.pull) continue;
    if (!same(c.run.actor?.login, me)) continue;
    out.push({ key: `run:${c.key}:${c.run.id}`, icon: "✖", tone: "ng", parts: [`${c.run.branch} の ${c.run.name} が失敗しています（あなたのプッシュ）`], at: c.run.created_at, target: { kind: "run", runId: c.run.id }, order: 5 });
  }

  // 名前を呼ばれたか: GitHub から読んだものは、本文まるごとから数えた mentions で。ないときは本文から
  // （メールアドレス bob@alice.com や、チームの @org/team は、人を呼んだとしない）
  const meLower = me.toLowerCase();
  const mention = new RegExp(`(?<![\\w/.@-])@${me.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w/-])`, "i");
  const mentionsMe = (e: ActivityEvent) => (e.mentions ? e.mentions.includes(meLower) : !!e.body && mention.test(e.body));
  // 🆘 が、あとの「解決しました」で片付いているか（Issue ごとの、いちばん新しい解決の時刻）
  const doneAt = new Map<number, string>();
  for (const e of o.events) {
    if (e.type === "IssueCommentEvent" && e.number && e.body?.includes(HELP_DONE_MARK) && (doneAt.get(e.number) ?? "") < e.at) doneAt.set(e.number, e.at);
  }
  for (const e of o.events) {
    if (same(e.actor, me) || now - Date.parse(e.at) > MENTION_DAYS * 86400000 || !e.number) continue;
    const target = { kind: (e.pull || e.type.startsWith("PullRequest") ? "pull" : "issue") as "pull" | "issue", number: e.number };
    const ref: Part = { kind: target.kind, number: e.number, title: e.title };
    // コメントは、書いたとき（created）だけ。直した・消したで、また知らせない
    const isComment = (e.type === "IssueCommentEvent" || e.type === "PullRequestReviewCommentEvent") && (!e.action || e.action === "created");
    if (isComment && e.body && mentionsMe(e)) {
      // 助けを求める（🆘）と、その解決（✅）は、名前を呼ばれたとは別に、目立つように。あとで解決になった 🆘 は出さない
      if (e.body.includes(HELP_MARK)) {
        if ((doneAt.get(e.number) ?? "") > e.at) continue;
        out.push({ key: `help:${e.id}`, icon: "🆘", tone: "ng", parts: [`${e.actor} が助けを求めています ・ `, ref], detail: e.body, at: e.at, target, order: -1 });
      } else if (e.body.includes(HELP_DONE_MARK)) {
        out.push({ key: `helped:${e.id}`, icon: "✅", tone: "ok", parts: [`${e.actor} が 🆘 を解決にしました ・ `, ref], detail: e.body, at: e.at, target, order: 6 });
      } else {
        out.push({ key: `mention:${e.id}`, icon: "💬", tone: "", parts: [`${e.actor} が `, ref, " であなたの名前を出しました"], detail: e.body, at: e.at, target, order: 6 });
      }
    }
    if (e.type === "IssuesEvent" && e.action === "assigned" && same(e.assignee, me)) {
      out.push({ key: `assigned:${e.id}`, icon: "👤", tone: "", parts: [`${e.actor} が `, ref, " の担当をあなたにしました"], at: e.at, target, order: 7 });
    }
  }

  return out.sort((a, b) => a.order - b.order || (b.at ?? "").localeCompare(a.at ?? ""));
}
