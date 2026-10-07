// 画面の言語（#256）の確かめ。npm run i18n:check
//   1. 訳のない文: src の tr()・trx()・sentence() の鍵と、Rust から画面に届く文のうち、辞書（src/locales/*.json）にないもの
//   2. 包み忘れ: tr() で包んでいない日本語のうち、scripts/i18n-baseline.json（わざと日本語のまま残したもの）にないもの
//   3. 訳の形: 辞書の訳の {名前} と <0>…</0> が、元の文と同じか
// npm run i18n:todo                       … 訳のない文を i18n-todo.json に書き出す（訳すときに使う。コミットしない）
// node scripts/i18n.mjs --update-baseline … 今の包んでいない日本語を「わざと残したもの」として記録する（GitHub に書く文などを足したとき）
//
// 決まり（CLAUDE.md の「画面の言語」も）:
// - 画面に出す文は tr("日本語") で包む。数や名前は tr("{n} 件", { n })、太字やコードの入る文は trx("<0>{name}</0> を…", { name }, [<b />])
// - GitHub やチームに書く文（日誌・作業報告や 🆘 の決まった文・ラベルの名前・Actions のひな形・Issue テンプレート・リリースノート・Discord）は包まない
// - Rust が返す文（エラー・結果）は lib/invoke が訳す。鍵は format! の {} を {0} {1} … にした形
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(ROOT, "package.json"));
const ts = require("typescript");

const args = process.argv.slice(2);
const TODO = args.includes("--todo");
const UPDATE_BASELINE = args.includes("--update-baseline");
const PRUNE = args.includes("--prune");
const LANGS = ["en", "zh-Hans", "zh-Hant"];
const BASELINE = path.join(ROOT, "scripts", "i18n-baseline.json");
const TODO_FILE = path.join(ROOT, "i18n-todo.json");

const JA = /[぀-ヿ㐀-鿿]/;
const DATA_LABEL = /^(種別|状態|優先|セクション|分野|見積|ルーチン)[:：]/;
const I18N_CALLS = new Set(["tr", "trx", "sentence"]);
// 包まなくてよい呼び出しの引数（比べる・探す・記録する）
const DENY_CALLS = new Set([
  "startsWith", "endsWith", "includes", "indexOf", "lastIndexOf", "split", "replace", "replaceAll", "match", "matchAll", "test", "search",
  "has", "get", "set", "delete", "add", "getItem", "setItem", "removeItem", "querySelector", "querySelectorAll", "closest", "localeCompare",
  "log", "warn", "error", "info", "debug", "RegExp", "fetch", "encodeURIComponent", "decodeURIComponent", "parseInt", "parseFloat",
  "require", "emit", "listen", "padStart", "padEnd", "trim", "normalize", "find", "findIndex", "filter", "some", "every",
  ...I18N_CALLS,
]);
// GitHub に書く呼び出し（引数の文は日本語のまま）
const WRITE_CALLS = /^(invoke\w*|create[A-Z]\w*|update[A-Z]\w*|add[A-Z]?\w*Comment\w*|post[A-Z]?\w*|edit\w*Comment\w*|onCreate\w*|onUpdate\w*|onAdd\w*Comment\w*|onPost\w*|onEdit\w*|commit\w*|onCommit\w*|setBody|onSetBody|closeIssue|onCloseIssue|reopen\w*|merge\w*|onMerge\w*|addLabels?|removeLabel\w*|setLabels?|onSetLabels?)$/;
const DENY_ATTRS = new Set([
  "key", "className", "id", "value", "defaultValue", "href", "src", "type", "name", "role", "htmlFor", "style", "accept", "pattern",
  "autoComplete", "inputMode", "method", "action", "target", "rel", "lang", "dir", "form", "list", "step", "min", "max", "viewBox", "d",
  "fill", "stroke", "transform", "points", "x", "y", "width", "height", "cx", "cy", "r", "tabIndex", "kind", "tone", "view", "variant",
  "size", "position", "section", "status", "mode", "genre", "sectionKey", "labelName", "branch",
]);

