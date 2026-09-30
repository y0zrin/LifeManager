import { useMemo, useState } from "react";
import { errorRange, logLine } from "../../lib/actions";

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
        <div className="ac-log-note">ログは空です。</div>
      ) : (
        <>
          {!all && start > 0 && <div className="ac-log-note">…（エラーのまわりだけを出しています。上に {start} 行）</div>}
          {all && truncated && <div className="ac-log-note">…（長いので、最後の {lines.length} 行だけです）</div>}
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
          {all ? "エラーのまわりだけにする" : `ログをすべて見る（${lines.length} 行）`}
        </button>
      )}
    </div>
  );
}
