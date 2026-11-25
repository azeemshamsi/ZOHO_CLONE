import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { AuthProvider } from "./lib/auth";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import "./styles.css";

// After an update, a page opened before it asks for files that were replaced ("Failed to fetch dynamically
// imported module"): load the new version instead (once a minute at most, so it can't loop).
const reloadForUpdate = () => {
  try {
    const last = Number(sessionStorage.getItem("chunkReload") || 0);
    if (Date.now() - last < 60000) return false;
    sessionStorage.setItem("chunkReload", String(Date.now()));
  } catch {}
  window.location.reload();
  return true;
};
window.__reloadForUpdate = reloadForUpdate;
window.addEventListener("vite:preloadError", (e) => {
  if (reloadForUpdate()) e.preventDefault();
});

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter>
      <ErrorBoundary>
        <AuthProvider>
          <App />
        </AuthProvider>
      </ErrorBoundary>
    </BrowserRouter>
  </React.StrictMode>
);

// Installable web app (Add to Home Screen) — only in the built app, not while developing.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}
