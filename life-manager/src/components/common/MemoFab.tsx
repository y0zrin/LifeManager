import { useEffect, useMemo, useRef, useState } from "react";
import type { GitHubLabel } from "../../lib/types";
import type { MemoButtonPosition } from "../../hooks/useDisplaySettings";
import { isComposing, isEnter, isEscape } from "../../lib/keys";
import { isSectionLabel, sectionOf } from "../../lib/section";
import { isMobile, keyHint } from "../../lib/platform";
import { tr, trx } from "../../lib/i18n";

interface MemoFabProps {
  /** ボタンを置く角（hidden ならボタンを出さず、Ctrl+M で画面の上のほうに欄を開く） */
  position: MemoButtonPosition;
  /** このリポジトリのラベル（セクションのものを、メモのセクションの候補にする） */
  labels: GitHubLabel[];
  /** 送り先のリポジトリ（owner/repo。見出しに出す） */
  repoName: string;
  onCreateMemo: (text: string, theme: string) => Promise<void>;
}

/** 前に選んだセクション（次に開いたときも同じにする） */
const THEME_STORE = "memo-theme";
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
    return localStorage.getItem(THEME_STORE) ?? "";
  } catch {
    return "";
  }
}

type Result = { kind: "sending" | "ok" | "error"; text: string };

/**
 * メモの投入（どの画面からでも）。画面の角の 📝 を押すか Ctrl+M で、小さな欄を開く。
 * 角は 設定 → 表示 で選ぶ（サイドバー・上のバーにかぶらない所。CSS で決める）。ほかの欄で文字を打っているあいだは、画面の外へよける
 */
export function MemoFab({ position, labels, repoName, onCreateMemo }: MemoFabProps) {
  const themes = useMemo(() => labels.filter((l) => isSectionLabel(l.name)).map((l) => l.name), [labels]);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [theme, setTheme] = useState(loadTheme);
  const [result, setResult] = useState<Result | null>(null);
  const [away, setAway] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // 閉じたら、開く前にいた欄へ戻る（Esc・Ctrl+M で閉じたとき）
  const returnFocus = useRef<HTMLElement | null>(null);

  // セクションは、このリポジトリにあるものから選ぶ（前に選んだものがなければ「なし」）
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
      // 覚えられなくても、今は選んだセクションで送れる
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
    } catch {
      // 送れなかったメモは、一覧・ボードに「送れませんでした」で残る（「もう一度」で送り直せる）ので、欄には戻さない
      setResult({ kind: "error", text: body });
    }
  }

  return (
    <div ref={wrapRef} className={`memo-fab-wrap at-${position}${open ? " open" : away ? " away" : ""}`}>
      {open && (
        <div className="memo-pop" role="dialog" aria-label={tr("メモを投入")}
          onKeyDown={(e) => {
            if (isEscape(e)) {
              e.stopPropagation();
              hide(true);
            }
          }}>
          <div className="memo-pop-head">
            {trx("<0>📝 メモを投入</0><1>{repoName}</1>", { repoName }, [<b />, <span className="memo-pop-repo" title={tr("メモはこのリポジトリの Issue（種別:メモ・状態:未整理）になります")} />])}
          </div>
          <input ref={inputRef} className="memo-pop-input" value={text} placeholder={tr("思いついたことを 1 行で")}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (isEnter(e)) {
                e.preventDefault();
                submit();
              }
            }} />
          <div className="memo-pop-row">
            <select className="select-sm" value={current} aria-label={tr("セクション")} onChange={(e) => changeTheme(e.target.value)}>
              <option value="">{tr("セクション: なし")}</option>
              {themes.map((t) => (
                <option key={t} value={t}>{trx("セクション: {sectionOf}", { sectionOf: sectionOf(t) })}</option>
              ))}
            </select>
            <button type="button" className="btn-primary" disabled={!text.trim()} onClick={submit}>{tr("投入")}</button>
          </div>
          {result?.kind === "sending" ? (
            <p className="memo-pop-note">{trx("「{text}」を送っています…", { text: result.text })}</p>
          ) : result?.kind === "ok" ? (
            <p className="memo-pop-note ok">{trx("✔ 「{text}」を投入しました", { text: result.text })}</p>
          ) : result?.kind === "error" ? (
            <p className="memo-pop-note err">{trx("⚠ 「{text}」を送れませんでした。タスク一覧やボードの「もう一度」で送り直せます", { text: result.text })}</p>
          ) : (
            <p className="memo-pop-note">{isMobile ? tr("「投入」で入れたあとも、続けて書けます") : tr("Enter で投入（続けて書けます）・Esc で閉じる")}</p>
          )}
        </div>
      )}
      {position !== "hidden" && (
        <button type="button" className="memo-fab" aria-label={tr("メモを投入{keyHint}", { keyHint: keyHint("（Ctrl+M）") })} aria-expanded={open}
          onClick={() => (open ? hide(false) : show())}>
          <span aria-hidden="true">📝</span>
        </button>
      )}
      {position !== "hidden" && !open && <span className="memo-fab-tip" aria-hidden="true">{trx("メモ{keyHint}", { keyHint: keyHint("（Ctrl+M）") })}</span>}
    </div>
  );
}
