import { tr } from "../../lib/i18n";
/** まだ GitHub に送っていない変更がある印（オフラインのあいだの変更。つながったら送る） */
export function PendingChip() {
  return (
    <span className="pending-chip" title={tr("まだ GitHub に送っていない変更があります。つながったら送ります")}>
      {tr("未送信")}
    </span>
  );
}
