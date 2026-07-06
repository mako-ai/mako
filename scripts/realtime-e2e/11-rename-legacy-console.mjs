/**
 * Repro/regression — agent rename of a LEGACY console (no draftRevision field)
 * must update the open tab title + breadcrumbs.
 *
 * Legacy consoles (created before the draftRevision field) have draftRevision
 * absent. The client read it as `?? 1`; the server's first write `$inc` on a
 * null field also yields 1 — so revisions-sync sees serverRevision === clientRevision
 * and returns NOTHING. The rename (a name-only modify_console) therefore never
 * reaches the open tab/breadcrumbs, even after a refresh (the tree updates only
 * because it is a full fetch).
 *
 * Simulates the legacy state by $unset-ing draftRevision via mongosh.
 */
import { execSync } from "node:child_process";
import * as h from "./helpers.mjs";

const MONGO_URL = process.env.E2E_MONGO_URL || "mongodb://127.0.0.1:27017/mako";

h.requireConfig();
const b = await h.launch();
const A = await h.newWindow(b);

const id = h.oid();
const newName = `RenamedCute-${Date.now()}`;
const headers = {
  "content-type": "application/json",
  cookie: `auth_session=${h.SESSION}`,
};

// Seed a draft console (this gives it draftRevision: 1).
await fetch(`${h.API}/api/workspaces/${h.WS_ID}/consoles/${id}`, {
  method: "PUT",
  headers,
  body: JSON.stringify({ content: "SELECT 1", clientId: "seed", language: "sql" }),
}).then(r => r.json());

// Make it LEGACY: remove the draftRevision field entirely.
execSync(
  `mongosh --quiet "${MONGO_URL}" --eval 'db.savedconsoles.updateOne({_id:ObjectId("${id}")},{$unset:{draftRevision:""}})'`,
);
// Sanity: confirm it is now absent.
const check = execSync(
  `mongosh --quiet "${MONGO_URL}" --eval 'db.savedconsoles.findOne({_id:ObjectId("${id}")}).draftRevision'`,
)
  .toString()
  .trim();
h.check("console is legacy (draftRevision absent)", check === "null" || check === "", check);

// Open it in window A through the agent.
await h.uiAgentChat(A.page, [{ tool: "open_console", input: { consoleId: id } }]);
const opened = await h.waitFor(async () => {
  const t = (await h.getTabs(A.page))[id];
  return t ? t : null;
});
h.check("legacy console opened as a tab", Boolean(opened));

// Rename via the agent: a name-only modify_console (no-op patch of line 1).
await h.uiAgentChat(A.page, [
  {
    tool: "modify_console",
    input: {
      consoleId: id,
      action: "patch",
      startLine: 1,
      endLine: 1,
      content: "SELECT 1",
      title: newName,
    },
  },
]);

// Server applied the rename.
const ranOnServer = await h.waitFor(
  async () => {
    const srv = await h.apiGetConsole(id);
    return srv?.name === newName ? srv : null;
  },
  { timeoutMs: 15_000 },
);
h.check("server renamed the console", Boolean(ranOnServer), ranOnServer?.name);

// The OPEN TAB title must reflect the rename without a refresh.
const tabRenamed = await h.waitFor(
  async () => {
    const t = (await h.getTabs(A.page))[id];
    return t?.title === newName ? t : null;
  },
  { timeoutMs: 12_000, stepMs: 1000 },
);
h.check(
  "open tab title updated to the new name (drives breadcrumbs/page title)",
  Boolean(tabRenamed),
  ((await h.getTabs(A.page))[id] || {}).title,
);

// The editor tab strip (driven by the same tab.title) should show the new
// name — scoped to a [role="tab"] so it can't false-positive on the agent's
// chat reply text.
const tabStripShown =
  (await A.page
    .locator(`[role="tab"]:has-text("${newName}")`)
    .count()
    .catch(() => 0)) > 0;
h.check("editor tab strip shows the new name", tabStripShown);

await h.screenshot(A.page, "11-rename-legacy");

await b.close();
h.finish("11-rename-legacy-console");
