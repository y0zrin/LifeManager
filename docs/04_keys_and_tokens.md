# 鍵とトークン — だれが何を持つか（開発者向け）

利用者側（メンバー・リーダー・組織の持ち主）がすることは、アプリのマニュアルの「だれが何をするか」（`life-manager/src-tauri/resources/manual.html` の `#roles`）にまとめてある。
ここは、アプリを作って配る人（開発者）が持つものと、すること。

## 開発者が持つもの

| もの | 秘密か | どこにあるか | 失くしたら・漏れたら |
|---|---|---|---|
| GitHub App「Life Manager App」の Client ID と URL の名前 | 秘密ではない（アプリに入れて配る） | `life-manager/src-tauri/src/github/auth.rs` の `CLIENT_ID`（`Iv23lilmumXASbk6CNV2`）と `APP_SLUG`（`life-manager-app`。公開ページ `https://github.com/apps/life-manager-app`）。2026-09-29 に登録 | GitHub の Developer settings → GitHub Apps でいつでも見られる |
| GitHub App の Client secret・Private key | — | **作らない**。デバイスフローでもらった鍵は、Client secret なしで新しくできる（GitHub の決まり）。Private key はサーバーから App として動くときのもので、このアプリは使わない | 作ってしまったら、GitHub App の画面で消す |
| 前に登録した OAuth アプリ「Life Manager」（`Ov23liu0oRzKR4l5kDMZ`） | — | **使わなくなった**（0.9.0 の途中で GitHub App に替えた。全部のリポジトリに届く・期限なしのため） | GitHub の Developer settings → OAuth Apps で消してよい |
| 更新の署名の秘密鍵（minisign） | **秘密** | 開発 PC のユーザー環境変数 `TAURI_SIGNING_PRIVATE_KEY`（鍵の中身そのもの。パスワードは空） | 失くすと、入っているアプリに更新を届けられなくなる。漏れると、偽の更新を作られる → **控えを取る**（下） |
| 更新の署名の公開鍵 | 秘密ではない | `life-manager/src-tauri/tauri.conf.json` の `plugins.updater.pubkey` | 変えない。変えた版は、古い版の自動更新で受け取れない（手で入れ直しになる） |
| GitHub Releases へのアップロード | — | Web の画面で上げる（トークンは使わない） | — |

## GitHub App の登録（一度だけ）

「GitHub でログイン」は GitHub App で行う。アプリが触れるのは、持ち主が Life Manager を入れて選んだリポジトリだけ。鍵は 8 時間で切れ、アプリが更新の鍵（半年）で新しくする。この PC で使う期限（30 日・90 日・半年）は利用者が選ぶ。

1. GitHub → Settings → Developer settings → **GitHub Apps** → **New GitHub App**
2. GitHub App name: `Life Manager App`（GitHub 全体で重ならない名前が要る。`Life Manager` はほかの人の非公開の GitHub App が使っていた）、Homepage URL: `https://github.com/y0zrin/LifeManager`
3. Identifying and authorizing users: Callback URL は同じ URL、**Expire user authorization tokens に印（付けたまま）**、Request user authorization (OAuth) during installation は印なし、**Enable Device Flow に印**
4. Post installation は空、**Webhook の Active の印を外す**
5. Repository permissions（ほかは No access）
   - **Administration: Read and write**（メンバーの招待・送った招待・招待を受ける・リポジトリを作る）
   - **Contents: Read and write**（設定・日誌・テンプレートのファイル）
   - **Issues: Read and write**（Issue・ラベル・マイルストーン・サブイシュー・変更の履歴）
   - Metadata: Read-only（自動で付く）
6. Where can this GitHub App be installed?: **Any account** → **Create GitHub App**
7. **Client ID** と URL の名前を `auth.rs` の `CLIENT_ID`・`APP_SLUG` に入れて、ビルドして配る。**Generate a new client secret・Generate a private key は押さない**

利用者側: チームのリポジトリには、持ち主（リーダー、組織なら組織の持ち主）が一度だけ Life Manager を入れて、使うリポジトリを選ぶ（`https://github.com/apps/<APP_SLUG>/installations/new`）。メンバーはログインするだけ。自分のリポジトリを使う人は、自分のアカウントに入れる。

Administration の権限は、リポジトリの設定を変える・消すこともできる強い権限。アプリは招待と、リポジトリを作ることにしか使わない（リポジトリを消す・設定を変える API は呼ばない）。

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
- ログインの鍵の期限・更新の鍵・この PC で使う期限は、キー `github-login`（JSON）。期限が近いと、送る前に新しくする（`tokens::fresh_default`）。この PC の期限が過ぎたら鍵を消し、次の起動で最初の画面に「期限が来た」と出す
- Discord の Webhook の URL も同じところ（キー `project-discord-持ち主/名前`）
- ログアウトで、その PC のトークンは全部消える。GitHub での許可は残るので、取り消すときは GitHub の Settings → Applications → Authorized GitHub Apps → Life Manager App → Revoke（ログアウトのあとの画面に案内が出る）。アプリからは取り消せない（Client secret が要るため）
- リーダーや先生が、ほかの人のトークンを作って配る使い方はしない（マニュアルの「チームで使う」で止めている）。組織の Fine-grained token は、はじめの設定では 1 本ごとに持ち主の承認がいるので、ログインをすすめる
- Fine-grained のトークンでは、届いた招待を受ける操作（`PATCH /user/repository_invitations/{id}`）が GitHub の決まりで使えない。ログインなら使える（Life Manager が入ったリポジトリへの招待）
