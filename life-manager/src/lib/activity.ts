// ヒストリー: リポジトリで起きたこと（チームの動き）と、「あなたがすること」（GitHub の通知の代わり）。
// GitHub の通知（ベル）そのものは、GitHub の決まりで App の鍵では読めないので、Issue・プルリク・Actions から集める
import { invoke } from "./invoke";
import type { GitHubIssue, GitHubMilestone } from "./types";
import type { Verdicts } from "./pulls";
import type { CheckSummary, Stack } from "./actions";
import { daysUntil, dueOf } from "./due";
import { joinNames, tr, weekdayShort } from "./i18n";

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
  /** マイルストーンの達成（アプリが作る出来事。MILESTONE_EVENT）: 期限と、最後に終えたタスク */
  due_on?: string | null;
  last_task?: { number: number; title: string } | null;
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

/** 押せる Issue・プルリクの番号 */
export type RefPart = { kind: "issue" | "pull"; number: number; title?: string | null };
/** 文の一部: 文字か、押せる番号か、した人の名前（太字） */
export type Part = string | RefPart | { kind: "actor"; name: string };

/**
 * 文の形（日本語の鍵）を今の言語にして、{ref}・{actor} などの場所に Part を入れる（#256。語順が言語で変わっても崩れない）。
 * 文字と数の値は、そのまま文に入れる
 */
export function sentence(ja: string, vars: Record<string, string | number | Part> = {}): Part[] {
  const text: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(vars)) if (typeof v !== "object") text[k] = v;
  const s = tr(ja, text);
  const out: Part[] = [];
  for (const piece of s.split(/(\{\w+\})/)) {
    const m = /^\{(\w+)\}$/.exec(piece);
    const v = m ? vars[m[1]] : undefined;
    if (v && typeof v === "object") out.push(v);
    else if (piece) out.push(piece);
  }
  return out;
}

export type ActivityKind = "issue" | "pull" | "push" | "release" | "milestone" | "other";

export const KIND_LABELS: Record<ActivityKind, string> = {
  issue: "Issue",
  pull: tr("プルリク"),
  push: tr("プッシュ"),
  release: tr("リリース・タグ"),
  milestone: tr("マイルストーンの達成"),
  other: tr("そのほか"),
};

/** マイルストーンの達成。GitHub の出来事にはないので、アプリがマイルストーンとタスクから作る（milestoneEvents） */
export const MILESTONE_EVENT = "LmMilestoneAchieved";

export function kindOf(e: ActivityEvent): ActivityKind {
  if (e.type === MILESTONE_EVENT) return "milestone";
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
  /** 下に小さく、押せる番号つきで（マイルストーンの達成の、終えたタスクの数など） */
  sub?: Part[];
  commits?: { sha: string; message: string }[];
  /** 飾り: マイルストーンの達成（大きく）・タスクの完了・🆘（助けを求めた・答えた・解決した） */
  tone?: "milestone" | "done" | "help" | "answer" | "resolved";
}

/** 🆘 の流れの中での役: 助けを求めた・それに答えた（あとから同じ Issue に、ほかの人が書いた）・解決した */
export type HelpRole = { role: "ask" } | { role: "answer"; asker: string } | { role: "resolved" };

const ref = (e: ActivityEvent, pull = !!e.pull): RefPart => ({ kind: pull ? "pull" : "issue", number: e.number ?? 0, title: e.title });

