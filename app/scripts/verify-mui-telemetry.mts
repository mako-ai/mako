/* eslint-disable no-console */
/**
 * Verifies that MUI X telemetry is fully disabled by our app configuration.
 *
 * Exercises the REAL installed @mui/x-telemetry sender:
 *   1. With the global flag set (as index.html/main.tsx do), firing an event
 *      must NOT log a debug event and must NOT POST to x-telemetry.mui.com.
 *   2. Positive control: when telemetry is force-enabled, the same harness DOES
 *      observe a debug event — proving the test can actually detect telemetry
 *      (so the disabled result in step 1 is meaningful, not a false pass).
 *
 * Run (uses the workspace's tsx, e.g. from the api package):
 *   (cd api && npx tsx ../app/scripts/verify-mui-telemetry.mts)
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

process.env.NODE_ENV = "development"; // ensure the real (non-noop) sender is used

// Simulate a browser; shouldSendTelemetry() bails out when window is undefined.
(globalThis as Record<string, unknown>).window = globalThis;
// This is exactly what index.html / main.tsx set.
(globalThis as Record<string, unknown>).__MUI_X_TELEMETRY_DISABLED__ = true;

const fetchCalls: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown) => {
  const url =
    typeof input === "string"
      ? input
      : ((input as { url?: string })?.url ?? String(input));
  fetchCalls.push(url);
  return new Response("{}", { status: 200 });
}) as typeof fetch;

const logLines: string[] = [];
const realLog = console.log;
console.log = (...args: unknown[]) => {
  logLines.push(args.map(String).join(" "));
};

function telemetryPosts(): string[] {
  return fetchCalls.filter(u => u.includes("x-telemetry.mui.com"));
}
function eventLogs(): string[] {
  return logLines.filter(l => l.includes("[mui-x-telemetry] event"));
}

async function main() {
  // @mui/x-telemetry is a dependency of @mui/x-license (a direct app dep), not
  // of the app directly. Resolve it through the license package so this works
  // regardless of the invoking cwd / pnpm layout.
  const req = createRequire(import.meta.url);
  const licenseEntry = req.resolve("@mui/x-license");
  const telemetryEntry = createRequire(licenseEntry).resolve(
    "@mui/x-telemetry",
  );
  const { muiXTelemetrySettings, sendMuiXTelemetryEvent } = await import(
    telemetryEntry
  );

  // enableDebug => if telemetry were active, the event would be logged.
  muiXTelemetrySettings.enableDebug();

  // --- Step 1: disabled (our config) ---
  await sendMuiXTelemetryEvent({
    type: "license-verification",
    context: {},
  } as never);

  const postsWhileDisabled = telemetryPosts().length;
  const logsWhileDisabled = eventLogs().length;

  // --- Step 2: positive control — force telemetry ON ---
  (globalThis as Record<string, unknown>).__MUI_X_TELEMETRY_DISABLED__ =
    undefined;
  muiXTelemetrySettings.enableTelemetry();
  await sendMuiXTelemetryEvent({
    type: "license-verification",
    context: {},
  } as never);
  const logsAfterEnable = eventLogs().length;

  // Restore globals before asserting/reporting.
  console.log = realLog;
  globalThis.fetch = realFetch;

  assert.equal(
    postsWhileDisabled,
    0,
    `expected no telemetry POSTs while disabled, saw ${postsWhileDisabled}`,
  );
  assert.equal(
    logsWhileDisabled,
    0,
    `expected no telemetry events while disabled, saw ${logsWhileDisabled}`,
  );
  assert.ok(
    logsAfterEnable > logsWhileDisabled,
    "positive control failed: harness did not detect telemetry even when enabled",
  );

  realLog(
    `mui-telemetry verify: OK — disabled (0 events / 0 network); control detected ${logsAfterEnable} event when enabled`,
  );
}

main().catch(err => {
  console.log = realLog;
  globalThis.fetch = realFetch;
  realLog("mui-telemetry verify: FAILED", err);
  process.exitCode = 1;
});
