// ガントの先行タスクの矢印: どの矢印を描くか（余計な矢印を省く）と、帯の並びの右上・左下のどちらに通すかを決める（#196）
//
// 帯が階段（行の順 = 日の順）に並ぶとき、矢印は右上（先行の行に沿って横に出て、後続の帯に上から入る）か、
// 左下（先行の帯の下から出て、後続の行に沿って左から入る）を通す。右上と左下の矢印は交わらない。
// 同じ側の 2 本が交わるのは、行の順で a < c < b < d となる a→b と c→d（互い違い）のときだけ。
// そこで互い違いの組を、できるだけ右上と左下に分ける（分けきれれば交わり 0）
import type { GanttTask } from "./ganttTypes";

export type ArrowSide = "top" | "below";

export interface ArrowPlan {
  /** 推移的に余計な矢印（ほかの矢印をたどって、もう順番が決まっているもの）。鍵は arrowKey */
  redundant: Set<string>;
  /** 矢印を通す側。鍵は arrowKey。上の行へ向かう矢印（順番が守られていない）は入れない */
  sides: Map<string, ArrowSide>;
}

/** 矢印の鍵（先行 → 後続） */
export function arrowKey(from: number, to: number): string {
  return `${from}>${to}`;
}

interface Edge {
  from: number;
  to: number;
  key: string;
}

/** 推移的に余計な矢印。from から to へ、この矢印を使わずにたどり着けるなら余計 */
export function redundantArrows(edges: { from: number; to: number }[]): Set<string> {
  const next = new Map<number, number[]>();
  for (const e of edges) next.set(e.from, [...(next.get(e.from) ?? []), e.to]);
  const out = new Set<string>();
  for (const e of edges) {
    const seen = new Set<number>([e.from]);
    const stack = (next.get(e.from) ?? []).filter((n) => n !== e.to);
    let found = false;
    while (stack.length > 0 && !found) {
      const n = stack.pop()!;
      if (seen.has(n)) continue;
      seen.add(n);
      for (const m of next.get(n) ?? []) {
        if (m === e.to) {
          found = true;
          break;
        }
        if (!seen.has(m)) stack.push(m);
      }
    }
    if (found) out.add(arrowKey(e.from, e.to));
  }
  return out;
}

/** 互い違いか（行の順で a < c < b < d） */
function interleaved(a1: number, b1: number, a2: number, b2: number): boolean {
  return (a1 < a2 && a2 < b1 && b1 < b2) || (a2 < a1 && a1 < b2 && b2 < b1);
}

/**
 * 矢印を通す側を決める。下の行へ向かう矢印だけを考える。
 * 自然な側: 何本も 1 つに入る矢印（逆扇）は左下、ほかは右上（同じ先行の矢印は先行の行で、同じ後続の矢印は後続の行で重なる）。
 * 互い違いの組がつながっているまとまりごとに、2 つの側に塗り分ける（自然な側に多く合うほうを選ぶ）。
 * 塗り分けられないまとまり（3 本が互いに互い違い、など）は、交わりが少なくなるように 1 本ずつ決めてから、入れ替えて減るものを入れ替える
 */
export function chooseSides(edges: { from: number; to: number }[], rowOf: Map<number, number>): Map<string, ArrowSide> {
  const down: Edge[] = edges
    .filter((e) => rowOf.has(e.from) && rowOf.has(e.to) && rowOf.get(e.from)! < rowOf.get(e.to)!)
    .map((e) => ({ ...e, key: arrowKey(e.from, e.to) }));
  const inDeg = new Map<number, number>();
  const outDeg = new Map<number, number>();
  for (const e of down) {
    inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
    outDeg.set(e.from, (outDeg.get(e.from) ?? 0) + 1);
  }
  const natural = (e: Edge): ArrowSide => ((inDeg.get(e.to) ?? 0) >= 2 && (outDeg.get(e.from) ?? 0) < 2 ? "below" : "top");

  const adj = new Map<string, string[]>(down.map((e) => [e.key, []]));
  for (let i = 0; i < down.length; i++) {
    for (let j = i + 1; j < down.length; j++) {
      const p = down[i];
      const q = down[j];
      if (interleaved(rowOf.get(p.from)!, rowOf.get(p.to)!, rowOf.get(q.from)!, rowOf.get(q.to)!)) {
        adj.get(p.key)!.push(q.key);
        adj.get(q.key)!.push(p.key);
      }
    }
  }
  const byKey = new Map(down.map((e) => [e.key, e]));
  const sides = new Map<string, ArrowSide>();
  const done = new Set<string>();
  const flip = (s: ArrowSide): ArrowSide => (s === "top" ? "below" : "top");

  for (const e of down) {
    if (done.has(e.key)) continue;
    // まとまりを集めて、2 つに塗り分けてみる
    const comp: string[] = [];
    const color = new Map<string, number>([[e.key, 0]]);
    const stack = [e.key];
    let bipartite = true;
    done.add(e.key);
    while (stack.length > 0) {
      const k = stack.pop()!;
      comp.push(k);
      for (const m of adj.get(k)!) {
        if (!color.has(m)) {
          color.set(m, 1 - color.get(k)!);
          done.add(m);
          stack.push(m);
        } else if (color.get(m) === color.get(k)) {
          bipartite = false;
        }
      }
    }
    if (bipartite) {
      const score = (zero: ArrowSide) => comp.filter((k) => (color.get(k) === 0 ? zero : flip(zero)) === natural(byKey.get(k)!)).length;
      const zero: ArrowSide = score("top") >= score("below") ? "top" : "below";
      for (const k of comp) sides.set(k, color.get(k) === 0 ? zero : flip(zero));
      continue;
    }
    // 塗り分けられない: 互い違いの相手の多いものから、交わりの少ない側に置き、そのあと入れ替えて減るものを入れ替える
    const order = [...comp].sort((a, b) => adj.get(b)!.length - adj.get(a)!.length);
    const clash = (k: string, side: ArrowSide) => adj.get(k)!.filter((m) => sides.get(m) === side).length;
    for (const k of order) {
      const nat = natural(byKey.get(k)!);
      sides.set(k, clash(k, flip(nat)) < clash(k, nat) ? flip(nat) : nat);
    }
    for (let pass = 0; pass < 20; pass++) {
      let changed = false;
      for (const k of order) {
        const now = sides.get(k)!;
        if (clash(k, flip(now)) < clash(k, now)) {
          sides.set(k, flip(now));
          changed = true;
        }
      }
      if (!changed) break;
    }
  }
  return sides;
}

/** ガントの行（並べた順の GanttTask）から、描く矢印と通す側を決める。帯（日程）のあるタスクどうしの矢印だけ */
export function planArrows(tasks: GanttTask[]): ArrowPlan {
  const rowOf = new Map<number, number>();
  tasks.forEach((t, i) => {
    if (t.startDate && t.endDate) rowOf.set(t.issueNumber, i);
  });
  const edges: { from: number; to: number }[] = [];
  for (const t of tasks) {
    if (!rowOf.has(t.issueNumber)) continue;
    for (const d of t.dependencies) if (rowOf.has(d) && d !== t.issueNumber) edges.push({ from: d, to: t.issueNumber });
  }
  const redundant = redundantArrows(edges);
  const sides = chooseSides(
    edges.filter((e) => !redundant.has(arrowKey(e.from, e.to))),
    rowOf,
  );
  return { redundant, sides };
}