function walk(dir, exts, out = []) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) walk(p, exts, out);
    else if (exts.some((e) => f.endsWith(e))) out.push(p);
  }
  return out;
}
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, "/");

function calleeName(expr) {
  if (!expr) return "";
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return "";
}

/** JSX のテキストが画面に出す文字（React と同じ空白の扱い） */
function cleanJsxText(value) {
  const lines = value.split(/\r\n|\n|\r/);
  let last = 0;
  lines.forEach((l, i) => {
    if (/[^ \t]/.test(l)) last = i;
  });
  let out = "";
  lines.forEach((line, i) => {
    let t = line.replace(/\t/g, " ");
    if (i > 0) t = t.replace(/^[ ]+/, "");
    if (i < lines.length - 1) t = t.replace(/[ ]+$/, "");
    if (t) out += i !== last ? `${t} ` : t;
  });
  return out;
}

// --- 画面（TypeScript）: 鍵と、包んでいない日本語 ---
const keys = new Map(); // 鍵 → 場所
const unwrapped = []; // { file, line, text }
for (const file of walk(path.join(ROOT, "src"), [".ts", ".tsx"])) {
  const r = rel(file);
  if (r === "src/lib/i18n.ts") continue;
  // 単体テスト（vitest）は画面に出さないので見ない
  if (/\.test\.tsx?$/.test(r)) continue;
  const text = fs.readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lineOf = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const insideWriteCall = (node) => {
    for (let n = node; n.parent; n = n.parent) {
      const p = n.parent;
      if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.arguments?.includes(n) && WRITE_CALLS.test(calleeName(p.expression))) return true;
      if (ts.isFunctionLike(p) || ts.isSourceFile(p) || ts.isJsxElement(p) || ts.isJsxSelfClosingElement(p)) return false;
    }
    return false;
  };
  /** コードの中の文字列を、包まなくてよい（比べる相手・データ・GitHub に書く文） */
  const skip = (node, value) => {
    const p = node.parent;
    if (!p) return true;
    if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isExternalModuleReference(p) || ts.isLiteralTypeNode(p)) return true;
    if ((ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p) || ts.isEnumMember(p)) && p.name === node) return true;
    if (ts.isElementAccessExpression(p) && p.argumentExpression === node) return true;
    if (ts.isCaseClause(p)) return true;
    if (ts.isBinaryExpression(p) && [ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.InKeyword].includes(p.operatorToken.kind)) return true;
    if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.arguments?.includes(node)) {
      const c = calleeName(p.expression);
      if (DENY_CALLS.has(c) || c === "Set" || c === "Map") return true;
    }
    if (ts.isArrayLiteralExpression(p)) {
      const pp = p.parent;
      if (pp && ts.isPropertyAccessExpression(pp) && ["includes", "indexOf", "some", "every", "find", "filter"].includes(pp.name.text)) return true;
      if (pp && ts.isNewExpression(pp) && ["Set", "Map"].includes(calleeName(pp.expression))) return true;
    }
    return DATA_LABEL.test(value) || insideWriteCall(node);
  };
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && I18N_CALLS.has(node.expression.text)) {
      const a = node.arguments[0];
      if (a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) && !keys.has(a.text)) keys.set(a.text, `${r}:${lineOf(node)}`);
      // 値（vars）の中の文は見る
      node.arguments.slice(1).forEach(visit);
      return;
    }
    if (ts.isJsxText(node)) {
      const t = cleanJsxText(node.text);
      if (JA.test(t)) unwrapped.push({ file: r, line: lineOf(node), text: t.trim() });
      return;
    }
    if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer)) {
      const name = node.name.getText(sf);
      const t = node.initializer.text;
      if (JA.test(t) && !DENY_ATTRS.has(name) && !name.startsWith("data-") && !DATA_LABEL.test(t)) unwrapped.push({ file: r, line: lineOf(node), text: t });
      return;
    }
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && JA.test(node.text)) {
      if (!skip(node, node.text)) unwrapped.push({ file: r, line: lineOf(node), text: node.text });
      return;
    }
    if (ts.isTemplateExpression(node)) {
      const parts = [node.head.text, ...node.templateSpans.map((s) => s.literal.text)];
      if (parts.some((s) => JA.test(s)) && !skip(node, node.head.text)) unwrapped.push({ file: r, line: lineOf(node), text: parts.join("${}") });
      node.templateSpans.forEach((s) => visit(s.expression));
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

// 変数で訳す文（tr(ラベルの名前) など。コードから鍵を拾えないもの）。scripts/i18n-extra-keys.json に「鍵: どこで使うか」で書く
const EXTRA = path.join(ROOT, "scripts", "i18n-extra-keys.json");
if (fs.existsSync(EXTRA)) {
  for (const [k, note] of Object.entries(JSON.parse(fs.readFileSync(EXTRA, "utf8")))) if (!keys.has(k)) keys.set(k, `（${note}）`);
}

// --- Rust: 画面に届く日本語の文（エラー・結果） ---
// 除くもの: テスト・コメント・eprintln!/println!・GitHub やチームに送る文（日誌・ルーチン・Discord）・ラベルの定義
const RUST_SKIP = new Set(["src-tauri/src/journal/generator.rs", "src-tauri/src/scheduler/routine.rs", "src-tauri/src/notify/discord.rs", "src-tauri/src/git/scenario_tests.rs"]);
function stripRust(src) {
  const i = src.indexOf("#[cfg(test)]");
  if (i >= 0) src = src.slice(0, i);
  let out = "";
  for (let k = 0; k < src.length; ) {
    if (src.startsWith("//", k)) {
      const j = src.indexOf("\n", k);
      k = j < 0 ? src.length : j;
    } else if (src.startsWith("/*", k)) {
      const j = src.indexOf("*/", k + 2);
      k = j < 0 ? src.length : j + 2;
    } else if (src[k] === "r" && (src[k + 1] === '"' || (src[k + 1] === "#" && /^#+"/.test(src.slice(k + 1)))) && !/[\w]/.test(src[k - 1] ?? "")) {
      // 生の文字列（r"…"・r#"…"#）は、\ を特別に扱わない。画面の文ではないので読み飛ばす
      const hashes = /^#*/.exec(src.slice(k + 1))[0];
      const end = src.indexOf(`"${hashes}`, k + 2 + hashes.length);
      k = end < 0 ? src.length : end + 1 + hashes.length;
      out += '""';
    } else if (src[k] === '"') {
      let j = k + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
      out += src.slice(k, j + 1);
      k = j + 1;
    } else if (src[k] === "'" && (src[k + 2] === "'" || (src[k + 1] === "\\" && src[k + 3] === "'"))) {
      const j = src.indexOf("'", k + 2);
      out += src.slice(k, j + 1);
      k = j + 1;
    } else {
      out += src[k++];
    }
  }
  return out;
}
const rustKeys = new Map();
for (const file of walk(path.join(ROOT, "src-tauri", "src"), [".rs"])) {
  const r = rel(file);
  if (RUST_SKIP.has(r)) continue;
  const src = stripRust(fs.readFileSync(file, "utf8"));
  for (const m of src.matchAll(/"((?:[^"\\]|\\.)*)"/gs)) {
    const raw = m[1];
    if (!JA.test(raw)) continue;
    const ls = src.lastIndexOf("\n", m.index) + 1;
    const line = src.slice(ls, src.indexOf("\n", m.index));
    if (/eprintln!|println!|log::|debug!/.test(line) || /^\s*\("(優先|セクション|種別|状態):/.test(line)) continue;
    let t = raw.replace(/\\\n\s*/g, "").replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\\\/g, "\\");
    if (DATA_LABEL.test(t)) continue;
    if (t.includes("{")) {
      let k = 0;
      t = t.replace(/\{\{|\}\}|\{[^{}]*\}/g, (s) => (s === "{{" ? "{" : s === "}}" ? "}" : `{${k++}}`));
    }
    if (!rustKeys.has(t)) rustKeys.set(t, `${r}:${src.slice(0, m.index).split("\n").length}`);
  }
}

// --- 辞書と比べる ---
const dicts = Object.fromEntries(LANGS.map((l) => [l, JSON.parse(fs.readFileSync(path.join(ROOT, "src", "locales", `${l}.json`), "utf8"))]));
const allKeys = new Map([...keys, ...rustKeys]);
const missing = [...allKeys].filter(([k]) => LANGS.some((l) => dicts[l][k] === undefined)).map(([key, where]) => ({ key, where, lack: LANGS.filter((l) => dicts[l][key] === undefined) }));

// 訳の形
const shape = (s) => [[...s.matchAll(/\{([^{}\s]+)\}/g)].map((m) => m[1]).sort().join(","), [...s.matchAll(/<\/?(\d+)>/g)].map((m) => m[1]).sort().join(",")].join("|");
const badShape = [];
for (const l of LANGS) {
  for (const [k, v] of Object.entries(dicts[l])) {
    if (!allKeys.has(k)) continue;
    const forms = typeof v === "string" ? [v] : [v.other, v.one].filter(Boolean);
    // 英語の one は、数の場所を書かなくてもよい（"an hour ago"）
    if (forms.some((f, i) => f && (i === 0 ? shape(f) !== shape(k) : false))) badShape.push(`${l}: ${JSON.stringify(k)} → ${JSON.stringify(v)}`);
  }
}

// 包み忘れ（わざと残したものは除く）
const baseline = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, "utf8")) : {};
if (UPDATE_BASELINE) {
  const next = {};
  for (const u of unwrapped) (next[u.file] ??= []).includes(u.text) || next[u.file].push(u.text);
  fs.writeFileSync(BASELINE, JSON.stringify(next, null, 1) + "\n");
  console.log(`わざと残した日本語を記録しました: ${unwrapped.length} か所 → ${rel(BASELINE)}`);
  process.exit(0);
}
const forgotten = unwrapped.filter((u) => !(baseline[u.file] ?? []).includes(u.text));
const unusedKeys = Object.keys(dicts.en ?? {}).filter((k) => !allKeys.has(k));
const unused = unusedKeys.length;
if (PRUNE) {
  // 使っていない鍵を辞書から消す（並びはそのまま）
  for (const l of LANGS) {
    for (const k of unusedKeys) delete dicts[l][k];
    fs.writeFileSync(path.join(ROOT, "src", "locales", `${l}.json`), JSON.stringify(dicts[l], null, 1) + "\n");
  }
  for (const k of unusedKeys) console.log(`  消した: ${JSON.stringify(k).slice(0, 100)}`);
  console.log(`使っていない鍵 ${unused} 件を辞書から消しました`);
  process.exit(0);
}

