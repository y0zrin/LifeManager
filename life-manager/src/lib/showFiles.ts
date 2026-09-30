// git show（と、GitHub から同じ形に作ったもの）の出力から、変わったファイルと、ファイルごとの差分を取り出す

export interface ShowFile {
  path: string;
  /** 名前を変えたときの、前の名前 */
  previous: string | null;
  /** そのファイルの差分（diff --git の行から、次のファイルの前まで） */
  patch: string;
  status: "added" | "removed" | "renamed" | "modified";
  additions: number;
  deletions: number;
}

/** 出力の中の、ファイルごとの差分 */
export function filesFromShow(output: string): ShowFile[] {
  const at = output.indexOf("\ndiff --git ");
  if (at < 0) return [];
  const parts = output.slice(at + 1).split(/\n(?=diff --git )/);
  return parts.flatMap((part) => {
    const head = part.match(/^diff --git a\/(.+?) b\/(.+)$/m);
    if (!head) return [];
    const [, a, b] = head;
    const lines = part.split("\n");
    const added = lines.some((l) => l === "--- /dev/null" || l.startsWith("new file mode"));
    const removed = lines.some((l) => l === "+++ /dev/null" || l.startsWith("deleted file mode"));
    let additions = 0;
    let deletions = 0;
    let inHunk = false;
    for (const l of lines) {
      if (l.startsWith("@@")) inHunk = true;
      else if (inHunk && l.startsWith("+")) additions++;
      else if (inHunk && l.startsWith("-")) deletions++;
    }
    const status = added ? "added" : removed ? "removed" : a !== b ? "renamed" : "modified";
    return [{ path: b, previous: a !== b ? a : null, patch: part, status, additions, deletions }];
  });
}

/** 1 つのファイルの差分（なければ null） */
export function patchFor(output: string, path: string): string | null {
  return filesFromShow(output).find((f) => f.path === path)?.patch ?? null;
}
