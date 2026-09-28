/** Issue テンプレート（GitHub と同じ .github/ISSUE_TEMPLATE/*.md） */
export interface IssueTemplate {
  /** ファイルの名前（bug.md など） */
  file: string;
  name: string;
  about: string;
  /** 題名の頭（"[バグ] " など） */
  title: string;
  labels: string[];
  body: string;
}

/** リポジトリにまだテンプレートがないときの見本（「このリポジトリに置く」で、この 3 つをファイルにする） */
export const BUILTIN_TEMPLATES: IssueTemplate[] = [
  {
    file: "bug.md",
    name: "🐞 バグ報告",
    about: "動かない・おかしい",
    title: "[バグ] ",
    labels: ["種別:バグ", "状態:未整理"],
    body: "## 何が起きたか\n\n\n## どうすると起きるか（手順）\n1. \n2. \n\n## 本当はどうなってほしいか\n\n\n## 画面やエラーの文（あれば）\n",
  },
  {
    file: "task.md",
    name: "✅ やること",
    about: "目的と終わりの条件",
    title: "",
    labels: ["種別:イシュー", "状態:未整理"],
    body: "## 目的\n\n\n## やること\n- [ ] \n- [ ] \n\n## 終わりの条件（これができたら閉じる）\n",
  },
  {
    file: "research.md",
    name: "🔍 調べもの",
    about: "わかったことを残す",
    title: "[調べもの] ",
    labels: ["種別:イシュー", "状態:未整理"],
    body: "## 知りたいこと\n\n\n## わかったこと\n\n\n## 参考にしたもの\n",
  },
];
