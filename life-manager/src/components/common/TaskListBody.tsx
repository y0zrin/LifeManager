import { useState } from "react";

// タスクリストの本文を表示し、チェックボックスのトグルを可能にするコンポーネント

interface TaskListBodyProps {
  body: string;
  issueNumber: number;
  onToggle: (issueNumber: number, newBody: string) => Promise<void>;
}

// 本文中のN番目のチェックボックスをトグルする
function toggleCheckboxAtIndex(body: string, index: number): string {
  const pattern = /- \[[ x]\]/g;
  let matchIndex = 0;
  return body.replace(pattern, (match) => {
    if (matchIndex === index) {
      matchIndex++;
      return match === "- [x]" ? "- [ ]" : "- [x]";
    }
    matchIndex++;
    return match;
  });
}

export function TaskListBody({ body, issueNumber, onToggle }: TaskListBodyProps) {
  const [saving, setSaving] = useState(false);
  const [currentBody, setCurrentBody] = useState(body);

  if (body !== currentBody && !saving) {
    setCurrentBody(body);
  }

  async function handleToggle(checkboxIndex: number) {
    if (saving) return;
    const newBody = toggleCheckboxAtIndex(currentBody, checkboxIndex);
    setCurrentBody(newBody);
    setSaving(true);
    try {
      await onToggle(issueNumber, newBody);
    } catch (e) {
      console.error("タスク更新エラー:", e);
      setCurrentBody(currentBody);
    }
    setSaving(false);
  }

  const lines = currentBody.split("\n");
  let checkboxIndex = 0;
  const cursorStyle = saving ? "not-allowed" : "pointer";

  return (
    <div className="task-list-body">
      {saving && (
        <div className="task-list-overlay">保存中...</div>
      )}

      {lines.map((line, lineIndex) => {
        const uncheckedMatch = line.match(/^(\s*)- \[ \] (.*)$/);
        if (uncheckedMatch) {
          const idx = checkboxIndex++;
          const indent = uncheckedMatch[1];
          const text = uncheckedMatch[2];
          return (
            <div key={lineIndex} style={{ whiteSpace: "pre-wrap" }}>
              {indent}
              <label
                style={{ cursor: cursorStyle, display: "inline" }}
                onClick={(e) => { e.preventDefault(); handleToggle(idx); }}
              >
                <input type="checkbox" checked={false} readOnly disabled={saving}
                  className="task-checkbox" style={{ cursor: cursorStyle }} />
                <span>{text}</span>
              </label>
            </div>
          );
        }

        const checkedMatch = line.match(/^(\s*)- \[x\] (.*)$/);
        if (checkedMatch) {
          const idx = checkboxIndex++;
          const indent = checkedMatch[1];
          const text = checkedMatch[2];
          return (
            <div key={lineIndex} style={{ whiteSpace: "pre-wrap" }}>
              {indent}
              <label
                style={{ cursor: cursorStyle, display: "inline" }}
                onClick={(e) => { e.preventDefault(); handleToggle(idx); }}
              >
                <input type="checkbox" checked={true} readOnly disabled={saving}
                  className="task-checkbox" style={{ cursor: cursorStyle }} />
                <span className="task-text--done">{text}</span>
              </label>
            </div>
          );
        }

        return (
          <div key={lineIndex} style={{ whiteSpace: "pre-wrap", minHeight: line === "" ? "0.8em" : undefined }}>
            {line}
          </div>
        );
      })}
    </div>
  );
}
