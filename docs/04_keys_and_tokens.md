# 鍵とトークン — だれが何を持つか（開発者向け）

利用者側（メンバー・リーダー・組織の持ち主）がすることは、アプリのマニュアルの「だれが何をするか」（`life-manager/src-tauri/resources/manual.html` の `#roles`）にまとめてある。
ここは、アプリを作って配る人（開発者）が持つものと、すること。

## 開発者が持つもの

| もの | 秘密か | どこにあるか | 失くしたら・漏れたら |
|---|---|---|---|
| OAuth アプリ「Life Manager」の Client ID | 秘密ではない（アプリに入れて配る） | `life-manager/src-tauri/src/github/auth.rs` の `CLIENT_ID`。**今は空**なので「GitHub でログイン」は出ず、全員「トークンで入る」になる | GitHub の Developer settings でいつでも見られる |
| OAuth アプリの Client secret | — | **作らない**。デバイスフロー（GitHub Desktop・GitHub CLI と同じやり方）では使わない | 作ってしまったら、GitHub の OAuth アプリの画面で消す |
| 更新の署名の秘密鍵（minisign） | **秘密** | 開発 PC のユーザー環境変数 `TAURI_SIGNING_PRIVATE_KEY`（鍵の中身そのもの。パスワードは空） | 失くすと、入っているアプリに更新を届けられなくなる。漏れると、偽の更新を作られる → **控えを取る**（下） |
| 更新の署名の公開鍵 | 秘密ではない | `life-manager/src-tauri/tauri.conf.json` の `plugins.updater.pubkey` | 変えない。変えた版は、古い版の自動更新で受け取れない（手で入れ直しになる） |
| GitHub Releases へのアップロード | — | Web の画面で上げる（トークンは使わない） | — |

## OAuth アプリの登録（一度だけ。まだしていない）

1. GitHub → Settings → Developer settings → OAuth Apps → **New OAuth App**
2. Application name: `Life Manager`、Homepage URL: `https://github.com/y0zrin/LifeManager`、Authorization callback URL: 同じ URL（デバイスフローでは使わないが、入れる欄がある）
3. **Register application** → 同じ画面の **Enable Device Flow** に印を付けて **Update application**
4. **Client ID** を `auth.rs` の `CLIENT_ID` に入れて、ビルドして配る。**Generate a new client secret は押さない**
5. 組織で使うときは、組織の持ち主が Life Manager を一度許可する（新しい組織は、外のアプリを使うのに許可がいる設定になっている）

アプリが求める権限は `repo` と `read:org`（`auth.rs` の `SCOPES`）。組織への招待を受けるには `write:org` が要るが、求めない（組織への参加は GitHub の画面で行う）。

## 署名の秘密鍵の控え

- 今は開発 PC の環境変数にしかない。PC が壊れると失う
- 控えの取り方（値を画面に出さず、クリップボードからパスワード管理アプリに貼る。貼ったら、クリップボードを別の文字で上書きする）:

  ```powershell
  [Environment]::GetEnvironmentVariable('TAURI_SIGNING_PRIVATE_KEY','User') | Set-Clipboard
  ```

- リポジトリ・チャット・メールには入れない

## リリースのとき（抜けやすいところ）

- `release.bat` のあと、`latest.json` と setup を GitHub の Release に上げる。タグは `0.9.0` のように **v を付けない**（`release.ps1` が URL にそのまま使う）。**pre-release にしない**（`releases/latest` が指さなくなる）
- `latest.json` を上げないと、全員の更新の確認が 404 になり、アプリは何も言わないので、だれも気づかない（0.3.3 がこうなっている）

## 利用者のトークンについて（アプリの決まり）

- ログインのトークン・自分で作ったトークンは、その人の PC の資格情報（service `life-manager`、キー `github-token`、プロジェクト専用は `project-token-持ち主/名前`）にしまう。平文でファイルに置かない
- Discord の Webhook の URL も同じところ（キー `project-discord-持ち主/名前`）
- ログアウトで、その PC のトークンは全部消える
- リーダーや先生が、ほかの人のトークンを作って配る使い方はしない（マニュアルの「チームで使う」で止めている）。組織の Fine-grained token は、はじめの設定では 1 本ごとに持ち主の承認がいるので、ログインをすすめる
