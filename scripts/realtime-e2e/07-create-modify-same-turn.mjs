/**
 * Scenario 07 — create_console + modify_console in ONE agent turn WITH a
 * delayed content fetch to force the poke-before-tab-open race.
 *
 * Without post-open revisions-sync the client sticks on create-time content.
 */
import * as h from "./helpers.mjs";

h.requireConfig();
const b = await h.launch();
const A = await h.newWindow(b);
const chat = await h.getActiveChat(A.page);

const uniqueContent = `SELECT 'race-${Date.now()}' AS marker`;

// Slow the initial openConsoleFromServer fetch so modify's poke lands while
// the tab is still absent from the store (the deterministic race).
await A.page.route("**/consoles/content?id=*", async route => {
  await new Promise(r => setTimeout(r, 1500));
  await route.continue();
});

await h.apiAgentChat(chat.chatId, [
  {
    tool: "create_console",
    input: {
      title: h.uniqueName("RaceCreate"),
      content: "SELECT 1",
      connectionId: h.CONN_ID,
    },
  },
  {
    tool: "modify_console",
    input: {
      consoleId: "$prev.consoleId",
      action: "replace",
      content: uniqueContent,
    },
  },
]);

const created = await h.waitFor(async () => {
  const tabs = await h.getTabs(A.page);
  return Object.values(tabs).find(t =>
    (t.title || "").startsWith("RaceCreate"),
  );
});
h.check("create+modify opened a tab", Boolean(created));
const id = created?.id;

// Give sync a moment without requiring a page refresh.
await h.waitMs(500);

const editorText = await h.getEditorTextByTabId(A.page, id);
const storeContent = id ? (await h.getTabs(A.page))[id]?.content : null;
const srv = id ? await h.apiGetConsole(id) : null;

h.check(
  "Monaco shows the modified query without a page refresh",
  Boolean(editorText?.includes(uniqueContent)),
  editorText,
);
h.check(
  "store content matches the server (not stuck on SELECT 1)",
  storeContent?.includes(uniqueContent),
  storeContent,
);
h.check(
  "server holds the modified content",
  srv?.content?.includes(uniqueContent),
  srv?.content,
);

await b.close();
h.finish("07-create-modify-same-turn");