if (TODO) {
  fs.writeFileSync(TODO_FILE, JSON.stringify(missing, null, 1) + "\n");
  console.log(`訳のない文 ${missing.length} 件を ${rel(TODO_FILE)} に書きました`);
}
console.log(`鍵: 画面 ${keys.size}・Rust ${rustKeys.size}（辞書にあって使っていない鍵 ${unused}）`);
console.log(`訳のない文: ${missing.length}`);
for (const m of missing.slice(0, 20)) console.log(`  ${m.where}  ${JSON.stringify(m.key).slice(0, 100)}  [${m.lack.join(", ")}]`);
if (missing.length > 20) console.log(`  …ほか ${missing.length - 20}（npm run i18n:todo で一覧）`);
console.log(`包み忘れの日本語: ${forgotten.length}`);
for (const u of forgotten.slice(0, 20)) console.log(`  ${u.file}:${u.line}  ${JSON.stringify(u.text).slice(0, 100)}`);
if (forgotten.length > 20) console.log(`  …ほか ${forgotten.length - 20}`);
console.log(`訳の形が元の文と合わない: ${badShape.length}`);
for (const b of badShape.slice(0, 20)) console.log(`  ${b.slice(0, 160)}`);
process.exit(missing.length || forgotten.length || badShape.length ? 1 : 0);