/** 起きたこと 1 つを、今の言語の文にする（出さないものは null）。help は 🆘 の流れの中での役（helpRoles）。した人は {actor}（太字） */
export function describe(e: ActivityEvent, help?: HelpRole): Described | null {
  const actor: Part = { kind: "actor", name: e.actor };
  switch (e.type) {
    case MILESTONE_EVENT: {
      const left = e.due_on ? daysUntil(e.due_on.slice(0, 10), new Date(e.at)) : null;
      const when = left === null ? [] : left > 0 ? sentence(" ・ 期限の {n} 日前", { n: left }) : left === 0 ? sentence(" ・ 期限の日") : sentence(" ・ 期限から {n} 日", { n: -left });
      const last: Part[] = e.last_task ? sentence(" ・ 最後は {ref}", { ref: { kind: "issue", number: e.last_task.number, title: e.last_task.title } }) : [];
      return { icon: "🏆", tone: "milestone", parts: [e.title ?? ""], sub: [...sentence("終えたタスク {n} 件", { n: e.size ?? 0 }), ...last, ...when] };
    }
    case "PushEvent": {
      // 今の GitHub はコミットの数を入れないので、比べて足せなかったときは数を出さない
      const count = e.size ?? (e.commits?.length || null);
      return {
        icon: "⬆",
        parts: count ? sentence("{actor} が {ref} に {n} コミットをプッシュ", { actor, ref: e.ref ?? "", n: count }) : sentence("{actor} が {ref} にプッシュしました", { actor, ref: e.ref ?? "" }),
        commits: e.commits ?? [],
      };
    }
    case "PullRequestEvent": {
      const r = ref(e, true);
      if (e.action === "opened") return { icon: "🔃", parts: sentence("{actor} がプルリク {ref} を作りました", { actor, ref: r }) };
      // マージは、前は closed と merged、今の GitHub は merged で来る
      if (e.action === "merged" || (e.action === "closed" && e.merged)) return { icon: "🟣", parts: sentence("{actor} が {ref} をマージしました", { actor, ref: r }) };
      if (e.action === "closed") return { icon: "🔴", parts: sentence("{actor} がプルリク {ref} を閉じました", { actor, ref: r }) };
      if (e.action === "reopened") return { icon: "🟢", parts: sentence("{actor} がプルリク {ref} を開き直しました", { actor, ref: r }) };
      if (e.action === "ready_for_review") return { icon: "📣", parts: sentence("{actor} が {ref} をレビューをお願いできる状態にしました", { actor, ref: r }) };
      return null;
    }
    case "PullRequestReviewEvent": {
      const r = ref(e, true);
      if (e.review_state === "approved") return { icon: "✔", parts: sentence("{actor} が {ref} を承認しました", { actor, ref: r }) };
      if (e.review_state === "changes_requested") return { icon: "✏️", parts: sentence("{actor} が {ref} に修正を依頼しました", { actor, ref: r }) };
      return { icon: "💬", parts: sentence("{actor} が {ref} をレビューしました", { actor, ref: r }) };
    }
    case "PullRequestReviewCommentEvent":
      return { icon: "💬", parts: sentence("{actor} が {ref} の行にコメントしました", { actor, ref: ref(e, true) }), detail: e.body ?? undefined };
    case "IssuesEvent": {
      const r = ref(e);
      if (e.action === "opened") return { icon: "📝", parts: sentence("{actor} が {ref} を作りました", { actor, ref: r }) };
      if (e.action === "closed") {
        if (e.state_reason === "not_planned") return { icon: "⊘", parts: sentence("{actor} が {ref} を閉じました（予定なし）", { actor, ref: r }) };
        if (e.state_reason === "duplicate") return { icon: "⊘", parts: sentence("{actor} が {ref} を閉じました（重複）", { actor, ref: r }) };
        return { icon: "✅", tone: "done", parts: sentence("{actor} が {ref} を完了にしました", { actor, ref: r }) };
      }
      if (e.action === "reopened") return { icon: "↺", parts: sentence("{actor} が {ref} を開き直しました", { actor, ref: r }) };
      if (e.action === "assigned" && e.assignee) return { icon: "👤", parts: sentence("{actor} が {ref} の担当を {assignee} にしました", { actor, ref: r, assignee: e.assignee }) };
      return null;
    }
    case "IssueCommentEvent":
      if (e.action !== "created") return null;
      if (help?.role === "ask") return { icon: "🆘", tone: "help", parts: sentence("{actor} が {ref} で助けを求めました", { actor, ref: ref(e) }), detail: e.body ?? undefined };
      if (help?.role === "answer") return { icon: "🤝", tone: "answer", parts: sentence("{actor} が {ref} で {asker} の 🆘 に答えました", { actor, ref: ref(e), asker: help.asker }), detail: e.body ?? undefined };
      if (help?.role === "resolved") return { icon: "🎉", tone: "resolved", parts: sentence("{actor} が {ref} の 🆘 を解決しました", { actor, ref: ref(e) }) };
      return { icon: "💬", parts: sentence("{actor} が {ref} にコメントしました", { actor, ref: ref(e) }), detail: e.body ?? undefined };
    case "CreateEvent":
      if (e.ref_type === "branch") return { icon: "🌿", parts: sentence("{actor} がブランチ {ref} を作りました", { actor, ref: e.ref ?? "" }) };
      if (e.ref_type === "tag") return { icon: "🏷️", parts: sentence("{actor} がタグ {ref} を付けました", { actor, ref: e.ref ?? "" }) };
      if (e.ref_type === "repository") return { icon: "📦", parts: sentence("{actor} がリポジトリを作りました", { actor }) };
      return null;
    case "DeleteEvent":
      return { icon: "🗑", parts: e.ref_type === "tag" ? sentence("{actor} がタグ {ref} を消しました", { actor, ref: e.ref ?? "" }) : sentence("{actor} がブランチ {ref} を消しました", { actor, ref: e.ref ?? "" }) };
    case "ReleaseEvent":
      if (e.action !== "published") return null;
      return { icon: "🏷️", parts: e.prerelease ? sentence("{actor} が試用版 {ref} を出しました", { actor, ref: e.title ?? e.ref ?? "" }) : sentence("{actor} がリリース {ref} を出しました", { actor, ref: e.title ?? e.ref ?? "" }) };
    case "MemberEvent":
      return e.action === "added" ? { icon: "👥", parts: sentence("{actor} が {member} をメンバーに入れました", { actor, member: e.member ?? "" }) } : null;
    case "ForkEvent":
      return { icon: "🍴", parts: sentence("{actor} がフォークしました", { actor }) };
    case "WatchEvent":
      return { icon: "⭐", parts: sentence("{actor} がスターを付けました", { actor }) };
    default:
      return null;
  }
}

