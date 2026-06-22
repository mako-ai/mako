/**
 * Scenario 02 — saved console, two windows.
 *
 *   - A saves a console; B opens it from the tree.
 *   - A edits + explicit-saves → B (clean) live-applies.
 *   - B types (unsaved edits); A saves again → B gets the banner, no clobber.
 *   - B (stale + dirty) hits Cmd+S → version-conflict dialog, never a silent
 *     overwrite; server keeps A's copy until B chooses.
 */
import * as h from "./helpers.mjs";

h.requireConfig();
const b = await h.launch();
const A = await h.newWindow(b);
const name = h.uniqueName("SavedSync");

// A: create, type, save via the first-time save dialog
await A.page.locator('button:has-text("Open Console")').click();
await A.page.waitForTimeout(800);
const tabId = Object.keys(await h.getTabs(A.page))[0];
await h.clickEditorAndType(A.page, tabId, "select 2 -- saved v1");
await A.page.waitForTimeout(500);
await A.page.keyboard.press("Control+s");
await A.page.waitForTimeout(1200);
await A.page.locator('div[role="dialog"] input').first().fill(name);
await A.page
  .locator('div[role="dialog"] button:has-text("Save")')
  .last()
  .click();
await A.page.waitForTimeout(2500);
const aTab = (await h.getTabs(A.page))[tabId];
h.check("A's console saved", aTab?.isSaved === true, { filePath: aTab?.filePath });

// B: open from the consoles tree
const B = await h.newWindow(b);
await B.page.mouse.click(17, 76); // consoles explorer rail icon
await B.page.waitForTimeout(800);
await B.page.locator(`text=${name}`).first().click();
await B.page.waitForTimeout(2000);
h.check("B opened it from the tree", Boolean((await h.getTabs(B.page))[tabId]));

// A edits + saves (comment dialog) → B clean must live-apply
await h.clickEditorAndType(A.page, tabId, "\n-- A edit 1");
await A.page.keyboard.press("Control+s");
await A.page.waitForTimeout(1500);
const save1 = A.page.locator('div[role="dialog"] button:has-text("Save")').last();
if (await save1.isVisible().catch(() => false)) await save1.click();
const bGot = await h.waitFor(
  async () => {
    const text = await h.getEditorTextByTabId(B.page, tabId);
    return text?.includes("A edit 1") ? text : null;
  },
  { timeoutMs: 12_000 },
);
h.check("B (clean) live-applied A's explicit save", Boolean(bGot), bGot);

// B types; A saves again → B must get the banner, content untouched
await h.clickEditorAndType(B.page, tabId, "\n-- B local edit");
await B.page.waitForTimeout(500);
await h.clickEditorAndType(A.page, tabId, "\n-- A edit 2");
await A.page.keyboard.press("Control+s");
await A.page.waitForTimeout(1500);
const save2 = A.page.locator('div[role="dialog"] button:has-text("Save")').last();
if (await save2.isVisible().catch(() => false)) await save2.click();
await A.page.waitForTimeout(3500);

const bTabs = await h.getTabs(B.page);
const bEditor = await h.getEditorTextByTabId(B.page, tabId);
h.check(
  "B (dirty) got the banner instead of a silent replace",
  Boolean(bTabs[tabId]?.remoteUpdate),
  bTabs[tabId]?.remoteUpdate,
);
h.check(
  "B's local edit was NOT clobbered",
  bEditor?.includes("B local edit") && !bEditor?.includes("A edit 2"),
  bEditor,
);

// B (stale + dirty) saves → conflict dialog; server must keep A's copy
await B.page
  .locator(`[data-mako-tab-id="${tabId}"] .monaco-editor`)
  .first()
  .click();
await B.page.keyboard.press("Control+s");
await B.page.waitForTimeout(1500);
const bSave = B.page.locator('div[role="dialog"] button:has-text("Save")').last();
if (await bSave.isVisible().catch(() => false)) await bSave.click();
await B.page.waitForTimeout(2500);
const dialogText = (
  await B.page.locator('div[role="dialog"]').allTextContents().catch(() => [])
).join(" ");
h.check(
  "B's stale save hit the version-conflict dialog",
  dialogText.includes("Console Was Modified"),
  dialogText.slice(0, 120),
);
const srv = await h.apiGetConsole(tabId);
h.check(
  "server still has A's copy (no silent overwrite)",
  srv.content?.includes("A edit 2") && !srv.content?.includes("B local edit"),
  JSON.stringify(srv.content),
);

await b.close();
h.finish("02-saved-console");
