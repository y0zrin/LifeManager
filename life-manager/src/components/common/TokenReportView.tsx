import { openUrl } from "@tauri-apps/plugin-opener";
import { expiryOf, EXPIRY_WARN_DAYS, KIND_LABELS, TOKENS_PAGE, type TokenReport } from "../../lib/auth";
import { tr, trx } from "../../lib/i18n";

interface TokenReportViewProps {
  report: TokenReport;
  /** Life Manager App を入れる画面（「使用するリポジトリを選ぶ」・「リポジトリを追加する」。空なら出さない） */
  installUrl?: string;
}

/** トークンを確かめた結果（だれのトークンか・期限・リポジトリごとに使えるか）。足りないときは直し方と、そのページへのボタン */
export function TokenReportView({ report, installUrl }: TokenReportViewProps) {
  const expiry = expiryOf(report);
  return (
    <ul className="token-checks">
      <li className="token-check--ok">
        ✔ {report.name
          ? trx("<0>{login}</0> （{name}）のトークン <1>{kind}</1>", { login: report.login, name: report.name, kind: KIND_LABELS[report.kind] }, [<b />, <span className="token-kind" />])
          : trx("<0>{login}</0> のトークン <1>{kind}</1>", { login: report.login, kind: KIND_LABELS[report.kind] }, [<b />, <span className="token-kind" />])}
      </li>
      {expiry ? (
        <li className={expiry.days < 0 ? "token-check--ng" : expiry.days <= EXPIRY_WARN_DAYS ? "token-check--warn" : "token-check--ok"}>
          {expiry.days < 0 ? "✖" : expiry.days <= EXPIRY_WARN_DAYS ? "⚠" : "✔"}{" "}
          {expiry.days < 0 ? tr("期限 {date}（切れています）", { date: expiry.date }) : tr("期限 {date}（あと {days} 日）", { date: expiry.date, days: expiry.days })}
        </li>
      ) : (
        <li className="token-check--ok">{tr("✔ 期限なし")}</li>
      )}
      {report.repos.map((r) => (
        <li key={`${r.owner}/${r.repo}`} className={r.ok ? (r.message ? "token-check--warn" : "token-check--ok") : "token-check--ng"}>
          {r.ok ? (r.message ? "⚠" : "✔") : "✖"}{" "}
          {r.ok && !r.message ? trx("<0>{owner}/{repo}</0> が見える・Issue を読める", { owner: r.owner, repo: r.repo }, [<b />]) : <b>{r.owner}/{r.repo}</b>}
          {r.message && <div className="token-check-fix">{r.message}</div>}
          {r.problem === "not_found" && report.kind === "fine-grained" && (
            <button type="button" className="btn-sm token-check-action" onClick={() => openUrl(TOKENS_PAGE)}>
              {tr("GitHub のトークンの画面を開く")}
            </button>
          )}
          {r.problem === "not_installed" && installUrl && (
            <button type="button" className="btn-sm token-check-action" onClick={() => openUrl(installUrl)}>
              {tr("使用するリポジトリを選ぶ・追加する（GitHub が開きます）")}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
