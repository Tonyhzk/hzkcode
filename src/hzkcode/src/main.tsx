import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import i18n from "./lib/i18n";
import { ipc } from "./lib/ipc";
import { windowContext } from "./lib/window-context";
import { applyTheme, THEME_STORAGE_KEY } from "./features/settings/theme";

// The drag-ghost window must stay fully transparent so its rounded card shows
// through — the default page background would otherwise fill it solid.
if (windowContext.kind === "drag-ghost") {
  document.documentElement.dataset.windowCtx = "drag-ghost";
}

// Apply the locally cached theme synchronously, before first paint, so the
// window never flashes the wrong color scheme while settings load.
const cachedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
if (cachedTheme) applyTheme(cachedTheme);

// Kick off the authoritative settings fetch at module scope (shared cached
// promise in ipc.ts); apply theme/language as soon as it resolves. Rendering
// is not blocked on this.
void ipc
  .getAppSettings()
  .then((settings) => {
    applyTheme(settings.theme);
    if (settings.language && settings.language !== i18n.language) {
      void i18n.changeLanguage(settings.language);
    }
  })
  .catch(() => {});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
// Analytics stays off the cold-start critical path: install after first paint
// via dynamic import. setTimeout (not requestIdleCallback) because older
// WebKitGTK lacks it. The install itself no-ops outside production.
window.setTimeout(() => {
  void import("./lib/analytics")
    .then(({ installBaiduTongji }) => installBaiduTongji())
    .catch((error) => {
      console.warn(
        "[analytics] deferred Baidu Tongji install failed",
        error instanceof Error ? error.message : String(error),
      );
    });
}, 3000);