const same = (a: string | null | undefined, b: string) => !!a && a.toLowerCase() === b.toLowerCase();

/**
 * 🆘 の流れ: 助けを求めたコメント、そのあと同じ Issue にほかの人が書いたコメント（答えた）、解決のコメント。
 * 古い順に見て、解決のあとに書いたものは答えにしない
 */
export function helpRoles(events: ActivityEvent[]): Map<string, HelpRole> {
  const roles = new Map<string, HelpRole>();
  // Issue ごとの、まだ解決していない 🆘（助けを求めた人）
  const open = new Map<number, string[]>();
  const comments = events
    .filter((e) => e.type === "IssueCommentEvent" && (!e.action || e.action === "created") && e.number)
    .sort((a, b) => a.at.localeCompare(b.at));
  for (const e of comments) {
    const n = e.number!;
    if (e.body?.includes(HELP_MARK)) {
      roles.set(e.id, { role: "ask" });
      open.set(n, [...(open.get(n) ?? []), e.actor]);
    } else if (e.body?.includes(HELP_DONE_MARK)) {
      roles.set(e.id, { role: "resolved" });
      open.delete(n);
    } else {
      const asker = (open.get(n) ?? []).filter((a) => !same(a, e.actor)).pop();
      if (asker) roles.set(e.id, { role: "answer", asker });
    }
  }
  return roles;
}

