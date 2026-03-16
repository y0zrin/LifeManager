export function LabelBadge({ name, color }: { name: string; color: string }) {
  return (
    <span
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
      {name}
    </span>
  );
}
