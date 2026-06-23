/**
 * Scenario 08 — modify in a SECOND turn while workspace SSE is dead.
 *
 * Simulates the user report: create opens instantly, then a later modify
 * doesn't reach the client until refresh (missed poke + no in-band path).
 */
import * as h from "./helpers.mjs";

h.requireConfig();
const b = await h.launch();
const A = await h.newWindow(b);
const chat = await h.getActiveChat(A.page);

const uniqueContent = `SELECT 'dead-sse-${Date.now()}' AS marker`;

// (a) create — tab opens via chat.ui-intent
await h.apiAgentChat(chat.chatId, [
  {
    tool: "create_console",
    input: {
      title: h.uniqueName("DeadSse"),
      content: "SELECT 1",
      connectionId: h.CONN_ID,
    },
  },
]);
const created = await h.waitFor(async () => {
  const tabs = await h.getTabs(A.page);
  return Object.values(tabs).find(t => (t.title || "").startsWith("DeadSse"));
});
h.check("create opened a tab", Boolean(created));
const id = created?.id;

// Kill workspace SSE silently — pokes won't arrive (no error event).
await h.killRealtimeSilently(A.page);
await h.waitMs(300);

// (b) modify in a separate turn — server writes, client never poked
await h.apiAgentChat(chat.chatId, [
  {
    tool: "modify_console",
    input: {
      consoleId: id,
      action: "replace",
      content: uniqueContent,
    },
  },
]);

await h.waitMs(800);

const editorText = await h.getEditorTextByTabId(A.page, id);
const srv = await h.apiGetConsole(id);

h.check(
  "Monaco shows the modified query without refresh (needs in-band or wake)",
  Boolean(editorText?.includes(uniqueContent)),
  editorText,
);
h.check(
  "server holds the modified content",
  srv?.content?.includes(uniqueContent),
  srv?.content,
);

await b.close();
h.finish("08-modify-dead-sse");
