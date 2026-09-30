// ブランチ画面・全体図のための履歴の組み立て（ブランチの一覧、1 本のブランチのコミット、全体図のレーン）
import type { GitBranch, GitCommit, GitHistory } from "./types";

// --- LifeManager が自分で作るコミット（日次ログ・設定の保存など）。履歴では畳んで見せる ---

const APP_COMMITS: [string, RegExp][] = [
  ["日次ログ", /の日次ログを生成$/],
  ["ノート", /のノートを更新$/],
  ["ルーチン設定", /^ルーチン設定を更新$/],
  ["通知設定", /^(通知スケジュール|イベント通知)設定を更新$/],
  ["リマインダー", /^(リマインダーを更新|発火済みリマインダーを削除)$/],
  ["ボード設定", /^ボード設定を更新$/],
];

/** アプリの自動コミットなら、その種類（日次ログなど）。そうでなければ null */
export function appCommitKind(subject: string): string | null {
  return APP_COMMITS.find(([, re]) => re.test(subject))?.[0] ?? null;
}

/** 「日次ログ 5 · ルーチン設定 1」のような内訳 */
export function appCommitBreakdown(commits: GitCommit[]): string {
  const counts = new Map<string, number>();
  for (const c of commits) {
    const k = appCommitKind(c.subject) ?? "その他";
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(" · ");
}

export const isMerge = (c: GitCommit) => c.parents.length > 1;

// --- ブランチの一覧 ---

export interface BranchEntry {
  name: string;
  /** 指しているコミット */
  tip: string;
  /** この PC にある（GitHub API から読んだときは false） */
  onPc: boolean;
  /** GitHub にもある（origin/… の控えがある、または GitHub API から読んだ） */
  onGitHub: boolean;
  /** GitHub にある方のコミット（この PC の git のときだけ） */
  remoteTip: string | null;
  isDefault: boolean;
  isCurrent: boolean;
  /** 上流との差など（この PC の git のときだけ） */
  info: GitBranch | null;
}

/**
 * 画面に並べるブランチ。既定のブランチ → チェックアウト中 → ほかは新しい順。
 * この PC の git のときは、GitHub にだけあるブランチ（origin/… だけがあるもの）も入れる
 */
export function listBranchEntries(h: GitHistory, localInfo: GitBranch[]): BranchEntry[] {
  const dateOf = new Map(h.commits.map((c) => [c.hash, c.date]));
  const entries: BranchEntry[] = [];
  if (h.source === "github") {
    for (const r of h.refs.filter((r) => r.kind === "branch")) {
      entries.push({
        name: r.name,
        tip: r.hash,
        onPc: false,
        onGitHub: true,
        remoteTip: null,
        isDefault: r.name === h.default_branch,
        isCurrent: false,
        info: null,
      });
    }
  } else {
    const remotes = new Map(h.refs.filter((r) => r.kind === "remote").map((r) => [r.name, r.hash]));
    for (const r of h.refs.filter((r) => r.kind === "branch")) {
      const remoteTip = remotes.get(`origin/${r.name}`) ?? null;
      entries.push({
        name: r.name,
        tip: r.hash,
        onPc: true,
        onGitHub: remoteTip !== null,
        remoteTip,
        isDefault: r.name === h.default_branch,
        isCurrent: r.name === h.head_branch,
        info: localInfo.find((b) => b.name === r.name) ?? null,
      });
    }
    const localNames = new Set(entries.map((e) => e.name));
    for (const [full, hash] of remotes) {
      const name = full.startsWith("origin/") ? full.slice("origin/".length) : full;
      if (localNames.has(name)) continue;
      entries.push({
        name,
        tip: hash,
        onPc: false,
        onGitHub: true,
        remoteTip: hash,
        isDefault: name === h.default_branch,
        isCurrent: false,
        info: null,
      });
    }
  }
  const rank = (e: BranchEntry) => (e.isDefault ? 0 : e.isCurrent ? 1 : 2);
  return entries.sort(
    (a, b) => rank(a) - rank(b) || (dateOf.get(b.tip) ?? "").localeCompare(dateOf.get(a.tip) ?? ""),
  );
}

// --- 1 本のブランチ（ブランチ画面） ---

/** 先頭から、1 つ目の親だけをたどったコミット（そのブランチで積み重ねてきたコミット） */
export function firstParentChain(byHash: Map<string, GitCommit>, tip: string, limit = 300): GitCommit[] {
  const out: GitCommit[] = [];
  let c = byHash.get(tip);
  while (c && out.length < limit) {
    out.push(c);
    c = c.parents[0] ? byHash.get(c.parents[0]) : undefined;
  }
  return out;
}

/** tip からたどれるコミット（読み込んだ範囲で） */
export function ancestors(byHash: Map<string, GitCommit>, tip: string): Set<string> {
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const h = stack.pop()!;
    if (seen.has(h)) continue;
    const c = byHash.get(h);
    if (!c) continue;
    seen.add(h);
    stack.push(...c.parents);
  }
  return seen;
}

/** a が b より何コミット先行し、何コミット遅れているか */
export function aheadBehind(byHash: Map<string, GitCommit>, a: string, b: string) {
  const ra = ancestors(byHash, a);
  const rb = ancestors(byHash, b);
  let ahead = 0;
  let behind = 0;
  for (const h of ra) if (!rb.has(h)) ahead++;
  for (const h of rb) if (!ra.has(h)) behind++;
  return { ahead, behind };
}

