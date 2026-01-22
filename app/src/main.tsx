import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import { BrowserRouter } from "react-router-dom";
import CssBaseline from "@mui/material/CssBaseline";
import { LicenseInfo } from "@mui/x-license";
import { enableMapSet } from "immer";
import App from "./App.tsx";
import { ThemeProvider } from "./contexts/ThemeContext";
import { AuthProvider } from "./contexts/auth-context.tsx";
import { initializeStoreVersion } from "./store/lib/storeVersion";

// Set MUI X Premium license key
LicenseInfo.setLicenseKey(import.meta.env.VITE_MUI_LICENSE_KEY || "");

// Initialize store versioning before any stores are created
// This clears localStorage when the schema version changes
initializeStoreVersion();

enableMapSet();

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Root element not found");

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <BrowserRouter>
      <ThemeProvider>
        <CssBaseline />
        <AuthProvider>
          <App />
        </AuthProvider>
      </ThemeProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
