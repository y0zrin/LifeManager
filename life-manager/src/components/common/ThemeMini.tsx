import { useLayoutEffect, useRef, useState } from "react";
import type { Theme } from "../../lib/theme";
import { Buncho } from "./Buncho";

/** ミニの画面の、もとの大きさ（入れ物の幅に合わせて縮める） */
const W = 560;

/** 机の名前と、上の小物（テーマごと） */
const DESK: Record<Theme, { name: string; items: string[]; glow?: number; steam?: number }> = {
  chalk: { name: "勉強机", items: ["✏️", "📓"] },
  white: { name: "オフィスのデスク", items: ["💻", "☕"] },
  quest: { name: "ギルドの受付", items: ["📜", "🪙"] },
  night: { name: "夜の机", items: ["🕯️", "☕"], glow: 0 },
  day: { name: "カフェのテーブル", items: ["☕", "🥐"], steam: 0 },
  spring: { name: "春の机", items: ["🍡", "🍵"], steam: 1 },
  winter: { name: "こたつ", items: ["🍊", "🍵"], steam: 1 },
  kingyo: { name: "縁側", items: ["🍉", "🍧"] },
  buncho: { name: "文机", items: ["✉️", "🍵"], steam: 1 },
};

/** ボードの右上の飾り（テーマごと） */
const DECO: Partial<Record<Theme, string>> = { quest: "⚔️", night: "🌙", day: "☀️", spring: "🌸", winter: "❄️" };

/**
 * テーマのミニの画面（動く）: サイドバー・ボード 2 枚（付箋が 1 枚、となりのボードへ運ばれる）・机・後ろの粒。
 * 金魚のテーマでは、水そうの中を金魚が泳ぐ。文鳥のテーマでは、止まり木に文鳥がいる。
 * はじめに見た目を選ぶ画面と、設定 → 表示 のテーマのカードで使う。still で止める
 */
export function ThemeMini({ theme, still = false }: { theme: Theme; still?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);

  // 入れ物の幅に合わせて、まるごと縮める
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => setScale(el.clientWidth / W);
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const desk = DESK[theme];
  const deco = DECO[theme];
  return (
    <div ref={ref} className={`tm tm--${theme}${still ? " still" : ""}`} aria-hidden="true">
      <div className="tm-inner" style={{ transform: `scale(${scale})` }}>
        <div className="tm-stage">
          <i />
          <i />
        </div>
        <div className="tm-side">
          <b>Life Manager</b>
          <span />
          <span />
          <span className="on" />
          <span />
          <span />
          <span />
        </div>
        <div className="tm-main">
          <div className="tm-top">ボード</div>
          <div className="tm-boards">
            <div className="tm-board">
              {theme === "kingyo" && (
                <>
                  <span className="tm-fish" />
                  <span className="tm-fish f2" />
                </>
              )}
              {theme === "buncho" && (
                <span className="tm-bird">
                  <Buncho flip />
                </span>
              )}
              <b>進行中</b>
              {deco && <span className="tm-deco">{deco}</span>}
              <div className="tm-note">#11 ジャンプを作る</div>
              <div className="tm-note tm-carry">#12 敵が左右に歩く</div>
            </div>
            <div className="tm-board">
              {theme === "kingyo" && <span className="tm-fish f3" />}
              <b>チェック待ち</b>
              {deco && <span className="tm-deco">{deco}</span>}
              <div className="tm-note n2">#15 当たり判定</div>
            </div>
          </div>
          <div className="tm-desk">
            <small>{desk.name}</small>
            <span className="grow" />
            {theme === "kingyo" && <span className="tm-furin" />}
            {desk.items.map((x, i) => (
              <span key={i} className={desk.glow === i ? "tm-glow" : desk.steam === i ? "tm-steam" : undefined}>
                {x}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
