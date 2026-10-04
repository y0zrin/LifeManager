import { splitCode } from "../../lib/help";
import { tr } from "../../lib/i18n";

/** 「`feature/hitbox`（作業中の変更 2）」の `…` を、コードにして出す */
export function CodeLine({ text }: { text: string }) {
  return (
    <>
      {splitCode(text).map((p, i) => (p.code ? <code key={i}>{p.text}</code> : <span key={i}>{p.text}</span>))}
    </>
  );
}

/** 🆘 に添えた、いっしょに送ったもの（ブランチ・最後に失敗した git・競合しているファイルと、git のメッセージ） */
export function HelpContextBox({ items, log, title = tr("いっしょに送ったもの") }: { items: string[]; log: string | null; title?: string }) {
  if (items.length === 0 && !log) return null;
  return (
    <div className="help-ctx">
      <div className="help-ctx-title">{title}</div>
      {items.length > 0 && (
        <ul>
          {items.map((line, i) => (
            <li key={i}>
              <CodeLine text={line} />
            </li>
          ))}
        </ul>
      )}
      {log && <pre className="help-ctx-log">{log}</pre>}
    </div>
  );
}
