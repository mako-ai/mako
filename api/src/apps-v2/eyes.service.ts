/**
 * Agent eyes (apps-v2.md §13.15): a real headless browser INSIDE the sandbox.
 *
 * The agent needs pixel truth (what does the app render), runtime truth
 * (what did the browser's console say) and the ability to click around —
 * and the only place all three exist same-origin, with no public URL, no
 * tunnel, and no tenant JS on the API host (N1), is the box itself.
 *
 * Chrome-headless-shell + puppeteer-core are installed into /tmp/mako-eyes
 * on first use (~30-60s, cached until the box is recycled; the template can
 * pre-warm it later). Each browse is one short-lived browser: launch, act,
 * capture, quit — nothing resident to fight the 2 GiB box for memory.
 */
import { loggers } from "../logging";
import { getSandboxProvider } from "./sandbox/provider";
import { boxCtx, ensureBox, type WorktreeHandle } from "./worktree.service";
import { currentDevPort } from "./dev-server.service";

const logger = loggers.api("apps-v2-eyes");

const EYES_DIR = "/tmp/mako-eyes";
const RUNNER_PATH = `${EYES_DIR}/run.mjs`;
const SHELL_GLOB = `${EYES_DIR}/browsers/chrome-headless-shell/*/chrome-headless-shell-linux64/chrome-headless-shell`;

export interface EyesStep {
  action: "navigate" | "click" | "type" | "wait" | "eval";
  selector?: string;
  path?: string;
  value?: string;
  expression?: string;
  ms?: number;
}

export interface EyesResult {
  ok: boolean;
  error?: string;
  url?: string;
  stepResults?: unknown[];
  consoleLogs?: string[];
  pageErrors?: string[];
  failedRequests?: string[];
  /** Entries shed beyond the per-category caps, when any (flood signal). */
  droppedBeyondCaps?: Record<string, number>;
  /** JPEG, base64 (no data: prefix). */
  screenshotBase64?: string;
}

/**
 * The in-box runner. Plain ESM executed with the box's node; puppeteer-core
 * resolves from /tmp/mako-eyes/node_modules. Prints ONE marker-prefixed JSON
 * line so parsing survives any library noise on stdout.
 */
