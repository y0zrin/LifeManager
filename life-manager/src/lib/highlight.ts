import { tr } from "./i18n";
// コードの色分け（ライブラリを使わない、小さな字句の分け方）。行ごとに [種類, 文字] の並びにする。
// C 系（C/C++/C#/Java/JS/TS/Go/Rust/シェーダー など）・Python・Lua・シェル・JSON・YAML/INI/TOML・XML/HTML・CSS

export type TokenType = "plain" | "kw" | "ty" | "str" | "num" | "cm" | "fn" | "pp" | "tag" | "attr" | "key";
export type Token = { t: TokenType; s: string };

const words = (s: string) => new Set(s.split(/\s+/).filter(Boolean));

const C_KW = "auto break case char const continue default do double else enum extern float for goto if inline int long register return short signed sizeof static struct switch typedef union unsigned void volatile while bool true false nullptr NULL class public private protected virtual override final template typename namespace using new delete this operator friend constexpr consteval noexcept static_cast dynamic_cast reinterpret_cast const_cast try catch throw explicit mutable decltype";
const CS_KW = "abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using var virtual void volatile while async await get set yield partial where record init nameof";
const JAVA_KW = "abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new null package private protected public return short static strictfp super switch synchronized this throw throws transient true false try void volatile while var record";
const JS_KW = "break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new return super switch this throw try typeof var void while with yield async await of from as interface type enum implements private public protected readonly static abstract declare keyof null undefined true false satisfies";
const GO_KW = "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false";
const RUST_KW = "as break const continue crate else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while async await dyn";
const PY_KW = "False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield self match case";
const LUA_KW = "and break do else elseif end false for function goto if in local nil not or repeat return then true until while self";
const SHADER_KW = C_KW + " uniform varying attribute in out inout layout precision highp mediump lowp discard vec2 vec3 vec4 ivec2 ivec3 ivec4 bvec2 bvec3 bvec4 mat2 mat3 mat4 sampler2D samplerCube float2 float3 float4 half half2 half3 half4 fixed fixed2 fixed3 fixed4 float4x4 float3x3 Texture2D SamplerState cbuffer Shader Properties SubShader Pass CGPROGRAM ENDCG HLSLPROGRAM ENDHLSL Tags";
const SH_KW = "if then else elif fi for do done while until case esac function return in echo exit set export local readonly shift source alias cd rem goto call setlocal endlocal param foreach begin process end try catch finally switch";
const KOTLIN_SWIFT_KW = "fun val var class object interface if else when for while do return break continue null true false is in as import package private public protected internal override open abstract data sealed let func struct enum protocol extension guard self super init deinit throws try catch nil static";

interface CLang {
  line: string[];
  block: [string, string][];
  /** 長い順に（""" を " より先に） */
  strings: string[];
  /** 行をまたぐ文字列（Python の """、JS の ` など） */
  multiline: string[];
  keywords: Set<string>;
  /** # で始まる行はプリプロセッサ（C/C++/C#/シェーダー） */
  pp: boolean;
  /** 大文字で始まる名前は型の色に */
  caps: boolean;
  ci?: boolean;
}

const C_LIKE = (kw: string, pp = false, extra: Partial<CLang> = {}): CLang => ({
  line: ["//"], block: [["/*", "*/"]], strings: ['"', "'"], multiline: [], keywords: words(kw), pp, caps: true, ...extra,
});

