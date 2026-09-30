import { openUrl } from "@tauri-apps/plugin-opener";
import { LEVELS, SEVERITY_LABELS, type StackCard } from "../../lib/actions";
import { ago } from "../../lib/pulls";

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
        <span className="ac-sev">危険度「{SEVERITY_LABELS[severity] ?? severity}」</span>
        <h2 className="ac-title">{a ? `🛡 ${a.package}` : `🔍 ${c?.rule ?? ""}`}</h2>
        <span className="grow" />
        {url && (
          <button type="button" className="btn-sm" onClick={() => openUrl(url).catch(() => {})}>
            GitHub で開く ↗
          </button>
        )}
      </div>
      {a && (
        <>
          <p className="ac-meta">{a.summary}</p>
          <table className="ac-table">
            <tbody>
              <tr>
                <th>ライブラリ</th>
                <td>
                  <code>{a.package}</code> <span className="muted">（{a.ecosystem}）</span>
                </td>
              </tr>
              <tr>
                <th>書いてあるファイル</th>
                <td>
                  <code>{a.manifest}</code>
                </td>
              </tr>
              <tr>
                <th>危ない版</th>
                <td>{a.vulnerable ?? "—"}</td>
              </tr>
              <tr>
                <th>直った版</th>
                <td>{a.fixed ?? "まだありません"}</td>
              </tr>
              <tr>
                <th>番号</th>
                <td>{[a.cve, a.ghsa].filter(Boolean).join("・") || "—"}</td>
              </tr>
              <tr>
                <th>出た日</th>
                <td>{ago(a.created_at)}</td>
              </tr>
            </tbody>
          </table>
          <div className={`ac-todo l${card.level}`}>
            <b>何をすればよいか</b>
            <ol>
              {card.fixPull ? (
                <li>
                  Dependabot が、直すプルリク{" "}
                  <button type="button" className="pr-ref" onClick={() => onOpenPull(card.fixPull!.number)}>
                    #{card.fixPull.number}
                  </button>{" "}
                  を出しています。変更されたファイルとチェックを見て、よければマージします。
                </li>
              ) : a.fixed ? (
                <li>
                  <code>{a.manifest}</code> の {a.package} を <b>{a.fixed}</b> 以上に上げます
                  {upgradeCommand(a.ecosystem, a.package, a.fixed) && (
                    <>
                      （この PC で <code>{upgradeCommand(a.ecosystem, a.package, a.fixed)}</code>）
                    </>
                  )}
                  。
                </li>
              ) : (
                <li>直った版はまだありません。GitHub の説明を読み、危ない使い方をしていないかを確かめるか、ほかのライブラリに替えます。</li>
              )}
              <li>上げたらテストを動かして、こわれていないかを確かめてからコミット・プッシュします（Actions が確かめます）。</li>
              <li>直ると、このお知らせは GitHub が自動で閉じ、山から消えます。</li>
            </ol>
          </div>
        </>
      )}
      {c && (
        <>
          <p className="ac-meta">
            {c.tool} が見つけました（{ago(c.created_at)}）。
          </p>
          <table className="ac-table">
            <tbody>
              <tr>
                <th>場所</th>
                <td>
                  <code>
                    {c.path ?? "—"}
                    {c.line ? `:${c.line}` : ""}
                  </code>
                </td>
              </tr>
              <tr>
                <th>中身</th>
                <td>{c.message ?? "—"}</td>
              </tr>
            </tbody>
          </table>
          <div className={`ac-todo l${card.level}`}>
            <b>何をすればよいか</b>
            <ol>
              <li>GitHub で開くと、なぜ危ないかと、直し方の例が見られます。</li>
              <li>その場所を直してコミット・プッシュすると、次のスキャンで閉じます。</li>
            </ol>
          </div>
        </>
      )}
    </div>
  );
}