/** コミットをクリックしたときに開くブランチ（そのコミットを 1 つ目の親でたどれるブランチ。先に並んでいるほど優先） */
export function homeBranches(byHash: Map<string, GitCommit>, branches: BranchEntry[]): Map<string, string> {
  const home = new Map<string, string>();
  const order = [...branches].sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent));
  for (const b of order) {
    for (const c of firstParentChain(byHash, b.tip, Number.MAX_SAFE_INTEGER)) {
      if (!home.has(c.hash)) home.set(c.hash, b.name);
    }
  }
  return home;
}

// --- 全体図のレイアウト ---

export type RowKind = "commit" | "merge" | "app" | "group";

export interface RefChip {
  kind: "head" | "branch" | "remote" | "tag";
  name: string;
}

export interface GraphRow {
  kind: RowKind;
  lane: number;
  /** group のときは、まとめた自動コミット（新しい順） */
  commits: GitCommit[];
  chips: RefChip[];
}

export interface GraphEdge {
  from: number;
  fromLane: number;
  /** 親の行。親を読み込んでいないときは行の数（いちばん下の外） */
  to: number;
  toLane: number;
  kind: "first" | "merge";
}

export interface GraphLayout {
  rows: GraphRow[];
  edges: GraphEdge[];
  laneCount: number;
  rowOf: Map<string, number>;
}

/** 行に付けるラベル。チェックアウト中のブランチは「●」で見せ、同じ名前のブランチのラベルは出さない */
function chipsByCommit(h: GitHistory): Map<string, RefChip[]> {
  const map = new Map<string, RefChip[]>();
  const add = (hash: string, chip: RefChip) => map.set(hash, [...(map.get(hash) ?? []), chip]);
  if (h.head && h.head_branch) add(h.head, { kind: "head", name: h.head_branch });
  for (const r of h.refs) {
    if (r.kind === "branch" && r.name === h.head_branch && h.source === "local") continue;
    add(r.hash, { kind: r.kind === "branch" ? "branch" : r.kind, name: r.name });
  }
  return map;
}

/**
 * Sourcetree のようなレーンの割り当て（git log --graph と同じ考え方）。
 * seeds のコミットのレーンを左から順に固定する（既定のブランチ、チェックアウト中のブランチ）。
 * 同じレーンで続く自動コミット（ラベルなし）は 1 行にまとめる
 */
export function layoutGraph(h: GitHistory, seeds: string[]): GraphLayout {
  const known = new Set(h.commits.map((c) => c.hash));
  const lanes: (string | null)[] = [];
  for (const s of seeds) if (known.has(s) && !lanes.includes(s)) lanes.push(s);
  const laneOf = new Map<string, number>();
  const rawEdges: { child: string; parent: string; kind: "first" | "merge" }[] = [];
  const freeSlot = () => {
    const i = lanes.indexOf(null);
    if (i >= 0) return i;
    lanes.push(null);
    return lanes.length - 1;
  };

  for (const c of h.commits) {
    let lane = -1;
    lanes.forEach((x, i) => {
      if (x !== c.hash) return;
      if (lane < 0) lane = i;
      // 同じ親を待っていたほかのレーンは、ここで合流して終わる（＝ここから枝分かれした）
      else lanes[i] = null;
    });
    if (lane < 0) lane = freeSlot();
    laneOf.set(c.hash, lane);
    if (c.parents.length) {
      lanes[lane] = c.parents[0];
      rawEdges.push({ child: c.hash, parent: c.parents[0], kind: "first" });
      for (const p of c.parents.slice(1)) {
        if (!lanes.includes(p)) lanes[freeSlot()] = p;
        rawEdges.push({ child: c.hash, parent: p, kind: "merge" });
      }
    } else {
      lanes[lane] = null;
    }
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
  }

  const chips = chipsByCommit(h);
  const rows: GraphRow[] = [];
  for (const c of h.commits) {
    const lane = laneOf.get(c.hash)!;
    const own = chips.get(c.hash) ?? [];
    const auto = appCommitKind(c.subject) !== null && own.length === 0 && c.hash !== h.head;
    const last = rows[rows.length - 1];
    if (auto && last && last.lane === lane && (last.kind === "group" || last.kind === "app")) {
      last.kind = "group";
      last.commits.push(c);
      continue;
    }
    rows.push({ kind: auto ? "app" : isMerge(c) ? "merge" : "commit", lane, commits: [c], chips: own });
  }

  const rowOf = new Map<string, number>();
  rows.forEach((r, i) => r.commits.forEach((c) => rowOf.set(c.hash, i)));
  const edges: GraphEdge[] = [];
  for (const e of rawEdges) {
    const from = rowOf.get(e.child)!;
    const to = rowOf.get(e.parent);
    if (to === from) continue; // まとめた行の内側
    edges.push({
      from,
      fromLane: laneOf.get(e.child)!,
      to: to ?? rows.length,
      toLane: to === undefined ? laneOf.get(e.child)! : laneOf.get(e.parent)!,
      kind: e.kind,
    });
  }
  const laneCount = Math.max(1, ...[...laneOf.values()].map((l) => l + 1));
  return { rows, edges, laneCount, rowOf };
}

// --- 日付の表示 ---

const WEEKDAYS = "日月火水木金土";

export function dayKey(iso: string) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** 9月27日（日） */
export function longDay(iso: string) {
  const d = new Date(iso);
  return `${d.getMonth() + 1}月${d.getDate()}日（${WEEKDAYS[d.getDay()]}）`;
}

/** 9/27（日） */
export function shortDay(iso: string) {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}（${WEEKDAYS[d.getDay()]}）`;
}

export function timeOf(iso: string) {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 9/27 15:48 */
export function shortWhen(iso: string) {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${timeOf(iso)}`;
}
