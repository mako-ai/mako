/**
 * Mako Desktop: a thin Electron shell around the Mako web app.
 *
 * Architecture (Figma/Notion/Slack model):
 * - The window loads the live web app (https://app.mako.ai by default), so
 *   the product self-updates with every cloud deploy. This binary rarely
 *   changes.
 * - The Mako Local Agent (packages/local-agent) is started alongside the
 *   window, so "local connection" features work out of the box and the web
 *   app can reach databases running on this machine.
 *
 * Override the loaded URL with MAKO_DESKTOP_URL (e.g. http://localhost:5173
 * during development).
 */
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { autoUpdater } from "electron-updater";
import { spawn, ChildProcess } from "child_process";
import * as http from "http";
import * as path from "path";
import {
  DEEP_LINK_SCHEME,
  VERIFIER_TTL_MS,
  generatePkcePair,
  buildDesktopAuthUrl,
  buildCompleteUrl,
  parseDeepLinkAuthCode,
  findDeepLinkInArgv,
  isOAuthInitiationUrl,
} from "./auth-handoff";

const APP_URL = process.env.MAKO_DESKTOP_URL || "https://app.mako.ai";
const AGENT_PORT = process.env.MAKO_AGENT_PORT
  ? parseInt(process.env.MAKO_AGENT_PORT, 10)
  : 41720;
const DOWNLOAD_PAGE_URL = "https://mako.ai/download";
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

let mainWindow: BrowserWindow | null = null;
let agentProcess: ChildProcess | null = null;

// ── Browser-based sign-in (deep-link handoff) ────────────────────────────────
// Third-party logins (Google/GitHub) never render inside this window: the
// user can't inspect the URL or certificate there, and the fresh Chromium
// profile has no password manager. Instead the system browser handles login
// at ${APP_URL}/desktop-auth and hands the session back via mako://auth.

/** PKCE verifier awaiting its deep-link code. Never leaves this process. */
let pendingAuth: { verifier: string; expiresAt: number } | null = null;

/** Deep link received before the window existed (cold start via mako://). */
let queuedDeepLink: string | null = null;

function startBrowserAuth(): void {
  const { verifier, challenge } = generatePkcePair();
  pendingAuth = { verifier, expiresAt: Date.now() + VERIFIER_TTL_MS };
  shell.openExternal(buildDesktopAuthUrl(APP_URL, challenge));
}

function handleDeepLink(rawUrl: string): void {
  const code = parseDeepLinkAuthCode(rawUrl);
  if (!code) return;

  if (!mainWindow) {
    // Window not ready yet (cold start): replay once it exists.
    queuedDeepLink = rawUrl;
    return;
  }

  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();

  if (!pendingAuth || pendingAuth.expiresAt < Date.now()) {
    // No matching sign-in attempt from this instance (expired, or the link
    // was triggered without us initiating). The code is useless without the
    // verifier, so just surface the login screen.
    pendingAuth = null;
    console.warn("Ignoring auth deep link without a pending sign-in attempt");
    return;
  }

  const { verifier } = pendingAuth;
  pendingAuth = null; // single use
  mainWindow.loadURL(buildCompleteUrl(APP_URL, code, verifier));
}

