import { useCallback, useEffect, useState } from "react";
import { THEMES, type Theme } from "../../lib/theme";
import { ThemeMini } from "./ThemeMini";
import { isMobile } from "../../lib/platform";
import { tr, trx } from "../../lib/i18n";
import { LanguageSelect } from "./LanguageSelect";

/** はじめに見た目を選んだ印（この PC に。はじめて起動したときだけ出すため） */
const CHOSEN_KEY = "theme-chosen";

/** はじめて起動したときに、見た目を選ぶ画面を出すか（まだ選んでいない・表示の設定を一度も変えていない） */
export function needsThemeChoice(): boolean {
  try {
    return !localStorage.getItem(CHOSEN_KEY) && !localStorage.getItem("display-settings");
  } catch {
    return false;
  }
}

export function markThemeChosen() {
  try {
    localStorage.setItem(CHOSEN_KEY, "1");
  } catch {
    // 覚えられなければ、次の起動でもう一度出る
  }
}

/** i 番目が、選んでいる所から何枚となりか（輪のように。-1 = 左どなり） */
function offsetOf(i: number, at: number, n: number): number {
  let d = (i - at + n) % n;
  if (d > n / 2) d -= n;
  return d;
}

function placeOf(d: number): string {
  if (d === 0) return "on";
  if (d === -1) return "side left";
  if (d === 1) return "side right";
  return d < 0 ? "far left" : "far right";
}

interface ThemePickerProps {
  initial: Theme;
  /** 選んでいるテーマを、画面ぜんたいに当てて見せる */
  onPreview: (theme: Theme) => void;
  /** 「このテーマではじめる」 */
  onDone: (theme: Theme) => void;
}

/**
 * はじめに見た目を選ぶ画面（はじめて起動したとき、GitHub にログインする前）。選ぶ画面と同じ作りで、まん中に大きく、左右にとなりのテーマ。
 * カードには、そのテーマのミニの画面が動く。選んでいるテーマを画面ぜんたいに当てるので、後ろの舞台（動く背景）も変わる。← → で選んで Enter ではじめる
 */
export function ThemePicker({ initial, onPreview, onDone }: ThemePickerProps) {
  const n = THEMES.length;
  const [at, setAt] = useState(() => Math.max(0, THEMES.findIndex((t) => t.key === initial)));
  const focused = THEMES[at];

  useEffect(() => {
    onPreview(focused.key);
  }, [focused.key, onPreview]);

  const move = useCallback((step: number) => setAt((i) => (i + step + n) % n), [n]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        move(-1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        move(1);
      } else if (e.key === "Enter" && !(e.target as HTMLElement).closest?.("button")) {
        e.preventDefault();
        onDone(THEMES[at].key);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [at, move, onDone]);

  return (
    <div className="picker tp" role="dialog" aria-label={tr("見た目を選ぶ")}>
      <div className="picker-top">
        {trx("<0>L</0><1>Life Manager へようこそ</1>", undefined, [<span className="picker-logo" aria-hidden="true" />, <span />])}
        <span className="picker-grow" />
        <LanguageSelect className="lang-select--picker" />
        <div className="tp-steps" aria-label={tr("はじめの手順")}>
          {trx("<0>1. 見た目</0><1>2. GitHub にログイン</1><2>3. 使い方を選ぶ</2><3>4. 準備する</3>", undefined, [<span className="on" />, <span />, <span />, <span />])}
        </div>
      </div>
      <h2 className="picker-title">{tr("好きな見た目を選んでください")}</h2>
      <p className="tp-sub">
        {trx("アプリぜんたいの色、ボード、机が変わります。<0>あとから 設定 → 表示 でいつでも変えられます</0>", undefined, [<b />])}
      </p>

      <div className="picker-deck">
        {THEMES.map((t, i) => {
          const d = offsetOf(i, at, n);
          if (Math.abs(d) > 2) return null;
          return (
            <div key={t.key} className={`picker-card tp-card ${placeOf(d)}`} role={d === 0 ? undefined : "button"} tabIndex={-1}
              aria-hidden={Math.abs(d) > 1 || undefined} onClick={d === 0 ? undefined : () => move(d)} title={d === 0 ? undefined : tr("{label} を選ぶ", { label: t.label })}>
              <ThemeMini theme={t.key} still={d !== 0} />
              <div className="tp-foot">
                <div>
                  <b className="tp-name">{t.label}</b>
                  <small>{t.about}</small>
                </div>
                {d === 0 && (
                  <button type="button" className="picker-open" onClick={() => onDone(t.key)} autoFocus>
                    {tr("このテーマではじめる")}
                  </button>
                )}
              </div>
            </div>
          );
        })}
        <button type="button" className="picker-arrow left" onClick={() => move(-1)} aria-label={tr("前のテーマ")} tabIndex={-1}>‹</button>
        <button type="button" className="picker-arrow right" onClick={() => move(1)} aria-label={tr("次のテーマ")} tabIndex={-1}>›</button>
      </div>

      <div className="picker-strip">
        {THEMES.map((t, i) => (
          <button key={t.key} type="button" className={i === at ? "on" : ""} onClick={() => move(offsetOf(i, at, n))} onDoubleClick={() => onDone(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      {!isMobile && (<div className="picker-hint" aria-hidden="true">
        <span>{trx("<0>← →</0>選ぶ", undefined, [<b />])}</span>
        <span>{trx("<0>Enter</0>このテーマではじめる", undefined, [<b />])}</span>
      </div>)}
    </div>
  );
}
