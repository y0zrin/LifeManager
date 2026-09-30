import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import { ErrorBoundary } from "./components/common/ErrorBoundary";
import { NoticeApp } from "./components/notices/NoticeApp";
import { loadDisplaySettings } from "./hooks/useDisplaySettings";
import { applyTheme } from "./lib/theme";

// 描く前にテーマを当てる（明るいテーマで、起動のときに暗い色が一瞬出ないように）
applyTheme(loadDisplaySettings().theme);

// 同じ中身（index.html）を、窓の名前で出し分ける: notice = アプリの窓の外の「おしらせ」の小さな窓
function windowLabel(): string {
  try {
    return getCurrentWindow().label;
  } catch {
    return "main";
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>{windowLabel() === "notice" ? <NoticeApp /> : <App />}</ErrorBoundary>
  </React.StrictMode>,
);
