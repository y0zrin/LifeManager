// おしらせ（アプリの中の通知）: 知らせの形・りれき（この PC に、日ごとに 60 日まで）・おしらせの窓への送り方。
// 未読・既読は持たない（片付ける受信箱にしない）。新しい知らせが来たことだけ、🔔 に小さな点で出す
import { emitTo } from "@tauri-apps/api/event";
import type { Part, Todo } from "./activity";
import { helpSummary } from "./help";

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
  help: "助けて",
  helped: "解決",
  assigned: "担当",
  review: "レビュー",
  mention: "名前を呼ばれた",
  changes: "修正の依頼",
  approved: "承認",
  checks: "チェックの失敗",
  due: "期限",
  run: "Actions の失敗",
  milestone: "達成",
  summary: "まとめ",
};

/** りれきの絞り込み */
export const NOTICE_GROUPS: { key: string; label: string; kinds: NoticeKind[] | null }[] = [
  { key: "all", label: "すべて", kinds: null },
  { key: "help", label: "🆘 助けて", kinds: ["help", "helped"] },
  { key: "mine", label: "自分の番", kinds: ["assigned", "due", "changes", "mention"] },
  { key: "review", label: "レビュー", kinds: ["review", "approved"] },
  { key: "fail", label: "失敗", kinds: ["checks", "run"] },
  { key: "done", label: "達成", kinds: ["milestone"] },
];

/** 知らせの窓を出す角（出さない = アプリの中だけ） */
export type NoticeCorner = "top-right" | "bottom-right" | "top-left" | "bottom-left" | "off";
export const NOTICE_CORNERS: NoticeCorner[] = ["top-right", "bottom-right", "top-left", "bottom-left", "off"];

const KEEP_DAYS = 60;
const KEEP_ITEMS = 300;
const HISTORY_KEY = (repo: string) => `notices:${repo}`;

export function newNoticeId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** 「あなたがすること」の文（Issue・プルリクは「#11 題名」） */
export function partsText(parts: Part[]): string {
  return parts.map((p) => (typeof p === "string" ? p : `${p.kind === "pull" ? "🔃 " : ""}#${p.number}${p.title ? ` ${p.title}` : ""}`)).join("");
}

function kindOfTodo(key: string): NoticeKind {
  const head = key.split(":")[0];
  const known: NoticeKind[] = ["help", "helped", "assigned", "review", "mention", "changes", "approved", "checks", "due", "run"];
  return (known as string[]).includes(head) ? (head as NoticeKind) : "mention";
}

/**
 * 知らせたかを覚える鍵。「あなたがすること」の鍵には、プルリクが動くたびに変わる時刻が入るもの（レビュー・修正の依頼・承認）があるので、
 * それはプルリクごとに 1 回だけ知らせる。チェックの失敗（コミットごと）・Actions（実行ごと）・名前を呼ばれた（コメントごと）は、そのまま
 */
export function noticeKeyOf(todoKey: string): string {
  const [head, number] = todoKey.split(":");
  return head === "review" || head === "changes" || head === "approved" ? `${head}:${number}` : todoKey;
}

/** 「あなたがすること」の 1 つを、知らせに */
export function noticeFromTodo(todo: Todo, repo: string): Notice {
  const kind = kindOfTodo(todo.key);
  const raw = todo.detail ?? "";
  const detail = raw.replace(/<!--[\s\S]*?-->/g, "").trim();
  // 🆘 は困っていることと、ブランチ・失敗した git。ほかは、コメントの（@ で呼んだ行でない）はじめの 1 行
  const body = kind === "help"
    ? helpSummary(raw)
    : detail.split("\n").find((l) => l.trim() && !/^@[\w-]/.test(l.trim()))?.trim().slice(0, 120);
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

/** 起動したときに、たまっていた「あなたがすること」を 1 つにまとめた知らせ（🆘 は、まとめずに 1 つずつ） */
export function summaryNotice(count: number, repo: string): Notice {
  return {
    id: newNoticeId(),
    key: `summary:${Date.now()}`,
    kind: "summary",
    icon: "📰",
    tone: "",
    title: `あなたがすることが ${count} 件あります`,
    body: "アクティビティの「あなたがすること」で見られます",
    at: new Date().toISOString(),
    repo,
    target: { kind: "view", view: "activity" },
  };
}

/** マイルストーンを達成した知らせ */
export function milestoneNotice(o: { number: number; title: string; doneCount: number; amount: string | null; leftDays: number | null }, repo: string): Notice {
  const when = o.leftDays === null ? "" : o.leftDays > 0 ? ` ・ 期限の ${o.leftDays} 日前` : o.leftDays === 0 ? " ・ 期限の日" : ` ・ 期限の ${-o.leftDays} 日後`;
  return {
    id: newNoticeId(),
    key: `milestone:${o.number}`,
    kind: "milestone",
    icon: "🏆",
    tone: "ok",
    title: `${o.title} を達成しました`,
    body: `${o.doneCount} 件のタスク${o.amount ? `（${o.amount}）` : ""}${when}`,
    at: new Date().toISOString(),
    repo,
    target: { kind: "view", view: "milestones" },
  };
}

export function loadNotices(repo: string): Notice[] {
  try {
    const list = JSON.parse(localStorage.getItem(HISTORY_KEY(repo)) ?? "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** りれきに足す（新しい順。60 日・300 件まで） */
export function saveNotice(repo: string, notice: Notice): Notice[] {
  const cut = Date.now() - KEEP_DAYS * 86400000;
  const next = [notice, ...loadNotices(repo)].filter((n) => Date.parse(n.at) >= cut).slice(0, KEEP_ITEMS);
  try {
    localStorage.setItem(HISTORY_KEY(repo), JSON.stringify(next));
  } catch {
    // 覚えられなくても、今の知らせは出る
  }
  return next;
}

/** おしらせの窓に送る（デスクトップ）。窓がなければ false */
export async function sendToNoticeWindow(notice: Notice): Promise<boolean> {
  try {
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
    dow: "日月火水木金土"[d.getDay()],
    rel: days === 0 ? "今日" : days === 1 ? "昨日" : days === 2 ? "おととい" : "",
  };
}

export function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}
