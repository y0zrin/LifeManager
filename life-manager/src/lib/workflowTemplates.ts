// Actions のワークフローのひな形（リポジトリのファイルから、言語に合うものを選ぶ）。
// 学ぶ人が読めるよう、1 行ずつ日本語の説明を付けておく

export interface WorkflowTemplate {
  id: string;
  name: string;
  /** どんなリポジトリ向けか */
  detail: string;
  /** いちばん上のファイルの名前・GitHub の見た言語から、合うか */
  detect: (files: string[], language: string | null) => boolean;
  /** 置くファイル */
  file: string;
  /** dir は、プロジェクトのあるフォルダ（いちばん上なら "."） */
  yaml: (dir: string) => string;
}

const HEADER = (title: string, what: string) =>
  `# ${title}: ${what}（Life Manager のひな形）
name: ${title}

on:
  push:               # プッシュしたとき
  pull_request:       # プルリクを出した・コミットを足したとき
  workflow_dispatch:  # 手で動かすとき（Life Manager の「▶ 手で実行」）
`;

/** プロジェクトがいちばん上でないときは、そのフォルダで動かす */
const inDir = (dir: string) =>
  dir && dir !== "." ? `    defaults:\n      run:\n        working-directory: ${dir}   # コマンドを動かすフォルダ\n` : "";

