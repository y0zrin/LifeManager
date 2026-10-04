// おしらせ（アプリの中の通知）: 知らせの形・りれき（この PC に、日ごとに 60 日まで）・おしらせの窓への送り方。
// 未読・既読は持たない（片付ける受信箱にしない）。新しい知らせが来たことだけ、🔔 に小さな点で出す
import { emitTo } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { Part, Todo } from "./activity";
import { countOf } from "./count";
import { helpSummary } from "./help";
import { tr, weekdayShort } from "./i18n";

export type NoticeKind =
  | "help" | "helped" | "assigned" | "review" | "mention" | "changes" | "approved" | "checks" | "due" | "run" | "milestone" | "summary";

export type NoticeTarget =
  | { kind: "issue" | "pull"; number: number }
  | { kind: "run"; runId: number }
  | { kind: "view"; view: string };

export interface Notice {
  id: string;
  /** もとの「あなたがすること」の鍵（同じものは二度知らせない） */
  key: string;
  kind: NoticeKind;
  icon: string;
  tone: "ng" | "warn" | "ok" | "";
  title: string;
  /** 1 行目の下に出す、短い文（助けてのメッセージ・コメントのはじめなど） */
  body?: string;
  /** 押して開いたときの詳しい中身（助けてに添えたようすなど） */
  detail?: string;
  /** 知らせた時（ISO） */
  at: string;
  /** どのリポジトリの知らせか（owner/repo） */
  repo: string;
  target?: NoticeTarget;
}

/** 種類ごとの色（おしらせの窓・りれきの左の線） */
export const NOTICE_COLORS: Record<NoticeKind, string> = {
  help: "var(--accent-red)",
  helped: "var(--accent-green-hover)",
  assigned: "var(--accent-blue)",
  review: "var(--view-pulls)",
  mention: "var(--accent-blue)",
  changes: "var(--accent-yellow)",
  approved: "var(--accent-green-hover)",
  checks: "var(--accent-red)",
  due: "var(--accent-yellow)",
  run: "var(--accent-red)",
  milestone: "var(--celebrate-text)",
  summary: "var(--accent-blue)",
};

export const NOTICE_LABELS: Record<NoticeKind, string> = {
  help: tr("助けて"),
  helped: tr("解決"),
  assigned: tr("担当"),
  review: tr("レビュー"),
  mention: tr("名前を呼ばれた"),
  changes: tr("修正の依頼"),
  approved: tr("承認"),
  checks: tr("チェックの失敗"),
  due: tr("期限"),
  run: tr("Actions の失敗"),
  milestone: tr("達成"),
  summary: tr("まとめ"),
};

/** りれきの絞り込み */
export const NOTICE_GROUPS: { key: string; label: string; kinds: NoticeKind[] | null }[] = [
  { key: "all", label: tr("すべて"), kinds: null },
  { key: "help", label: tr("🆘 助けて"), kinds: ["help", "helped"] },
  { key: "mine", label: tr("自分の番"), kinds: ["assigned", "due", "changes", "mention"] },
  { key: "review", label: tr("レビュー"), kinds: ["review", "approved"] },
  { key: "fail", label: tr("失敗"), kinds: ["checks", "run"] },
  { key: "done", label: tr("達成"), kinds: ["milestone"] },
];

/** 知らせの窓を出す角（出さない = アプリの中だけ） */
export type NoticeCorner = "top-right" | "bottom-right" | "top-left" | "bottom-left" | "off";
export const NOTICE_CORNERS: NoticeCorner[] = ["top-right", "bottom-right", "top-left", "bottom-left", "off"];

const KEEP_DAYS = 60;
const KEEP_ITEMS = 300;
/** だれの覚えか（ログイン。1 台の PC でアカウントを切り替えても、ほかの人のりれき・知らせ済みを混ぜない） */
let noticeUser = "";
export function setNoticeUser(login: string) {
  noticeUser = login.toLowerCase();
}

