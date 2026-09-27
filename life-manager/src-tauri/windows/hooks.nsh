; LifeManager のインストーラーに足す処理（tauri.conf.json の bundle > windows > nsis > installerHooks）。
; インストールの最後に Git が入っているかを調べ、入っていなければ、入れるかどうかを聞く。
; 自動アップデート（/UPDATE）や、画面を出さないインストール（/P・/S）のときは聞かない
; （アプリを起動したときにも確かめて、そこからも入れられるため）。
; このファイルはインストーラーの本体より前に読み込まれるので、関数の中では本体の変数（$UpdateMode など）を使わない

!include "LogicLib.nsh"

; Git が見つかれば $0 に 1、見つからなければ 0 を入れる
Function LifeManagerHasGit
  nsExec::ExecToStack 'git --version'
  Pop $0
  Pop $1
  ${If} $0 == 0
    StrCpy $0 1
    Return
  ${EndIf}
  ; PATH に無くても、Git for Windows のいつもの入り先にあれば入っている
  ${If} ${FileExists} "$PROGRAMFILES64\Git\cmd\git.exe"
  ${OrIf} ${FileExists} "$PROGRAMFILES32\Git\cmd\git.exe"
  ${OrIf} ${FileExists} "$LOCALAPPDATA\Programs\Git\cmd\git.exe"
    StrCpy $0 1
    Return
  ${EndIf}
  StrCpy $0 0
FunctionEnd

; 入れるかどうかを聞き、「はい」なら winget で Git を入れる
Function LifeManagerInstallGit
  MessageBox MB_YESNO|MB_ICONQUESTION "LifeManager の「作業」「ブランチ」「全体図」では Git（ギット）を使います。$\r$\nこの PC には Git が入っていないようです。$\r$\n$\r$\n今すぐ Git をインストールしますか？$\r$\n（数分かかります。途中で「このアプリがデバイスに変更を加えることを許可しますか？」と出たら「はい」を押してください）" /SD IDNO IDYES install
  Return

  install:
  DetailPrint "Git をインストールしています（winget install --id Git.Git）…"
  nsExec::ExecToLog 'winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements --silent'
  Pop $0
  ${If} $0 == 0
    DetailPrint "Git をインストールしました"
    Return
  ${EndIf}
  MessageBox MB_OK|MB_ICONEXCLAMATION "Git を自動でインストールできませんでした。$\r$\nこのあと開く Git のページから、インストーラーを取ってきてインストールしてください。$\r$\n（LifeManager を起動したときにも、もう一度インストールを試せます）"
  ExecShell "open" "https://git-scm.com/downloads/win"
FunctionEnd

!macro NSIS_HOOK_POSTINSTALL
  ${If} $UpdateMode <> 1
  ${AndIf} $PassiveMode <> 1
  ${AndIfNot} ${Silent}
    Push $0
    Push $1
    Call LifeManagerHasGit
    ${If} $0 = 0
      Call LifeManagerInstallGit
    ${EndIf}
    Pop $1
    Pop $0
  ${EndIf}
!macroend
