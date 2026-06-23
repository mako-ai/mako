/**
 * Repro — "agent create shows instantly, agent modify does not until refresh".
 *
 * Models the user's exact report:
 *   1. user asks agent to CREATE a console  -> tab opens instantly
 *   2. realtime SSE silently dies (NAT/proxy half-close, frozen tab, ...)
 *   3. user asks agent to MODIFY the same console -> NOTHING happens in the
 *      editor (create rode the resumable chat stream; modify relies ONLY on
 *      the realtime poke, which is now dead)
 *   4. reload the page -> the edit finally shows (onopen revision sync)
 *
 * Both turns are driven through the BROWSER chat UI (uiAgentChat), so create
 * uses the in-band chat-stream open path and modify uses the realtime poke
 * path — the asymmetry under test.
 */
import * as h from "./helpers.mjs";

h.requireConfig();
const b = await h.launch();
const A = await h.newWindow(b);

// Turn 1: CREATE (realtime SSE still alive)
await h.uiAgentChat(A.page, [
  {
    tool: "create_console",
    input: {
      title: "ModifyRepro",
      content: "SELECT 1",
      connectionId: h.CONN_ID,
    },
  },
]);
const created = await h.waitFor(
  async () => {
    const tabs = await h.getTabs(A.page);
    return Object.values(tabs).find(t => t.title === "ModifyRepro");
  },
  { timeoutMs: 20_000 },
);
h.check("create_console opened the tab in the chat's window", Boolean(created));
const id = created?.id;
if (!id) {
  await b.close();
  h.finish("99-modify-dead-sse-repro");
  process.exit(0);
}
const createdText = await h.getEditorTextByTabId(A.page, id);
h.check("editor shows the created content (SELECT 1)", createdText === "SELECT 1", createdText);

// Kill the realtime SSE silently (no error event — looks alive to the store).
await h.killRealtimeSilently(A.page);
await A.page.waitForTimeout(500);

// Turn 2: MODIFY (realtime SSE is dead; chat stream still works)
await h.uiAgentChat(A.page, [
  {
    tool: "modify_console",
    input: { consoleId: id, action: "replace", content: "SELECT 2" },
  },
]);

// Give the agent turn time to finish + any (dead) poke to NOT arrive.
await A.page.waitForTimeout(10_000);

// Server ground truth: the modify committed.
const srv = await h.apiGetConsole(id);
h.check("server draft has the modified content (SELECT 2)", srv.content === "SELECT 2", srv.content);

// Client: did the agent edit surface LIVE (no refresh)? The edit is shown as
// a Monaco Accept/Reject diff, so detect either the diff banner or the new
// content anywhere in the tab DOM (getValue() returns the baseline in a diff).
// PRE-FIX: stays stale (nothing) until refresh. POST-FIX: surfaces live via
// the resumable chat-stream reconciliation even though the SSE poke is dead.
const surfacedLive = await h.waitFor(
  async () => {
    const banner =
      (await A.page
        .locator(`[data-mako-tab-id="${id}"]`)
        .locator("text=/AI suggested changes/i")
        .count()
        .catch(() => 0)) > 0;
    const newContent =
      (await A.page
        .locator(`[data-mako-tab-id="${id}"]`)
        .locator("text=/SELECT 2/")
        .count()
        .catch(() => 0)) > 0;
    return banner || newContent ? true : null;
  },
  { timeoutMs: 6000, stepMs: 1000 },
);
const editorAfterModify = await h.getEditorTextByTabId(A.page, id);
const storeAfterModify = (await h.getTabs(A.page))[id]?.content;
h.check(
  "agent modify surfaces LIVE with a dead SSE (no refresh needed)",
  Boolean(surfacedLive),
  { surfacedLive, editor: editorAfterModify, store: storeAfterModify },
);

await h.screenshot(A.page, "99-after-modify-dead-sse");

// Now refresh — the user's workaround. The agent edit surfaces as a Monaco
// Accept/Reject diff, so look for the new content anywhere in the tab DOM
// (the diff's modified side) rather than via the buffer getValue().
await A.page.reload({ waitUntil: "domcontentloaded" });
await A.page.waitForTimeout(5000);
const afterReload = await h.waitFor(
  async () => {
    const inBuffer = (await h.getEditorTextByTabId(A.page, id))?.includes(
      "SELECT 2",
    );
    const inDom =
      (
        await A.page
          .locator(`[data-mako-tab-id="${id}"]`)
          .locator("text=/SELECT 2|AI suggested changes/i")
          .count()
          .catch(() => 0)
      ) > 0;
    return inBuffer || inDom ? true : null;
  },
  { timeoutMs: 15_000, stepMs: 1000 },
);
h.check(
  "after a manual page refresh the modify is visible",
  Boolean(afterReload),
  afterReload,
);
await h.screenshot(A.page, "99-after-reload");

await b.close();
h.finish("99-modify-dead-sse-repro");
