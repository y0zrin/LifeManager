import { useEffect, useRef } from "react";
import { isMobile } from "../../lib/platform";

/** ためてから「ドン」までの秒（閃光・衝撃の輪・火花・音をそろえる） */
export const IMPACT = 0.38;

type Particle = {
  kind: "gather" | "spark" | "confetti";
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** 出てからの秒と、消えるまでの秒 */
  age: number;
  life: number;
  size: number;
  color: string;
  /** 紙吹雪の向きと回る速さ・ひらひらのずれ */
  rot: number;
  spin: number;
  seed: number;
  /** 集まる光: はじめの位置 */
  sx: number;
  sy: number;
};

/**
 * 画面いっぱいの粒（canvas）。外から中心へ光が集まり（ためる）、ドンで火花が飛び散り、少しあとで左右の下から紙吹雪を打ち上げる。
 * 5 秒ほどで止まる（くり返さない）
 */
function runParticles(canvas: HTMLCanvasElement): () => void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return () => {};
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const fit = () => {
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
  };
  fit();
  window.addEventListener("resize", fit);

  const css = getComputedStyle(document.documentElement);
  const pick = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const colors = Array.from({ length: 8 }, (_, i) => pick(`--spark-${i + 1}`, "#ffd66b"));
  const gold = pick("--cel-gold", "#ffd66b");
  const white = pick("--cel-text", "#ffffff");
  // スマホは粒を少なめに
  const many = isMobile ? 0.55 : 1;
  const w = () => window.innerWidth;
  const h = () => window.innerHeight;
  const cx = () => w() / 2;
  const cy = () => h() * 0.42;
  const ps: Particle[] = [];
  const add = (p: Partial<Particle> & Pick<Particle, "kind" | "x" | "y" | "life" | "color">) =>
    ps.push({ vx: 0, vy: 0, age: 0, size: 3, rot: 0, spin: 0, seed: Math.random() * 10, sx: p.x, sy: p.y, ...p });

  // ためる: 外から中心へ集まる光
  for (let i = 0; i < 48 * many; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = 240 + Math.random() * 300;
    add({ kind: "gather", x: cx() + Math.cos(a) * r, y: cy() + Math.sin(a) * r, life: IMPACT, color: i % 3 === 0 ? white : gold, size: 2 + Math.random() * 2.5 });
  }

  let burst = false;
  let cannons = false;
  const start = performance.now();
  let last = start;
  let raf = 0;
  const step = (now: number) => {
    const t = (now - start) / 1000;
    const dt = Math.min(0.033, (now - last) / 1000);
    last = now;

    // ドン: 中心から火花
    if (!burst && t >= IMPACT) {
      burst = true;
      for (let i = 0; i < 150 * many; i++) {
        const a = Math.random() * Math.PI * 2;
        const v = 380 + Math.random() * 900;
        add({ kind: "spark", x: cx(), y: cy(), vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.55 + Math.random() * 0.75, color: i % 4 === 0 ? white : colors[i % colors.length], size: 1.5 + Math.random() * 2.5 });
      }
    }
    // 少しあとで、左右の下から紙吹雪を打ち上げる
    if (!cannons && t >= IMPACT + 0.12) {
      cannons = true;
      for (const side of [0, 1]) {
        for (let i = 0; i < 95 * many; i++) {
          const base = side === 0 ? -Math.PI / 3 : (-Math.PI * 2) / 3;
          const a = base + (Math.random() - 0.5) * 0.55;
          const v = 900 + Math.random() * 750;
          add({
            kind: "confetti",
            x: side === 0 ? -10 : w() + 10,
            y: h() + 10,
            vx: Math.cos(a) * v,
            vy: Math.sin(a) * v,
            life: 3.2 + Math.random() * 1.2,
            color: colors[(i + side) % colors.length],
            size: 6 + Math.random() * 6,
            rot: Math.random() * Math.PI,
            spin: (Math.random() - 0.5) * 14,
          });
        }
      }
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w(), h());
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i];
      p.age += dt;
      if (p.age >= p.life) {
        ps.splice(i, 1);
        continue;
      }
      const k = p.age / p.life;
      if (p.kind === "gather") {
        // 加速しながら中心へ（ためる）
        const e = k * k;
        const px = p.x;
        const py = p.y;
        p.x = p.sx + (cx() - p.sx) * e;
        p.y = p.sy + (cy() - p.sy) * e;
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = 0.3 + 0.7 * k;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = p.size;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
      } else if (p.kind === "spark") {
        // 速く飛んで、空気で遅くなり、少し落ちる。尾を引く
        const drag = Math.pow(0.04, dt);
        p.vx *= drag;
        p.vy = p.vy * drag + 520 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = 1 - k;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = p.size;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - p.vx * 0.035, p.y - p.vy * 0.035);
        ctx.stroke();
      } else {
        // 紙吹雪: 打ち上がって、ひらひら落ちる
        const drag = Math.pow(0.35, dt);
        p.vx = p.vx * drag + Math.sin(p.age * 7 + p.seed) * 60 * dt;
        p.vy = p.vy * drag + 1100 * dt;
        p.vy = Math.min(p.vy, 260);
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.rot += p.spin * dt;
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = k > 0.8 ? (1 - k) / 0.2 : 1;
        ctx.fillStyle = p.color;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        // 回ると細く見える（裏返る）
        ctx.scale(1, Math.abs(Math.cos(p.age * 6 + p.seed)) * 0.8 + 0.2);
        ctx.fillRect(-p.size / 2, -p.size * 0.35, p.size, p.size * 0.7);
        ctx.restore();
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    if (t < 6 && (ps.length > 0 || !cannons)) raf = requestAnimationFrame(step);
    else ctx.clearRect(0, 0, w(), h());
  };
  raf = requestAnimationFrame(step);
  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener("resize", fit);
  };
}

/**
 * マイルストーンの達成の「ドン」（#231）: 光が集まる → 白い閃光・衝撃の輪・斜めの光の帯 → 火花と、左右から打ち上がる紙吹雪。
 * スマホは「ドン」で少しふるえる（ふるえられるとき）
 */
export function CelebrationFx() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const stop = runParticles(canvas);
    const buzz = isMobile
      ? window.setTimeout(() => {
          try {
            navigator.vibrate?.([40, 30, 90]);
          } catch {
            // ふるえられなくても、見た目はそのまま
          }
        }, IMPACT * 1000)
      : 0;
    return () => {
      stop();
      window.clearTimeout(buzz);
    };
  }, []);
  return (
    <>
      <div className="ms-cel-swipe l" aria-hidden="true" />
      <div className="ms-cel-swipe r" aria-hidden="true" />
      <div className="ms-cel-shock" aria-hidden="true" />
      <canvas ref={ref} className="ms-cel-canvas" aria-hidden="true" />
      <div className="ms-cel-flash" aria-hidden="true" />
    </>
  );
}
