import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import { ErrorBoundary } from "./components/common/ErrorBoundary";
import { NoticeApp } from "./components/notices/NoticeApp";
import { StageFx } from "./components/common/StageFx";
import { loadDisplaySettings, stageMoves } from "./hooks/useDisplaySettings";
import { applyStageMotion, applyTheme } from "./lib/theme";
import { startIdleWatch } from "./lib/idle";
import { currentLang, tr } from "./lib/i18n";
import { invoke } from "./lib/invoke";

// 描く前にテーマを当てる（明るいテーマで、起動のときに暗い色が一瞬出ないように）
const display = loadDisplaySettings();
applyTheme(display.theme);
applyStageMotion(stageMoves(display));

// 同じ中身（index.html）を、窓の名前で出し分ける: notice = アプリの窓の外の「おしらせ」の小さな窓
function windowLabel(): string {
  try {
    return getCurrentWindow().label;
  } catch {
    return "main";
  }
}

const isNotice = windowLabel() === "notice";

// 窓が前面にない・最小化・隠れているあいだは、くり返し動くアニメーションを止める（メインの窓だけ）
if (!isNotice) startIdleWatch();

// インジケーター（タスクトレイ）のメニューの字を、画面の言語に（#256。日本語ははじめの字のまま）
if (!isNotice && currentLang() !== "ja") void invoke("set_tray_labels", { open: tr("Life Manager を開く"), quit: tr("終了する") }).catch(() => {});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {/* 舞台（画面の後ろの、テーマの光と動く粒）。おしらせの窓には出さない */}
    {!isNotice && <StageFx />}
    <ErrorBoundary>{isNotice ? <NoticeApp /> : <App />}</ErrorBoundary>
  </React.StrictMode>,
);
