/**
 * Shared harness for the realtime-sync scenarios.
 *
 * Each "window" is its own browser context (isolated localStorage) carrying
 * the same session cookie. Includes:
 *  - SSE instrumentation (window.__sseLog / window.__esInstances) so tests
 *    can observe and kill the realtime stream;
 *  - console-store snapshots via the zustand persist localStorage key;
 *  - Monaco buffer readers via window.monaco.editor.getEditors();
 *  - direct API helpers (server ground truth + scripted agent turns).
 *
 * Configuration comes from scripts/realtime-e2e/.env.e2e (see setup.mjs).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const here = path.dirname(fileURLToPath(import.meta.url));

function loadEnvFile() {
  const file = path.join(here, ".env.e2e");
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
const fileEnv = loadEnvFile();
const env = key => process.env[key] || fileEnv[key];

export const APP = env("MAKO_E2E_APP_URL") || "http://localhost:5173";
export const API = env("MAKO_E2E_API_URL") || "http://localhost:8080";
export const WS_ID = env("MAKO_E2E_WORKSPACE_ID");
export const CONN_ID = env("MAKO_E2E_CONNECTION_ID");
export const SESSION = env("MAKO_E2E_SESSION");
export const CHROME =
  env("MAKO_E2E_CHROME") || "/usr/local/bin/google-chrome";
export const SHOTS_DIR = path.join(here, "shots");

export function requireConfig() {
  const missing = [];
  if (!WS_ID) missing.push("MAKO_E2E_WORKSPACE_ID");
  if (!CONN_ID) missing.push("MAKO_E2E_CONNECTION_ID");
  if (!SESSION) missing.push("MAKO_E2E_SESSION");
  if (missing.length) {
    throw new Error(
      `Missing config (${missing.join(", ")}). Run setup.mjs first — see README.md.`,
    );
  }
}

export async function launch() {
  return chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--no-sandbox", "--window-size=1500,950"],
  });
}

export async function newWindow(browser, { session = SESSION } = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 1500, height: 950 },
  });
  await ctx.addCookies([
    { name: "auth_session", value: session, domain: "localhost", path: "/" },
  ]);
  // Capture every SSE event the app receives + keep handles so tests can
  // simulate silently-dead connections (close() fires no error event).
  await ctx.addInitScript(() => {
    window.__sseLog = [];
    window.__esInstances = [];
    const Orig = window.EventSource;
    window.EventSource = function (url, opts) {
      const es = new Orig(url, opts);
      window.__esInstances.push(es);
      const log = type => e =>
        window.__sseLog.push({
          url: String(url),
          type,
          data: e.data,
          ts: Date.now(),
        });
      for (const t of ["message", "hello", "ping", "open", "error"]) {
        es.addEventListener(t, log(t));
      }
      return es;
    };
    window.EventSource.prototype = Orig.prototype;
    Object.defineProperty(window.EventSource, "CONNECTING", { value: 0 });
    Object.defineProperty(window.EventSource, "OPEN", { value: 1 });
    Object.defineProperty(window.EventSource, "CLOSED", { value: 2 });
  });
  const page = await ctx.newPage();
  await page.goto(APP, { waitUntil: "domcontentloaded" });
  // networkidle never settles: the realtime SSE connection stays open.
  await page.waitForTimeout(3000);
  return { ctx, page };
}

// ---------- console-store introspection (zustand persist localStorage) ----
export async function getConsoleStore(page) {
  return page.evaluate(() => {
    const raw = localStorage.getItem("console-store");
    return raw ? JSON.parse(raw).state : null;
  });
}

export async function getTabs(page) {
  const s = await getConsoleStore(page);
  return s ? s.tabs : {};
}

// ---------- Monaco access ---------------------------------------------------
export async function getEditorTextByTabId(page, tabId) {
  return page.evaluate(tid => {
    const editors = window.monaco?.editor?.getEditors?.() || [];
    const inTab = editors.filter(ed => {
      const node = ed.getContainerDomNode?.();
      return node && node.closest(`[data-mako-tab-id="${tid}"]`);
    });
    if (inTab.length === 0) return null;
    // An agent review renders a Monaco diff (original + proposed editors); the
    // proposed (modified) side is mounted last, so read that one — otherwise a
    // diff under review reads back as the stale baseline.
    return inTab.at(-1)?.getValue() ?? null;
  }, tabId);
}

export async function activateTabByTitle(page, title) {
  await page.locator(`[role="tab"]:has-text("${title}")`).first().click();
  await page.waitForTimeout(400);
}

export async function clickEditorAndType(
  page,
  tabId,
  text,
  { append = true } = {},
) {
  const container = page
    .locator(`[data-mako-tab-id="${tabId}"] .monaco-editor`)
    .first();
  await container.click();
  if (append) {
    await page.keyboard.press("Control+End");
  }
  await page.keyboard.type(text, { delay: 15 });
}

export async function killRealtimeSilently(page) {
  await page.evaluate(() => {
    for (const es of window.__esInstances) es.close();
  });
}

export async function screenshot(page, name) {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS_DIR, `${name}.png`) });
}

export async function waitMs(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ---------- API helpers (server ground truth + scripted agent) -------------
export async function apiGetConsole(consoleId) {
  const res = await fetch(
    `${API}/api/workspaces/${WS_ID}/consoles/content?id=${consoleId}`,
    { headers: { cookie: `auth_session=${SESSION}` } },
  );
  return res.json();
}

/** Drive a scripted agent turn directly against the API (mock gateway). */
export async function apiAgentChat(chatId, script, opts = {}) {
  const text = `MOCKSCRIPT::${JSON.stringify(script)}`;
  const res = await fetch(`${API}/api/agent/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `auth_session=${SESSION}`,
    },
    body: JSON.stringify({
      chatId,
      workspaceId: WS_ID,
      messages: [
        { id: `m-${Date.now()}`, role: "user", parts: [{ type: "text", text }] },
      ],
      ...opts,
    }),
  });
  return res.text(); // drain the SSE
}

/** Send a scripted agent turn through the browser's chat UI (in-band path). */
export async function uiAgentChat(page, script) {
  const input = page.locator('textarea[placeholder="Ask Chat..."]');
  await input.click();
  await input.fill(`MOCKSCRIPT::${JSON.stringify(script)}`);
  await page.keyboard.press("Enter");
}

export async function getActiveChat(page) {
  return page.evaluate(() =>
    JSON.parse(sessionStorage.getItem("mako:active-chat") || "{}"),
  );
}

export function oid() {
  const hex = "0123456789abcdef";
  let s = "";
  for (let i = 0; i < 24; i++) s += hex[Math.floor(Math.random() * 16)];
  return s;
}

export function uniqueName(prefix) {
  return `${prefix}-${Date.now().toString(36)}`;
}

// ---------- assertions ------------------------------------------------------
let failures = 0;

export function check(label, condition, detail) {
  const status = condition ? "PASS" : "FAIL";
  if (!condition) failures += 1;
  // eslint-disable-next-line no-console -- standalone dev tool, not API code
  console.log(
    `  [${status}] ${label}${detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`,
  );
}

export function finish(scenario) {
  // eslint-disable-next-line no-console -- standalone dev tool, not API code
  console.log(
    failures === 0
      ? `\n${scenario}: ALL CHECKS PASSED`
      : `\n${scenario}: ${failures} CHECK(S) FAILED`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

/** Poll until fn() is truthy or the timeout elapses; returns the last value. */
export async function waitFor(fn, { timeoutMs = 10_000, stepMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    value = await fn();
    if (value) return value;
    await waitMs(stepMs);
  }
  return value;
}