const has = (files: string[], ...names: string[]) => names.some((n) => files.some((f) => f.toLowerCase() === n.toLowerCase()));
const ends = (files: string[], ...exts: string[]) => files.some((f) => exts.some((e) => f.toLowerCase().endsWith(e)));

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    id: "node",
    name: "Node.js（npm test）",
    detail: "package.json があるリポジトリ。npm ci でライブラリを入れて、npm test を動かします",
    detect: (files, lang) => has(files, "package.json") || lang === "TypeScript" || lang === "JavaScript",
    file: ".github/workflows/test.yml",
    yaml: (dir) =>
      HEADER("テスト", "プッシュとプルリクのたびに、テストを動かす") +
      `
jobs:
  test:
    runs-on: ubuntu-latest   # GitHub が用意する Linux のパソコンで動かす
${inDir(dir)}    steps:
      - uses: actions/checkout@v4      # リポジトリの中身を取ってくる
      - uses: actions/setup-node@v4    # Node.js を入れる
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: ${dir && dir !== "." ? `${dir}/` : ""}package-lock.json
      - run: npm ci                    # ライブラリを入れる（package-lock.json のとおり）
      - run: npm test                  # テストを動かす（package.json の "test"）
`,
  },
  {
    id: "python",
    name: "Python（pytest）",
    detail: "requirements.txt・pyproject.toml があるリポジトリ。pytest でテストを動かします",
    detect: (files, lang) => has(files, "requirements.txt", "pyproject.toml", "setup.py") || lang === "Python",
    file: ".github/workflows/test.yml",
    yaml: (dir) =>
      HEADER("テスト", "プッシュとプルリクのたびに、テストを動かす") +
      `
jobs:
  test:
    runs-on: ubuntu-latest   # GitHub が用意する Linux のパソコンで動かす
${inDir(dir)}    steps:
      - uses: actions/checkout@v4       # リポジトリの中身を取ってくる
      - uses: actions/setup-python@v5   # Python を入れる
        with:
          python-version: "3.12"
      - run: pip install pytest         # テストの道具を入れる
      - run: if [ -f requirements.txt ]; then pip install -r requirements.txt; fi   # ライブラリを入れる
      - run: pytest                     # テストを動かす（test_*.py）
`,
  },
  {
    id: "rust",
    name: "Rust（cargo test）",
    detail: "Cargo.toml があるリポジトリ",
    detect: (files, lang) => has(files, "Cargo.toml") || lang === "Rust",
    file: ".github/workflows/test.yml",
    yaml: (dir) =>
      HEADER("テスト", "プッシュとプルリクのたびに、テストを動かす") +
      `
jobs:
  test:
    runs-on: ubuntu-latest   # GitHub が用意する Linux のパソコンで動かす
${inDir(dir)}    steps:
      - uses: actions/checkout@v4   # リポジトリの中身を取ってくる
      - run: cargo test             # ビルドして、テストを動かす（Rust は入っています）
`,
  },
  {
    id: "dotnet",
    name: "C#・.NET（dotnet test）",
    detail: ".sln・.csproj があるリポジトリ",
    detect: (files, lang) => ends(files, ".sln", ".csproj") || lang === "C#",
    file: ".github/workflows/test.yml",
    yaml: (dir) =>
      HEADER("テスト", "プッシュとプルリクのたびに、テストを動かす") +
      `
jobs:
  test:
    runs-on: ubuntu-latest   # GitHub が用意する Linux のパソコンで動かす
${inDir(dir)}    steps:
      - uses: actions/checkout@v4       # リポジトリの中身を取ってくる
      - uses: actions/setup-dotnet@v4   # .NET を入れる
        with:
          dotnet-version: "8.0.x"
      - run: dotnet test                # ビルドして、テストを動かす
`,
  },
  {
    id: "go",
    name: "Go（go test）",
    detail: "go.mod があるリポジトリ",
    detect: (files, lang) => has(files, "go.mod") || lang === "Go",
    file: ".github/workflows/test.yml",
    yaml: (dir) =>
      HEADER("テスト", "プッシュとプルリクのたびに、テストを動かす") +
      `
jobs:
  test:
    runs-on: ubuntu-latest   # GitHub が用意する Linux のパソコンで動かす
${inDir(dir)}    steps:
      - uses: actions/checkout@v4   # リポジトリの中身を取ってくる
      - uses: actions/setup-go@v5   # Go を入れる
        with:
          go-version: stable
      - run: go test ./...          # テストを動かす
`,
  },
  {
    id: "java",
    name: "Java（Maven）",
    detail: "pom.xml があるリポジトリ",
    detect: (files, lang) => has(files, "pom.xml") || lang === "Java",
    file: ".github/workflows/test.yml",
    yaml: (dir) =>
      HEADER("テスト", "プッシュとプルリクのたびに、テストを動かす") +
      `
jobs:
  test:
    runs-on: ubuntu-latest   # GitHub が用意する Linux のパソコンで動かす
${inDir(dir)}    steps:
      - uses: actions/checkout@v4     # リポジトリの中身を取ってくる
      - uses: actions/setup-java@v4   # Java を入れる
        with:
          distribution: temurin
          java-version: "21"
          cache: maven
      - run: mvn -B test              # ビルドして、テストを動かす
`,
  },
  {
    id: "hello",
    name: "はじめての見本（動かしてみるだけ）",
    detail: "どの言語でも。Actions がどう動くかを見るための、あいさつとファイルの一覧を出すだけのもの",
    detect: () => true,
    file: ".github/workflows/hello.yml",
    yaml: () =>
      HEADER("はじめての Actions", "動くしくみを見るための見本") +
      `
jobs:
  hello:
    runs-on: ubuntu-latest   # GitHub が用意する Linux のパソコンで動かす
    steps:
      - uses: actions/checkout@v4          # リポジトリの中身を取ってくる
      - run: echo "こんにちは、Actions！"   # 文字を出す（ログに出ます）
      - run: ls -la                        # 取ってきたファイルの一覧を出す
      - run: git log --oneline -5          # 最近のコミットを 5 つ出す
`,
  },
];

/** リポジトリに合うひな形（なければ「はじめての見本」） */
export function suggestTemplate(files: string[], language: string | null): WorkflowTemplate {
  return WORKFLOW_TEMPLATES.find((t) => t.id !== "hello" && t.detect(files, language)) ?? WORKFLOW_TEMPLATES[WORKFLOW_TEMPLATES.length - 1];
}

/** GitHub の「新しいファイル」の画面を、名前と中身を入れた状態で開く URL */
export const newFileUrl = (owner: string, repo: string, branch: string, file: string, text: string) =>
  `https://github.com/${owner}/${repo}/new/${encodeURIComponent(branch)}?filename=${encodeURIComponent(file)}&value=${encodeURIComponent(text)}`;
