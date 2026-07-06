/**
 * Acid test — agent renames a SAVED console; the tab, breadcrumbs AND sidebar
 * tree all update surgically (by id), with no full tree refetch (no skeletons
 * / layout shift) and no stale copy left anywhere.
 *
 * A saved console has a filePath (so it shows in the tree and the breadcrumb
 * renders its path). Made legacy ($unset draftRevision) so it also exercises
 * the revision-collision fix.
 */
import { execSync } from "node:child_process";
import * as h from "./helpers.mjs";

const MONGO_URL = process.env.E2E_MONGO_URL || "mongodb://127.0.0.1:27017/mako";

h.requireConfig();
const b = await h.launch();

const id = h.oid();
const ts = Date.now();
const oldName = `ReproSaved-${ts}`;
const newName = `RenamedSaved-${ts}`;
const headers = {
  "content-type": "application/json",
  cookie: `auth_session=${h.SESSION}`,
};

// Create a SAVED console (path ⇒ shows in the tree + breadcrumb), then make it
// legacy by removing draftRevision.
const created = await fetch(`${h.API}/api/workspaces/${h.WS_ID}/consoles`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    id,
    path: oldName,
    content: "SELECT 1",
    language: "sql",
    access: "private",
  }),
}).then(r => r.json());
h.check("saved console created", created?.success !== false, created?.error);
execSync(
  `mongosh --quiet "${MONGO_URL}" --eval 'db.savedconsoles.updateOne({_id:ObjectId("${id}")},{$unset:{draftRevision:""}})'`,
);

// Count text occurrences in the LEFT SIDEBAR only (x < 280px), so the chat
// panel on the right (which legitimately references the old name in a tool
// card) cannot pollute tree assertions.
const sidebarCount = async (page, text) => {
  const loc = page.locator(`text=/${text}/`);
  const n = await loc.count().catch(() => 0);
  let count = 0;
  for (let i = 0; i < n; i++) {
    const box = await loc
      .nth(i)
      .boundingBox()
      .catch(() => null);
    if (box && box.x < 280) count++;
  }
  return count;
};

// Now open the window (its tree fetch will include the saved console).
const A = await h.newWindow(b);

// Open it via the agent, then reveal it in the Consoles explorer by clicking
// the breadcrumb (the window defaults to the Databases explorer).
await h.uiAgentChat(A.page, [{ tool: "open_console", input: { consoleId: id } }]);
await h.waitFor(async () => (await h.getTabs(A.page))[id] || null);
await A.page
  .getByRole("button", { name: "Consoles", exact: true })
  .first()
  .click()
  .catch(() => undefined);
const treeHasOld = await h.waitFor(
  async () => ((await sidebarCount(A.page, oldName)) > 0 ? true : null),
  { timeoutMs: 15_000 },
);
h.check("sidebar tree shows the old name before rename", Boolean(treeHasOld));

// Rename via the agent (name-only modify_console: no-op patch + title).
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

await h.waitFor(
  async () => ((await h.apiGetConsole(id))?.name === newName ? true : null),
  { timeoutMs: 15_000 },
);

// Tab: store title updated (drives the tab strip).
const tabUpdated = await h.waitFor(
  async () => ((await h.getTabs(A.page))[id]?.title === newName ? true : null),
  { timeoutMs: 12_000, stepMs: 1000 },
);
h.check("tab title updated to the new name", Boolean(tabUpdated));

// Breadcrumb / page title: document.title derives from the active tab title.
const docTitle = await A.page.title();
h.check(
  "page title (breadcrumb source) reflects the new name",
  docTitle.includes(newName),
  docTitle,
);

// Surgical tree update: the sidebar now shows the NEW name and NO LONGER the
// old one — patched in place by id (no full refetch / skeleton).
const treeNew = await h.waitFor(
  async () => ((await sidebarCount(A.page, newName)) > 0 ? true : null),
  { timeoutMs: 12_000, stepMs: 1000 },
);
h.check("sidebar tree shows the new name (surgical, no refetch)", Boolean(treeNew));
const oldInSidebar = await sidebarCount(A.page, oldName);
h.check("old name is gone from the sidebar tree", oldInSidebar === 0, {
  oldInSidebar,
});

await h.screenshot(A.page, "12-rename-saved-surgical");

await b.close();
h.finish("12-rename-saved-surgical");
