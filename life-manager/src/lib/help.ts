// 「助けを求める」（🆘）のコメント: 作る・読む。GitHub の Issue に、呼んだ人あてのコメントとして残す
// （GitHub の画面でも読める形。アプリは、見えない印で見分けて、赤い 🆘 で出す）
import { HELP_DONE_MARK, HELP_MARK } from "./activity";

/** いっしょに送る、今のようす */
export interface HelpContext {
  /** 今のブランチと、作業中の変更の数 */
  branch?: { name: string; changes: number };
  /** 最後に失敗した git（コマンドと、git が出したメッセージ） */
  failure?: { command: string; message: string };
  /** 競合しているファイル */
  conflicts?: string[];
}

const SUMMARY = "今のようす（Life Manager から）";
const FAILURE_HEAD = "最後に失敗した git: ";

/** 困っていることは、長すぎないように */
const MESSAGE_CHARS = 2000;
/** git のメッセージは長いことがあるので、はじめの 20 行・1 行 200 字まで */
const LOG_LINES = 20;
const LOG_LINE_CHARS = 200;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** アプリの見えない印（🆘・解決）だけを消す。ほかの <!-- … --> は、書いた人の文として残す */
const stripMarks = (body: string) => body.split(HELP_MARK).join("").split(HELP_DONE_MARK).join("");

const code = (s: string) => `\`${s.replace(/`/g, "'")}\``;

/** 🆘 のコメントの本文 */
export function helpBody(to: string[], message: string, context: HelpContext): string {
  // 見えない印は 2 行目に（本文が長くても、読むときに切られて消えないように）
  const lines = [`🆘 **助けてください** ${to.map((l) => `@${l}`).join(" ")}`.trimEnd(), HELP_MARK, ""];
  if (message.trim()) lines.push(clip(message.trim(), MESSAGE_CHARS), "");
  const items: string[] = [];
  if (context.branch) items.push(`- ブランチ ${code(context.branch.name)}（作業中の変更 ${context.branch.changes}）`);
  if (context.failure) items.push(`- ${FAILURE_HEAD}${code(context.failure.command)}`);
  if (context.conflicts?.length) items.push(`- 競合しているファイル: ${context.conflicts.map(code).join("、")}`);
  if (items.length > 0) {
    lines.push(`<details><summary>${SUMMARY}</summary>`, "", ...items, "");
    if (context.failure?.message) {
      const log = context.failure.message.replace(/```/g, "'''").split("\n").slice(0, LOG_LINES).map((l) => clip(l, LOG_LINE_CHARS)).join("\n");
      lines.push("```text", log, "```", "");
    }
    lines.push("</details>", "");
  }
  return lines.join("\n").trimEnd();
}

/** 🆘 の解決の本文（呼ばれた人と、助けを求めた人に知らせる） */
export function helpDoneBody(to: string[]): string {
  return [`✅ **解決しました**（🆘 助けてください への返事） ${to.map((l) => `@${l}`).join(" ")}`.trimEnd(), "", HELP_DONE_MARK].join("\n");
}

export const isHelp = (body: string | null | undefined) => !!body && body.includes(HELP_MARK);
export const isHelpDone = (body: string | null | undefined) => !!body && body.includes(HELP_DONE_MARK);

export interface ParsedHelp {
  /** 呼んだ人 */
  to: string[];
  message: string;
  /** 添えたようす（1 行ずつ。`…` はコードとして出す） */
  items: string[];
  /** git のメッセージ */
  log: string | null;
}

/** 🆘 のコメントを読む（アプリの画面に、コメントのそのままでなく整えて出すため） */
export function parseHelp(body: string): ParsedHelp {
  const text = stripMarks(body).trim();
  const [head, ...rest] = text.split("\n");
  const to = [...head.matchAll(/@([A-Za-z0-9][A-Za-z0-9_-]*)/g)].map((m) => m[1]);
  const all = rest.join("\n");
  const at = all.indexOf("<details>");
  const message = (at >= 0 ? all.slice(0, at) : all).trim();
  const details = at >= 0 ? all.slice(at) : "";
  const items = details.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2).trim());
  const log = details.match(/```text\n([\s\S]*?)\n```/)?.[1] ?? null;
  return { to, message, items, log };
}

/** 「`feature/hitbox`（作業中の変更 2）」を、文とコードに分ける（画面で `…` をコードにして出す） */
export function splitCode(line: string): { code: boolean; text: string }[] {
  return line.split(/(`[^`]*`)/).filter(Boolean).map((s) => (s.startsWith("`") && s.endsWith("`") && s.length >= 2 ? { code: true, text: s.slice(1, -1) } : { code: false, text: s }));
}

/** コメントを 1 行で見せるとき（ヒストリー）: 🆘 は「🆘 助けてください ・ 困っていること」、解決は「✅ 解決しました」。印は出さない */
export function commentPreview(body: string): string {
  if (isHelp(body)) {
    const first = parseHelp(body).message.split("\n").find((l) => l.trim())?.trim();
    return `🆘 助けてください${first ? ` ・ ${first}` : ""}`;
  }
  if (isHelpDone(body)) return "✅ 解決しました";
  return body.replace(/<!--[\s\S]*?-->/g, "").trim();
}

/** 知らせに出す短い文（困っていることの 1 行目と、ブランチ・失敗した git） */
export function helpSummary(body: string): string {
  const h = parseHelp(body);
  const first = h.message.split("\n").find((l) => l.trim())?.trim() ?? "";
  const codeOf = (head: string) => h.items.find((l) => l.startsWith(head))?.match(/`([^`]*)`/)?.[1];
  const failed = codeOf(FAILURE_HEAD);
  const facts = [codeOf("ブランチ "), failed ? `${failed} が失敗` : ""].filter(Boolean).join(" ・ ");
  return [first ? `「${first.length > 60 ? `${first.slice(0, 60)}…` : first}」` : "", facts].filter(Boolean).join("\n");
}
