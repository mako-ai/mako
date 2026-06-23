/**
 * Repro/regression — agent run_console RESULTS surface under a dead SSE.
 *
 * run_console executes server-side and persists a run artifact (tab.lastRun)
 * + bumps the draft revision. Its only realtime delivery is the
 * console.run.completed poke; if that is missed (silently-dead SSE) the
 * results panel stayed empty until focus/reconnect. The in-band chat-stream
 * reconcile (syncRevisions on the run_console tool result) refreshes
 * tab.lastRun, which Editor.tsx renders reactively — so results appear live.
 *
 * Runs `SELECT '<marker>'` against the workspace's SQL connection, so it works
 * on the demo Postgres without mongo sample data.
 */
import * as h from "./helpers.mjs";

h.requireConfig();
const b = await h.launch();
const A = await h.newWindow(b);

const marker = `runheal-${Date.now()}`;

// Turn 1: create the console (SSE alive).
await h.uiAgentChat(A.page, [
  {
    tool: "create_console",
    input: {
      title: "RunHeal",
      content: `SELECT '${marker}' AS marker`,
      connectionId: h.CONN_ID,
    },
  },
]);
const created = await h.waitFor(
  async () => {
    const tabs = await h.getTabs(A.page);
    return Object.values(tabs).find(t => t.title === "RunHeal");
  },
  { timeoutMs: 20_000 },
);
h.check("create_console opened the tab", Boolean(created));
const id = created?.id;
if (!id) {
  await b.close();
  h.finish("10-run-dead-sse");
  process.exit(0);
}

// The realtime stream goes silently dead.
await h.killRealtimeSilently(A.page);
await A.page.waitForTimeout(500);

// Turn 2: agent runs the query (run.completed poke will be lost).
await h.uiAgentChat(A.page, [
  { tool: "run_console", input: { consoleId: id } },
]);

// Server ran it.
const ranOnServer = await h.waitFor(
  async () => {
    const srv = await h.apiGetConsole(id);
    return srv?.lastRun?.status === "success" ? srv : null;
  },
  { timeoutMs: 20_000 },
);
h.check("server executed the query (lastRun success)", Boolean(ranOnServer));

// Client: the results panel must render the row WITHOUT a refresh, driven by
// the in-band reconcile (not the dead poke).
const resultsShown = await h.waitFor(
  async () =>
    (await A.page
      .locator(`[data-mako-tab-id="${id}"]`)
      .locator(`text=/${marker}/`)
      .count()
      .catch(() => 0)) > 0
      ? true
      : null,
  { timeoutMs: 12_000, stepMs: 1000 },
);
h.check(
  "agent run results surfaced LIVE under a dead SSE (no refresh)",
  Boolean(resultsShown),
);
await h.screenshot(A.page, "10-run-dead-sse");

await b.close();
h.finish("10-run-dead-sse");
