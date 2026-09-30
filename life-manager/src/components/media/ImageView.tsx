import { useEffect, useMemo, useRef, useState } from "react";
import { blobUrl, defaultSprite, guessSprite } from "../../lib/media";

type Bg = "checker" | "dark" | "light";

interface ImageViewProps {
  bytes: ArrayBuffer;
  path: string;
  /** 画像の大きさが分かったとき（見出しに出す） */
  onInfo?: (text: string) => void;
}

/**
 * 画像（拡大・ドットのまま拡大・背景）。スプライトシートとして再生もできる（コマの分け方・速さ・範囲・ループ・拡大）。
 * 格子の画像（横長・縦長・正方形のコマが並ぶ）は、開いたときに分け方を推測して、スプライトシートとして出す
 */
export function ImageView({ bytes, path, onInfo }: ImageViewProps) {
  const url = useMemo(() => blobUrl(bytes, path), [bytes, path]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [zoom, setZoom] = useState<number | null>(null); // null = 合わせる
  const [pixel, setPixel] = useState(true);
  const [bg, setBg] = useState<Bg>("checker");
  const [sprite, setSprite] = useState(false);
  const [grid, setGrid] = useState({ cols: 1, rows: 1 });
  const [fps, setFps] = useState(12);
  const [range, setRange] = useState({ from: 1, to: 1 });
  const [loop, setLoop] = useState(true);
  const [playing, setPlaying] = useState(true);
  const [frame, setFrame] = useState(0);
  const frameRef = useRef(0);
  frameRef.current = frame;
  const [scale, setScale] = useState(3);
  const areaRef = useRef<HTMLDivElement | null>(null);
  const [areaSize, setAreaSize] = useState({ w: 800, h: 500 });

  // 画像を読んだら、大きさ・スプライトシートの推測
  function onLoad() {
    const img = imgRef.current;
    if (!img) return;
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    setSize({ w, h });
    const g = guessSprite(w, h);
    // 推測できなくても、ボタンでスプライトシートにしたときの分け方は用意しておく
    const start = g ?? defaultSprite(w, h);
    setGrid(start);
    setRange({ from: 1, to: start.cols * start.rows });
    const frameW = w / start.cols;
    setScale(frameW <= 32 ? 6 : frameW <= 64 ? 3 : frameW <= 128 ? 2 : 1);
    if (g) setSprite(true);
    onInfo?.(`${w}×${h}${g ? ` ・ ${g.cols * g.rows} コマ` : ""}`);
  }

  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setAreaSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const total = grid.cols * grid.rows;
  const from = Math.max(1, Math.min(range.from, total));
  const to = Math.max(from, Math.min(range.to, total));

  // 再生（範囲の中を回す。ループしないときは最後で止まる）
  useEffect(() => {
    if (!sprite || !playing) return;
    let raf = 0;
    let last = performance.now();
    let acc = 0;
    const step = () => {
      const now = performance.now();
      acc += now - last;
      last = now;
      const span = 1000 / Math.max(1, fps);
      if (acc >= span) {
        acc %= span;
        const cur = Math.max(from - 1, Math.min(frameRef.current, to - 1));
        if (cur + 1 <= to - 1) setFrame(cur + 1);
        else if (loop) setFrame(from - 1);
        else setPlaying(false);
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [sprite, playing, fps, from, to, loop]);

  // 今のコマを描く
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!sprite || !canvas || !img || !size) return;
    const fw = size.w / grid.cols;
    const fh = size.h / grid.rows;
    canvas.width = Math.max(1, Math.round(fw * scale));
    canvas.height = Math.max(1, Math.round(fh * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = !pixel;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const f = Math.max(0, Math.min(frame, total - 1));
    ctx.drawImage(img, (f % grid.cols) * fw, Math.floor(f / grid.cols) * fh, fw, fh, 0, 0, canvas.width, canvas.height);
  }, [sprite, frame, grid, size, scale, pixel, total]);

  // 表示の倍率（合わせる = 入る大きさ。ドット絵は整数倍）
  const fit = size ? Math.min((areaSize.w - 48) / size.w, (areaSize.h - 64) / size.h) : 1;
  const shown = zoom ?? (pixel && fit > 1 ? Math.max(1, Math.floor(fit)) : Math.min(fit, 8));
  const pct = Math.round(shown * 100);
  const setGridSafe = (cols: number, rows: number) => {
    const c = Math.max(1, Math.min(64, cols || 1));
    const r = Math.max(1, Math.min(64, rows || 1));
    setGrid({ cols: c, rows: r });
    setRange({ from: 1, to: c * r });
    setFrame(0);
  };

  return (
    <div className={`mv-main${sprite ? "" : " full"}`}>
      <div ref={areaRef} className={`mv-stage bg-${bg}`}>
        <div className="mv-toolbar">
          <button type="button" className="btn-sm" onClick={() => setZoom(Math.max(0.1, shown / 1.5))} aria-label="小さく">−</button>
          <button type="button" className="btn-sm" onClick={() => setZoom(null)} title="窓に合わせる">{pct}%</button>
          <button type="button" className="btn-sm" onClick={() => setZoom(Math.min(32, shown * 1.5))} aria-label="大きく">＋</button>
          <button type="button" className={`btn-sm${pixel ? " on" : ""}`} aria-pressed={pixel} onClick={() => setPixel(!pixel)} title="拡大してもぼかさない（ドット絵）">ドットのまま</button>
          <button type="button" className={`btn-sm${sprite ? " on" : ""}`} aria-pressed={sprite} onClick={() => setSprite(!sprite)}>🎞 スプライトシート</button>
        </div>
        <div className="mv-image-wrap" style={size ? { width: size.w * shown, height: size.h * shown } : undefined}>
          <img ref={imgRef} src={url} alt={path} onLoad={onLoad} draggable={false}
            style={{ width: size ? size.w * shown : undefined, imageRendering: pixel ? "pixelated" : "auto" }} />
          {sprite && size && (
            <div className="mv-grid" style={{ gridTemplateColumns: `repeat(${grid.cols}, 1fr)`, gridTemplateRows: `repeat(${grid.rows}, 1fr)` }}>
              {Array.from({ length: total }, (_, i) => (
                <button key={i} type="button" className={`mv-cell${i === frame ? " on" : ""}${i + 1 < from || i + 1 > to ? " out" : ""}`}
                  onClick={() => { setPlaying(false); setFrame(i); }} title={`コマ ${i + 1}`}>
                  <span>{i + 1}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {sprite && <div className="mv-hint">コマを押すと、そのコマで止まります</div>}
      </div>
      {sprite && (
        <div className="mv-panel">
          <h4>🎞 スプライトシートとして再生</h4>
          <div className={`mv-preview bg-${bg}`}>
            <canvas ref={canvasRef} className="mv-preview-canvas" />
          </div>
          <div className="mv-row">
            <button type="button" className="btn-primary" onClick={() => setPlaying(!playing)}>{playing ? "⏸ 止める" : "▶ 再生"}</button>
            <button type="button" className="btn-sm" onClick={() => { setPlaying(false); setFrame((f) => (f - 1 < from - 1 ? to - 1 : f - 1)); }} aria-label="前のコマ">⏮</button>
            <button type="button" className="btn-sm" onClick={() => { setPlaying(false); setFrame((f) => (f + 1 > to - 1 ? from - 1 : f + 1)); }} aria-label="次のコマ">⏭</button>
            <span className="grow" />
            <span className="muted">コマ {frame + 1} / {total}</span>
          </div>
          <label className="mv-row">
            <span className="mv-label">分け方</span>
            <input type="number" className="mv-num" min={1} max={64} value={grid.cols} onChange={(e) => setGridSafe(Number(e.target.value), grid.rows)} aria-label="横のコマの数" />
            ×
            <input type="number" className="mv-num" min={1} max={64} value={grid.rows} onChange={(e) => setGridSafe(grid.cols, Number(e.target.value))} aria-label="縦のコマの数" />
            {size && <span className="muted">（{Math.round((size.w / grid.cols) * 10) / 10}×{Math.round((size.h / grid.rows) * 10) / 10}）</span>}
          </label>
          <label className="mv-row">
            <span className="mv-label">速さ</span>
            <input type="range" min={1} max={60} value={fps} onChange={(e) => setFps(Number(e.target.value))} className="grow" />
            <span className="mv-num-out">{fps} fps</span>
          </label>
          <div className="mv-row">
            <span className="mv-label">範囲</span>
            <input type="number" className="mv-num" min={1} max={total} value={from} onChange={(e) => setRange({ from: Number(e.target.value), to })} aria-label="はじめのコマ" />
            〜
            <input type="number" className="mv-num" min={1} max={total} value={to} onChange={(e) => setRange({ from, to: Number(e.target.value) })} aria-label="おわりのコマ" />
            <button type="button" className={`btn-sm${loop ? " on" : ""}`} aria-pressed={loop} onClick={() => setLoop(!loop)}>🔁 ループ</button>
          </div>
          <div className="mv-row">
            <span className="mv-label">拡大</span>
            {[1, 2, 3, 4, 6, 8].map((s) => (
              <button key={s} type="button" className={`btn-sm${scale === s ? " on" : ""}`} onClick={() => setScale(s)}>×{s}</button>
            ))}
          </div>
          <div className="mv-row">
            <span className="mv-label">背景</span>
            {(["checker", "dark", "light"] as Bg[]).map((b) => (
              <button key={b} type="button" className={`btn-sm${bg === b ? " on" : ""}`} onClick={() => setBg(b)}>{b === "checker" ? "市松" : b === "dark" ? "黒" : "白"}</button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