function runnerSource(): string {
  return `
import { readdirSync } from "node:fs";
import path from "node:path";

const MARK = "MAKO_EYES_RESULT:";
const out = (obj) => {
  console.log(MARK + JSON.stringify(obj));
  process.exit(0);
};

const args = JSON.parse(process.argv[2] || "{}");
const base = args.base;
const steps = Array.isArray(args.steps) ? args.steps.slice(0, 10) : [];
const wantShot = args.screenshot !== false;

function findShell() {
  const root = ${JSON.stringify(`${EYES_DIR}/browsers/chrome-headless-shell`)};
  for (const ver of readdirSync(root)) {
    const p = path.join(root, ver, "chrome-headless-shell-linux64", "chrome-headless-shell");
    try { readdirSync(path.dirname(p)); return p; } catch {}
  }
  throw new Error("chrome-headless-shell not found under " + root);
}

const consoleLogs = [];
const pageErrors = [];
const failedRequests = [];
const stepResults = [];
const droppedCounts = { consoleLogs: 0, pageErrors: 0, failedRequests: 0 };
const cap = (arr, item, max, key) => {
  if (arr.length < max) arr.push(String(item).slice(0, 600));
  else if (key) droppedCounts[key] += 1;
};

try {
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.launch({
    executablePath: findShell(),
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--hide-scrollbars"],
  });
  // Watchdog: an eval that never returns (while(true){}) hangs page.evaluate
  // forever; without this the outer exec timeout killed the RUNNER but left
  // the browser tree orphaned in the box (verified: ~90MB per orphan). Fire
  // before the exec deadline, close the browser, and say WHAT happened.
  setTimeout(async () => {
    try { await browser.close(); } catch {}
    out({ ok: false, error: "browse timed out after 75s — a step never returned (infinite eval, hung navigation, or a frozen page). The browser was closed; the app and dev server are unaffected.", consoleLogs, pageErrors, failedRequests, stepResults });
  }, 75000);
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    page.setDefaultTimeout(8000);
    page.on("console", m => {
      const t = m.type();
      cap(consoleLogs, "[" + t + "] " + m.text(), 120, "consoleLogs");
    });
    page.on("pageerror", e => cap(pageErrors, e && (e.stack || e.message) || e, 40, "pageErrors"));
    page.on("requestfailed", r => cap(failedRequests, r.url() + " -> " + (r.failure() && r.failure().errorText), 40, "failedRequests"));

    const settle = (ms) => new Promise(r => setTimeout(r, ms));
    const goto = async (p) => {
      const url = new URL(p || "/", base).href;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
      await settle(1200);
      return url;
    };
    let currentUrl = await goto(steps[0] && steps[0].action === "navigate" ? steps[0].path : "/");
    for (const [i, step] of steps.entries()) {
      try {
        if (step.action === "navigate") {
          if (i === 0) { stepResults.push({ step: i, ok: true, url: currentUrl }); continue; }
          currentUrl = await goto(step.path);
          stepResults.push({ step: i, ok: true, url: currentUrl });
        } else if (step.action === "click") {
          await page.click(step.selector);
          await settle(600);
          stepResults.push({ step: i, ok: true });
        } else if (step.action === "type") {
          await page.type(step.selector, String(step.value ?? ""), { delay: 10 });
          stepResults.push({ step: i, ok: true });
        } else if (step.action === "wait") {
          await settle(Math.min(Number(step.ms) || 500, 5000));
          stepResults.push({ step: i, ok: true });
        } else if (step.action === "eval") {
          const value = await page.evaluate(step.expression);
          let text;
          try { text = JSON.stringify(value); } catch { text = String(value); }
          stepResults.push({ step: i, ok: true, value: String(text).slice(0, 4000) });
        } else {
          stepResults.push({ step: i, ok: false, error: "unknown action " + step.action });
        }
      } catch (e) {
        stepResults.push({ step: i, ok: false, error: String(e && e.message || e).slice(0, 500) });
      }
    }
    // Push the console bridge's pending batch NOW (hidden-page timer
    // throttling would otherwise fire it during browser.close()).
    try {
      await page.evaluate(() => (window.__makoEyesFlush ? window.__makoEyesFlush() : null));
    } catch {}
    await settle(400);
    let screenshotBase64;
    if (wantShot) {
      screenshotBase64 = await page.screenshot({ type: "jpeg", quality: 55, encoding: "base64" });
    }
    const truncated = Object.fromEntries(Object.entries(droppedCounts).filter(e => e[1] > 0));
    out({ ok: true, url: page.url(), stepResults, consoleLogs, pageErrors, failedRequests, ...(Object.keys(truncated).length ? { droppedBeyondCaps: truncated } : {}), screenshotBase64 });
  } finally {
    await browser.close().catch(() => {});
  }
} catch (e) {
  out({ ok: false, error: String(e && (e.stack || e.message) || e).slice(0, 1500), consoleLogs, pageErrors, failedRequests, stepResults });
}
`.trimStart();
}

