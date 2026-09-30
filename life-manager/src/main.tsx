import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/common/ErrorBoundary";
import { loadDisplaySettings } from "./hooks/useDisplaySettings";
import { applyTheme } from "./lib/theme";

// 描く前にテーマを当てる（明るいテーマで、起動のときに暗い色が一瞬出ないように）
applyTheme(loadDisplaySettings().theme);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
