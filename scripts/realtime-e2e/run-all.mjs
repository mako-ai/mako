/**
 * Runs every scenario sequentially and reports a summary. ~4 minutes total
 * (scenario 04 alone takes ~2 minutes — the watchdog window is real time).
 */
/* eslint-disable no-console -- standalone dev tool, not API code */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const scenarios = [
  "01-draft-two-windows.mjs",
  "02-saved-console.mjs",
  "03-agent-modalities.mjs",
  "04-dead-sse.mjs",
  "05-stale-save-dual-guard.mjs",
  "06-wake-triggers.mjs",
  "07-create-modify-same-turn.mjs",
  "10-run-dead-sse.mjs",
  "11-rename-legacy-console.mjs",
  "99-modify-dead-sse-repro.mjs",
];

const results = [];
for (const scenario of scenarios) {
  console.log(`\n=== ${scenario} ===`);
  const res = spawnSync("node", [path.join(here, scenario)], {
    stdio: "inherit",
  });
  results.push({ scenario, ok: res.status === 0 });
}

console.log("\n=== SUMMARY ===");
for (const r of results) {
  console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.scenario}`);
}
process.exitCode = results.every(r => r.ok) ? 0 : 1;
