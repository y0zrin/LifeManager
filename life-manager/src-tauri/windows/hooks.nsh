; LifeManager のインストーラーに足す処理（tauri.conf.json の bundle > windows > nsis > installerHooks）。
; インストールの最後に、Windows にアイコンを読み直してもらう（ピン止めしたアイコンが古いまま残らないように）。
; また、Git が入っているかを調べ、入っていなければ、入れるかどうかを聞く。
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

; Windows の表示言語（#256）。$1 に ja・zh-Hans・zh-Hant・en を入れる（$0 は使わない）
Function LifeManagerUiLang
  Push $2
  System::Call 'kernel32::GetUserDefaultUILanguage() i .r2'
  IntOp $1 $2 & 0x3FF
  ${If} $1 = 0x11
    StrCpy $1 "ja"
  ${ElseIf} $1 = 0x04
    ; 台湾・香港・マカオは繁体字
    ${If} $2 = 0x0404
    ${OrIf} $2 = 0x0C04
    ${OrIf} $2 = 0x1404
      StrCpy $1 "zh-Hant"
    ${Else}
      StrCpy $1 "zh-Hans"
    ${EndIf}
  ${Else}
    StrCpy $1 "en"
  ${EndIf}
  Pop $2
FunctionEnd

; 入れるかどうかを聞き、「はい」なら winget で Git を入れる。文は Windows の表示言語で出す
Function LifeManagerInstallGit
  Call LifeManagerUiLang
  ${If} $1 == "ja"
    MessageBox MB_YESNO|MB_ICONQUESTION "LifeManager の「作業」「ブランチ」「全体図」では Git（ギット）を使います。$\r$\nこの PC には Git が入っていないようです。$\r$\n$\r$\n今すぐ Git をインストールしますか？$\r$\n（数分かかります。途中で「このアプリがデバイスに変更を加えることを許可しますか？」と出たら「はい」を押してください）" /SD IDNO IDYES install
  ${ElseIf} $1 == "zh-Hans"
    MessageBox MB_YESNO|MB_ICONQUESTION "LifeManager 的“开始工作”“分支”“全局图”需要使用 Git。$\r$\n这台电脑上似乎没有安装 Git。$\r$\n$\r$\n现在安装 Git 吗？$\r$\n（需要几分钟。如果中途出现“你要允许此应用对你的设备进行更改吗？”，请点击“是”。）" /SD IDNO IDYES install
  ${ElseIf} $1 == "zh-Hant"
    MessageBox MB_YESNO|MB_ICONQUESTION "LifeManager 的「開始工作」「分支」「全局圖」需要使用 Git。$\r$\n這台電腦似乎沒有安裝 Git。$\r$\n$\r$\n現在要安裝 Git 嗎？$\r$\n（需要幾分鐘。如果途中出現「要允許此應用程式變更您的裝置嗎？」，請按「是」。）" /SD IDNO IDYES install
  ${Else}
    MessageBox MB_YESNO|MB_ICONQUESTION "LifeManager uses Git for Work, Branches and Graph.$\r$\nGit does not seem to be installed on this PC.$\r$\n$\r$\nInstall Git now?$\r$\n(This takes a few minutes. If Windows asks $\"Do you want to allow this app to make changes to your device?$\", click Yes.)" /SD IDNO IDYES install
  ${EndIf}
  Return

  install:
  ${If} $1 == "ja"
    DetailPrint "Git をインストールしています（winget install --id Git.Git）…"
  ${ElseIf} $1 == "zh-Hans"
    DetailPrint "正在安装 Git（winget install --id Git.Git）…"
  ${ElseIf} $1 == "zh-Hant"
    DetailPrint "正在安裝 Git（winget install --id Git.Git）…"
  ${Else}
    DetailPrint "Installing Git (winget install --id Git.Git)…"
  ${EndIf}
  nsExec::ExecToLog 'winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements --silent'
  Pop $0
  ${If} $0 == 0
    ${If} $1 == "ja"
      DetailPrint "Git をインストールしました"
    ${ElseIf} $1 == "zh-Hans"
      DetailPrint "已安装 Git"
    ${ElseIf} $1 == "zh-Hant"
      DetailPrint "已安裝 Git"
    ${Else}
      DetailPrint "Git installed"
    ${EndIf}
    Return
  ${EndIf}
  ${If} $1 == "ja"
    MessageBox MB_OK|MB_ICONEXCLAMATION "Git を自動でインストールできませんでした。$\r$\nこのあと開く Git のページから、インストーラーを取ってきてインストールしてください。$\r$\n（LifeManager を起動したときにも、もう一度インストールを試せます）"
  ${ElseIf} $1 == "zh-Hans"
    MessageBox MB_OK|MB_ICONEXCLAMATION "无法自动安装 Git。$\r$\n请从接下来打开的 Git 页面下载安装程序并安装。$\r$\n（启动 LifeManager 时也可以再次尝试安装。）"
  ${ElseIf} $1 == "zh-Hant"
    MessageBox MB_OK|MB_ICONEXCLAMATION "無法自動安裝 Git。$\r$\n請從接下來開啟的 Git 頁面下載安裝程式並安裝。$\r$\n（啟動 LifeManager 時也可以再次嘗試安裝。）"
  ${Else}
    MessageBox MB_OK|MB_ICONEXCLAMATION "Git could not be installed automatically.$\r$\nDownload and run the installer from the Git page that opens next.$\r$\n(You can also try installing again when you start LifeManager.)"
  ${EndIf}
  ExecShell "open" "https://git-scm.com/downloads/win"
FunctionEnd

; アイコンを変えた版に上書きすると、タスクバーにピン止めしたアイコンなどが、Windows の覚えている古い絵のまま残る。
; Windows にアイコンを読み直してもらう（関連付けが変わった知らせと、アイコンのキャッシュの更新）
Function LifeManagerRefreshIcons
  Push $0
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  ; ie4uinit は 64 ビットの System32 にだけある（32 ビットのインストーラーからは Sysnative で見える）
  ${If} ${FileExists} "$WINDIR\Sysnative\ie4uinit.exe"
    nsExec::Exec '"$WINDIR\Sysnative\ie4uinit.exe" -show'
    Pop $0
  ${ElseIf} ${FileExists} "$SYSDIR\ie4uinit.exe"
    nsExec::Exec '"$SYSDIR\ie4uinit.exe" -show'
    Pop $0
  ${EndIf}
  Pop $0
FunctionEnd

!macro NSIS_HOOK_POSTINSTALL
  ; 自動アップデートのときも、アイコンは読み直してもらう
  Call LifeManagerRefreshIcons
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