/** この PC に覚える鍵（ログインがわかれば「ログイン@owner/repo」） */
export function noticeStoreKey(kind: "notices" | "notified", repo: string): string {
  return noticeUser ? `${kind}:${noticeUser}@${repo}` : `${kind}:${repo}`;
}

/** 覚えている並びを読む（1.0 より前の「owner/repo」の鍵は、はじめて読むときに引き継ぐ） */
export function readNoticeStore(kind: "notices" | "notified", repo: string): unknown[] {
  try {
    let raw = localStorage.getItem(noticeStoreKey(kind, repo));
    if (raw === null && noticeUser) raw = localStorage.getItem(`${kind}:${repo}`);
    const list = JSON.parse(raw ?? "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function newNoticeId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** 「あなたがすること」の文（Issue・プルリクは「#11 題名」） */
export function partsText(parts: Part[]): string {
  return parts.map((p) => (typeof p === "string" ? p : p.kind === "actor" ? p.name : `${p.kind === "pull" ? "🔃 " : ""}#${p.number}${p.title ? ` ${p.title}` : ""}`)).join("");
}

function kindOfTodo(key: string): NoticeKind {
  const head = key.split(":")[0];
  const known: NoticeKind[] = ["help", "helped", "assigned", "review", "mention", "changes", "approved", "checks", "due", "run"];
  return (known as string[]).includes(head) ? (head as NoticeKind) : "mention";
}

/**
 * 知らせたかを覚える鍵。「あなたがすること」の鍵には、プルリクが動くたびに変わる時刻が入るもの（レビュー・修正の依頼・承認）があるので、
 * それはプルリクごとに 1 回だけ知らせる（「あなたがすること」から消えたら覚えを外すので、また頼まれたら、また知らせる）。
 * チェックの失敗（コミットごと）・Actions（実行ごと）・名前を呼ばれた（コメントごと）・期限（段階ごと）は、そのまま
 */
export function noticeKeyOf(todoKey: string): string {
  const [head, number] = todoKey.split(":");
  return head === "review" || head === "changes" || head === "approved" ? `${head}:${number}` : todoKey;
}

/** プルリクごとに 1 回の知らせの鍵か（レビュー・修正の依頼・承認） */
export function isPerPullNoticeKey(key: string): boolean {
  return /^(review|changes|approved):\d+$/.test(key);
}

/**
 * 何を知らせるかを決める: 今の「あなたがすること」と、知らせた鍵の覚え（stored）から、新しく知らせるもの（fresh）と、次に覚える鍵（変わらなければ null）。
 * レビュー・修正の依頼・承認は、「あなたがすること」から消えたら覚えを外す（また頼まれたら、また知らせる）。
 * 承認・修正の依頼は読むのが遅れて届くので、外すのは読めたとき（pullsSettled）だけ。読めていないのに外すと、届いたときにまた知らせてしまう
 */
export function planNotices(todos: Todo[], stored: string[], pullsSettled: boolean): { fresh: Todo[]; store: string[] | null } {
  const now = new Set(todos.map((todo) => noticeKeyOf(todo.key)));
  const kept = pullsSettled ? stored.filter((key) => !isPerPullNoticeKey(key) || now.has(key)) : stored;
  const known = new Set(kept);
  const seen = new Set<string>();
  const fresh = todos.filter((todo) => {
    const key = noticeKeyOf(todo.key);
    if (known.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const changed = fresh.length > 0 || kept.length !== stored.length;
  return { fresh, store: changed ? [...known, ...seen] : null };
}

/** 「あなたがすること」の 1 つを、知らせに */
export function noticeFromTodo(todo: Todo, repo: string): Notice {
  const kind = kindOfTodo(todo.key);
  const raw = todo.detail ?? "";
  const detail = raw.replace(/<!--[\s\S]*?-->/g, "").trim();
  // 🆘 は困っていることと、ブランチ・失敗した git。ほかは、コメントのはじめの 1 行（頭の「@名前」は外す。「@alice 見て」→「見て」）
  const body = kind === "help"
    ? helpSummary(raw)
    : detail.split("\n").map((l) => l.replace(/^(\s*@[\w-]+[\s,、]*)+/, "").trim()).find(Boolean)?.slice(0, 120);
  return {
    id: newNoticeId(),
    key: noticeKeyOf(todo.key),
    kind,
    icon: todo.icon,
    tone: todo.tone,
    title: partsText(todo.parts),
    body: body || undefined,
    // 🆘 は、りれきで整えて出すので、印も含めてそのまま
    detail: kind === "help" ? raw : detail || undefined,
    at: new Date().toISOString(),
    repo,
    target: todo.target,
  };
}

/**
 * 起動したときに、たまっていた「あなたがすること」を 1 つにまとめた知らせ（🆘 は、まとめずに 1 つずつ）。
 * total はヒストリーの「あなたがすること」に出ている数（サイドバーの数と同じ）、fresh はそのうち新しく出てきた数
 */
export function summaryNotice(total: number, fresh: number, repo: string): Notice {
  const all = Math.max(total, fresh);
  return {
    id: newNoticeId(),
    key: `summary:${Date.now()}`,
    kind: "summary",
    icon: "📰",
    tone: "",
    title: tr("あなたがすることが {n}あります", { n: countOf(all, tr("件")) }),
    body: fresh < all ? tr("新しく {n} ・ ヒストリーの「あなたがすること」で見られます", { n: countOf(fresh, tr("件")) }) : tr("ヒストリーの「あなたがすること」で見られます"),
    at: new Date().toISOString(),
    repo,
    target: { kind: "view", view: "activity" },
  };
}

/** マイルストーンを達成した知らせ */
export function milestoneNotice(o: { number: number; title: string; doneCount: number; amount: string | null; leftDays: number | null }, repo: string): Notice {
  const when = o.leftDays === null ? "" : o.leftDays > 0 ? tr(" ・ 期限の {leftDays} 日前", { leftDays: o.leftDays }) : o.leftDays === 0 ? tr(" ・ 期限の日") : tr(" ・ 期限の {v} 日後", { v: -o.leftDays });
  return {
    id: newNoticeId(),
    key: `milestone:${o.number}`,
    kind: "milestone",
    icon: "🏆",
    tone: "ok",
    title: tr("{title} を達成しました", { title: o.title }),
    body: tr("{doneCount} 件のタスク{v}{when}", { doneCount: o.doneCount, v: o.amount ? `（${o.amount}）` : "", when }),
    at: new Date().toISOString(),
    repo,
    target: { kind: "view", view: "milestones" },
  };
}

export function loadNotices(repo: string): Notice[] {
  return readNoticeStore("notices", repo) as Notice[];
}

/** りれきに足す（新しい順。60 日・300 件まで） */
export function saveNotice(repo: string, notice: Notice): Notice[] {
  const cut = Date.now() - KEEP_DAYS * 86400000;
  const next = [notice, ...loadNotices(repo)].filter((n) => Date.parse(n.at) >= cut).slice(0, KEEP_ITEMS);
  try {
    localStorage.setItem(noticeStoreKey("notices", repo), JSON.stringify(next));
  } catch {
    // 覚えられなくても、今の知らせは出る
  }
  return next;
}

/** おしらせの窓に送る（デスクトップ）。窓がなければ false（起動のときに作れなかったときは、アプリの中に出す） */
export async function sendToNoticeWindow(notice: Notice): Promise<boolean> {
  try {
    const win = await WebviewWindow.getByLabel("notice").catch(() => undefined);
    if (win === null) return false;
    await emitTo("notice", "lm-notice", notice);
    return true;
  } catch {
    return false;
  }
}

/** 「9/30（火）」と「今日・昨日・おととい」 */
export function dayHead(iso: string, now = new Date()): { date: string; dow: string; rel: string } {
  const d = new Date(iso);
  const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86400000);
  return {
    date: `${d.getMonth() + 1}/${d.getDate()}`,
    dow: weekdayShort(d),
    rel: days === 0 ? tr("今日") : days === 1 ? tr("昨日") : days === 2 ? tr("おととい") : "",
  };
}

export function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}
