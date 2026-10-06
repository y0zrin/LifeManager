import { useEffect, useRef, useState } from "react";
import { useBlobUrl } from "../../hooks/useBlobUrl";
import { tr, trx } from "../../lib/i18n";

interface AudioViewProps {
  bytes: ArrayBuffer;
  path: string;
  onInfo?: (text: string) => void;
}

/** 波形の山（幅のぶんだけ、区間ごとのいちばん大きい音） */
function peaksOf(buffer: AudioBuffer, count: number): number[] {
  const data = buffer.getChannelData(0);
  const other = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
  const step = Math.max(1, Math.floor(data.length / count));
  const peaks: number[] = [];
  for (let i = 0; i < count; i++) {
    let max = 0;
    const start = i * step;
    for (let j = start; j < Math.min(start + step, data.length); j += 4) {
      const v = Math.abs(data[j]);
      const w = other ? Math.abs(other[j]) : 0;
      if (v > max) max = v;
      if (w > max) max = w;
    }
    peaks.push(max);
  }
  return peaks;
}

function seconds(t: number): string {
  if (!isFinite(t)) return "0.0";
  return t < 60 ? t.toFixed(t < 10 ? 2 : 1) : `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
}

/** 音（波形・再生・ループ・速さ。波形を押すと、そこから） */
export function AudioView({ bytes, path, onInfo }: AudioViewProps) {
  const url = useBlobUrl(bytes, path);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [decoded, setDecoded] = useState<AudioBuffer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(false);
  const [rate, setRate] = useState(1);
  const [time, setTime] = useState(0);

  // 波形のため、音をほどく
  useEffect(() => {
    let alive = true;
    const ctx = new AudioContext();
    ctx
      .decodeAudioData(bytes.slice(0))
      .then((b) => {
        if (!alive) return;
        setDecoded(b);
        onInfo?.(tr("{toFixed} kHz ・ {v} ・ {seconds} 秒", { toFixed: (b.sampleRate / 1000).toFixed(1), v: b.numberOfChannels === 1 ? tr("モノラル") : b.numberOfChannels === 2 ? tr("ステレオ") : `${b.numberOfChannels} ch`, seconds: seconds(b.duration) }));
      })
      .catch(() => alive && setError(tr("波形を作れませんでした（再生はできることがあります）")))
      .finally(() => void ctx.close());
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bytes]);

  // 波形の山（音と幅が同じあいだは、計算し直さない。再生中は毎コマ描くので）
  const peaksCache = useRef<{ src: AudioBuffer; bars: number; peaks: number[]; max: number } | null>(null);

  // 波形を描く（今の位置まで明るく）
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !decoded) return;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    // 大きさが変わったときだけ、キャンバスを作り直す
    if (canvas.width !== Math.round(w * dpr)) canvas.width = Math.round(w * dpr);
    if (canvas.height !== Math.round(h * dpr)) canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(canvas);
    const played = css.getPropertyValue("--mv-wave-played").trim() || "#58a6ff";
    const rest = css.getPropertyValue("--mv-wave").trim() || "#58a6ff66";
    const head = css.getPropertyValue("--mv-wave-head").trim() || "#ffd33d";
    const bars = Math.max(50, Math.floor(w / 3));
    if (!peaksCache.current || peaksCache.current.src !== decoded || peaksCache.current.bars !== bars) {
      const p = peaksOf(decoded, bars);
      peaksCache.current = { src: decoded, bars, peaks: p, max: Math.max(0.01, ...p) };
    }
    const { peaks, max } = peaksCache.current;
    const at = decoded.duration > 0 ? time / decoded.duration : 0;
    ctx.clearRect(0, 0, w, h);
    peaks.forEach((p, i) => {
      const x = (i / bars) * w;
      const bh = Math.max(1, (p / max) * (h * 0.9));
      ctx.fillStyle = i / bars <= at ? played : rest;
      ctx.fillRect(x, (h - bh) / 2, Math.max(1, w / bars - 1), bh);
    });
    ctx.fillStyle = head;
    ctx.fillRect(at * w - 1, 0, 2, h);
  }, [decoded, time]);

  // 再生中は、位置を追う
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      if (audioRef.current) setTime(audioRef.current.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = rate;
  }, [rate]);

  function toggle() {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) void a.play();
    else a.pause();
  }

  function seek(e: React.MouseEvent<HTMLCanvasElement>) {
    const a = audioRef.current;
    if (!a || !decoded) return;
    const r = e.currentTarget.getBoundingClientRect();
    a.currentTime = ((e.clientX - r.left) / r.width) * decoded.duration;
    setTime(a.currentTime);
  }

  const duration = decoded?.duration ?? audioRef.current?.duration ?? 0;

  return (
    <div className="mv-main full">
      <div className="mv-stage mv-audio">
        <canvas ref={canvasRef} className="mv-wave" onClick={seek} title={tr("押すとそこから再生します")} />
        {error && <p className="mv-note">{error}</p>}
        <audio ref={audioRef} src={url ?? undefined} loop={loop} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
          onEnded={() => { setPlaying(false); setTime(0); }} />
        <div className="mv-row mv-audio-controls">
          <button type="button" className="btn-primary" onClick={toggle}>{playing ? tr("⏸ 止める") : tr("▶ 再生")}</button>
          <button type="button" className={`btn-sm${loop ? " on" : ""}`} aria-pressed={loop} onClick={() => setLoop(!loop)}>{tr("🔁 ループ")}</button>
          {[0.5, 1, 2].map((r) => (
            <button key={r} type="button" className={`btn-sm${rate === r ? " on" : ""}`} onClick={() => setRate(r)}>{r}×</button>
          ))}
          <span className="grow" />
          <span className="mv-time">{trx("{seconds} / {seconds2} 秒", { seconds: seconds(time), seconds2: seconds(duration) })}</span>
        </div>
      </div>
    </div>
  );
}
