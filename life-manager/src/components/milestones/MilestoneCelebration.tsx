import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { MILESTONE_CLEAR_EVENT, type MilestoneClearDetail } from "../../lib/celebrate";
import { isEscape } from "../../lib/keys";
import { usePortalHost } from "../../hooks/usePortalHost";
import { StageArt } from "./StageArt";
import { Buncho } from "../common/Buncho";
import { bunchoFlock } from "../../lib/buncho";
import { playDing, playFanfare, playTick } from "../../lib/celebrateSound";
import { CelebrationFx, IMPACT } from "./CelebrationFx";
import { tr, trx } from "../../lib/i18n";

interface MilestoneCelebrationProps {
  /** 画面の動きが「ふつう」か（少なめなら、動かさずに出す） */
  motion: boolean;
  /** 「マイルストーンを閉じる」（GitHub のマイルストーンを閉じる） */
  onCloseMilestone: (n: number) => Promise<void>;
  /** お祝いの音を鳴らすか（設定 → 表示） */
  sound: boolean;
}

/** 演出の種類: トロフィー・花火・ステージクリア（クエストはボス撃破）・大きなはんこ。金魚のテーマは、いつも夜の夏まつり。文鳥のテーマは、いつも朝のさえずり */
type Pattern = "trophy" | "fireworks" | "clear" | "stamp" | "matsuri" | "saezuri";
const PATTERNS: Pattern[] = ["trophy", "fireworks", "clear", "stamp"];

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const SPARKS = ["var(--spark-1)", "var(--spark-2)", "var(--spark-3)", "var(--spark-4)", "var(--spark-5)", "var(--spark-6)", "var(--spark-7)", "var(--spark-8)"];

/**
 * 数を 0 から数え上げる（#231）。数が進むたびに音を鳴らし、終わると「チン」と鳴って、ぽんと大きくなる。
 * 「23pt」「2 日前」のように、頭の数だけを数える（数でないもの「ぴったり」は、そのまま）
 */
