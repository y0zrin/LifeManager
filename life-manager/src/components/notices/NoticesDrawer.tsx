import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { NOTICE_COLORS, NOTICE_GROUPS, NOTICE_LABELS, dayHead, hhmm, type Notice } from "../../lib/notices";
import { parseHelp } from "../../lib/help";
import { isEscape } from "../../lib/keys";
import { HelpContextBox } from "./HelpParts";
import { THIS_DEVICE } from "../../lib/platform";

interface NoticesDrawerProps {
  /** りれき（新しい順） */
  notices: Notice[];
  onOpen: (n: Notice) => void;
  onClose: () => void;
}

/** 日ごとのまとまり（新しい日から） */
function byDay(list: Notice[]): { day: string; items: Notice[] }[] {
  const out: { day: string; items: Notice[] }[] = [];
  for (const n of list) {
    const d = new Date(n.at);
    const day = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    const last = out[out.length - 1];
    if (last?.day === day) last.items.push(n);
    else out.push({ day, items: [n] });
  }
  return out;
}

/**
 * 🔔 おしらせ（上のバーの右から出る欄）: 届いた知らせを日ごとに残す（60 日まで。この PC に）。種類で絞れる。
 * 押すと、そのときの詳しい中身（助けてのメッセージ・添えたようす）と「開く ›」。未読の数は出さない
 */
export function NoticesDrawer({ notices, onOpen, onClose }: NoticesDrawerProps) {
  const [group, setGroup] = useState("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const [box, setBox] = useState<CSSProperties>({});
  const ref = useRef<HTMLElement | null>(null);

  // 上のバーのすぐ下から、画面（サイドバーを除く）の下の端まで
  useLayoutEffect(() => {
    const place = () => {
      const main = document.querySelector(".app-main")?.getBoundingClientRect();
      const bar = document.querySelector(".app-main > .topbar")?.getBoundingClientRect();
      if (!main || !bar) return;
      setBox({ top: bar.bottom, right: Math.max(0, window.innerWidth - main.right), bottom: Math.max(0, window.innerHeight - main.bottom) });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, []);

  // Esc と、欄の外を押したら閉じる（🔔 は、押すと閉じる・開くを切り替えるので除く）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEscape(e)) onClose();
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (ref.current?.contains(t) || t.closest?.(".nt-bell")) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);

  const kinds = NOTICE_GROUPS.find((g) => g.key === group)?.kinds ?? null;
  const shown = useMemo(() => (kinds ? notices.filter((n) => kinds.includes(n.kind)) : notices), [notices, kinds]);
  const days = useMemo(() => byDay(shown), [shown]);

  return (
    <aside ref={ref} className="nt-drawer" style={box} role="dialog" aria-label="おしらせ">
      <div className="nt-drawer-head">
        <h2>🔔 おしらせ</h2>
        <button type="button" className="nt-drawer-x" onClick={onClose} aria-label="閉じる" title="閉じる（Esc）">×</button>
        <p>届いた知らせを日ごとに残しています（60 日まで。{THIS_DEVICE}に）。押すと、そのときの詳しい中身が開きます</p>
      </div>
      <div className="nt-chips" role="group" aria-label="絞り込み">
        {NOTICE_GROUPS.map((g) => (
          <button key={g.key} type="button" className={`nt-chip${group === g.key ? " on" : ""}`} aria-pressed={group === g.key} onClick={() => setGroup(g.key)}>
            {g.label}
          </button>
        ))}
      </div>
      <div className="nt-list">
        {days.length === 0 && (
          <p className="nt-empty">
            {notices.length === 0
              ? "まだ知らせはありません。担当になった・レビューを頼まれた・名前を呼ばれた・🆘 助けを求められた・マイルストーンを達成した、などが届くとここに残ります"
              : "この種類の知らせはまだありません"}
          </p>
        )}
        {days.map(({ day, items }) => {
          const head = dayHead(items[0].at);
          return (
            <section key={day} className="nt-day">
              <h3 className="nt-day-head">
                <b>{head.date}</b>
                <small>{head.dow}</small>
                {head.rel && <span className="nt-day-rel">{head.rel}</span>}
              </h3>
              <ul>
                {items.map((n) => {
                  const open = openId === n.id;
                  const help = n.kind === "help" && n.detail ? parseHelp(n.detail) : null;
                  return (
                    <li key={n.id} className={`nt-item${open ? " open" : ""}`} style={{ "--k": NOTICE_COLORS[n.kind] } as CSSProperties}>
                      <button type="button" className="nt-item-sum" onClick={() => setOpenId(open ? null : n.id)} aria-expanded={open}>
                        <span className="nt-item-time">{hhmm(n.at)}</span>
                        <span className="nt-item-ic" aria-hidden="true">{n.icon}</span>
                        <span className="nt-item-main">
                          <b>{n.title}</b>
                          {n.body && <span>{n.body.split("\n")[0]}</span>}
                        </span>
                        <span className="nt-item-car" aria-hidden="true">{open ? "⌄" : "›"}</span>
                      </button>
                      {open && (
                        <div className="nt-item-detail">
                          <div className="nt-item-kind">{NOTICE_LABELS[n.kind]}</div>
                          {help ? (
                            <>
                              {help.message && <div className="nt-item-msg">{help.message}</div>}
                              <HelpContextBox items={help.items} log={help.log} title="いっしょに送られたもの" />
                            </>
                          ) : n.detail ? (
                            <div className="nt-item-msg">{n.detail}</div>
                          ) : (
                            n.body && <div className="nt-item-note">{n.body}</div>
                          )}
                          {n.target && (
                            <button type="button" className="btn-primary nt-item-open" onClick={() => onOpen(n)}>
                              開く ›
                            </button>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
    </aside>
  );
}
