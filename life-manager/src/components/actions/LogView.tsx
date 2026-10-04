import { useMemo, useState } from "react";
import { errorRange, logLine } from "../../lib/actions";
import { tr, trx } from "../../lib/i18n";

interface LogViewProps {
  lines: string[];
  /** 長いので後ろだけを読んだ */
  truncated: boolean;
}

/** ジョブのログ。はじめはエラーのまわりだけ（赤い行が手がかり）。「ログをすべて見る」で全部 */
export function LogView({ lines, truncated }: LogViewProps) {
  const [all, setAll] = useState(false);
  const range = useMemo(() => errorRange(lines), [lines]);
  const start = all ? 0 : range.start;
  const end = all ? lines.length : range.end;
  const shown = useMemo(
    () =>
      lines
        .slice(start, end)
        .map((line, i) => ({ n: start + i + 1, ...logLine(line) }))
        .filter((l) => !(l.kind === "debug" && l.text === "")),
    [lines, start, end],
  );
  const cut = start > 0 || end < lines.length;

  return (
    <div className="ac-log">
      {lines.length === 0 ? (
        <div className="ac-log-note">{tr("ログは空です。")}</div>
      ) : (
        <>
          {!all && start > 0 && <div className="ac-log-note">{trx("…（エラーのまわりだけを出しています。上に {start} 行）", { start })}</div>}
          {all && truncated && <div className="ac-log-note">{trx("…（長いので、最後の {length} 行だけです）", { length: lines.length })}</div>}
          {shown.map((l) => (
            <div key={l.n} className={`ac-log-line k-${l.kind}`}>
              <span className="ac-log-n">{l.n}</span>
              <span className="ac-log-t">{l.text}</span>
            </div>
          ))}
        </>
      )}
      {(cut || all) && lines.length > 0 && (
        <button type="button" className="ac-log-toggle" onClick={() => setAll((v) => !v)}>
          {all ? tr("エラーのまわりだけにする") : tr("ログをすべて見る（{length} 行）", { length: lines.length })}
        </button>
      )}
    </div>
  );
}
