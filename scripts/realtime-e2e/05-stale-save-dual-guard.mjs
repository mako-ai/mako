/**
 * Scenario 05 — stale-window Cmd+S vs agent edits (dual save guard).
 *
 * Agent modify_console bumps draftRevision but NOT version. A window holding
 * unsaved edits from before the agent's change must get the version-conflict
 * dialog on Cmd+S — previously the version-only guard passed and the save
 * silently reverted the agent's edit.
 */
import * as h from "./helpers.mjs";

h.requireConfig();
const b = await h.launch();
const A = await h.newWindow(b);
const name = h.uniqueName("DualGuard");

// A: create + save
await A.page.locator('button:has-text("Open Console")').click();
await A.page.waitForTimeout(800);
const tabId = Object.keys(await h.getTabs(A.page))[0];
await h.clickEditorAndType(A.page, tabId, "select 10 -- base");
await A.page.waitForTimeout(500);
await A.page.keyboard.press("Control+s");
await A.page.waitForTimeout(1200);
await A.page.locator('div[role="dialog"] input').first().fill(name);
await A.page
  .locator('div[role="dialog"] button:has-text("Save")')
  .last()
  .click();
await A.page.waitForTimeout(2500);

// B: open from tree, type an UNSAVED local edit
const B = await h.newWindow(b);
await B.page.mouse.click(17, 76);
await B.page.waitForTimeout(800);
await B.page.locator(`text=${name}`).first().click();
await B.page.waitForTimeout(2000);
await h.clickEditorAndType(B.page, tabId, "\n-- B local unsaved edit");
await B.page.waitForTimeout(1000);

// Agent rewrites the console (draftRevision bump only)
const chat = await h.getActiveChat(A.page);
await h.apiAgentChat(chat.chatId, [
  {
    tool: "modify_console",
    input: { consoleId: tabId, action: "replace", content: "select 99 -- AGENT EDIT" },
  },
]);
await B.page.waitForTimeout(4000);
h.check(
  "B (holding unsaved edits) got the banner for the agent edit",
  Boolean((await h.getTabs(B.page))[tabId]?.remoteUpdate),
);

// B saves while stale → must hit the conflict dialog, not silently revert
await B.page
  .locator(`[data-mako-tab-id="${tabId}"] .monaco-editor`)
  .first()
  .click();
await B.page.keyboard.press("Control+s");
await B.page.waitForTimeout(1500);
const commentSave = B.page
  .locator('div[role="dialog"] button:has-text("Save")')
  .last();
if (await commentSave.isVisible().catch(() => false)) await commentSave.click();
await B.page.waitForTimeout(2500);
const dialogText = (
  await B.page.locator('div[role="dialog"]').allTextContents().catch(() => [])
).join(" ");
h.check(
  "stale Cmd+S hit the version-conflict dialog",
  dialogText.includes("Console Was Modified"),
  dialogText.slice(0, 120),
);
const srv = await h.apiGetConsole(tabId);
h.check(
  "server kept the AGENT edit (no silent revert)",
  srv.content?.includes("AGENT EDIT") && !srv.content?.includes("B local"),
  JSON.stringify(srv.content),
);

// Resolve with "Discard Mine & Load Latest" → B converges
const loadLatest = B.page.locator(
  'button:has-text("Discard Mine & Load Latest")',
);
if (await loadLatest.isVisible().catch(() => false)) {
  await loadLatest.click();
  const converged = await h.waitFor(async () => {
    const text = await h.getEditorTextByTabId(B.page, tabId);
    return text?.includes("AGENT EDIT") ? text : null;
  });
  h.check("B converged after Load Latest", Boolean(converged), converged);
}

await b.close();
h.finish("05-stale-save-dual-guard");