const LANGS: Record<string, CLang> = {
  c: C_LIKE(C_KW, true), cpp: C_LIKE(C_KW, true), cs: C_LIKE(CS_KW, true, { strings: ['@"', '$"', '"', "'"] }),
  java: C_LIKE(JAVA_KW), js: C_LIKE(JS_KW, false, { strings: ['"', "'", "`"], multiline: ["`"] }),
  go: C_LIKE(GO_KW, false, { strings: ['"', "'", "`"], multiline: ["`"] }), rust: C_LIKE(RUST_KW), shader: C_LIKE(SHADER_KW, true),
  kotlin: C_LIKE(KOTLIN_SWIFT_KW, false, { strings: ['"""', '"', "'"], multiline: ['"""'] }),
  php: C_LIKE(JS_KW + " echo function namespace use foreach elseif endif", false, { line: ["//", "#"] }),
  py: { line: ["#"], block: [], strings: ['"""', "'''", '"', "'"], multiline: ['"""', "'''"], keywords: words(PY_KW), pp: false, caps: true },
  ruby: { line: ["#"], block: [], strings: ['"', "'"], multiline: [], keywords: words("def end if elsif else unless while until for in do return class module self nil true false and or not yield begin rescue ensure require puts"), pp: false, caps: true },
  lua: { line: ["--"], block: [["--[[", "]]"]], strings: ['"', "'"], multiline: [], keywords: words(LUA_KW), pp: false, caps: false },
  sh: { line: ["#", "::", "REM ", "rem "], block: [["<#", "#>"]], strings: ['"', "'"], multiline: [], keywords: words(SH_KW), pp: false, caps: false, ci: true },
  sql: { line: ["--"], block: [["/*", "*/"]], strings: ["'", '"'], multiline: [], keywords: words("select from where and or not insert into values update set delete create table drop alter index primary key foreign references join left right inner outer on group by order having limit as distinct null is in like between union all case when then else end"), pp: false, caps: false, ci: true },
};

const EXT_LANG: Record<string, string> = {
  c: "c", h: "cpp", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", hxx: "cpp",
  cs: "cs", java: "java", js: "js", mjs: "js", cjs: "js", ts: "js", tsx: "js", jsx: "js", vue: "markup", svelte: "markup",
  go: "go", rs: "rust", kt: "kotlin", kts: "kotlin", swift: "kotlin", gradle: "kotlin", php: "php", py: "py", rb: "ruby", lua: "lua",
  glsl: "shader", vert: "shader", frag: "shader", hlsl: "shader", shader: "shader", cginc: "shader", compute: "shader",
  sh: "sh", bash: "sh", zsh: "sh", bat: "sh", cmd: "sh", ps1: "sh", cmake: "sh", sql: "sql",
  json: "json", jsonc: "json", yaml: "yaml", yml: "yaml", toml: "yaml", ini: "yaml", cfg: "yaml", conf: "yaml", env: "yaml", editorconfig: "yaml",
  xml: "markup", xaml: "markup", uxml: "markup", html: "markup", htm: "markup", svg: "markup",
  css: "css", scss: "css", less: "css", uss: "css",
};

/** 見出しに出す言語の名前 */
export const LANG_NAMES: Record<string, string> = {
  c: "C", h: "C/C++", cpp: "C++", cc: "C++", cxx: "C++", hpp: "C++", cs: "C#", java: "Java", js: "JavaScript", mjs: "JavaScript", ts: "TypeScript", tsx: "TSX", jsx: "JSX",
  go: "Go", rs: "Rust", kt: "Kotlin", swift: "Swift", php: "PHP", py: "Python", rb: "Ruby", lua: "Lua", glsl: "GLSL", hlsl: "HLSL", shader: "ShaderLab", cginc: "HLSL",
  sh: tr("シェル"), bat: tr("バッチ"), ps1: "PowerShell", cmake: "CMake", sql: "SQL", json: "JSON", yaml: "YAML", yml: "YAML", toml: "TOML", ini: "INI",
  xml: "XML", xaml: "XAML", uxml: "UXML", html: "HTML", htm: "HTML", svg: "SVG", css: "CSS", scss: "SCSS", less: "Less", uss: "USS", vue: "Vue", svelte: "Svelte",
};

function push(out: Token[], t: TokenType, s: string) {
  if (!s) return;
  const last = out[out.length - 1];
  if (last && last.t === t) last.s += s;
  else out.push({ t, s });
}

const NUM = /^(0[xX][0-9a-fA-F_]+|0[bB][01_]+|\d[\d_]*(\.\d+)?([eE][+-]?\d+)?)[fFdDuUlLmM]*/;
const IDENT = /^[A-Za-z_$@][\w$]*/;