/**
 * マイルストーンの達成を、出来事として作る（ヒストリーに出す）。タスクがすべて終わったマイルストーンで、
 * 時刻は最後のタスクを閉じたとき（わからなければ、マイルストーンを閉じたとき）。since より前のものは作らない。
 * 読んでいるマイルストーンは開いているものだけなので、閉じたマイルストーンは、閉じたタスクに入っているもので見る
 */
export function milestoneEvents(milestones: GitHubMilestone[], closedIssues: GitHubIssue[], since: number): ActivityEvent[] {
  const all = new Map<number, GitHubMilestone>();
  for (const i of closedIssues) if (i.milestone && !all.has(i.milestone.number)) all.set(i.milestone.number, i.milestone);
  // 開いているマイルストーンは、一覧のもの（新しい数）を使う
  for (const m of milestones) all.set(m.number, m);
  const out: ActivityEvent[] = [];
  for (const m of all.values()) {
    if (m.open_issues > 0 || m.closed_issues === 0) continue;
    let last: GitHubIssue | null = null;
    for (const i of closedIssues) {
      if (i.milestone?.number !== m.number || !i.closed_at) continue;
      if (!last || i.closed_at > (last.closed_at ?? "")) last = i;
    }
    const at = last?.closed_at ?? m.closed_at ?? null;
    if (!at || Date.parse(at) < since) continue;
    out.push({
      id: `ms:${m.number}`,
      type: MILESTONE_EVENT,
      actor: "",
      at,
      action: null,
      number: m.number,
      title: m.title,
      size: m.closed_issues,
      due_on: m.due_on,
      last_task: last ? { number: last.number, title: last.title } : null,
    });
  }
  return out;
}

