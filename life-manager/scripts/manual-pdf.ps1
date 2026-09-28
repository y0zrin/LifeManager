# マニュアル（src-tauri/resources/manual.html）を PDF にする。Edge（なければ Chrome）の画面なしの印刷を使う
# 使い方（life-manager フォルダで）: powershell -ExecutionPolicy Bypass -File scripts\manual-pdf.ps1 [-Out 出力先.pdf]
# 出力先を決めなければ manual-pdf\LifeManager_マニュアル_日付.pdf（git には入れない）
param([string]$Out = "")

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$html = Join-Path $root "src-tauri\resources\manual.html"
if (-not $Out) {
  $Out = Join-Path $root ("manual-pdf\LifeManager_マニュアル_" + (Get-Date -Format "yyyy-MM-dd") + ".pdf")
}
$Out = [IO.Path]::GetFullPath($Out)
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Out) | Out-Null
if (Test-Path $Out) { Remove-Item $Out }

$browser = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $browser) { throw "Edge か Chrome が見つかりません" }

# いつものブラウザの設定・履歴を使わないよう、専用のプロファイルで開く
$profileDir = Join-Path $env:TEMP "lifemanager-manual-pdf"
$url = ([Uri]$html).AbsoluteUri
$arguments = @(
  "--headless", "--disable-gpu", "--no-first-run",
  "--no-pdf-header-footer", "--print-to-pdf-no-header",
  "`"--user-data-dir=$profileDir`"",
  "--virtual-time-budget=3000",
  "`"--print-to-pdf=$Out`"",
  "`"$url`""
)
Start-Process -FilePath $browser -ArgumentList $arguments -Wait -WindowStyle Hidden
if (-not (Test-Path $Out)) { throw "PDF ができませんでした: $Out" }
Write-Output ("作りました: {0}（{1:N0} KB）" -f $Out, ((Get-Item $Out).Length / 1KB))
