import { tr, labelText } from "../../lib/i18n";
/**
 * ラベルの短い名前（スマホのカード。#208）: 分類の名前を外して値だけにする。
 * 優先は値だけだと分からない（「高」）ので「優先 高」。分類のない名前はそのまま
 */
export function shortLabelName(name: string): string {
  const i = name.indexOf(":");
  if (i < 0) return name;
  const cat = name.slice(0, i);
  const value = tr(name.slice(i + 1));
  return cat === "優先" ? tr("優先 {value}", { value }) : value;
}

export function LabelBadge({ name, color, short = false }: { name: string; color: string; short?: boolean }) {
  return (
    <span
      title={short ? labelText(name) : undefined}
      style={{
        display: "inline-block",
        padding: "1px 7px",
        margin: "0 3px 2px 0",
        borderRadius: "10px",
        fontSize: "11px",
        fontWeight: 600,
        color: parseInt(color, 16) > 0x7fffff ? "#000" : "#fff",
        backgroundColor: `#${color}`,
      }}
    >
      {short ? shortLabelName(name) : labelText(name)}
    </span>
  );
}
