import { useEffect, useLayoutEffect, useRef, useState } from "react";

/** メニューの項目。code は実行するコマンド、hint は押せない理由（押せないボタンには title が出ないので、下に小さく書く） */
export type MenuItem =
  | { label: string; code?: string; danger?: boolean; disabled?: boolean; hint?: string; run: () => void }
  | "sep";

export interface MenuSpec {
  x: number;
  y: number;
  title: string;
  items: MenuItem[];
}

/** 右クリック・「⋯」で出す操作のメニュー */
export function ContextMenu({ spec, onClose }: { spec: MenuSpec; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: spec.x, top: spec.y });

  // 画面からはみ出さないように置き直し、最初の押せる項目にフォーカスする
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(spec.x, window.innerWidth - r.width - 8)),
      top: Math.max(8, Math.min(spec.y, window.innerHeight - r.height - 8)),
    });
    el.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [spec]);

  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
      const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = e.key === "ArrowDown" ? (i + 1) % buttons.length : (i - 1 + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
    const close = () => onClose();
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    // メニューの外がスクロールしたら閉じる（メニューだけが取り残されないように）
    const onScroll = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [onClose]);

  return (
    <div className="ctx popover" ref={ref} role="menu" aria-label={spec.title} style={pos} onContextMenu={(e) => e.preventDefault()}>
      <div className="ctx-head">{spec.title}</div>
      {spec.items.map((it, i) =>
        it === "sep" ? (
          <hr key={i} />
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={`mi${it.danger ? " danger" : ""}`}
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.run();
            }}
          >
            <span>{it.label}</span>
            {it.code && <code>{it.code}</code>}
            {it.disabled && it.hint && <small className="mi-hint">{it.hint}</small>}
          </button>
        ),
      )}
    </div>
  );
}
