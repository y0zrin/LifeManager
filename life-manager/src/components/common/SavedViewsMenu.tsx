import { useEffect, useRef, useState } from "react";
import { useDismiss } from "../../hooks/useDismiss";
import { isEnter } from "../../lib/keys";
import { describeView, sameSettings, type SavedView, type ViewSettings } from "../../lib/savedViews";
import { tr } from "../../lib/i18n";

interface SavedViewsMenuProps {
  views: SavedView[];
  /** 今の絞り込み・並び・まとめ方・見せ方 */
  current: ViewSettings;
  onApply: (view: SavedView) => void;
  /** 一覧を書き換えて保存する（config/views.yaml に書いて GitHub に送る） */
  onSave: (views: SavedView[]) => Promise<void>;
  /** マイルストーンの番号から名前を引く（見方の説明に使う） */
  milestoneTitle?: (n: number) => string | undefined;
}

/**
 * 保存した見方。今の設定と同じ見方があれば、その名前をボタンに出す。
 * 保存・名前の変更・削除は、リポジトリの config/views.yaml を書き換える（チームの全員が同じ見方を使える）
 */
export function SavedViewsMenu({ views, current, onApply, onSave, milestoneTitle }: SavedViewsMenuProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLSpanElement>(null);
  useDismiss(ref, open, () => setOpen(false));

  const active = views.find((v) => sameSettings(v, current)) ?? null;
  const trimmed = name.trim();
  const existing = views.find((v) => v.name === trimmed) ?? null;

  // 開いたときは、今の見方の名前を入れておく（そのまま「名前を変える」に使える）
  useEffect(() => {
    if (open) {
      setName(active?.name ?? "");
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function save(next: SavedView[]) {
    setBusy(true);
    setError(null);
    try {
      await onSave(next);
    } catch (e) {
      setError(tr("保存できませんでした: {e}", { e }));
    } finally {
      setBusy(false);
    }
  }

  function saveCurrent() {
    if (!trimmed || busy) return;
    const view: SavedView = { name: trimmed, ...current };
    // 同じ名前があれば、その見方を今の設定で上書きする（並びの位置は変えない）
    save(existing ? views.map((v) => (v.name === trimmed ? view : v)) : [...views, view]);
  }

  function rename() {
    if (!active || !trimmed || busy) return;
    if (existing && existing !== active) {
      setError(tr("「{trimmed}」という見方はもうあります", { trimmed }));
      return;
    }
    save(views.map((v) => (v === active ? { ...v, name: trimmed } : v)));
  }

  function remove() {
    if (!active || busy) return;
    save(views.filter((v) => v !== active));
  }

  return (
    <span className="views-menu" ref={ref}>
      <button type="button" className={`select-sm views-menu-button${active ? " views-menu-button--on" : ""}`} onClick={() => setOpen((v) => !v)}>
        {tr("保存した見方:")}{" "} {active ? <b>{active.name}</b> : "—"} ▾
      </button>
      {open && (
        <div className="views-menu-pop popover">
          <div className="views-menu-title">{tr("このリポジトリの見方（チームで共有）")}</div>
          {views.length === 0 && (
            <div className="views-menu-empty">{tr("まだありません")}</div>
          )}
          {views.map((v) => (
            <button
              key={v.name}
              type="button"
              className={`views-menu-item${v === active ? " on" : ""}`}
              onClick={() => { onApply(v); setOpen(false); }}
            >
              <b>{v.name}</b>
              <small>{describeView(v, milestoneTitle)}</small>
            </button>
          ))}
          <div className="views-menu-save">
            <input
              className="input-full"
              value={name}
              placeholder={tr("今の見方に名前を付ける（例: 今週やること）")}
              onChange={(e) => { setName(e.target.value); setError(null); }}
              onKeyDown={(e) => { if (isEnter(e)) saveCurrent(); }}
              disabled={busy}
            />
            <div className="views-menu-actions">
              <button type="button" className="btn-sm" onClick={saveCurrent} disabled={!trimmed || busy}>
                {existing ? tr("上書き保存") : tr("保存")}
              </button>
              <button type="button" className="btn-sm" onClick={rename} disabled={!active || !trimmed || trimmed === active.name || busy}
                title={active ? tr("「{name}」の名前を変える", { name: active.name }) : tr("保存した見方を選んでいるときに使えます")}>
                {tr("名前を変える")}
              </button>
              <button type="button" className="btn-sm" onClick={remove} disabled={!active || busy}
                title={active ? tr("「{name}」を消す", { name: active.name }) : tr("保存した見方を選んでいるときに使えます")}>
                {tr("消す")}
              </button>
            </div>
            {busy && <div className="views-menu-note">{tr("保存しています…")}</div>}
            {error && <div className="views-menu-error">{error}</div>}
          </div>
        </div>
      )}
    </span>
  );
}
