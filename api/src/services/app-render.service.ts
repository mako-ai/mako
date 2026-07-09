/**
 * Server-side headless render of a draft-app preview.
 *
 * Completes the fully-autonomous iteration loop for MCP clients with no
 * browser of their own (Claude Desktop, claude.ai, CI): the `render_app`
 * tool loads `<client>/preview/<signed token>` in a pooled headless
 * Chromium, waits for the preview page to settle, and returns render
 * status, errors, filtered console output, and a screenshot.
 *
 * Deployment: requires a Chromium binary on the API host, configured via
 * RENDER_APP_BROWSER_PATH. Without it the service reports itself disabled
 * (the tool degrades with a clear message; nothing else breaks). Container
 * images typically also need RENDER_APP_BROWSER_ARGS=--no-sandbox.
 *
 * The page only ever navigates to URLs this module builds itself from a
 * freshly-minted preview token — the tool takes an appId, never a URL, so
 * the pool cannot be steered at arbitrary targets (no SSRF surface).
 */
import type { Browser } from "playwright-core";
import { loggers } from "../logging";

const logger = loggers.api("app-render");

/** Wait budget for the preview to report ready/error after navigation. */
const DEFAULT_SETTLE_TIMEOUT_MS = 20_000;
const MAX_SETTLE_TIMEOUT_MS = 45_000;
/** Post-ready delay so late paints (fonts, charts) land before screenshot. */
const PAINT_DELAY_MS = 750;
const MAX_CONCURRENT_RENDERS = 2;
const MAX_CONSOLE_LINES = 100;
const MAX_CONSOLE_LINE_CHARS = 2_000;

export interface AppRenderResult {
  success: boolean;
  /** ready | error | timeout — what the preview page reported. */
  status: "ready" | "error" | "timeout";
  errors: string[];
  consoleLogs: string[];
  /** JPEG screenshot, base64 (no data: prefix). Absent when disabled. */
  screenshotBase64?: string;
  error?: string;
}

export function isAppRenderEnabled(): boolean {
  return !!process.env.RENDER_APP_BROWSER_PATH;
}

let browserPromise: Promise<Browser> | null = null;
let activeRenders = 0;
const waiters: Array<() => void> = [];

async function acquireSlot(): Promise<void> {
  if (activeRenders < MAX_CONCURRENT_RENDERS) {
    activeRenders += 1;
    return;
  }
  await new Promise<void>(resolve => waiters.push(resolve));
  activeRenders += 1;
}

function releaseSlot(): void {
  activeRenders -= 1;
  waiters.shift()?.();
}

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = (async () => {
      // CJS/ESM interop: under tsx/commonjs the namespace may sit on .default.
      const mod = (await import("playwright-core")) as {
        chromium?: typeof import("playwright-core").chromium;
        default?: { chromium: typeof import("playwright-core").chromium };
      };
      const chromium = mod.chromium ?? mod.default?.chromium;
      if (!chromium) {
        throw new Error("playwright-core did not export chromium");
      }
      const args = (process.env.RENDER_APP_BROWSER_ARGS ?? "")
        .split(",")
        .map(a => a.trim())
        .filter(Boolean);
      const browser = await chromium.launch({
        executablePath: process.env.RENDER_APP_BROWSER_PATH,
        headless: true,
        args: ["--disable-dev-shm-usage", ...args],
      });
      // A crashed/killed browser must not poison the pool forever.
      browser.on("disconnected", () => {
        browserPromise = null;
      });
      return browser;
    })();
    browserPromise.catch(() => {
      browserPromise = null;
    });
  }
  return browserPromise;
}

interface PreviewWindowState {
  status?: "booting" | "ready" | "error";
  errors?: string[];
}

export async function renderAppPreview(input: {
  url: string;
  width?: number;
  height?: number;
  timeoutMs?: number;
}): Promise<AppRenderResult> {
  if (!isAppRenderEnabled()) {
    return {
      success: false,
      status: "error",
      errors: [],
      consoleLogs: [],
      error:
        "Server-side rendering is not configured (RENDER_APP_BROWSER_PATH is unset). " +
        "Use create_preview_token and open the URL in your own browser instead.",
    };
  }

  const timeoutMs = Math.min(
    Math.max(input.timeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS, 5_000),
    MAX_SETTLE_TIMEOUT_MS,
  );

  await acquireSlot();
  const consoleLogs: string[] = [];
  const pageErrors: string[] = [];
  try {
    const browser = await getBrowser();
    const context = await browser.newContext({
      viewport: {
        width: Math.min(Math.max(input.width ?? 1280, 320), 1920),
        height: Math.min(Math.max(input.height ?? 800, 320), 1920),
      },
    });
    try {
      const page = await context.newPage();
      page.on("console", message => {
        if (consoleLogs.length >= MAX_CONSOLE_LINES) return;
        const type = message.type();
        // Keep the machine markers + anything that looks like a problem;
        // drop the firehose of debug logging from app dependencies.
        const text = message.text();
        if (
          type === "error" ||
          type === "warning" ||
          text.startsWith("[mako-preview-")
        ) {
          consoleLogs.push(
            `[${type}] ${text.slice(0, MAX_CONSOLE_LINE_CHARS)}`,
          );
        }
      });
      page.on("pageerror", error => {
        if (pageErrors.length < MAX_CONSOLE_LINES) {
          pageErrors.push(String(error?.message ?? error));
        }
      });

      await page.goto(input.url, {
        waitUntil: "domcontentloaded",
        timeout: timeoutMs,
      });

      // The preview page publishes window.__MAKO_PREVIEW_STATE__ when the
      // sandboxed app reports ready or error (see AppPreviewPage.tsx).
      let settled: PreviewWindowState | null = null;
      try {
        await page.waitForFunction(
          () => {
            const state = (
              window as unknown as {
                __MAKO_PREVIEW_STATE__?: { status?: string };
              }
            ).__MAKO_PREVIEW_STATE__;
            return state?.status === "ready" || state?.status === "error";
          },
          undefined,
          { timeout: timeoutMs },
        );
        settled = await page.evaluate(
          () =>
            (
              window as unknown as {
                __MAKO_PREVIEW_STATE__?: PreviewWindowState;
              }
            ).__MAKO_PREVIEW_STATE__ ?? null,
        );
      } catch {
        settled = null; // timeout — still screenshot whatever rendered
      }

      if (settled?.status === "ready") {
        await page.waitForTimeout(PAINT_DELAY_MS);
      }

      const screenshot = await page.screenshot({
        type: "jpeg",
        quality: 70,
      });

      const status: AppRenderResult["status"] =
        settled?.status === "ready"
          ? "ready"
          : settled?.status === "error"
            ? "error"
            : "timeout";

      return {
        success: status === "ready",
        status,
        errors: [...(settled?.errors ?? []), ...pageErrors],
        consoleLogs,
        screenshotBase64: screenshot.toString("base64"),
      };
    } finally {
      await context.close().catch(() => {});
    }
  } catch (error) {
    logger.error("Headless render failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      status: "error",
      errors: pageErrors,
      consoleLogs,
      error: error instanceof Error ? error.message : "Headless render failed",
    };
  } finally {
    releaseSlot();
  }
}
