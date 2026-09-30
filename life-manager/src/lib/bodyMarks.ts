// 本文の見えない印（HTML のコメント <!-- … -->）。GitHub の画面と同じく、アプリの画面にも出さない。
// アプリが書く印（ガントの日程・先行・進み方、関連）は、本文を直すときも欄に出さず、保存するときに元に戻す

/** アプリが本文に書く印の行 */
const APP_MARK_LINE = /^[ \t]*<!--\s*(gantt|depends|progress-mode|progress|related):[^>]*-->[ \t]*$/;

/** 本文を、人が書いた部分と、アプリの印の行に分ける */
export function splitAppMarks(body: string | null | undefined): { text: string; marks: string[] } {
  const text: string[] = [];
  const marks: string[] = [];
  for (const line of (body ?? "").split("\n")) (APP_MARK_LINE.test(line) ? marks : text).push(line);
  return { text: text.join("\n").trimEnd(), marks };
}

/** 人が書いた部分に、アプリの印を戻す（印は最後にまとめる） */
export function withAppMarks(text: string, marks: string[]): string {
  const rest = text.trimEnd();
  if (marks.length === 0) return rest;
  return `${rest}${rest ? "\n" : ""}${marks.join("\n")}`;
}

/** 画面に出す本文（コメントを消し、消したあとに残る空の行を詰める） */
export function visibleBody(body: string | null | undefined): string {
  return (body ?? "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 行ごとに、コメントだけの行か（行の中にコメントの外の文字がなければ true。複数行にまたがるコメントの中の行も） */
export function commentOnlyLines(lines: string[]): boolean[] {
  let inComment = false;
  return lines.map((line) => {
    let touched = inComment;
    let outside = "";
    let rest = line;
    while (rest) {
      if (inComment) {
        const end = rest.indexOf("-->");
        if (end < 0) break;
        rest = rest.slice(end + 3);
        inComment = false;
      } else {
        const start = rest.indexOf("<!--");
        if (start < 0) {
          outside += rest;
          break;
        }
        outside += rest.slice(0, start);
        rest = rest.slice(start + 4);
        inComment = true;
        touched = true;
      }
    }
    return touched && outside.trim() === "";
  });
}
