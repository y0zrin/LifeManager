import { useEffect, useMemo, useState } from "react";
import * as git from "../../lib/git";
import { buildResolved, linesOf, parseConflict, sideNames, type ConflictChoice, type ConflictHunk } from "../../lib/conflict";
import type { GitStatus } from "../../lib/types";
import type { GitActions } from "../../hooks/useGitActions";

interface MergeToolProps {
  folder: string;
  /** 競合しているファイル */
  file: string;
  status: GitStatus;
  actions: GitActions;
  /** git の操作の途中（ボタンを押せなくする） */
  busy: boolean;
}

const CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳";
const numberOf = (i: number) => CIRCLED[i] ?? `(${i + 1})`;

type SideState = "" | "use" | "drop";

/** 片側の箱。選んだ側は太い枠と「✔ 使う」、捨てる側は薄く打ち消し線と「捨てる」 */
function SideBox({ side, label, lines, state, order, onUse }: {
  side: "ours" | "theirs";
  label: string;
  lines: string[];
  state: SideState;
  /** 両方を残すときの順（1・2） */
  order?: number;
  onUse?: () => void;
}) {
  return (
    <div className={`mt-side mt-side--${side}${state ? ` mt-side--${state}` : ""}`}>
      <div className="mt-side-head">
        <span className="mt-side-label">{label}</span>
        {state === "use" && <span className="mt-badge mt-badge--use">✔ {order ? `${order} 番目に` : ""}使う</span>}
        {state === "drop" && <span className="mt-badge mt-badge--drop">✖ 捨てる</span>}
      </div>
      <pre className="mt-lines">{lines.length > 0 ? lines.join("\n") : <span className="mt-empty">（この側では、ここは消されています）</span>}</pre>
      {onUse && (
        <button type="button" className={`mt-use mt-use--${side}`} onClick={onUse}>
          {side === "ours" ? "✔ 今のブランチの方を使う" : "✔ 取り込む側を使う"}
        </button>
      )}
    </div>
  );
}

/**
 * 競合（コンフリクト）を直す。作業タブで競合のファイルを選ぶと、右（いつもは差分）に出る。
 * か所ごとに、今のブランチの方・取り込む側・両方・自分で書く を選び、全部選んだら書き込んでステージする（git add）
 */
