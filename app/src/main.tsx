import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import { BrowserRouter } from "react-router-dom";
import CssBaseline from "@mui/material/CssBaseline";
import { LicenseInfo } from "@mui/x-license";
import { enableMapSet } from "immer";
import App from "./App.tsx";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import { AuthProvider } from "./contexts/auth-context.tsx";
import { initializeStoreVersion } from "./store/lib/storeVersion";

// Set MUI X Premium license key
LicenseInfo.setLicenseKey(import.meta.env.VITE_MUI_LICENSE_KEY || "");

// Initialize store versioning before any stores are created
// This clears localStorage when the schema version changes
initializeStoreVersion();

// Stale-bundle safety net: after a deploy, old content-hashed chunks no longer
// exist on the server, so lazy route/component imports from a stale client
// fail. Reload once to pick up the new build (guarded against reload loops).
window.addEventListener("vite:preloadError", event => {
  const LAST_RELOAD_KEY = "mako:chunk-error-reload-at";
  const lastReloadAt = Number(sessionStorage.getItem(LAST_RELOAD_KEY) || 0);
  if (Date.now() - lastReloadAt > 60_000) {
    sessionStorage.setItem(LAST_RELOAD_KEY, String(Date.now()));
    event.preventDefault();
    window.location.reload();
  }
});

enableMapSet();

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Root element not found");

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <BrowserRouter>
        <ThemeProvider>
          <CssBaseline />
          <AuthProvider>
            <App />
          </AuthProvider>
        </ThemeProvider>
      </BrowserRouter>
    </AppErrorBoundary>
  </React.StrictMode>,
);
