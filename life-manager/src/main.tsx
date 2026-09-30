import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import { ErrorBoundary } from "./components/common/ErrorBoundary";
import { NoticeApp } from "./components/notices/NoticeApp";
import { StageFx } from "./components/common/StageFx";
import { loadDisplaySettings, stageMoves } from "./hooks/useDisplaySettings";
import { applyStageMotion, applyTheme } from "./lib/theme";

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

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {/* 舞台（画面の後ろの、テーマの光と動く粒）。おしらせの窓には出さない */}
    {!isNotice && <StageFx />}
    <ErrorBoundary>{isNotice ? <NoticeApp /> : <App />}</ErrorBoundary>
  </React.StrictMode>,
);
