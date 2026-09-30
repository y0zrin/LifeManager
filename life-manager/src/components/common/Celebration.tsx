import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { CELEBRATE_EVENT, type CelebrateDetail } from "../../lib/celebrate";

interface CelebrationProps {
  /** 画面の動きが「ふつう」か（少なめなら、キラキラとスタンプは出さず、知らせだけ） */
  motion: boolean;
}

type Spark = { dx: number; dy: number; s: number; r: number; delay: number; dur: number; color: string; star: boolean; size: number };
type Burst = { id: number; x: number; y: number; sparks: Spark[]; stamp: ReactNode | null };
type Toast = { id: number; text: string };

// キラキラの色（CSS の --spark-* と同じ並び）
const SPARK_COLORS = ["var(--spark-1)", "var(--spark-2)", "var(--spark-3)", "var(--spark-4)", "var(--spark-5)", "var(--spark-6)", "var(--spark-7)", "var(--spark-8)"];

const PHRASES = ["完了！", "おつかれさま！", "よくできました", "やったね！", "Nice!", "Great job!", "Well done!", "Awesome!", "Perfect!"];

const pick = <T,>(list: T[]): T => list[Math.floor(Math.random() * list.length)];
const rand = (a: number, b: number) => a + Math.random() * (b - a);

/** 先生のはんこ（花の形の枠に、ことばを 2〜3 行） */
function SenseiStamp({ lines }: { lines: string[] }) {
  const petals = Array.from({ length: 8 }, (_, i) => {
    const a = (Math.PI * 2 * i) / 8;
    return <circle key={i} cx={60 + Math.cos(a) * 50} cy={60 + Math.sin(a) * 50} r="8" />;
  });
  const top = 62 - (lines.length - 1) * 9;
  return (
    <svg viewBox="0 0 120 120" className="cel-sensei-svg" aria-hidden="true">
      <g className="cel-sensei-petals">{petals}</g>
      <circle cx="60" cy="60" r="47" className="cel-sensei-ring" />
      <circle cx="60" cy="60" r="43" className="cel-sensei-face" />
      {lines.map((line, i) => (
        <text key={line} x="60" y={top + i * 18} textAnchor="middle" className="cel-sensei-text" style={{ fontSize: line.length > 4 ? 12 : 14 }}>
          {line}
        </text>
      ))}
    </svg>
  );
}

/** 金魚のテーマ: 金魚すくいのポイと、はねる金魚。「すくえた！」 */
function KingyoStamp() {
  return (
    <div className="cel-stamp cel-kingyo">
      <svg viewBox="0 0 120 120" className="cel-kingyo-svg" aria-hidden="true">
        <rect x="47" y="92" width="10" height="28" rx="5" className="k-handle" transform="rotate(-28 52 94)" />
        <circle cx="52" cy="66" r="30" className="k-poi" />
        <g transform="translate(56 16) rotate(-24)">
          <path d="M10 10 L0 3 L3 10 L0 17 Z" className="k-tail" />
          <ellipse cx="21" cy="10" rx="12" ry="7" className="k-body" />
          <circle cx="28" cy="8" r="1.6" className="k-eye" />
        </g>
      </svg>
      <span className="cel-kingyo-word">{pick(["すくえた！", "すくえた！", "すくえた！", "やったね！", "大物！"])}</span>
    </div>
  );
}

// スタンプの種類（毎回、前と違う種類にする）
const STAMPS: (() => ReactNode)[] = [
  () => {
    const [word, sub] = pick([["済", "DONE"], ["完了", "DONE"], ["OK", "DONE"]]);
    return (
      <div className="cel-stamp cel-hanko">
        <span className={word.length > 1 ? "cel-hanko-long" : undefined}>{word}</span>
        <small>{sub}</small>
      </div>
    );
  },
  () => (
    <div className="cel-stamp cel-sensei">
      <SenseiStamp lines={pick([["たいへん", "よく", "できました"], ["よく", "できました"], ["がん", "ばりました"]])} />
    </div>
  ),
  () => <div className="cel-stamp cel-badge">{pick(["Great job!", "Nice!", "Well done!", "Awesome!", "Perfect!", "Done!"])}</div>,
  () => <div className="cel-stamp cel-emoji">{pick(["💯", "🎉", "👏", "🏆", "⭐", "🙌"])}</div>,
];

