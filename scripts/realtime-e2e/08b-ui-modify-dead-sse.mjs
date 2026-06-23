/**
 * Scenario 08b — modify through the browser chat UI with workspace SSE dead.
 *
 * The chat stream is resumable and separate from workspace SSE, so in-band
 * modify_console handling should still pull the authoritative copy.
 */
import * as h from "./helpers.mjs";

h.requireConfig();
const b = await h.launch();
const A = await h.newWindow(b);
const chat = await h.getActiveChat(A.page);

const uniqueContent = `SELECT 'ui-dead-sse-${Date.now()}' AS marker`;

await h.uiAgentChat(A.page, [
  {
    tool: "create_console",
    input: {
      title: h.uniqueName("UiDeadSse"),
      content: "SELECT 1",
      connectionId: h.CONN_ID,
    },
  },
]);
const created = await h.waitFor(async () => {
  const tabs = await h.getTabs(A.page);
  return Object.values(tabs).find(t => (t.title || "").startsWith("UiDeadSse"));
});
const id = created?.id;
h.check("create opened a tab via UI chat", Boolean(id));

await h.killRealtimeSilently(A.page);
await h.waitMs(300);

await h.uiAgentChat(A.page, [
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
  { timeoutMs: 20_000 },
);
h.check(
  "in-band modify reaches Monaco even with dead workspace SSE",
  Boolean(editorText),
  editorText,
);

await b.close();
h.finish("08b-ui-modify-dead-sse");
