/**
 * Scenario 04 — silently-dead realtime SSE (NAT/proxy half-close: the
 * browser never gets an `error` event).
 *
 *   - A console created by the agent through the chat UI must STILL appear
 *     (in-band tool-result opening rides the resumable chat stream, not the
 *     realtime poke channel) and its run results must render;
 *   - the liveness watchdog must detect the dead stream and reconnect within
 *     ~85s (70s stale + 15s sweep), after which edits made by another window
 *     during the dead period are repaired by the reconnect revision sync.
 *
 * NOTE: this scenario takes ~2 minutes by design (watchdog window).
 */
import * as h from "./helpers.mjs";

h.requireConfig();
const b = await h.launch();
const A = await h.newWindow(b);

// A scratch console whose pokes will be missed while the stream is dead.
await A.page.locator('button:has-text("Open Console")').click();
await A.page.waitForTimeout(800);
const scratchId = Object.keys(await h.getTabs(A.page))[0];
await h.clickEditorAndType(A.page, scratchId, "select 1 -- watchdog probe");
await A.page.waitForTimeout(3000);

await h.killRealtimeSilently(A.page);

// (1) agent create+run through the chat UI while the realtime SSE is dead
await h.uiAgentChat(A.page, [
  {
    tool: "create_console",
    input: {
      title: "InBandConsole",
      content: "db.users.find({})",
      connectionId: h.CONN_ID,
    },
  },
  { tool: "run_console", input: { consoleId: "$prev.consoleId" } },
]);
const inband = await h.waitFor(
  async () => {
    const tabs = await h.getTabs(A.page);
    return Object.values(tabs).find(t => t.title === "InBandConsole");
  },
  { timeoutMs: 15_000 },
);
h.check(
  "console created during dead SSE appears via the in-band chat stream",
  Boolean(inband),
);
if (inband) {
  const results = await h.waitFor(
    async () =>
      (
        await A.page
          .locator(`[data-mako-tab-id="${inband.id}"]`)
          .locator("text=/Alice|Carol/i")
          .allTextContents()
          .catch(() => [])
      ).length > 0,
    { timeoutMs: 10_000 },
  );
  h.check("its run results rendered despite the dead poke channel", results);
}

// (2) another window edits the scratch console while A's stream is dead
const B = await h.newWindow(b);
const storeRaw = await A.page.evaluate(() =>
  localStorage.getItem("console-store"),
);
await B.page.evaluate(raw => localStorage.setItem("console-store", raw), storeRaw);
await B.page.reload({ waitUntil: "domcontentloaded" });
await B.page.waitForTimeout(2500);
await h.activateTabByTitle(B.page, "New Console");
await h.clickEditorAndType(B.page, scratchId, "\n-- edited by B while A dead");
await B.page.waitForTimeout(3500);

// (3) the watchdog must reconnect and repair A within ~100s
const repaired = await h.waitFor(
  async () => {
    const text = await h.getEditorTextByTabId(A.page, scratchId);
    return text?.includes("edited by B while A dead") ? text : null;
  },
  { timeoutMs: 110_000, stepMs: 5000 },
);
h.check(
  "watchdog reconnected and the revision sync repaired A's editor",
  Boolean(repaired),
  repaired,
);

await b.close();
h.finish("04-dead-sse");
