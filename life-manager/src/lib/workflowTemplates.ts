// Actions のワークフローのひな形（リポジトリのファイルとフォルダから、合うものを選ぶ。Unity・Unreal は先に見る）。
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
  /** GitHub の側で先に要る準備（秘密の登録・ランナーの登録など） */
  prepare?: {
    text: string;
    warning?: string;
    links: { label: string; url: (owner: string, repo: string) => string }[];
  };
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
    id: "unity",
    name: "Unity（Unity Test Framework）",
    detail:
      "Assets と ProjectSettings があるリポジトリ。EditMode・PlayMode のテストを、GitHub のパソコンで動かします（GameCI）。テストがなくても、スクリプトのコンパイルエラーに気づけます",
    detect: (files) => has(files, "Assets/") && has(files, "ProjectSettings/"),
    file: ".github/workflows/unity-test.yml",
    prepare: {
      text: "リポジトリの Settings → Secrets and variables → Actions に、秘密を 3 つ登録します: UNITY_LICENSE（Unity Hub で Personal のライセンスを有効にすると、その PC の C:\\ProgramData\\Unity\\Unity_lic.ulf にできます。その中身をまるごと）・UNITY_EMAIL・UNITY_PASSWORD（そのライセンスの Unity のアカウント）。1 回目は Unity を用意するのに時間がかかります（10〜20 分ほど）。非公開のリポジトリでは、Actions の無料の時間（月 2,000 分）を使います。",
      warning: "チームのリポジトリでは、書き込める人はワークフローを通して秘密を取り出せます。テスト用に別の Unity のアカウントを作って登録するのがおすすめです。",
      links: [{ label: "秘密を登録する画面を開く", url: (owner, repo) => `https://github.com/${owner}/${repo}/settings/secrets/actions` }],
    },
    yaml: (dir) => {
      const p = dir && dir !== "." ? dir : ".";
      const base = p === "." ? "" : `${p}/`;
      return (
        HEADER("Unity テスト", "EditMode・PlayMode のテストを動かす") +
        `
jobs:
  test:
    runs-on: ubuntu-latest   # GitHub が用意する Linux のパソコンで動かす（Unity は GameCI が用意する）
    permissions:
      contents: read
      checks: write          # テストの結果を、プルリクのチェックに出す
    steps:
      - uses: actions/checkout@v4
        with:
          lfs: true          # Git LFS で入れた画像・音も取ってくる
      - uses: actions/cache@v4   # Library を残して、2 回目から速くする
        with:
          path: ${base}Library
          key: Library-\${{ hashFiles('${base}Assets/**', '${base}Packages/**', '${base}ProjectSettings/**') }}
          restore-keys: Library-
      - uses: game-ci/unity-test-runner@v4   # Unity を入れて、テストを動かす（版は ProjectSettings/ProjectVersion.txt から）
        env:
          UNITY_LICENSE: \${{ secrets.UNITY_LICENSE }}     # ライセンス（.ulf の中身）
          UNITY_EMAIL: \${{ secrets.UNITY_EMAIL }}         # Unity のアカウント（テスト用のものがおすすめ）
          UNITY_PASSWORD: \${{ secrets.UNITY_PASSWORD }}
        with:
          projectPath: ${p}
          testMode: all                                   # EditMode と PlayMode の両方
          githubToken: \${{ secrets.GITHUB_TOKEN }}       # 結果をチェックに出す
      - uses: actions/upload-artifact@v4   # テストの結果（XML）を残す
        if: always()
        with:
          name: unity-test-results
          path: artifacts
`
      );
    },
  },
  {
    id: "unreal",
    name: "Unreal Engine（自動テスト）",
    detail:
      ".uproject があるリポジトリ。Automation のテストを、Unreal の入った PC（セルフホストランナー）で動かします。GitHub のパソコンには Unreal が入っていません",
    detect: (files) => files.some((f) => f.toLowerCase().endsWith(".uproject")),
    file: ".github/workflows/unreal-test.yml",
    prepare: {
      text: "Unreal の入った Windows の PC（学校の PC など）を、このリポジトリのランナーに登録します: Settings → Actions → Runners → New self-hosted runner → Windows。出てくるコマンドをその PC の PowerShell で順に動かし、ラベルに unreal を足します。その PC の環境変数 UE_ROOT に、Unreal の場所（例: C:\\Program Files\\Epic Games\\UE_5.4）を入れておきます。",
      warning: "公開のリポジトリでは、セルフホストランナーを使わないでください（だれでもプルリクを通して、その PC でコードを動かせてしまいます）。",
      links: [{ label: "ランナーを登録する画面を開く", url: (owner, repo) => `https://github.com/${owner}/${repo}/settings/actions/runners/new?arch=x64&os=win` }],
    },
    yaml: (dir) => {
      const p = dir && dir !== "." ? dir : ".";
      const base = p === "." ? "" : `${p}/`;
      return (
        HEADER("Unreal テスト", "Automation のテストを、Unreal の入った PC で動かす") +
        `
jobs:
  test:
    # Unreal の入った PC（学校の PC など）で動かす。GitHub のパソコンには Unreal が入っていないので、
    # その PC を「セルフホストランナー」として登録し、ラベル unreal を付けておく
    runs-on: [self-hosted, Windows, unreal]
    defaults:
      run:
        shell: pwsh
        working-directory: ${p}
    steps:
      - uses: actions/checkout@v4
        with:
          lfs: true          # Git LFS で入れたアセットも取ってくる
      - name: C++ をビルドする（Source フォルダがあるとき）
        run: |
          $uproject = (Get-ChildItem -Filter *.uproject | Select-Object -First 1).FullName
          if (Test-Path Source) {
            $name = [IO.Path]::GetFileNameWithoutExtension($uproject)
            & "$env:UE_ROOT\\Engine\\Build\\BatchFiles\\Build.bat" "$($name)Editor" Win64 Development "-Project=$uproject" -WaitMutex
            if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
          }
      - name: 自動テストを動かす（Project. で始まるテスト。自分のテストの名前に合わせて変える）
        run: |
          $uproject = (Get-ChildItem -Filter *.uproject | Select-Object -First 1).FullName
          # UE_ROOT は、その PC の Unreal の場所（例: C:\\Program Files\\Epic Games\\UE_5.4）
          & "$env:UE_ROOT\\Engine\\Binaries\\Win64\\UnrealEditor-Cmd.exe" $uproject \`
            -ExecCmds="Automation RunTests Project" -TestExit="Automation Test Queue Empty" \`
            -ReportExportPath="$PWD\\TestReport" -unattended -nullrhi -nosplash -nopause -nosound -log
          $report = Get-Content "$PWD\\TestReport\\index.json" -Raw | ConvertFrom-Json
          Write-Output "成功 $($report.succeeded)・失敗 $($report.failed)"
          if ($report.failed -gt 0) { exit 1 }
      - uses: actions/upload-artifact@v4   # テストの結果を残す
        if: always()
        with:
          name: unreal-test-report
          path: ${base}TestReport
`
      );
    },
  },
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
    // Unity のプロジェクトも C# なので、Unity は先に見分ける（上の unity）
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