function agentIsRunning(): Promise<boolean> {
  return new Promise(resolve => {
    const req = http.get(
      { host: "127.0.0.1", port: AGENT_PORT, path: "/health", timeout: 1000 },
      res => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

/**
 * Start the Mako Local Agent unless one is already running (e.g. the
 * standalone agent installed as a login item).
 *
 * Development: spawns the agent from the monorepo via pnpm.
 * Packaged builds: expects a bundled agent under resources/ (added by the
 * packaging pipeline; not part of the MVP).
 */
async function startAgent(): Promise<void> {
  if (process.env.MAKO_AGENT_SPAWN === "0") return;
  if (await agentIsRunning()) return;

  if (app.isPackaged) {
    // Packaged agent sidecar is wired up by electron-builder extraResources.
    const bundledAgent = path.join(process.resourcesPath, "agent", "index.js");
    agentProcess = spawn(process.execPath, [bundledAgent], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: "ignore",
    });
  } else {
    // Development: repo root is three levels up from packages/desktop/dist.
    const repoRoot = path.resolve(__dirname, "..", "..", "..");
    agentProcess = spawn(
      "pnpm",
      ["--filter", "@mako/local-agent", "start"],
      { cwd: repoRoot, stdio: "inherit" },
    );
  }

  agentProcess.on("exit", code => {
    if (code !== 0 && code !== null) {
      console.error(`Mako Local Agent exited with code ${code}`);
    }
    agentProcess = null;
  });
}

function stopAgent(): void {
  if (agentProcess && !agentProcess.killed) {
    agentProcess.kill("SIGTERM");
  }
  agentProcess = null;
}

/**
 * Keep the shell binary fresh: the web app self-updates with every cloud
 * deploy, but the Electron shell and bundled Local Agent only change via new
 * releases. Updates are downloaded in the background from the GitHub release
 * feed (see publish config in electron-builder.yml) and applied on restart.
 */
function setupAutoUpdater(): void {
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  let availableVersion: string | null = null;
  let fallbackShown = false;

  autoUpdater.on("update-available", info => {
    availableVersion = info.version;
  });

  autoUpdater.on("update-downloaded", info => {
    void dialog
      .showMessageBox({
        type: "info",
        message: `Mako ${info.version} is ready to install`,
        detail:
          "The update has been downloaded. Restart now to apply it, or it will be installed the next time Mako starts.",
        buttons: ["Restart Now", "Later"],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) {
          autoUpdater.quitAndInstall();
        }
      });
  });

  // Unsigned/ad-hoc-signed macOS builds cannot self-update (Squirrel.Mac
  // validates code signatures), and network hiccups land here too. If we know
  // a newer version exists, point at the download page once instead of
  // failing silently.
  autoUpdater.on("error", err => {
    console.error("Auto-update error:", err);
    if (!availableVersion || fallbackShown) return;
    fallbackShown = true;
    void dialog
      .showMessageBox({
        type: "info",
        message: `Mako ${availableVersion} is available`,
        detail:
          "This build can't update itself automatically. Download the latest version from the Mako website.",
        buttons: ["Download", "Later"],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) {
          void shell.openExternal(DOWNLOAD_PAGE_URL);
        }
      });
  });

  const check = () => {
    autoUpdater.checkForUpdates().catch(err => {
      console.error("Auto-update check failed:", err);
    });
  };
  check();
  setInterval(check, UPDATE_CHECK_INTERVAL_MS);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: "Mako",
    backgroundColor: "#111418",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Open target=_blank links for other origins in the system browser; keep
  // same-origin popups (rare) inside the shell.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url);
      const appOrigin = new URL(APP_URL).origin;
      if (target.origin !== appOrigin) {
        shell.openExternal(url);
        return { action: "deny" };
      }
    } catch {
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  // Safety net: even if a (stale) frontend tries to start an OAuth login
  // in-window, push it through the system-browser handoff instead. Google &
  // GitHub login pages must never render inside this shell.
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (isOAuthInitiationUrl(url, APP_URL)) {
      event.preventDefault();
      startBrowserAuth();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.loadURL(APP_URL);

  // Cold start via a mako:// link: complete the sign-in once the window exists.
  if (queuedDeepLink) {
    const link = queuedDeepLink;
    queuedDeepLink = null;
    handleDeepLink(link);
  }
}

// Strip the Electron token from the user agent so the web app sees a
// regular Chrome UA. Third-party logins never happen in this window (they
// go through the system browser via the mako:// handoff).
app.userAgentFallback = app.userAgentFallback
  .replace(/ Electron\/[\d.]+/, "")
  .replace(/ mako-desktop\/[\d.]+/, "");

// The HTTPS web app must call the plain-HTTP Local Agent on 127.0.0.1.
// Chromium's Local/Private Network Access checks gate that behind a
// permission prompt that Electron never renders, so the agent health probe
// silently fails and the app believes the agent is offline. The shell only
// loads the trusted Mako app, so disable those checks here. (Browsers keep
// them; the web app handles the permission prompt there.)
app.commandLine.appendSwitch(
  "disable-features",
  [
    "LocalNetworkAccessChecks",
    "PrivateNetworkAccessSendPreflights",
    "PrivateNetworkAccessRespectPreflightResults",
    "PrivateNetworkAccessPermissionPrompt",
  ].join(","),
);

// Register the mako:// scheme so "Open Mako" links reach this app.
// Packaged builds also declare it statically (electron-builder `protocols`);
// dev runs need the executable + entry script spelled out on Win/Linux.
if (app.isPackaged || process.platform === "darwin") {
  app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
} else if (process.argv.length >= 2) {
  app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME, process.execPath, [
    path.resolve(process.argv[1]),
  ]);
}

// macOS delivers deep links via open-url (register before app is ready).
app.on("open-url", (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  // Windows/Linux deliver deep links as argv of a second instance.
  app.on("second-instance", (_event, commandLine) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    const deepLink = findDeepLinkInArgv(commandLine);
    if (deepLink) handleDeepLink(deepLink);
  });

  // Renderer → main: start the browser-based sign-in flow.
  ipcMain.handle("mako:start-browser-auth", () => {
    startBrowserAuth();
  });

  app.whenReady().then(async () => {
    setupAutoUpdater();

    // Windows/Linux cold start via a mako:// link: the URL arrives in argv.
    const coldStartLink = findDeepLinkInArgv(process.argv);
    if (coldStartLink) queuedDeepLink = coldStartLink;

    await startAgent();
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app.on("before-quit", stopAgent);
}
