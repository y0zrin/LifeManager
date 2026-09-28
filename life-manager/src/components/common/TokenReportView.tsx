import { openUrl } from "@tauri-apps/plugin-opener";
import { expiryOf, EXPIRY_WARN_DAYS, KIND_LABELS, TOKENS_PAGE, orgApprovalUrl, type TokenReport } from "../../lib/auth";

interface TokenReportViewProps {
  report: TokenReport;
  /** 組織の許可をお願いするページに使う（空なら出さない） */
  clientId?: string;
}

/** トークンを確かめた結果（だれのトークンか・期限・リポジトリごとに使えるか）。足りないときは直し方と、そのページへのボタン */
export function TokenReportView({ report, clientId }: TokenReportViewProps) {
  const expiry = expiryOf(report);
  return (
    <ul className="token-checks">
      <li className="token-check--ok">
        ✔ <b>{report.login}</b> {report.name && `（${report.name}）`}のトークン <span className="token-kind">{KIND_LABELS[report.kind]}</span>
      </li>
      {expiry ? (
        <li className={expiry.days < 0 ? "token-check--ng" : expiry.days <= EXPIRY_WARN_DAYS ? "token-check--warn" : "token-check--ok"}>
          {expiry.days < 0 ? "✖" : expiry.days <= EXPIRY_WARN_DAYS ? "⚠" : "✔"} 期限 {expiry.date}
          {expiry.days < 0 ? "（切れています）" : `（あと ${expiry.days} 日）`}
        </li>
      ) : (
        <li className="token-check--ok">✔ 期限なし</li>
      )}
      {report.repos.map((r) => (
        <li key={`${r.owner}/${r.repo}`} className={r.ok ? (r.message ? "token-check--warn" : "token-check--ok") : "token-check--ng"}>
          {r.ok ? (r.message ? "⚠" : "✔") : "✖"} <b>{r.owner}/{r.repo}</b>
          {r.ok && !r.message && " が見える・Issue を読める"}
          {r.message && <div className="token-check-fix">{r.message}</div>}
          {r.problem === "not_found" && report.kind === "fine-grained" && (
            <button type="button" className="btn-sm token-check-action" onClick={() => openUrl(TOKENS_PAGE)}>
              GitHub のトークンの画面を開く
            </button>
          )}
          {r.problem === "org_restricted" && clientId && (
            <button type="button" className="btn-sm token-check-action" onClick={() => openUrl(orgApprovalUrl(clientId))}>
              組織に許可をお願いする（GitHub が開きます）
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
