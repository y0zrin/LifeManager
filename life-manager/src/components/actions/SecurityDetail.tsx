import { openUrl } from "@tauri-apps/plugin-opener";
import { LEVELS, SEVERITY_LABELS, type StackCard } from "../../lib/actions";
import { ago } from "../../lib/pulls";
import { tr, trx } from "../../lib/i18n";

interface SecurityDetailProps {
  card: StackCard;
  onOpenPull: (n: number) => void;
}

/** 危ない版を直す、手元のコマンドの例（入れ物ごと） */
function upgradeCommand(ecosystem: string, pkg: string, fixed: string): string | null {
  switch (ecosystem) {
    case "npm":
      return `npm install ${pkg}@${fixed}`;
    case "pip":
      return `pip install "${pkg}>=${fixed}"`;
    case "rust":
      return `cargo update -p ${pkg} --precise ${fixed}`;
    case "rubygems":
      return `bundle update ${pkg}`;
    case "nuget":
      return `dotnet add package ${pkg} --version ${fixed}`;
    case "composer":
      return `composer require ${pkg}:^${fixed}`;
    case "go":
      return `go get ${pkg}@v${fixed.replace(/^v/, "")}`;
    default:
      return null;
  }
}

/** セキュリティのお知らせの中身（Dependabot・コードスキャン）と、何をすればよいか */
export function SecurityDetail({ card, onOpenPull }: SecurityDetailProps) {
  const level = LEVELS.find((l) => l.level === card.level);
  const a = card.dependabot;
  const c = card.code;
  const url = a?.html_url ?? c?.html_url ?? "";
  const severity = a?.severity ?? c?.severity ?? "";

  return (
    <div className="ac-detail">
      <div className="ac-head">
        {level && <span className={`ac-level l${card.level}`}>{level.icon} {level.label}</span>}
        <span className="ac-sev">{tr("危険度「{level}」", { level: SEVERITY_LABELS[severity] ?? severity })}</span>
        <h2 className="ac-title">{a ? `🛡 ${a.package}` : `🔍 ${c?.rule ?? ""}`}</h2>
        <span className="grow" />
        {url && (
          <button type="button" className="btn-sm" onClick={() => openUrl(url).catch(() => {})}>
            {tr("GitHub で開く ↗")}
          </button>
        )}
      </div>
      {a && (
        <>
          <p className="ac-meta">{a.summary}</p>
          <table className="ac-table">
            <tbody>
              <tr>
                <th>{tr("ライブラリ")}</th>
                <td>
                  <code>{a.package}</code> <span className="muted">{tr("（{v}）", { v: a.ecosystem })}</span>
                </td>
              </tr>
              <tr>
                <th>{tr("書いてあるファイル")}</th>
                <td>
                  <code>{a.manifest}</code>
                </td>
              </tr>
              <tr>
                <th>{tr("危ない版")}</th>
                <td>{a.vulnerable ?? "—"}</td>
              </tr>
              <tr>
                <th>{tr("直った版")}</th>
                <td>{a.fixed ?? tr("まだありません")}</td>
              </tr>
              <tr>
                <th>{tr("番号")}</th>
                <td>{[a.cve, a.ghsa].filter(Boolean).join(tr("・")) || "—"}</td>
              </tr>
              <tr>
                <th>{tr("出た日")}</th>
                <td>{ago(a.created_at)}</td>
              </tr>
            </tbody>
          </table>
          <div className={`ac-todo l${card.level}`}>
            <b>{tr("何をすればよいか")}</b>
            <ol>
              {card.fixPull ? (
                <li>
                  {trx("Dependabot が、直すプルリク <0>#{number}</0> を出しています。変更されたファイルとチェックを見て、よければマージします。", { number: card.fixPull.number }, [
                    <button type="button" className="pr-ref" onClick={() => onOpenPull(card.fixPull!.number)} />,
                  ])}
                </li>
              ) : a.fixed ? (
                <li>
                  {upgradeCommand(a.ecosystem, a.package, a.fixed)
                    ? trx("<0>{manifest}</0> の {package} を <1>{fixed}</1> 以上に上げます（この PC で <2>{command}</2>）。", { manifest: a.manifest, package: a.package, fixed: a.fixed, command: upgradeCommand(a.ecosystem, a.package, a.fixed) }, [<code />, <b />, <code />])
                    : trx("<0>{manifest}</0> の {package} を <1>{fixed}</1> 以上に上げます。", { manifest: a.manifest, package: a.package, fixed: a.fixed }, [<code />, <b />])}
                </li>
              ) : (
                <li>{tr("直った版はまだありません。GitHub の説明を読み、危ない使い方をしていないかを確かめるか、ほかのライブラリに替えます。")}</li>
              )}
              <li>{tr("上げたらテストを動かして、こわれていないかを確かめてからコミットとプッシュをします（Actions が確かめます）。")}</li>
              <li>{tr("直ると、このお知らせは GitHub が自動で閉じ、山から消えます。")}</li>
            </ol>
          </div>
        </>
      )}
      {c && (
        <>
          <p className="ac-meta">
            {trx("{tool} が見つけました（{ago}）。", { tool: c.tool, ago: ago(c.created_at) })}
          </p>
          <table className="ac-table">
            <tbody>
              <tr>
                <th>{tr("場所")}</th>
                <td>
                  <code>
                    {c.path ?? "—"}
                    {c.line ? `:${c.line}` : ""}
                  </code>
                </td>
              </tr>
              <tr>
                <th>{tr("中身")}</th>
                <td>{c.message ?? "—"}</td>
              </tr>
            </tbody>
          </table>
          <div className={`ac-todo l${card.level}`}>
            <b>{tr("何をすればよいか")}</b>
            <ol>
              <li>{tr("GitHub で開くと、なぜ危ないかと直し方の例が見られます。")}</li>
              <li>{tr("その場所を直してコミットとプッシュをすると、次のスキャンで閉じます。")}</li>
            </ol>
          </div>
        </>
      )}
    </div>
  );
}