function tokenizeC(lines: string[], lang: CLang): Token[][] {
  const result: Token[][] = [];
  let inBlock: string | null = null;
  let inString: string | null = null;
  const starts = (line: string, i: number, m: string) => (lang.ci ? line.slice(i, i + m.length).toLowerCase() === m.toLowerCase() : line.startsWith(m, i));
  for (const line of lines) {
    const out: Token[] = [];
    let i = 0;
    if (inBlock) {
      const end = line.indexOf(inBlock);
      if (end < 0) {
        push(out, "cm", line);
        result.push(out);
        continue;
      }
      push(out, "cm", line.slice(0, end + inBlock.length));
      i = end + inBlock.length;
      inBlock = null;
    } else if (inString) {
      const end = line.indexOf(inString);
      if (end < 0) {
        push(out, "str", line);
        result.push(out);
        continue;
      }
      push(out, "str", line.slice(0, end + inString.length));
      i = end + inString.length;
      inString = null;
    }
    if (i === 0 && lang.pp && /^\s*#\s*\w/.test(line)) {
      const cm = line.indexOf("//");
      push(out, "pp", cm >= 0 ? line.slice(0, cm) : line);
      if (cm >= 0) push(out, "cm", line.slice(cm));
      result.push(out);
      continue;
    }
    while (i < line.length) {
      const rest = line.slice(i);
      if (lang.line.some((m) => starts(line, i, m))) {
        push(out, "cm", rest);
        break;
      }
      const block = lang.block.find(([s]) => line.startsWith(s, i));
      if (block) {
        const end = line.indexOf(block[1], i + block[0].length);
        if (end < 0) {
          push(out, "cm", rest);
          inBlock = block[1];
          break;
        }
        push(out, "cm", line.slice(i, end + block[1].length));
        i = end + block[1].length;
        continue;
      }
      const quote = lang.strings.find((q) => line.startsWith(q, i));
      if (quote) {
        const close = quote.length === 2 && (quote[0] === "@" || quote[0] === "$") ? '"' : quote;
        let j = i + quote.length;
        let closed = false;
        while (j < line.length) {
          if (close.length === 1 && line[j] === "\\") {
            j += 2;
            continue;
          }
          if (line.startsWith(close, j)) {
            j += close.length;
            closed = true;
            break;
          }
          j++;
        }
        push(out, "str", line.slice(i, j));
        if (!closed && lang.multiline.includes(quote)) inString = close;
        i = j;
        continue;
      }
      const num = NUM.exec(rest);
      if (num && !/[\w$]/.test(line[i - 1] ?? "")) {
        push(out, "num", num[0]);
        i += num[0].length;
        continue;
      }
      const id = IDENT.exec(rest);
      if (id) {
        const w = id[0];
        const next = line.slice(i + w.length).match(/^\s*\(/);
        const isKw = lang.ci ? lang.keywords.has(w.toLowerCase()) || lang.keywords.has(w) : lang.keywords.has(w);
        push(out, isKw ? "kw" : next ? "fn" : lang.caps && /^[A-Z][a-z0-9]/.test(w) ? "ty" : "plain", w);
        i += w.length;
        continue;
      }
      push(out, "plain", line[i]);
      i++;
    }
    result.push(out);
  }
  return result;
}

function tokenizeJson(lines: string[]): Token[][] {
  return lines.map((line) => {
    const out: Token[] = [];
    const re = /("(?:\\.|[^"\\])*")(\s*:)?|(\/\/.*$)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([^"\/\d\-tfn]+|.)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
      if (m[1]) {
        push(out, m[2] ? "key" : "str", m[1]);
        if (m[2]) push(out, "plain", m[2]);
      } else if (m[3]) push(out, "cm", m[3]);
      else if (m[4]) push(out, "num", m[4]);
      else if (m[5]) push(out, "kw", m[5]);
      else push(out, "plain", m[0]);
    }
    return out;
  });
}

