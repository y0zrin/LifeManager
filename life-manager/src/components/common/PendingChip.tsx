/** まだ GitHub に送っていない変更がある印（オフラインのあいだの変更。つながったら送る） */
export function PendingChip() {
  return (
    <span className="pending-chip" title="まだ GitHub に送っていない変更があります。つながったら送ります">
      未送信
    </span>
  );
}
