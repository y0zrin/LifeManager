import { useEffect, useRef, useState } from "react";
import { readSeen, writeSeen, type Seen } from "../../lib/milestoneStage";

interface StageMeterProps {
  /** 前に見たときの量を覚える鍵（「owner/repo#番号#数え方」） */
  seenKey: string;
  remaining: number;
  total: number;
  /** HP（ボスの残りの体力。減る）か、達成率（のびる）か */
  hp: boolean;
  /** 量の書き方（「2pt」「3 件」） */
  fmt: (v: number) => string;
  /** HP が減った（ボスを揺らす） */
  onHit?: () => void;
}

type View = { w: number; ghost: number; instant: boolean; delta: number | null; tick: number; flash: boolean };

const ratioOf = (v: Seen, hp: boolean) => (v.total > 0 ? (hp ? v.remaining / v.total : (v.total - v.remaining) / v.total) : 0);
const pct = (r: number) => `${Math.max(0, Math.min(1, r)) * 100}%`;

/**
 * マイルストーンのバー。ふと見たときに、前に見たときの量から今の量まで動かす（HP なら、減った分が「−2pt」と飛ぶ）。
 * はじめて見るときは 0 からのびる（HP は、ボスが現れたように満ちる）。見ているあいだに変わったときも、そこから動かす
 */
export function StageMeter({ seenKey, remaining, total, hp, fmt, onHit }: StageMeterProps) {
  const [first] = useState(() => readSeen(seenKey));
  const last = useRef<Seen | null>(first);
  // last がどの見方（見積もり・件数）の量か。見方を切り替えたら、その見方で前に見た量からくらべる（件数とポイントをくらべない）
  const lastKey = useRef(seenKey);
  const tick = useRef(0);
  const onHitRef = useRef(onHit);
  onHitRef.current = onHit;
  const [view, setView] = useState<View>(() => {
    const r = first ? ratioOf(first, hp) : 0;
    return { w: r, ghost: r, instant: true, delta: null, tick: 0, flash: false };
  });

  useEffect(() => {
    if (lastKey.current !== seenKey) {
      lastKey.current = seenKey;
      last.current = readSeen(seenKey);
    }
    const prev = last.current;
    const now = { remaining, total };
    const target = ratioOf(now, hp);
    const start = prev ? ratioOf(prev, hp) : 0;
    const delta = prev ? prev.remaining - remaining : null;
    last.current = now;
    writeSeen(seenKey, now);
    let started = false;
    const id = ++tick.current;
    setView({ w: start, ghost: start, instant: true, delta: null, tick: id, flash: false });
    let raf2 = 0;
    // 前の量を描いてから、次の描画で今の量へ（CSS の transition で動く）
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        started = true;
        const damaged = hp && delta !== null && delta > 0;
        setView({ w: target, ghost: damaged ? start : target, instant: false, delta: delta ? delta : null, tick: id, flash: damaged });
        if (damaged) onHitRef.current?.();
      });
    });
    // 黄色い「減った分」は、少し遅れて追いつく。飛んだ数は、しばらくして消す
    const t1 = window.setTimeout(() => setView((v) => (v.tick === id ? { ...v, ghost: target, flash: false } : v)), 750);
    const t2 = window.setTimeout(() => setView((v) => (v.tick === id ? { ...v, delta: null } : v)), 2600);
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      // StrictMode の二度目（描いてすぐ片づけて、もう一度動かす）も、同じところから動かす
      if (!started) last.current = prev;
    };
  }, [seenKey, remaining, total, hp]);

  let deltaText = "";
  let deltaClass = "";
  if (view.delta !== null) {
    const amount = fmt(Math.abs(view.delta));
    if (hp) {
      deltaText = view.delta > 0 ? `−${amount}` : `+${amount}`;
      deltaClass = view.delta > 0 ? "dmg" : "heal";
    } else {
      deltaText = view.delta > 0 ? `+${amount}` : `残り +${amount}`;
      deltaClass = view.delta > 0 ? "gain" : "more";
    }
  }

  return (
    <div className={`stage-meter ${hp ? "hp" : "progress"}${view.instant ? " instant" : ""}${view.flash ? " flash" : ""}`}>
      <div className="stage-meter-track">
        {hp && <i className="stage-meter-ghost" style={{ width: pct(view.ghost) }} />}
        <i className="stage-meter-fill" style={{ width: pct(view.w) }} />
      </div>
      {view.delta !== null && (
        <span key={view.tick} className={`stage-meter-delta ${deltaClass}`} style={{ left: pct(view.w) }} aria-live="polite">
          {deltaText}
        </span>
      )}
    </div>
  );
}