function tokenizeYaml(lines: string[]): Token[][] {
  return lines.map((line) => {
    const out: Token[] = [];
    const comment = line.match(/^(\s*)([#;].*)$/);
    if (comment) {
      push(out, "plain", comment[1]);
      push(out, "cm", comment[2]);
      return out;
    }
    const section = line.match(/^(\s*)(\[[^\]]*\])(.*)$/);
    if (section) {
      push(out, "plain", section[1]);
      push(out, "ty", section[2]);
      push(out, "plain", section[3]);
      return out;
    }
    const kv = line.match(/^(\s*-?\s*)([^:=#"'\s][^:=#]*?)(\s*[:=])(.*)$/);
    let rest = line;
    if (kv) {
      push(out, "plain", kv[1]);
      push(out, "key", kv[2]);
      push(out, "plain", kv[3]);
      rest = kv[4];
    }
    const re = /("(?:\\.|[^"\\])*"|'[^']*')|(\s#.*$)|(-?\d+(?:\.\d+)?)(?=\s*$|\s*#)|\b(true|false|null|yes|no|on|off)\b|([^"'#\d\-tfnyo]+|.)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(rest))) {
      if (m[1]) push(out, "str", m[1]);
      else if (m[2]) push(out, "cm", m[2]);
      else if (m[3]) push(out, "num", m[3]);
      else if (m[4]) push(out, "kw", m[4]);
      else push(out, "plain", m[0]);
    }
    return out;
  });
}

function tokenizeMarkup(lines: string[]): Token[][] {
  const result: Token[][] = [];
  let inComment = false;
  let inTag = false;
  for (const line of lines) {
    const out: Token[] = [];
    let i = 0;
    while (i < line.length) {
      if (inComment) {
        const end = line.indexOf("-->", i);
        if (end < 0) {
          push(out, "cm", line.slice(i));
          i = line.length;
          break;
        }
        push(out, "cm", line.slice(i, end + 3));
        i = end + 3;
        inComment = false;
        continue;
      }
      if (inTag) {
        const rest = line.slice(i);
        const m = rest.match(/^(\s+)|^(\/?>)|^("[^"]*"|'[^']*')|^([\w:@.-]+)|^(=)|^(.)/);
        if (!m) break;
        if (m[2]) {
          push(out, "tag", m[2]);
          inTag = false;
        } else if (m[3]) push(out, "str", m[3]);
        else if (m[4]) push(out, "attr", m[4]);
        else push(out, "plain", m[0]);
        i += m[0].length;
        continue;
      }
      if (line.startsWith("<!--", i)) {
        inComment = true;
        continue;
      }
      const tag = line.slice(i).match(/^<\/?[\w:.-]+|^<!\w+/);
      if (tag) {
        push(out, "tag", tag[0]);
        i += tag[0].length;
        inTag = true;
        continue;
      }
      const next = line.indexOf("<", i + 1);
      const text = next < 0 ? line.slice(i) : line.slice(i, next);
      push(out, "plain", text);
      i += text.length;
    }
    result.push(out);
  }
  return result;
}

function tokenizeCss(lines: string[]): Token[][] {
  const result: Token[][] = [];
  let inComment = false;
  for (const line of lines) {
    const out: Token[] = [];
    let rest = line;
    if (inComment) {
      const end = rest.indexOf("*/");
      if (end < 0) {
        push(out, "cm", rest);
        result.push(out);
        continue;
      }
      push(out, "cm", rest.slice(0, end + 2));
      rest = rest.slice(end + 2);
      inComment = false;
    }
    const re = /(\/\*.*?(?:\*\/|$))|(\/\/.*$)|("[^"]*"|'[^']*')|([\w-]+)(\s*:)(?!:)|(#[0-9a-fA-F]{3,8}\b|-?\d+(?:\.\d+)?(?:px|em|rem|%|s|ms|deg|vh|vw|fr)?)|(@[\w-]+)|([^\/"'\w#@-]+|.)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(rest))) {
      if (m[1]) {
        push(out, "cm", m[1]);
        if (!m[1].endsWith("*/")) inComment = true;
      } else if (m[2]) push(out, "cm", m[2]);
      else if (m[3]) push(out, "str", m[3]);
      else if (m[4]) {
        push(out, "key", m[4]);
        push(out, "plain", m[5]);
      } else if (m[6]) push(out, "num", m[6]);
      else if (m[7]) push(out, "kw", m[7]);
      else push(out, "plain", m[0]);
    }
    result.push(out);
  }
  return result;
}

/** コードを行ごとの字句に（知らない言語は、色なしで） */
export function highlightLines(code: string, ext: string): Token[][] {
  const lines = code.replace(/\r\n?/g, "\n").split("\n");
  const lang = EXT_LANG[ext] ?? "";
  if (lang === "json") return tokenizeJson(lines);
  if (lang === "yaml") return tokenizeYaml(lines);
  if (lang === "markup") return tokenizeMarkup(lines);
  if (lang === "css") return tokenizeCss(lines);
  const spec = LANGS[lang];
  if (spec) return tokenizeC(lines, spec);
  return lines.map((l) => (l ? [{ t: "plain" as const, s: l }] : []));
}
