import { useEffect, useMemo, useRef, useState } from "react";
import type { GitHubLabel } from "../../lib/types";
import { isComposing, isEnter, isEscape } from "../../lib/keys";

interface MemoFabProps {
  /** このリポジトリのラベル（「分野:」のものを、メモの分野の候補にする） */
  labels: GitHubLabel[];
  /** 送り先のリポジトリ（owner/repo。見出しに出す） */
  repoName: string;
  onCreateMemo: (text: string, theme: string) => Promise<void>;
}

/** 前に選んだ分野（次に開いたときも同じにする） */
const THEME_STORE = "memo-theme";
const THEME_PREFIX = "分野:";
/** 打つのをやめてから、ボタンが戻ってくるまで */
const BACK_AFTER_MS = 1500;
/** 文字を打つ欄（ここで打っているあいだは、ボタンを画面の外へよける） */
const TEXT_INPUT_TYPES = new Set(["text", "search", "email", "url", "tel", "password", "number"]);

function isTextField(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  if (t instanceof HTMLTextAreaElement) return !t.readOnly && !t.disabled;
  if (t instanceof HTMLInputElement) return !t.readOnly && !t.disabled && TEXT_INPUT_TYPES.has(t.type);
  return false;
}

function loadTheme(): string {
  try {
    return localStorage.getItem(THEME_STORE) ?? "分野:私用";
  } catch {
    return "分野:私用";
  }
}

type Result = { kind: "sending" | "ok" | "error"; text: string };

/**
 * メモの投入（どの画面からでも）。画面の下の角の 📝 を押すか Ctrl+M で、小さな欄を開く。
 * 置く角はサイドバーの側（CSS で決める）。ほかの欄で文字を打っているあいだは、画面の外へよける
 */
export function MemoFab({ labels, repoName, onCreateMemo }: MemoFabProps) {
  const themes = useMemo(() => labels.filter((l) => l.name.startsWith(THEME_PREFIX)).map((l) => l.name), [labels]);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [theme, setTheme] = useState(loadTheme);
  const [result, setResult] = useState<Result | null>(null);
  const [away, setAway] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // 閉じたら、開く前にいた欄へ戻る（Esc・Ctrl+M で閉じたとき）
  const returnFocus = useRef<HTMLElement | null>(null);

  // 分野は、このリポジトリにあるものから選ぶ（前に選んだものがなければ「なし」）
  const current = themes.includes(theme) ? theme : "";

  function show() {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setResult(null);
    setOpen(true);
  }

  function hide(restoreFocus: boolean) {
    setOpen(false);
    if (restoreFocus) returnFocus.current?.focus();
    returnFocus.current = null;
  }

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Ctrl+M で開く・閉じる。Issue の詳細やダイアログを開いているあいだは使わない（閉じる操作がぶつかるため）
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "m" || isComposing(e)) return;
      if (!open && document.querySelector(".palette-overlay")) return;
      e.preventDefault();
      if (open) hide(true);
      else show();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  // 外を押すと閉じる（書きかけは残しておく）
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) hide(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // ほかの欄で文字を打っているあいだは、ボタンを画面の外へよける（日本語の変換中・貼り付けも。打つのをやめると戻る）
  useEffect(() => {
    let timer = 0;
    function onInput(e: Event) {
      if (!isTextField(e.target) || wrapRef.current?.contains(e.target as Node)) return;
      setAway(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setAway(false), BACK_AFTER_MS);
    }
    window.addEventListener("input", onInput, true);
    return () => {
      window.removeEventListener("input", onInput, true);
      window.clearTimeout(timer);
    };
  }, []);

  function changeTheme(value: string) {
    setTheme(value);
    try {
      localStorage.setItem(THEME_STORE, value);
    } catch {
      // 覚えられなくても、今は選んだ分野で送れる
    }
  }

  // すぐに欄を空けて、続けて書けるようにする（送るのは後ろで）
  async function submit() {
    const body = text.trim();
    if (!body) return;
    setText("");
    setResult({ kind: "sending", text: body });
    try {
      await onCreateMemo(body, current);
      setResult({ kind: "ok", text: body });
    } catch (e) {
      // 送れなかったら、書いたものを欄に戻す（もう次を書き始めていたら、そのまま）
      setText((now) => now || body);
      setResult({ kind: "error", text: String(e) });
    }
  }

  return (
    <div ref={wrapRef} className={`memo-fab-wrap${open ? " open" : away ? " away" : ""}`}>
      {open && (
        <div className="memo-pop" role="dialog" aria-label="メモを投入"
          onKeyDown={(e) => {
            if (isEscape(e)) {
              e.stopPropagation();
              hide(true);
            }
          }}>
          <div className="memo-pop-head">
            <b>📝 メモを投入</b>
            <span className="memo-pop-repo" title="メモは、このリポジトリの Issue（種別:メモ・状態:未整理）になります">{repoName}</span>
          </div>
          <input ref={inputRef} className="memo-pop-input" value={text} placeholder="思いついたことを 1 行で"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (isEnter(e)) {
                e.preventDefault();
                submit();
              }
            }} />
          <div className="memo-pop-row">
            <select className="select-sm" value={current} aria-label="分野" onChange={(e) => changeTheme(e.target.value)}>
              <option value="">分野: なし</option>
              {themes.map((t) => (
                <option key={t} value={t}>分野: {t.slice(THEME_PREFIX.length)}</option>
              ))}
            </select>
            <button type="button" className="btn-primary" disabled={!text.trim()} onClick={submit}>投入</button>
          </div>
          {result?.kind === "sending" ? (
            <p className="memo-pop-note">「{result.text}」を送っています…</p>
          ) : result?.kind === "ok" ? (
            <p className="memo-pop-note ok">✔ 「{result.text}」を投入しました</p>
          ) : result?.kind === "error" ? (
            <p className="memo-pop-note err">⚠ 送れませんでした（{result.text}）</p>
          ) : (
            <p className="memo-pop-note">Enter で投入（続けて書けます）・Esc で閉じる</p>
          )}
        </div>
      )}
      <button type="button" className="memo-fab" aria-label="メモを投入（Ctrl+M）" aria-expanded={open}
        onClick={() => (open ? hide(false) : show())}>
        <span aria-hidden="true">📝</span>
      </button>
      {!open && <span className="memo-fab-tip" aria-hidden="true">メモ（Ctrl+M）</span>}
    </div>
  );
}
