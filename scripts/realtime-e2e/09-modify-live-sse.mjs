/**
 * Scenario 09 — modify in a SECOND turn with live workspace SSE.
 */
import * as h from "./helpers.mjs";

h.requireConfig();
const b = await h.launch();
const A = await h.newWindow(b);
const chat = await h.getActiveChat(A.page);

const uniqueContent = `SELECT 'live-sse-${Date.now()}' AS marker`;

await h.apiAgentChat(chat.chatId, [
  {
    tool: "create_console",
    input: {
      title: h.uniqueName("LiveSse"),
      content: "SELECT 1",
      connectionId: h.CONN_ID,
    },
  },
]);
const created = await h.waitFor(async () => {
  const tabs = await h.getTabs(A.page);
  return Object.values(tabs).find(t => (t.title || "").startsWith("LiveSse"));
});
const id = created?.id;
h.check("create opened a tab", Boolean(id));

await h.apiAgentChat(chat.chatId, [
  {
    tool: "modify_console",
    input: { consoleId: id, action: "replace", content: uniqueContent },
  },
]);

const editorText = await h.waitFor(
  async () => {
    const text = await h.getEditorTextByTabId(A.page, id);
    return text?.includes(uniqueContent) ? text : null;
  },
  { timeoutMs: 12_000 },
);
h.check(
  "Monaco shows modified query with live SSE",
  Boolean(editorText),
  editorText,
);

await b.close();
h.finish("09-modify-live-sse");
