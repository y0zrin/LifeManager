import { useId, type JSX } from "react";

// マイルストーンの画面の絵。クエストはボス（番号で決まる。最後は城）、ほかのテーマは「STAGE 3」の印（最後はゴールの旗）。
// 色は CSS（.stage-art）で付ける

function Slime({ id }: { id: string }) {
  return (
    <svg viewBox="0 0 220 200" className="stage-art boss-slime" aria-hidden="true">
      <defs>
        <radialGradient id={`${id}b`} cx=".4" cy=".35" r=".75">
          <stop offset="0" className="g1" /><stop offset=".6" className="g2" /><stop offset="1" className="g3" />
        </radialGradient>
        <linearGradient id={`${id}c`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" className="gold1" /><stop offset="1" className="gold2" />
        </linearGradient>
      </defs>
      <ellipse className="shadow" cx="110" cy="188" rx="88" ry="10" />
      <path className="body" style={{ fill: `url(#${id}b)` }} d="M22 180 C 10 130, 40 70, 110 64 C 180 70, 210 130, 198 180 C 170 190, 50 190, 22 180 Z" />
      <ellipse className="shine" cx="78" cy="96" rx="22" ry="11" transform="rotate(-20 78 96)" />
      <ellipse className="eye" cx="85" cy="125" rx="16" ry="18" /><ellipse className="eye" cx="138" cy="125" rx="16" ry="18" />
      <circle className="pupil" cx="90" cy="130" r="8" /><circle className="pupil" cx="133" cy="130" r="8" />
      <circle className="eye" cx="92" cy="127" r="2.5" /><circle className="eye" cx="135" cy="127" r="2.5" />
      <path className="line" d="M66 104 L100 114 M156 104 L122 114" />
      <path className="line thin" d="M84 156 Q111 172 138 156" />
      <path className="eye" d="M94 160 l5 10 5 -8 Z M118 162 l5 8 5 -10 Z" />
      <path className="crown" style={{ fill: `url(#${id}c)` }} d="M72 70 L80 36 L96 58 L110 28 L124 58 L140 36 L148 70 Z" />
      <circle className="gem" cx="110" cy="56" r="5" />
    </svg>
  );
}

function Golem() {
  return (
    <svg viewBox="0 0 220 200" className="stage-art boss-golem" aria-hidden="true">
      <ellipse className="shadow" cx="110" cy="190" rx="80" ry="9" />
      <rect className="rock2" x="28" y="92" width="36" height="70" rx="14" />
      <rect className="rock2" x="156" y="92" width="36" height="70" rx="14" />
      <rect className="rock" x="60" y="80" width="100" height="95" rx="18" />
      <rect className="rock3" x="75" y="40" width="70" height="50" rx="14" />
      <path className="crack" d="M78 120 l20 8 M130 110 l14 16 M104 150 l-6 14" />
      <circle className="glow" cx="96" cy="64" r="6" /><circle className="glow" cx="124" cy="64" r="6" />
      <rect className="mouth" x="98" y="76" width="24" height="5" rx="2" />
    </svg>
  );
}

function Ghost({ id }: { id: string }) {
  return (
    <svg viewBox="0 0 220 200" className="stage-art boss-ghost" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}g`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" className="g1" /><stop offset="1" className="g2" />
        </linearGradient>
      </defs>
      <ellipse className="shadow" cx="110" cy="192" rx="60" ry="7" />
      <path className="body" style={{ fill: `url(#${id}g)` }}
        d="M50 176 V 92 C 50 38, 170 38, 170 92 V 176 l -20 -14 -20 14 -20 -14 -20 14 -20 -14 -20 14 Z" />
      <path className="arm" d="M52 110 C 30 112, 24 130, 30 142 M168 110 C 190 112, 196 130, 190 142" />
      <ellipse className="hole" cx="88" cy="96" rx="11" ry="15" /><ellipse className="hole" cx="132" cy="96" rx="11" ry="15" />
      <circle className="spark" cx="90" cy="100" r="3" /><circle className="spark" cx="134" cy="100" r="3" />
      <ellipse className="hole" cx="110" cy="136" rx="14" ry="12" />
    </svg>
  );
}

function Demon() {
  return (
    <svg viewBox="0 0 220 200" className="stage-art boss-demon" aria-hidden="true">
      <ellipse className="shadow" cx="110" cy="190" rx="70" ry="8" />
      <path className="wing" d="M100 100 C 70 56, 26 58, 8 92 C 30 96, 40 112, 44 128 C 60 116, 80 118, 100 132 Z" />
      <path className="wing" d="M120 100 C 150 56, 194 58, 212 92 C 190 96, 180 112, 176 128 C 160 116, 140 118, 120 132 Z" />
      <path className="horn" d="M88 84 l -10 -30 22 18 Z M132 84 l 10 -30 -22 18 Z" />
      <ellipse className="body" cx="110" cy="118" rx="36" ry="40" />
      <ellipse className="eye" cx="97" cy="108" rx="8" ry="6" /><ellipse className="eye" cx="123" cy="108" rx="8" ry="6" />
      <rect className="pupil" x="95.5" y="103" width="3" height="10" rx="1.5" /><rect className="pupil" x="121.5" y="103" width="3" height="10" rx="1.5" />
      <path className="line thin" d="M96 132 Q110 142 124 132" />
      <path className="fang" d="M101 134 l3 8 3 -6 Z M113 136 l3 6 3 -8 Z" />
    </svg>
  );
}

function Castle() {
  return (
    <svg viewBox="0 0 220 200" className="stage-art boss-castle" aria-hidden="true">
      <rect className="wall" x="40" y="96" width="140" height="84" />
      <rect className="tower" x="30" y="62" width="40" height="118" /><rect className="tower" x="150" y="62" width="40" height="118" />
      <path className="roof" d="M26 64 l24 -34 24 34 Z M146 64 l24 -34 24 34 Z" />
      <path className="battle" d="M40 96 h14 v-10 h14 v10 h14 v-10 h14 v10 h14 v-10 h14 v10 h14 v-10 h14 v10 h14" />
      <rect className="gate" x="95" y="130" width="30" height="50" rx="15" />
      <path className="pole" d="M110 30 v56" /><path className="flag" d="M110 30 h28 l-7 8 7 8 h-28 z" />
      <circle className="win" cx="50" cy="96" r="5" /><circle className="win" cx="170" cy="96" r="5" />
    </svg>
  );
}

function StageBadge({ no }: { no: number }) {
  return (
    <svg viewBox="0 0 120 120" className="stage-art stage-badge" aria-hidden="true">
      <circle className="ring" cx="60" cy="60" r="52" />
      <circle className="face" cx="60" cy="60" r="44" />
      <text className="word" x="60" y="30" textAnchor="middle">STAGE</text>
      <text className="num" x="60" y="84" textAnchor="middle" style={{ fontSize: no >= 10 ? 44 : 58 }}>{no}</text>
    </svg>
  );
}

function GoalFlag() {
  return (
    <svg viewBox="0 0 120 120" className="stage-art stage-goal" aria-hidden="true">
      <circle className="ring" cx="60" cy="60" r="52" />
      <path className="pole" d="M48 94 V28" />
      <path className="flag" d="M48 28 h34 l-9 10 9 10 h-34 z" />
    </svg>
  );
}

const BOSSES: ((props: { id: string }) => JSX.Element)[] = [Slime, Golem, Ghost, Demon];

/** ステージの絵（クエストはボス。倒した・終えたかどうかは、外側の CSS で灰色にする） */
export function StageArt({ no, last, quest }: { no: number; last: boolean; quest: boolean }) {
  const id = useId().replace(/:/g, "");
  if (quest) {
    if (last) return <Castle />;
    const Boss = BOSSES[(no - 1) % BOSSES.length];
    return <Boss id={id} />;
  }
  return last ? <GoalFlag /> : <StageBadge no={no} />;
}
