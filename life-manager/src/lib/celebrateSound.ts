// お祝いの音（マイルストーンの達成）。音のファイルは持たず、Web Audio でその場で作る（#231）

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  try {
    ctx ??= new AudioContext();
    // 鳴らせないとき（まだ画面を触っていない など）は、鳴らさないだけ
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    return ctx;
  } catch {
    return null;
  }
}

/** 鳴らす先（音量と、大きな音が割れないようにするコンプレッサー） */
function output(ac: AudioContext, volume: number): AudioNode {
  const gain = ac.createGain();
  gain.gain.value = volume;
  const comp = ac.createDynamicsCompressor();
  gain.connect(comp).connect(ac.destination);
  return gain;
}

/** 1 つの音（立ち上がりは速く、だんだん消える） */
function tone(ac: AudioContext, out: AudioNode, at: number, freq: number, dur: number, type: OscillatorType, gain: number) {
  const o = ac.createOscillator();
  const g = ac.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, at);
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(gain, at + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  o.connect(g).connect(out);
  o.start(at);
  o.stop(at + dur + 0.05);
}

let noiseBuf: AudioBuffer | null = null;

/** ざーっという音のもと（1 秒ぶん。くり返して使う） */
function noise(ac: AudioContext): AudioBuffer {
  if (noiseBuf && noiseBuf.sampleRate === ac.sampleRate) return noiseBuf;
  const b = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  noiseBuf = b;
  return b;
}

/** ためる音: ざーっという音の高さを from から to へ上げながら大きくする */
function rise(ac: AudioContext, out: AudioNode, at: number, dur: number, from: number, to: number, gain: number) {
  const src = ac.createBufferSource();
  src.buffer = noise(ac);
  src.loop = true;
  const f = ac.createBiquadFilter();
  f.type = "bandpass";
  f.Q.value = 2.5;
  f.frequency.setValueAtTime(from, at);
  f.frequency.exponentialRampToValueAtTime(to, at + dur);
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(gain, at + dur * 0.9);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur + 0.08);
  src.connect(f).connect(g).connect(out);
  src.start(at);
  src.stop(at + dur + 0.1);
}

/** ドン: 低い音が下がりながら消える。ざっという音を重ねる */
function boom(ac: AudioContext, out: AudioNode, at: number) {
  const o = ac.createOscillator();
  const g = ac.createGain();
  o.type = "sine";
  o.frequency.setValueAtTime(150, at);
  o.frequency.exponentialRampToValueAtTime(40, at + 0.5);
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(0.9, at + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, at + 0.7);
  o.connect(g).connect(out);
  o.start(at);
  o.stop(at + 0.75);
  const src = ac.createBufferSource();
  src.buffer = noise(ac);
  const f = ac.createBiquadFilter();
  f.type = "lowpass";
  f.frequency.setValueAtTime(2600, at);
  f.frequency.exponentialRampToValueAtTime(180, at + 0.4);
  const gn = ac.createGain();
  gn.gain.setValueAtTime(0.55, at);
  gn.gain.exponentialRampToValueAtTime(0.0001, at + 0.45);
  src.connect(f).connect(gn).connect(out);
  src.start(at);
  src.stop(at + 0.5);
}

const FANFARE = [523.25, 659.25, 783.99, 1046.5]; // ド・ミ・ソ・ド

/** マイルストーンの達成: ためる → ドン（impact 秒あと）→ ファンファーレ（ド・ミ・ソ・ド と和音）→ きらきら */
export function playFanfare(impact: number, volume = 0.45) {
  const ac = audio();
  if (!ac) return;
  const out = output(ac, volume);
  const t0 = ac.currentTime + 0.03;
  rise(ac, out, t0, impact, 260, 3200, 0.35);
  boom(ac, out, t0 + impact);
  const t1 = t0 + impact + 0.08;
  FANFARE.forEach((f, i) => {
    tone(ac, out, t1 + i * 0.1, f, i === FANFARE.length - 1 ? 1.3 : 0.32, "triangle", 0.5);
    tone(ac, out, t1 + i * 0.1, f * 2, 0.2, "sine", 0.08);
  });
  const t2 = t1 + 0.42;
  for (const f of FANFARE) tone(ac, out, t2, f, 1.6, "sawtooth", 0.05);
  for (let i = 0; i < 12; i++) tone(ac, out, t2 + 0.05 + i * 0.06 + Math.random() * 0.03, 1800 + Math.random() * 2600, 0.16, "sine", 0.1);
}

/** 数え上げの音（数が進むたび。step が大きいほど少し高く） */
export function playTick(step: number, volume = 0.22) {
  const ac = audio();
  if (!ac) return;
  tone(ac, output(ac, volume), ac.currentTime + 0.005, 880 * Math.pow(2, Math.min(step, 24) / 24), 0.07, "square", 0.25);
}

/** 数え上げの終わり（チン） */
export function playDing(volume = 0.3) {
  const ac = audio();
  if (!ac) return;
  const out = output(ac, volume);
  const at = ac.currentTime + 0.005;
  tone(ac, out, at, 1567.98, 0.5, "sine", 0.5);
  tone(ac, out, at + 0.04, 2093, 0.6, "sine", 0.35);
}
