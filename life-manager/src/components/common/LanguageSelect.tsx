import { LANGS, currentLang, setLang, type Lang } from "../../lib/i18n";

/** どの言語の人でも見つけられるよう、名前は 4 つの言語で並べる（訳さない） */
const LABEL = "言語 / Language / 语言 / 語言";

/** 画面の言語を選ぶ（#256）。選ぶと覚えて、画面を読み直す */
export function LanguageSelect({ className }: { className?: string }) {
  return (
    <label className={`lang-select${className ? ` ${className}` : ""}`} title={LABEL}>
      <span className="lang-select-icon" aria-hidden="true">
        🌐
      </span>
      <select className="select-sm" value={currentLang()} aria-label={LABEL} onChange={(e) => setLang(e.target.value as Lang)}>
        {LANGS.map((l) => (
          <option key={l.key} value={l.key}>
            {l.name}
          </option>
        ))}
      </select>
    </label>
  );
}
