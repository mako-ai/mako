/**
 * Scenario 03 — every agent console modality against an attached window.
 *
 *   - create_console → tab appears in the chat's window;
 *   - modify_console + run_console in one turn → Monaco shows the NEW query
 *     (not a stale buffer) AND the results render;
 *   - set_console_connection → tab metadata follows;
 *   - user types after the agent → the edit persists (autosave alive) and the
 *     next agent patch lands on top of it (no lost updates in either
 *     direction);
 *   - open_console → activates the tab.
 */
import * as h from "./helpers.mjs";

h.requireConfig();
const b = await h.launch();
const A = await h.newWindow(b);
const chat = await h.getActiveChat(A.page);

// (a) create
await h.apiAgentChat(chat.chatId, [
  {
    tool: "create_console",
    input: {
      title: "AgentScenario",
      content: "db.users.find({})",
      connectionId: h.CONN_ID,
    },
  },
]);
const created = await h.waitFor(async () => {
  const tabs = await h.getTabs(A.page);
  return Object.values(tabs).find(t => t.title === "AgentScenario");
});
h.check("create_console opened a tab in the attached window", Boolean(created));
const id = created?.id;

// (b) modify + run in one turn
await h.apiAgentChat(chat.chatId, [
  {
    tool: "modify_console",
    input: {
      consoleId: id,
      action: "replace",
      content: "db.users.find({ age: { $gt: 30 } })",
    },
  },
  { tool: "run_console", input: { consoleId: id } },
]);
const editorAfterRun = await h.waitFor(
  async () => {
    const text = await h.getEditorTextByTabId(A.page, id);
    return text?.includes("$gt") ? text : null;
  },
  { timeoutMs: 12_000 },
);
h.check(
  "Monaco shows the agent's NEW query after modify+run",
  Boolean(editorAfterRun),
  editorAfterRun,
);
const srvB = await h.apiGetConsole(id);
const tabB = (await h.getTabs(A.page))[id];
h.check(
  "store revision matches the server after the run",
  tabB?.draftRevision === srvB.draftRevision,
  { store: tabB?.draftRevision, server: srvB.draftRevision },
);
h.check(
  "the run kept the tab a DRAFT (autosave must stay alive)",
  tabB?.isSaved === false,
  { isSaved: tabB?.isSaved },
);
const results = await A.page
  .locator(`[data-mako-tab-id="${id}"]`)
  .locator("text=/Alice|Carol/i")
  .allTextContents()
  .catch(() => []);
h.check("run results rendered in the results panel", results.length > 0, results);

// (c) user types after the agent → must persist; then agent appends on top
await h.clickEditorAndType(A.page, id, "\n// user note");
await A.page.waitForTimeout(3500); // autosave
const srvC = await h.apiGetConsole(id);
h.check(
  "user's post-agent edit persisted (autosave alive)",
  srvC.content?.includes("user note"),
  JSON.stringify(srvC.content),
);
await h.apiAgentChat(chat.chatId, [
  {
    tool: "modify_console",
    input: { consoleId: id, action: "append", content: "\n// agent appended" },
  },
]);
const converged = await h.waitFor(
  async () => {
    const text = await h.getEditorTextByTabId(A.page, id);
    return text?.includes("user note") && text?.includes("agent appended")
      ? text
      : null;
  },
  { timeoutMs: 12_000 },
);
h.check(
  "agent append landed ON TOP of the user edit and reached Monaco",
  Boolean(converged),
  converged,
);

// (d) set_console_connection (re-attach to the same connection but with an
// explicit databaseName) → tab metadata follows
await h.apiAgentChat(chat.chatId, [
  {
    tool: "set_console_connection",
    input: { consoleId: id, connectionId: h.CONN_ID, databaseName: "sampledb" },
  },
]);
const tabD = await h.waitFor(async () => {
  const t = (await h.getTabs(A.page))[id];
  return t?.databaseName === "sampledb" ? t : null;
});
h.check(
  "set_console_connection propagated to the tab",
  Boolean(tabD),
  tabD && { databaseName: tabD.databaseName },
);

// (e) open_console for an existing console → activates the tab
await h.apiAgentChat(chat.chatId, [
  { tool: "open_console", input: { consoleId: id } },
]);
const active = await h.waitFor(async () => {
  const s = await h.getConsoleStore(A.page);
  return s?.activeTabId === id;
});
h.check("open_console activated the tab", Boolean(active));

await b.close();
h.finish("03-agent-modalities");