function makeSparks(count: number, spread: number): Spark[] {
  return Array.from({ length: count }, (_, i) => {
    const a = (Math.PI * 2 * i) / count + rand(-0.25, 0.25);
    const dist = rand(0.55, 1) * spread;
    return {
      dx: Math.cos(a) * dist,
      dy: Math.sin(a) * dist * 0.8 - rand(0, 14),
      s: rand(0.7, 1.3),
      r: rand(-160, 160),
      delay: rand(0, 140),
      dur: rand(700, 1050),
      color: SPARK_COLORS[i % SPARK_COLORS.length],
      star: i % 3 !== 2,
      size: rand(10, 18),
    };
  });
}

/**
 * お祝いの重ね（画面のいちばん上。クリックは下に通る）。「完了」でキラキラが散ってスタンプが押され、下のまんなかに完了の知らせが出る。
 * スタンプ（はんこ・先生のはんこ・英語のバッジ・絵文字）とことばは、毎回かわる
 */
export function Celebration({ motion }: CelebrationProps) {
  const [bursts, setBursts] = useState<Burst[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const lastStamp = useRef(-1);
  const motionRef = useRef(motion);
  motionRef.current = motion;

  useEffect(() => {
    function onCelebrate(e: Event) {
      const detail = (e as CustomEvent<CelebrateDetail>).detail;
      const effects = motionRef.current && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (detail.kind === "new") {
        if (!effects) return;
        const id = ++seq.current;
        setBursts((prev) => [...prev, { id, x: detail.origin.x, y: detail.origin.y, sparks: makeSparks(9, 46), stamp: null }]);
        window.setTimeout(() => setBursts((prev) => prev.filter((b) => b.id !== id)), 1400);
        return;
      }
      // 完了の知らせ（下のまんなか）
      const toastId = ++seq.current;
      setToasts((prev) => [...prev.slice(-2), { id: toastId, text: `✨ ${detail.text ?? `${detail.label} を完了しました`}　${pick(PHRASES)}` }]);
      window.setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== toastId)), 2800);
      if (!effects) return;
      // 押したところ（なければ知らせのすこし上）から、キラキラとスタンプ
      const x = detail.origin?.x ?? window.innerWidth / 2;
      const y = detail.origin?.y ?? window.innerHeight - 110;
      let n = Math.floor(Math.random() * STAMPS.length);
      if (n === lastStamp.current) n = (n + 1) % STAMPS.length;
      lastStamp.current = n;
      const id = ++seq.current;
      // 金魚のテーマでは、いつも金魚すくい
      const stamp = document.documentElement.dataset.theme === "kingyo" ? <KingyoStamp /> : STAMPS[n]();
      setBursts((prev) => [...prev, { id, x, y, sparks: makeSparks(18, 92), stamp }]);
      window.setTimeout(() => setBursts((prev) => prev.filter((b) => b.id !== id)), 1800);
    }
    window.addEventListener(CELEBRATE_EVENT, onCelebrate);
    return () => window.removeEventListener(CELEBRATE_EVENT, onCelebrate);
  }, []);

  if (bursts.length === 0 && toasts.length === 0) return null;

  return (
    <div className="cel-layer" aria-live="polite">
      {bursts.map((b) => (
        <div key={b.id} className="cel-burst" style={{ left: b.x, top: b.y }}>
          {b.stamp && <div className="cel-stamp-wrap">{b.stamp}</div>}
          {b.sparks.map((s, i) => (
            <span key={i} className={s.star ? "cel-spark cel-spark--star" : "cel-spark cel-spark--dot"} aria-hidden="true"
              style={{
                "--dx": `${s.dx}px`, "--dy": `${s.dy}px`, "--s": s.s, "--r": `${s.r}deg`,
                animationDelay: `${s.delay}ms`, animationDuration: `${s.dur}ms`,
                color: s.color, fontSize: s.size,
              } as CSSProperties}>
              {s.star ? "✦" : ""}
            </span>
          ))}
        </div>
      ))}
      {toasts.length > 0 && (
        <div className="cel-toasts">
          {toasts.map((t) => <div key={t.id} className="cel-toast">{t.text}</div>)}
        </div>
      )}
    </div>
  );
}
