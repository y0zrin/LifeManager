// 競合（コンフリクト）したファイルの中身を、印 <<<<<<< ・（|||||||）・======= ・>>>>>>> で読み分け、
// か所ごとに選んだ内容で書き直す（マージツール）
import type { GitOperation } from "./types";
import { tr } from "./i18n";

/** 競合した 1 か所 */
export interface ConflictHunk {
  /** 何か所目か（0 から） */
  index: number;
  /** 印 <<<<<<< がある行（1 から。今のファイルの行） */
  line: number;
  /** 今のブランチの側（<<<<<<< と ======= のあいだ） */
  ours: string[];
  /** 取り込む側（======= と >>>>>>> のあいだ） */
  theirs: string[];
  /** もとの内容（diff3 の書き方のときだけ。||||||| のあと） */
  base: string[] | null;
  /** 印に付いている名前（HEAD・ブランチの名前・コミット） */
  oursLabel: string;
  theirsLabel: string;
  /** すぐ上の行（どこの話か分かるように出す） */
  before: string | null;
}

type Piece = { kind: "text"; lines: string[] } | { kind: "conflict"; hunk: ConflictHunk };

export interface ParsedConflict {
  pieces: Piece[];
  hunks: ConflictHunk[];
  /** ファイルの改行（書き直すときも同じにする） */
  eol: "\n" | "\r\n";
  /** 最後の行のあとに改行があるか */
  finalNewline: boolean;
}

const START = /^<{7}(?: (.*))?$/;
const BASE = /^\|{7}(?: (.*))?$/;
const SEP = /^={7}$/;
const END = /^>{7}(?: (.*))?$/;

/** ファイルの中身を、ふつうの行と競合したか所に分ける（印がそろっていないところは、ふつうの行として扱う） */
export function parseConflict(text: string): ParsedConflict {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const finalNewline = text.endsWith("\n");
  const lines = text.split(/\r?\n/);
  if (finalNewline) lines.pop();

  const pieces: Piece[] = [];
  const hunks: ConflictHunk[] = [];
  let plain: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const start = START.exec(lines[i]);
    if (!start) {
      plain.push(lines[i]);
      i++;
      continue;
    }
    const ours: string[] = [];
    const theirs: string[] = [];
    let base: string[] | null = null;
    let part: "ours" | "base" | "theirs" = "ours";
    let theirsLabel = "";
    let end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (part === "ours" && BASE.test(l)) {
        part = "base";
        base = [];
        continue;
      }
      if (part !== "theirs" && SEP.test(l)) {
        part = "theirs";
        continue;
      }
      if (part === "theirs") {
        const m = END.exec(l);
        if (m) {
          theirsLabel = m[1] ?? "";
          end = j;
          break;
        }
      }
      (part === "ours" ? ours : part === "base" ? base! : theirs).push(l);
    }
    if (end < 0) {
      // 閉じる印がない（たまたま < が 7 つ並んだ行など）
      plain.push(lines[i]);
      i++;
      continue;
    }
    if (plain.length > 0) pieces.push({ kind: "text", lines: plain });
    const hunk: ConflictHunk = {
      index: hunks.length,
      line: i + 1,
      ours,
      theirs,
      base,
      oursLabel: start[1] ?? "",
      theirsLabel,
      before: plain.length > 0 ? plain[plain.length - 1] : null,
    };
    hunks.push(hunk);
    pieces.push({ kind: "conflict", hunk });
    plain = [];
    i = end + 1;
  }
  if (plain.length > 0) pieces.push({ kind: "text", lines: plain });
  return { pieces, hunks, eol, finalNewline };
}

/** か所ごとに選んだもの */
export type ConflictChoice =
  | { kind: "ours" }
  | { kind: "theirs" }
  /** 両方を残す（first が先） */
  | { kind: "both"; first: "ours" | "theirs" }
  /** 自分で書いた内容 */
  | { kind: "custom"; text: string };

/** 選んだ内容の行 */
export function linesOf(hunk: ConflictHunk, choice: ConflictChoice): string[] {
  switch (choice.kind) {
    case "ours":
      return hunk.ours;
    case "theirs":
      return hunk.theirs;
    case "both":
      return choice.first === "ours" ? [...hunk.ours, ...hunk.theirs] : [...hunk.theirs, ...hunk.ours];
    case "custom":
      return choice.text === "" ? [] : choice.text.split(/\r?\n/);
  }
}

/** 選んだ内容で書き直したファイル（まだ選んでいないか所があれば null） */
export function buildResolved(parsed: ParsedConflict, choices: (ConflictChoice | undefined)[]): string | null {
  const out: string[] = [];
  for (const piece of parsed.pieces) {
    if (piece.kind === "text") {
      out.push(...piece.lines);
      continue;
    }
    const choice = choices[piece.hunk.index];
    if (!choice) return null;
    out.push(...linesOf(piece.hunk, choice));
  }
  if (out.length === 0) return "";
  return out.join(parsed.eol) + (parsed.finalNewline ? parsed.eol : "");
}

/** 両側の呼び方（操作ごとに、今のブランチ・取り込む側 がどれに当たるか） */
export function sideNames(
  operation: GitOperation | null,
  branch: string | null,
  hunk: Pick<ConflictHunk, "oursLabel" | "theirsLabel"> | null,
): { ours: string; theirs: string } {
  const theirs = hunk?.theirsLabel ?? "";
  const here = branch || tr("今のブランチ");
  // 退避した変更を戻したとき（git stash pop）
  if (hunk?.oursLabel === "Updated upstream" || theirs === "Stashed changes") {
    return { ours: tr("今のファイル"), theirs: tr("退避していた変更") };
  }
  switch (operation) {
    case "rebase":
      return { ours: tr("付け替え先（取り込み済みの内容）"), theirs: theirs ? tr("自分のコミット（{theirs}）", { theirs }) : tr("自分のコミット") };
    case "cherry-pick":
      return { ours: tr("今のブランチ（{here}）", { here }), theirs: theirs ? tr("取り込むコミット（{theirs}）", { theirs }) : tr("取り込むコミット") };
    case "revert":
      return { ours: tr("今のブランチ（{here}）", { here }), theirs: theirs ? tr("打ち消した内容（{theirs}）", { theirs }) : tr("打ち消した内容") };
    default:
      return { ours: tr("今のブランチ（{here}）", { here }), theirs: theirs ? tr("取り込む側（{theirs}）", { theirs }) : tr("取り込む側") };
  }
}
