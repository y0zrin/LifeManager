import { useRef } from "react";

interface DatePickerButtonProps {
  value: string;
  onChange: (date: string) => void;
  label?: string;
  className?: string;
}

/**
 * 「日付選択」ボタン。クリックでネイティブのカレンダーピッカーを開く。
 * WebView2の日本語ロケールで曜日が壊れる問題を回避するため、
 * input[type="date"] のテキスト表示を隠しボタンUIで代替する。
 */
export function DatePickerButton({ value, onChange, label = "日付選択", className = "btn-sm" }: DatePickerButtonProps) {
  const ref = useRef<HTMLInputElement>(null);

  return (
    <span style={{ position: "relative", display: "inline-block" }}>
      <button className={className} onClick={() => ref.current?.showPicker()}>
        {label}
      </button>
      <input
        ref={ref}
        type="date"
        value={value}
        onChange={(e) => { if (e.target.value) onChange(e.target.value); }}
        style={{ position: "absolute", opacity: 0, width: 0, height: 0, pointerEvents: "none" }}
      />
    </span>
  );
}