/** 「今日」「きのう」「9/27（土）」 */
export function dayLabel(iso: string, today = new Date()): string {
  const d = new Date(iso);
  const days = daysUntil(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`, today);
  if (days === 0) return tr("今日");
  if (days === -1) return tr("きのう");
  return tr("{m}/{d}（{w}）", { m: d.getMonth() + 1, d: d.getDate(), w: weekdayShort(d) });
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
/** 作業をする の「引き継ぐ」が Issue に書くコメントの書き出し（相手の名前） */
const HANDOVER = /^@([\w-]+) さんに引き継ぎます。/;

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
      out.push({ key: `review:${p.number}:${p.updated_at}`, icon: "👀", tone: "", parts: sentence("{ref} のレビューを頼まれています", { ref: pr(p) }), at: p.updated_at, target: { kind: "pull", number: p.number }, order: 2 });
    }
    if (!same(p.user, me)) continue;
    const ck = o.checks[p.head_sha];
    if (ck && ck.failure > 0) {
      out.push({ key: `checks:${p.number}:${p.head_sha}`, icon: "✖", tone: "ng", parts: sentence("あなたのプルリク {ref} のチェックが {n} 件失敗しています", { ref: pr(p), n: ck.failure }), at: p.updated_at, target: { kind: "pull", number: p.number }, order: 0 });
    }
    const v = o.verdicts[String(p.number)];
    if (v && v.changes_requested.length > 0) {
      out.push({ key: `changes:${p.number}:${p.updated_at}`, icon: "✏️", tone: "warn", parts: sentence("{ref} で修正を頼まれています（{who}）", { ref: pr(p), who: joinNames(v.changes_requested) }), at: p.updated_at, target: { kind: "pull", number: p.number }, order: 1 });
    } else if (v && v.approved.length > 0 && !p.draft && !(ck && ck.failure > 0)) {
      out.push({ key: `approved:${p.number}:${p.updated_at}`, icon: "✔", tone: "ok", parts: sentence("{ref} が承認されました（{who}）。マージできます", { ref: pr(p), who: joinNames(v.approved) }), at: p.updated_at, target: { kind: "pull", number: p.number }, order: 4 });
    }
  }

  for (const i of o.issues) {
    if (!i.assignees.some((a) => same(a.login, me))) continue;
    const due = dueOf(i);
    if (!due) continue;
    const days = daysUntil(due.date, new Date(now));
    if (days > 3) continue;
    const ref: Part = { kind: "issue", number: i.number, title: i.title };
    const parts =
      days < 0
        ? sentence("担当の {ref} の期限が {n} 日過ぎています", { ref, n: -days })
        : days === 0
          ? sentence("担当の {ref} の期限が今日です", { ref })
          : days === 1
            ? sentence("担当の {ref} の期限が明日です", { ref })
            : sentence("担当の {ref} の期限まであと {n} 日です", { ref, n: days });
    // もうすぐ・今日・過ぎた、の段階ごとに鍵を変える（段階が変わると、また出る・また知らせる）
    const stage = days < 0 ? "over" : days === 0 ? "today" : "soon";
    out.push({ key: `due:${i.number}:${due.date}:${stage}`, icon: "📅", tone: days < 0 ? "ng" : days <= 1 ? "warn" : "", parts, at: null, target: { kind: "issue", number: i.number }, order: days < 0 ? 1 : 3 });
  }

  for (const c of o.stack?.cards ?? []) {
    if (c.kind !== "run" || !c.run || c.level > 3 || c.pull) continue;
    if (!same(c.run.actor?.login, me)) continue;
    out.push({ key: `run:${c.key}:${c.run.id}`, icon: "✖", tone: "ng", parts: sentence("{branch} の {name} が失敗しています（あなたのプッシュ）", { branch: c.run.branch, name: c.run.name }), at: c.run.created_at, target: { kind: "run", runId: c.run.id }, order: 5 });
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
  // 自分への引き継ぎ（作業をする の「引き継ぐ」が書く「@相手 さんに引き継ぎます。…」）。同じ人の「担当をあなたにしました」は重ねて出さない
  const handOver = (e: ActivityEvent) => {
    const m = e.type === "IssueCommentEvent" && e.body ? HANDOVER.exec(e.body.trim()) : null;
    return m && same(m[1], me) ? m : null;
  };
  const handedBy = new Set(o.events.filter((e) => handOver(e) && e.number).map((e) => `${e.number}:${e.actor}`));
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
        out.push({ key: `help:${e.id}`, icon: "🆘", tone: "ng", parts: sentence("{actor} が助けを求めています ・ {ref}", { actor: e.actor, ref }), detail: e.body, at: e.at, target, order: -1 });
      } else if (e.body.includes(HELP_DONE_MARK)) {
        out.push({ key: `helped:${e.id}`, icon: "✅", tone: "ok", parts: sentence("{actor} が 🆘 を解決にしました ・ {ref}", { actor: e.actor, ref }), detail: e.body, at: e.at, target, order: 6 });
      } else if (handOver(e)) {
        const rest = e.body.trim().slice(handOver(e)![0].length).trim();
        out.push({ key: `handover:${e.id}`, icon: "🤝", tone: "", parts: sentence("{actor} が {ref} をあなたに引き継ぎました", { actor: e.actor, ref }), detail: rest || undefined, at: e.at, target, order: 6 });
      } else {
        out.push({ key: `mention:${e.id}`, icon: "💬", tone: "", parts: sentence("{actor} が {ref} であなたの名前を出しました", { actor: e.actor, ref }), detail: e.body, at: e.at, target, order: 6 });
      }
    }
    if (e.type === "IssuesEvent" && e.action === "assigned" && same(e.assignee, me) && !handedBy.has(`${e.number}:${e.actor}`)) {
      out.push({ key: `assigned:${e.id}`, icon: "👤", tone: "", parts: sentence("{actor} が {ref} の担当をあなたにしました", { actor: e.actor, ref }), at: e.at, target, order: 7 });
    }
  }

  return out.sort((a, b) => a.order - b.order || (b.at ?? "").localeCompare(a.at ?? ""));
}
