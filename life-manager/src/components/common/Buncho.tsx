import { useId, useState, type CSSProperties } from "react";
import { PARTNER, type BunchoKind } from "../../lib/buncho";

/** 体の形（体のぬり・中の色を切りぬく形） */
const BODY = "M232 66 C290 84 366 160 380 246 L400 270 Q406 280 398 284 L330 280 C318 283 310 292 296 295 C250 299 150 299 104 289 C80 282 60 266 51 244 C44 224 43 196 50 172 L120 150 Z";
/** くちばしの形 */
const BEAK = "M100 76 C82 72 60 78 46 92 C32 106 26 124 28 142 C30 154 40 158 56 158 C80 158 104 158 118 152 C128 146 131 134 128 122 C124 106 114 88 100 76 Z";
/** 頭（黒い帽子）の形 */
const CAP = "M44.5 96 C48 58 92 16 145 15.5 C182 15 214 32 228 60 C234 74 237 88 236 100 C214 128 178 156 138 170 C116 178 88 176 66 164 C54 150 46 128 44.5 96 Z";
/** 足（線の上に色の線を重ねて、ふちどりにする） */
const FEET = "M146 290 L140 314 M140 314 L116 318 M140 314 L142 332 M140 314 L162 326 M246 288 L252 312 M252 312 L232 328 M252 312 L262 330 M252 312 L280 318";

interface BunchoProps {
  /** 色（はじめはパートナー＝起動ごとにランダム） */
  kind?: BunchoKind;
  /** 右を向く（絵はもとは左向き） */
  flip?: boolean;
  /** 足もとに影（地面に立つとき。止まり木では出さない） */
  ground?: boolean;
  /** 手紙をくわえる */
  letter?: boolean;
  className?: string;
}

/**
 * 文鳥（文鳥のテーマのパートナー）。太い輪郭・大きな丸い頭・丸い赤いくちばし・黒い目・白いほお。
 * うごき（体ごと首をかしげる・まばたき・ときどき跳ねる）は App.css の .bk。止まり木・上のバー・送っているあいだ・お祝いで使う
 */
export function Buncho({ kind = PARTNER, flip = false, ground = false, letter = false, className }: BunchoProps) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const body = `bkb${id}`;
  const beak = `bkk${id}`;
  // 何羽もいるとき、そろって動かないように、うごきの始まりをずらす
  const [delay] = useState(() => `${-(Math.random() * 9).toFixed(2)}s`);
  const cls = ["bk", `bk--${kind}`, flip && "bk--flip", ground && "bk--ground", letter && "bk--letter", className].filter(Boolean).join(" ");
  return (
    <svg className={cls} viewBox="0 0 426 340" aria-hidden="true" style={{ "--bk-d": delay } as CSSProperties}>
      <defs>
        <clipPath id={body}>
          <path d={BODY} />
        </clipPath>
        <clipPath id={beak}>
          <path d={BEAK} />
        </clipPath>
      </defs>
      {ground && <ellipse className="bk-shadow" cx="226" cy="318" rx="150" ry="17" />}
      <g className="bk-lean">
        <g className="bk-all">
          <path className="bk-foot-ol" d={FEET} />
          <path className="bk-foot" d={FEET} />
          <path className="bk-body" d={BODY} />
          <g clipPath={`url(#${body})`}>
            <path className="bk-belly" d="M30 230 C80 240 130 247 180 246 C230 245 280 250 322 262 L330 330 L30 330 Z" />
            <path className="bk-tail" d="M318 244 C350 248 380 254 400 262 L420 300 L318 300 Z" />
            <path className="bk-under" d="M316 265 C348 268 378 274 402 281 L400 288 C372 286 344 284 316 282 Z" />
            <path className="bk-throat" d="M62 160 C88 170 116 175 138 170 C144 184 130 198 106 200 C84 202 66 192 58 178 Z" />
            <circle className="bk-hi" cx="288" cy="120" r="17" />
          </g>
          <path className="bk-ol" d="M232 66 C290 84 366 160 380 246 L400 270 Q406 280 398 284 L330 280 C318 283 310 292 296 295 C250 299 150 299 104 289 C80 282 60 266 51 244 C44 224 43 196 50 172 C52 164 56 156 62 150" />
          <path className="bk-ol" d="M222 194 C240 214 270 232 310 241 C340 247 370 252 396 261" />
          <path className="bk-cap" d={CAP} />
          <path className="bk-cheek" d="M178 96 L222 95 Q228 99 221 108 L152 164 Q140 169 135 157 L134 140 Q134 130 146 121 Z" />
          <path className="bk-ol" d="M66 164 C54 150 46 128 44.5 96 C48 58 92 16 145 15.5 C182 15 214 32 228 60 C234 74 237 88 236 100 C214 128 178 156 138 170 C116 178 88 176 66 164" />
          <circle className="bk-caphi" cx="188" cy="46" r="13" />
          <g className="bk-eyes">
            <ellipse className="bk-eye" cx="160.5" cy="95.5" rx="11.5" ry="17.5" />
          </g>
          <path className="bk-beak" d={BEAK} />
          <g clipPath={`url(#${beak})`}>
            <path className="bk-beak-shade" d="M20 148 C60 138 110 138 140 146 L140 170 L20 170 Z" />
          </g>
          <path className="bk-beak-hi" d="M42 136 C40 116 52 98 74 88" />
          <circle className="bk-beak-dot" cx="86" cy="84" r="4.5" />
          <path className="bk-ol" d={BEAK} />
          {letter && (
            <g className="bk-letter" transform="translate(-58 118) rotate(10)">
              <rect x="0" y="0" width="92" height="62" rx="6" />
              <path className="bk-flap" d="M3 3 L46 36 L89 3" />
              <circle className="bk-seal" cx="46" cy="36" r="9" />
            </g>
          )}
        </g>
      </g>
    </svg>
  );
}
