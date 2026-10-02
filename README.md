# Life Manager

GitHub の Issue でタスクを管理し、git の作業を画面で見ながら覚えるためのデスクトップアプリ（Windows）です。Android の試用版もあります。

- どの操作でも、実際に動く git のコマンドが出ます（ボタンに乗せたときと、動かしたあとの知らせに）。ステージ、コミット、ブランチなどの意味はマニュアルにあります。
- データ（Issue・マイルストーン・ラベル・設定）は GitHub のリポジトリに置きます。アプリを消しても残ります。
- チームで使えます。リーダーがリポジトリに招待し、メンバーはそれぞれ自分の GitHub アカウントでログインします。

## 入れ方

1. [Releases](https://github.com/y0zrin/LifeManager/releases/latest) から `Life Manager_x.x.x_x64-setup.exe` を落として実行します。
2. 起動して **GitHub でログイン** を押します（GitHub のアカウントがなければ **GitHub で作る** から）。
3. **チームを作る**・**招待を受ける**・**個人で使う** から選びます。

新しいバージョンが出ると、アプリの上に知らせが出ます（設定 → その他 の「バージョン」からも確かめられます）。

## できること

| まとまり | 画面 |
|---|---|
| ホーム | オーバービュー（いまの状況・チームのペース）、ヒストリー（あなたがすること・チームの動き） |
| タスク | 作業をする（Issue を選ぶ → 作業報告 → コミット・プッシュ → 完了。プルリクとマージも）、タスク（一覧・絞り込み・見積もり）、ボード（未整理・着手済み・確認待ち。下の机に置くと自分の担当）、マイルストーン（スプリント）、ルーチン、日誌、ガント |
| リポジトリ | ブランチ、全体図、プルリク（レビュー・マージ）、Actions（直す順に積んだ山）、リリース |
| 設定 | 接続（チーム・招待）、タスク（見積もりの単位・ボードの区画・ラベル）、通知（Discord・予定・イベント）、表示（テーマ 9 つ）、トークン、その他 |

## マニュアル

アプリの **設定 → その他 → マニュアルを開く** で開きます（ファイルは [`life-manager/src-tauri/resources/manual.html`](life-manager/src-tauri/resources/manual.html)）。

6 つの部に分かれています: はじめる ／ ホーム ／ タスクを管理する ／ git で作業する（PC） ／ GitHub でチームと作る ／ 設定と困ったとき。

## チームで使う

- **リーダー**: リポジトリに Life Manager（GitHub App）を入れ、設定 → 接続 の **案内をコピー** でメンバーに参加の案内を送ります。届いた GitHub の名前を貼って **招待を送る** と招待できます。
- **メンバー**: 自分の GitHub アカウントで **GitHub でログイン** し、届いた招待を受けます。
- 2 人以上で続けて使うときは、GitHub の Organization（無料）がおすすめです。

くわしくは、マニュアルの「チームで使う（管理者向け）」と「だれが何をするか（アカウント・トークン・許可）」を見てください。学校などでトークン（Fine-grained token）を使うときの入れ方も、そこにあります。

## 開発

- 技術: Tauri 2（Rust）＋ React 19 / TypeScript ＋ Vite。GitHub REST API。トークンは OS のキーチェーンに置きます。
- 開発: `cd life-manager` → `npm install` → `npm run tauri dev`
- 確かめる: `npx tsc --noEmit`（型）、`cargo test`（`life-manager/src-tauri` で。Rust のテスト）
- リリース: `release.bat`（バージョンを上げて、署名つきでビルドし、`latest.json` を作る）。鍵とトークンの扱いは [`docs/04_keys_and_tokens.md`](docs/04_keys_and_tokens.md)、変わったことは [`docs/release-notes/`](docs/release-notes/) にあります。
- Android: `npm run tauri android build`
