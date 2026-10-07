// 枠に入りきらない名前を、流し続ける（全体図のブランチの名前。#292）。
// 流すのは CSS（App.css の lh-flow。くり返しの動きなので、lib/idle.ts の時計が進める）。
// 動きを少なくしているときは、CSS が止めて、今どおり「…」で切る
import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { flowTiming } from "../../lib/flowName";

export function FlowingName({ text, className }: { text: string; className: string }) {
  const box = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(0);

  // 測るのは、名前が変わったときと、字体を読み終えたとき（斜めにしていても、幅は傾ける前の長さで測れる）
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    let alive = true;
    const measure = () => {
      if (alive) setOverflow(el.scrollWidth - el.clientWidth);
    };
    measure();
    document.fonts?.ready.then(measure).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [text]);

  const flow = flowTiming(overflow);
  const style = flow ? ({ "--flow-shift": `${flow.shift}px`, "--flow-dur": `${flow.duration.toFixed(2)}s` } as CSSProperties) : undefined;
  return (
    <span ref={box} className={flow ? `${className} flow` : className} style={style}>
      <span>{text}</span>
    </span>
  );
}
