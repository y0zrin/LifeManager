# Life Manager — 作業ステップ計画 v2

## 役割分担

| 作業 | 担当 | 手段 |
|------|------|------|
| コードを書く | あなた | エディタ（VSCode等） |
| ナビゲート・レビュー | Claude | 何を書くか指示、書いたコードを確認、エラー解決 |
| コマンド実行・動作確認 | あなた | PowerShell / ターミナル |
| 設計判断 | 共同 | チャットで議論 |

**つまり**: 私が「次に何をやるか」「何を書くか」を説明する。あなたが書く。書いたら見せてもらい、レビューする。

---

## 進め方のルール

1. **1ステップずつ進める**。完了条件を満たしたら次へ
2. **コードを書く前に、何をやるか・なぜやるかを説明する**
3. **書いたコードを見せてもらう**。私がレビューして改善点を伝える
4. **エラーが出たらそのまま貼る**。原因を説明し、あなた自身で修正できるよう導く
5. **Rustの文法・概念で分からないことがあれば都度聞いてOK**

---

## Phase 1: Core（MVP）

### Step 1: 環境構築
- Rust, Node.js, Git のインストール確認
- Tauri CLI のインストール
- プロジェクト初期化 (`cargo create-tauri-app`)
- `cargo tauri dev` で起動確認

### Step 2: Rustの基礎確認
- Tauri が生成したコードを読んで構造を理解する
- Rust の mod, struct, impl, Result, async/await を確認
- 小さな Tauri コマンドを1つ書いてフロントから呼んでみる

### Step 3: GitHub API クライアント
- reqwest クレートで HTTP GET を叩く
- GitHub REST API の認証ヘッダーを付ける
- Issue一覧を取得して返す Tauri コマンドを作る

### Step 4: Issue CRUD
- Issue 作成（POST）
- Issue 更新（PATCH）— ラベル変更、クローズ
- 構造体でIssueの型を定義する（serde でJSON変換）

### Step 5: ラベル体系セットアップ
- ラベル一覧取得・作成のAPI呼び出し
- 初回起動時に grain:*, theme:*, status:*, priority:* を自動作成

### Step 6: フロントエンド — Dashboard
- React + TypeScript で画面を作る
- Tauri コマンドを呼んでIssue一覧を表示
- メモ投入フォーム

### Step 7: MVP統合テスト
- メモ投入 → Issue作成 → フィルタ → クローズ の一連の操作確認

---

## 現在地

→ **Step 1 から開始**

まず以下のコマンドをターミナルで実行し、結果を教えてください:

```powershell
rustc --version
cargo --version
node --version
npm --version
git --version
```