/** One-time (per box) browser install; fast no-op once the marker exists. */
async function ensureEyesRuntime(ctx: {
  sessionKey: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const provider = getSandboxProvider();
  // "Installed" means RUNNABLE: the shell binary exists AND its shared
  // libraries resolve. The first rollout trusted a marker file and shipped a
  // browser that could not launch (libnspr4.so missing from the base image).
  const probe = await provider.exec(
    ctx,
    `shell=$(ls ${SHELL_GLOB} 2>/dev/null | head -1); ` +
      `[ -n "$shell" ] && [ -f ${EYES_DIR}/ready ] && ` +
      `[ "$(ldd "$shell" 2>/dev/null | grep -c 'not found')" = "0" ] ` +
      `&& echo eyes-ok || echo eyes-missing`,
    { timeoutMs: 15_000 },
  );
  if (probe.stdout.includes("eyes-ok")) return { ok: true };
  logger.info("Apps v2 eyes: installing headless browser in the box", {
    sessionKey: ctx.sessionKey,
  });
  // Chromium's shared-library set is not in the base image; the box has
  // passwordless sudo, so install what the binary actually needs. The
  // template can pre-bake all of this later — this path just makes any box
  // self-sufficient.
  const CHROME_DEPS =
    "libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libdbus-1-3 libcups2 " +
    "libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 " +
    "libxrandr2 libgbm1 libasound2 libpango-1.0-0 libcairo2 libx11-6 " +
    "libxcb1 libxext6 libexpat1";
  const install = await provider.exec(
    ctx,
    [
      `mkdir -p ${EYES_DIR} && cd ${EYES_DIR}`,
      `[ -f package.json ] || npm init -y >/dev/null 2>&1`,
      `[ -d node_modules/puppeteer-core ] || npm i --no-audit --no-fund puppeteer-core >/dev/null 2>&1`,
      `ls ${SHELL_GLOB} >/dev/null 2>&1 || npx --yes @puppeteer/browsers install chrome-headless-shell@stable --path ${EYES_DIR}/browsers >/dev/null 2>&1`,
      `shell=$(ls ${SHELL_GLOB} 2>/dev/null | head -1)`,
      `[ -n "$shell" ]`,
      `if [ "$(ldd "$shell" | grep -c 'not found')" != "0" ]; then ` +
        `sudo -n apt-get update -qq >/dev/null 2>&1; ` +
        `sudo -n DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${CHROME_DEPS} >/dev/null 2>&1; ` +
        `fi`,
      `[ "$(ldd "$shell" | grep -c 'not found')" = "0" ] && touch ready && echo eyes-installed || { echo eyes-failed; ldd "$shell" | grep 'not found' | head -5; }`,
    ].join(" && "),
    { timeoutMs: 300_000 },
  );
  if (!install.stdout.includes("eyes-installed")) {
    return {
      ok: false,
      error:
        "Could not install the in-box browser: " +
        (install.stderr || install.stdout).slice(-400),
    };
  }
  return { ok: true };
}

/**
 * Look at the running app: navigate/click/type/eval, then capture screenshot
 * + console. Requires a RUNNING dev server — this never starts one (§13.9;
 * app2_open_app is the start affordance).
 */
export async function browseApp(
  handle: WorktreeHandle,
  opts: {
    steps?: EyesStep[];
    screenshot?: boolean;
    /**
     * "local" (default) hits 127.0.0.1 inside the box — debugs the APP,
     * immune to proxy/edge state. "public" hits the sandbox's public
     * `*.e2b.app` origin — the exact path the user's browser takes, so it
     * also exercises the E2B proxy, allowedHosts and TLS.
     */
    origin?: "local" | "public";
  },
): Promise<EyesResult> {
  const provider = getSandboxProvider();
  if (provider.id === "local") {
    return {
      ok: false,
      error:
        "app2_browse needs the E2B sandbox (the local provider would run a " +
        "browser on the API host).",
    };
  }
  const port = await currentDevPort(handle);
  if (!port) {
    return {
      ok: false,
      error:
        "No dev server is running for this app — start one with " +
        "app2_open_app first.",
    };
  }
  const ctx = boxCtx(handle);
  await ensureBox(handle);
  const runtime = await ensureEyesRuntime(ctx);
  if (!runtime.ok) return { ok: false, error: runtime.error };

  await provider.writeFile(
    ctx,
    RUNNER_PATH,
    new TextEncoder().encode(runnerSource()),
  );
  let base = `http://127.0.0.1:${port}`;
  if (opts.origin === "public") {
    // Peek, never create (§13.9): the box exists — a dev server is running
    // in it — so this only resolves the hostname.
    const url = await provider.peekPublicUrlForPort(ctx, port);
    if (!url) {
      return {
        ok: false,
        error:
          "Could not resolve the sandbox's public origin — it may be " +
          "mid-recycle. Retry, or browse with the default local origin.",
      };
    }
    base = url;
  }
  const args = JSON.stringify({
    base,
    steps: opts.steps ?? [],
    screenshot: opts.screenshot !== false,
  });
  const result = await provider.exec(
    ctx,
    // The sweep first: any eyes browser older than 3 minutes is an orphan
    // (a live browse lasts under 90s) — reap it before spending memory on a
    // new one. Never a bare pkill: a concurrent browse would be collateral.
    `for pid in $(pgrep -f chrome-headless-shell 2>/dev/null); do ` +
      `t=$(ps -o etimes= -p "$pid" 2>/dev/null | tr -d ' '); ` +
      `[ -n "$t" ] && [ "$t" -gt 180 ] && kill -9 "$pid" 2>/dev/null; done; ` +
      `node ${RUNNER_PATH} '${args.replace(/'/g, String.raw`'\''`)}'`,
    { timeoutMs: 90_000 },
  );
  const line = result.stdout
    .split("\n")
    .reverse()
    .find(l => l.startsWith("MAKO_EYES_RESULT:"));
  if (!line) {
    return {
      ok: false,
      error:
        "The in-box browser produced no result" +
        (result.timedOut
          ? " (the browse exceeded its 90s budget — an eval that never " +
            "returns, or a hung page; the stale browser is reaped on the " +
            "next call)"
          : "") +
        ": " +
        (result.stderr || result.stdout).slice(-500),
    };
  }
  try {
    return JSON.parse(line.slice("MAKO_EYES_RESULT:".length)) as EyesResult;
  } catch {
    return { ok: false, error: "Unparseable eyes result." };
  }
}