export function MergeTool({ folder, file, status, actions, busy }: MergeToolProps) {
  const [data, setData] = useState<git.ConflictText | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choices, setChoices] = useState<(ConflictChoice | undefined)[]>([]);
  // 自分で書いているか所と、書きかけ
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [reloadSeq, setReloadSeq] = useState(0);

  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    setChoices([]);
    setEditing(null);
    git.conflictFile(folder, file)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [folder, file, reloadSeq]);

  const parsed = useMemo(() => (data && !data.binary && !data.missing ? parseConflict(data.text) : null), [data]);
  const names = sideNames(status.operation, status.branch, parsed?.hunks[0] ?? null);
  const hunks = parsed?.hunks ?? [];
  const done = hunks.filter((h) => choices[h.index]).length;
  const resolved = parsed ? buildResolved(parsed, choices) : null;

  function choose(index: number, choice: ConflictChoice | undefined) {
    setChoices((prev) => {
      const next = [...prev];
      next[index] = choice;
      return next;
    });
  }

  function startEditing(h: ConflictHunk) {
    const current = choices[h.index];
    setDraft(current ? linesOf(h, current).join("\n") : [...h.ours, ...h.theirs].join("\n"));
    setEditing(h.index);
  }

  const wholeSideButtons = (
    <>
      <button type="button" className="btn-sm" disabled={busy} onClick={() => actions.takeConflictSide(file, "ours", names.ours)}>
        まるごと今のブランチの方に…
      </button>
      <button type="button" className="btn-sm" disabled={busy} onClick={() => actions.takeConflictSide(file, "theirs", names.theirs)}>
        まるごと取り込む側に…
      </button>
    </>
  );

  if (error) {
    return (
      <div className="mt">
        <p className="mt-error">⚠ {error}</p>
        <button type="button" className="btn-sm" onClick={() => setReloadSeq((n) => n + 1)}>読み直す</button>
      </div>
    );
  }
  if (!data) return <div className="mt"><p className="mt-hint">読み込んでいます…</p></div>;

  // 印で直せないファイル: 片方で消された・文字でない（画像など）・印が見つからない
  if (!parsed || hunks.length === 0) {
    return (
      <div className="mt">
        <div className="mt-head"><b>競合を直す — {file}</b></div>
        {data.missing ? (
          <p>このファイルは、片方で消され、もう片方では変えられていました。消したままにするか、どちらかの内容で残すかを選びます。</p>
        ) : data.binary ? (
          <p>文字でないファイル（画像など）なので、か所ごとには選べません。どちらか片方を、まるごと選びます。</p>
        ) : (
          <p>
            競合の印（<code>{"<<<<<<<"}</code>）が見つかりません。エディタなどで、もう直してあるなら、このままステージします。
          </p>
        )}
        <div className="mt-foot">
          {!data.missing && !data.binary && (
            <button type="button" className="btn-primary" disabled={busy} onClick={() => actions.resolveConflict(file, data.text)}>
              このままステージする
            </button>
          )}
          {data.missing && (
            <button type="button" className="btn-sm" disabled={busy} onClick={() => actions.takeConflictSide(file, "delete", "")}>
              消したままにする…
            </button>
          )}
          {wholeSideButtons}
          <button type="button" className="btn-sm" onClick={() => setReloadSeq((n) => n + 1)}>読み直す</button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt">
      <div className="mt-head">
        <b>競合を直す — {file}</b>
        <span className={`mt-progress${done === hunks.length ? " all" : ""}`}>
          {hunks.length} か所のうち {done} か所 直した
        </span>
      </div>
      <p className="mt-lead">
        同じところが、<span className="mt-name--ours">{names.ours}</span>と<span className="mt-name--theirs">{names.theirs}</span>
        で違います。か所ごとに、<b>使う方</b>を選んでください。
      </p>

      {hunks.map((h) => {
        const choice = choices[h.index];
        const stateOf = (side: "ours" | "theirs"): SideState => {
          if (!choice) return "";
          if (choice.kind === "both") return "use";
          if (choice.kind === "custom") return "";
          return choice.kind === side ? "use" : "drop";
        };
        const orderOf = (side: "ours" | "theirs") => (choice?.kind === "both" ? (choice.first === side ? 1 : 2) : undefined);
        const dropped = choice?.kind === "ours" ? names.theirs : choice?.kind === "theirs" ? names.ours : null;
        const choiceText = !choice
          ? ""
          : choice.kind === "ours"
            ? `${names.ours}を使う`
            : choice.kind === "theirs"
              ? `${names.theirs}を使う`
              : choice.kind === "both"
                ? "両方を残す"
                : "自分で書いた内容にする";
        return (
          <div key={h.index} className={`mt-hunk${choice ? " done" : ""}`}>
            <div className="mt-hunk-head">
              <b>{numberOf(h.index)} {h.line} 行目</b>
              {h.before !== null && h.before.trim() !== "" && <code className="mt-ctx">{h.before}</code>}
              {choice && <span className="mt-done">✔ {choiceText}</span>}
              {choice && (
                <button type="button" className="link-button mt-redo" onClick={() => choose(h.index, undefined)}>
                  やり直す
                </button>
              )}
            </div>

            {editing === h.index ? (
              <div className="mt-custom">
                <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={Math.min(12, Math.max(3, draft.split("\n").length + 1))} autoFocus />
                <p className="mt-hint">両方の内容を入れてあります。残したい形に書き直してください（印は入れません）。</p>
                <div className="mt-custom-actions">
                  <button type="button" className="btn-primary" onClick={() => { choose(h.index, { kind: "custom", text: draft }); setEditing(null); }}>
                    これにする
                  </button>
                  <button type="button" className="btn-sm" onClick={() => setEditing(null)}>やめる</button>
                </div>
              </div>
            ) : choice?.kind === "custom" ? (
              <pre className="mt-result">{choice.text || "（何も残さない）"}</pre>
            ) : (
              <div className="mt-sides">
                <SideBox side="ours" label={names.ours} lines={h.ours} state={stateOf("ours")} order={orderOf("ours")}
                  onUse={choice ? undefined : () => choose(h.index, { kind: "ours" })} />
                <SideBox side="theirs" label={names.theirs} lines={h.theirs} state={stateOf("theirs")} order={orderOf("theirs")}
                  onUse={choice ? undefined : () => choose(h.index, { kind: "theirs" })} />
              </div>
            )}

            {!choice && editing !== h.index && (
              <div className="mt-more">
                <button type="button" className="btn-sm" onClick={() => choose(h.index, { kind: "both", first: "ours" })}>両方を残す（左 → 右の順）</button>
                <button type="button" className="btn-sm" onClick={() => choose(h.index, { kind: "both", first: "theirs" })}>両方を残す（右 → 左の順）</button>
                <button type="button" className="btn-sm" onClick={() => startEditing(h)}>自分で書く…</button>
              </div>
            )}
            {dropped && (
              <p className="mt-drop-note">
                捨てる内容（{dropped}）は、そのブランチ・コミットに残っています。あとで要るときは、そちらのファイルを見て手で入れます。
              </p>
            )}
          </div>
        );
      })}

      <div className="mt-foot">
        <button type="button" className="btn-primary" disabled={busy || resolved === null} onClick={() => resolved !== null && actions.resolveConflict(file, resolved)}
          title={resolved === null ? "すべてのか所で、使う方を選ぶと押せます" : undefined}>
          直したので、ステージする
        </button>
        <button type="button" className="btn-sm" disabled={busy} onClick={() => actions.openFile(file)}>エディタで開く</button>
        {wholeSideButtons}
        <button type="button" className="btn-sm" onClick={() => setReloadSeq((n) => n + 1)} title="エディタで直したあとなど">読み直す</button>
        <code className="mt-cmd">書き込んで {git.displayCommand(["add", "--", file])}</code>
      </div>
      <p className="hint">
        ファイルの中では、競合したところに <code>{"<<<<<<<"}</code>（ここから今のブランチ）・<code>=======</code>（区切り）・
        <code>{">>>>>>>"}</code>（ここまで取り込む側）の印が入っています。ここで選ぶと、印を消して、選んだ内容だけを書き込みます。
      </p>
    </div>
  );
}