function CountUp({ text, delay, sound, still }: { text: string; delay: number; sound: boolean; still: boolean }) {
  const m = text.match(/^(\d+(?:\.\d+)?)(.*)$/);
  const target = m ? Number(m[1]) : null;
  const decimals = m && m[1].includes(".") ? m[1].split(".")[1].length : 0;
  const [n, setN] = useState(still || target === null ? target : 0);
  const [done, setDone] = useState(still || target === null);
  useEffect(() => {
    if (still || target === null) return;
    let raf = 0;
    let lastTick = 0;
    let lastValue = 0;
    const t0 = performance.now() + delay * 1000;
    const dur = Math.min(1100, 300 + target * 45);
    const step = (now: number) => {
      const p = Math.max(0, Math.min(1, (now - t0) / dur));
      const v = (1 - Math.pow(1 - p, 3)) * target;
      setN(v);
      const whole = Math.floor(v);
      // 音は、数が進んだときに。続けて鳴らしすぎないよう、少し間をあける
      if (sound && whole > lastValue && now - lastTick > 45) {
        lastTick = now;
        lastValue = whole;
        playTick(whole);
      }
      if (p < 1) {
        raf = requestAnimationFrame(step);
      } else {
        setN(target);
        setDone(true);
        if (sound) playDing();
      }
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // はじめに 1 回だけ数える
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (target === null || n === null) return <b>{text}</b>;
  return (
    <b className={`ms-cel-num${done ? " done" : ""}`}>
      {decimals ? n.toFixed(decimals) : Math.floor(n)}
      {m![2]}
    </b>
  );
}

/** 期限まで何日残したか（「2 日前」「ぴったり」「3 日」） */
function timingOf(leftDays: number | null): { value: string; label: string } | null {
  if (leftDays === null) return null;
  if (leftDays > 0) return { value: tr("{leftDays} 日前", { leftDays }), label: tr("期限より") };
  if (leftDays === 0) return { value: tr("ぴったり"), label: tr("期限の日に") };
  return { value: tr("{v} 日", { v: -leftDays }), label: tr("期限をすぎて") };
}

function Trophy() {
  return (
    <svg viewBox="0 0 120 140" className="ms-cel-trophy" aria-hidden="true">
      <path className="t-handle" d="M22 26 C2 26 2 62 30 66 M98 26 C118 26 118 62 90 66" />
      <path className="t-cup" d="M20 10 H100 V40 C100 74 82 90 60 92 C38 90 20 74 20 40 Z" />
      <path className="t-star" d="M60 30 l6 12 13 2 -9.5 9 2.3 13 -11.8 -6.2 -11.8 6.2 2.3 -13 -9.5 -9 13 -2 z" />
      <rect className="t-cup" x="52" y="92" width="16" height="16" />
      <rect className="t-cup" x="36" y="108" width="48" height="12" rx="3" />
      <rect className="t-base" x="28" y="120" width="64" height="12" rx="3" />
    </svg>
  );
}

/** 花火（何発か。字にかからないよう上と左右に。場所・色・遅れはばらばら） */
function Fireworks() {
  const bursts = useMemo(
    () =>
      Array.from({ length: 9 }, (_, i) => {
        // 半分は上の帯、半分は左右の端
        const top = i % 2 === 0;
        const x = top ? rand(14, 86) : i % 4 === 1 ? rand(6, 20) : rand(80, 94);
        const y = top ? rand(8, 26) : rand(30, 70);
        return { x, y, r: rand(90, 160), color: SPARKS[i % SPARKS.length], delay: i * 0.3 + rand(0, 0.2) };
      }),
    [],
  );
  return (
    <div className="ms-cel-fw" aria-hidden="true">
      {bursts.map((b, i) => (
        <svg key={i} className="ms-cel-burst" viewBox="-150 -150 300 300"
          style={{ left: `${b.x}%`, top: `${b.y}%`, width: b.r * 2, height: b.r * 2, animationDelay: `${b.delay}s`, color: b.color } as CSSProperties}>
          {Array.from({ length: 24 }, (_, k) => {
            const a = (k / 24) * Math.PI * 2;
            return (
              <g key={k}>
                <line x1={Math.cos(a) * 30} y1={Math.sin(a) * 30} x2={Math.cos(a) * 120} y2={Math.sin(a) * 120 + 10} />
                <circle cx={Math.cos(a) * 132} cy={Math.sin(a) * 132 + 16} r="4" />
              </g>
            );
          })}
        </svg>
      ))}
    </div>
  );
}

/** 紙ふぶき（上から舞い落ちる） */
function Confetti() {
  const pieces = useMemo(
    () => Array.from({ length: 70 }, (_, i) => ({ x: rand(0, 100), delay: rand(0, 1.6), dur: rand(2.6, 4.4), r: rand(0, 360), color: SPARKS[i % SPARKS.length] })),
    [],
  );
  return (
    <div className="ms-cel-confetti" aria-hidden="true">
      {pieces.map((p, i) => (
        <i key={i} style={{ left: `${p.x}%`, animationDelay: `${p.delay}s`, animationDuration: `${p.dur}s`, background: p.color, "--r": `${p.r}deg` } as CSSProperties} />
      ))}
    </div>
  );
}

/** はんこ（黒板・スプリングは花丸、クエストは「撃破」、ほかは「達成」） */
function Stamp({ theme, title }: { theme: string; title: string }) {
  if (theme === "chalk" || theme === "spring") {
    const petals = Array.from({ length: 12 }, (_, i) => {
      const a = (Math.PI * 2 * i) / 12;
      return <circle key={i} cx={100 + Math.cos(a) * 78} cy={100 + Math.sin(a) * 78} r="18" />;
    });
    return (
      <svg viewBox="0 0 200 200" className="ms-cel-stamp hanamaru" aria-hidden="true">
        <g className="h-petals">{petals}</g>
        <circle className="h-ring" cx="100" cy="100" r="70" />
        <circle className="h-ring thin" cx="100" cy="100" r="60" />
        <text className="h-text" x="100" y="94" textAnchor="middle">{tr("よく")}</text>
        <text className="h-text" x="100" y="124" textAnchor="middle">{tr("できました")}</text>
      </svg>
    );
  }
  const word = theme === "quest" ? tr("撃破") : tr("達成");
  const now = new Date();
  const date = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, "0")}.${String(now.getDate()).padStart(2, "0")}`;
  return (
    <svg viewBox="0 0 330 330" className="ms-cel-stamp hanko" aria-hidden="true">
      <defs>
        <path id="ms-cel-arc" d="M 60 165 A 105 105 0 0 1 270 165" />
        <path id="ms-cel-arc2" d="M 74 175 A 92 92 0 0 0 256 175" />
      </defs>
      <circle className="k-ring" cx="165" cy="165" r="140" />
      <circle className="k-ring thin" cx="165" cy="165" r="118" />
      <text className="k-small"><textPath href="#ms-cel-arc" startOffset="50%" textAnchor="middle">{title.length > 14 ? `${title.slice(0, 13)}…` : title}</textPath></text>
      <text className="k-word" x="165" y="198" textAnchor="middle">{word}</text>
      <text className="k-date"><textPath href="#ms-cel-arc2" startOffset="50%" textAnchor="middle">{date}</textPath></text>
      <g className="k-ink"><circle cx="30" cy="70" r="7" /><circle cx="300" cy="260" r="9" /><circle cx="286" cy="52" r="5" /><circle cx="44" cy="276" r="6" /></g>
    </svg>
  );
}

/**
 * マイルストーンを達成したときの演出（画面全体を暗くして、大きく祝う）。トロフィー・花火・ステージクリア（クエストはボス撃破）・
 * 大きなはんこ から、毎回ちがうものを出す。終えたタスクの数・見積もり・期限まで何日残したかと、かかわった人を出す。
 * まだ GitHub でマイルストーンを閉じていなければ「マイルストーンを閉じる」も。どこかを押すか Esc で閉じる
 */
export function MilestoneCelebration({ motion, onCloseMilestone, sound }: MilestoneCelebrationProps) {
  const [cel, setCel] = useState<{ detail: MilestoneClearDetail; pattern: Pattern; id: number } | null>(null);
  const [closing, setClosing] = useState(false);
  const lastPattern = useRef(-1);
  const host = usePortalHost();

  useEffect(() => {
    function onClear(e: Event) {
      const detail = (e as CustomEvent<MilestoneClearDetail>).detail;
      setClosing(false);
      const theme = document.documentElement.dataset.theme;
      if (theme === "kingyo" || theme === "buncho") {
        setCel({ detail, pattern: theme === "kingyo" ? "matsuri" : "saezuri", id: Date.now() });
        return;
      }
      let n = Math.floor(Math.random() * PATTERNS.length);
      if (n === lastPattern.current) n = (n + 1) % PATTERNS.length;
      lastPattern.current = n;
      setCel({ detail, pattern: PATTERNS[n], id: Date.now() });
    }
    window.addEventListener(MILESTONE_CLEAR_EVENT, onClear);
    return () => window.removeEventListener(MILESTONE_CLEAR_EVENT, onClear);
  }, []);

  // お祝いの音（ためる → ドン → ファンファーレ）。ドンは、閃光と火花と同じとき
  const celId = cel?.id;
  useEffect(() => {
    if (celId !== undefined && sound) playFanfare(IMPACT);
  }, [celId, sound]);

  useEffect(() => {
    if (!cel) return;
    function onKey(e: KeyboardEvent) {
      if (isEscape(e)) setCel(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cel]);

  if (!cel || !host) return null;
  const { detail: d, pattern } = cel;
  const theme = document.documentElement.dataset.theme ?? "chalk";
  const quest = theme === "quest";
  const still = !motion || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const timing = timingOf(d.leftDays);
  const stars = d.leftDays === null || d.leftDays >= 0 ? 3 : 2;

  async function closeMilestone() {
    setClosing(true);
    try {
      await onCloseMilestone(d.number);
      setCel(null);
    } catch {
      setClosing(false);
    }
  }

  // 数は、ドンのあと中身が出てから、1 つずつ数え上げる
  const countAt = (i: number) => IMPACT + 0.55 + i * 0.3;
  const stats = (
    <div className="ms-cel-stats">
      <div><CountUp text={String(d.doneCount)} delay={countAt(0)} sound={sound} still={still} /><span>{quest ? tr("倒したタスク") : tr("終えたタスク")}</span></div>
      {d.amount && <div><CountUp text={d.amount} delay={countAt(1)} sound={sound} still={still} /><span>{quest ? tr("経験値") : tr("見積もり")}</span></div>}
      {timing && <div><CountUp text={timing.value} delay={countAt(2)} sound={sound} still={still} /><span>{timing.label}</span></div>}
    </div>
  );
  // チームの顔は、1 人ずつ飛び出す
  const team = d.team.length > 0 && (
    <div className="ms-cel-team">
      {d.team.map((u, i) =>
        u.avatar_url ? (
          <img key={u.login} src={u.avatar_url} alt="" title={u.login} style={{ "--i": i } as CSSProperties} />
        ) : (
          <span key={u.login} title={u.login} style={{ "--i": i } as CSSProperties}>
            {u.login.slice(0, 1).toUpperCase()}
          </span>
        ),
      )}
      {quest ? tr("パーティのみんなで") : tr("チームのみんなで")}
    </div>
  );

  let body;
  if (pattern === "trophy") {
    body = (
      <>
        <Trophy />
        <div className="ms-cel-kick">{quest ? "BOSS DEFEATED" : "MILESTONE COMPLETE"}</div>
        <div className="ms-cel-title">{d.title} {quest ? tr("撃破！") : tr("達成！")}</div>
        <div className="ms-cel-sub">{trx("{doneCount} 件のタスクをぜんぶ終えました", { doneCount: d.doneCount })}</div>
        {stats}
        {team}
      </>
    );
  } else if (pattern === "fireworks") {
    body = (
      <>
        <div className="ms-cel-kick sky">MISSION COMPLETE</div>
        <div className="ms-cel-title sky">{trx("{title} クリア！", { title: d.title })}</div>
        <div className="ms-cel-sub">{tr("おつかれさまでした")}</div>
        {stats}
        {team}
      </>
    );
  } else if (pattern === "matsuri") {
    body = (
      <>
        <div className="ms-cel-lanterns" aria-hidden="true">
          {Array.from({ length: 7 }, (_, i) => (
            <span key={i} style={{ animationDelay: `${0.2 + i * 0.18}s` }}>{tr("祭")}</span>
          ))}
        </div>
        <div className="ms-cel-kick sky">SUMMER FESTIVAL</div>
        <div className="ms-cel-title sky">{trx("{title} 達成！", { title: d.title })}</div>
        <div className="ms-cel-sub">{tr("夏まつりだ。おつかれさまでした")}</div>
        {stats}
        {team}
      </>
    );
  } else if (pattern === "saezuri") {
    // チームの人数だけ（3〜7 羽）、文鳥が 1 羽ずつ枝にとまって歌う
    const flock = bunchoFlock(Math.min(7, Math.max(3, d.team.length)));
    body = (
      <>
        <div className="ms-cel-perch" aria-hidden="true">
          {flock.map((kind, i) => (
            <span key={i} style={{ animationDelay: `${0.25 + i * 0.22}s` }}>
              <Buncho kind={kind} flip={i % 2 === 0} />
              {i % 2 === 1 && <i className="ms-cel-song" style={{ animationDelay: `${1.2 + i * 0.3}s` }}>{i % 4 === 1 ? "♪" : "♫"}</i>}
            </span>
          ))}
        </div>
        <div className="ms-cel-kick sky">MORNING SONG</div>
        <div className="ms-cel-title sky">{trx("{title} 達成！", { title: d.title })}</div>
        <div className="ms-cel-sub">{tr("朝のさえずり。おつかれさまでした")}</div>
        {stats}
        {team}
      </>
    );
  } else if (pattern === "clear") {
    body = quest ? (
      <>
        <div className="ms-cel-boss"><StageArt no={d.no} last={d.last} quest /></div>
        <div className="ms-cel-kick boss">BOSS DEFEATED</div>
        <div className="ms-cel-banner">{tr("ボス撃破！")}</div>
        <div className="ms-cel-sub">{d.title}</div>
        {stats}
      </>
    ) : (
      <>
        <div className="ms-cel-kick">STAGE CLEAR</div>
        <div className="ms-cel-banner">{d.title}</div>
        <div className="ms-cel-stars">{"★".repeat(stars)}<span className="off">{"★".repeat(3 - stars)}</span></div>
        <div className="ms-cel-starnote">{stars === 3 ? tr("★ 期限まで ・ ★ ぜんぶ終えた ・ ★ クリア") : tr("★ ぜんぶ終えた ・ ★ クリア（期限はすぎました）")}</div>
        <div className="ms-cel-tally">
          <div><span>{tr("終えたタスク")}</span><i /><CountUp text={String(d.doneCount)} delay={countAt(0)} sound={sound} still={still} /></div>
          {d.amount && <div><span>{tr("見積もり")}</span><i /><CountUp text={d.amount} delay={countAt(1)} sound={sound} still={still} /></div>}
          {timing && <div><span>{timing.label}</span><i /><CountUp text={timing.value} delay={countAt(2)} sound={sound} still={still} /></div>}
        </div>
      </>
    );
  } else {
    body = (
      <>
        <Stamp theme={theme} title={d.title} />
        <div className="ms-cel-title plain">{tr("おつかれさまでした！")}</div>
        <div className="ms-cel-sub">{trx("{title} のタスク {doneCount} 件をぜんぶ終えました", { title: d.title, doneCount: d.doneCount })}</div>
        {team}
      </>
    );
  }

  return createPortal(
    <div className={`ms-cel p-${pattern}${still ? " still" : ""}`} role="dialog" aria-label={tr("{title} を達成しました", { title: d.title })} onClick={() => setCel(null)}>
      <div className="ms-cel-dim" />
      {(pattern === "trophy" || pattern === "clear") && <div className="ms-cel-rays" />}
      {(pattern === "fireworks" || pattern === "matsuri") && <Fireworks />}
      {pattern === "trophy" && <Confetti />}
      {/* ためる → ドン（閃光・衝撃の輪・光の帯・火花・紙吹雪。#231） */}
      {!still && <CelebrationFx key={`fx${cel.id}`} />}
      <div key={cel.id} className="ms-cel-shake">
      <div className="ms-cel-body" onClick={(e) => e.stopPropagation()}>
        {body}
        <div className="ms-cel-btns">
          {d.canClose ? (
            <>
              <button type="button" className="ms-cel-btn" disabled={closing} onClick={closeMilestone}>
                {closing ? tr("閉じています…") : tr("マイルストーンを閉じる")}
              </button>
              <button type="button" className="ms-cel-btn sub" onClick={() => setCel(null)}>{tr("あとで")}</button>
            </>
          ) : (
            <button type="button" className="ms-cel-btn" autoFocus onClick={() => setCel(null)}>OK</button>
          )}
        </div>
      </div>
      </div>
    </div>,
    host,
  );
}
