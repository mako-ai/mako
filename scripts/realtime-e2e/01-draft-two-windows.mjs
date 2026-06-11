/**
 * Scenario 01 — draft console, two windows of the same user.
 *
 * Window A creates a draft and types; window B (simulated same-profile second
 * window via localStorage copy + reload) must:
 *   - NOT bump the server draftRevision just by opening the draft
 *     (mount-resave regression);
 *   - receive A's subsequent edits LIVE in its Monaco buffer;
 * and A — the only typist — must never see a conflict banner or lose edits.
 */
import * as h from "./helpers.mjs";

h.requireConfig();
const b = await h.launch();
const A = await h.newWindow(b);
const B = await h.newWindow(b);

// A: open a console and type (autosave creates the server draft)
await A.page.locator('button:has-text("Open Console")').click();
await A.page.waitForTimeout(800);
const tabId = Object.keys(await h.getTabs(A.page))[0];
await h.clickEditorAndType(A.page, tabId, "select 1 -- from window A");
await A.page.waitForTimeout(3500); // autosave debounce + margin

const srv1 = await h.apiGetConsole(tabId);
h.check("A's draft autosaved", srv1.success && srv1.draftRevision >= 1, {
  rev: srv1.draftRevision,
});

// B: hydrate the same tabs (same-profile second window) and reload
const storeRaw = await A.page.evaluate(() =>
  localStorage.getItem("console-store"),
);
await B.page.evaluate(raw => localStorage.setItem("console-store", raw), storeRaw);
await B.page.reload({ waitUntil: "domcontentloaded" });
await B.page.waitForTimeout(3000);

const srv2 = await h.apiGetConsole(tabId);
h.check(
  "opening the draft in B does NOT bump draftRevision (no mount-resave)",
  srv2.draftRevision === srv1.draftRevision,
  { before: srv1.draftRevision, after: srv2.draftRevision },
);

// A types more — B must converge live
await h.clickEditorAndType(A.page, tabId, "\n-- second line from A");
const bEditor = await h.waitFor(
  async () => {
    const text = await h.getEditorTextByTabId(B.page, tabId);
    return text?.includes("second line from A") ? text : null;
  },
  { timeoutMs: 12_000 },
);
h.check("B's Monaco received A's edit live", Boolean(bEditor), bEditor);

const aTabs = await h.getTabs(A.page);
h.check(
  "A (the only typist) has no conflict banner",
  !aTabs[tabId]?.remoteUpdate,
  aTabs[tabId]?.remoteUpdate ?? "none",
);

const srv3 = await h.apiGetConsole(tabId);
h.check(
  "server persisted A's full content",
  srv3.content?.includes("second line from A"),
  JSON.stringify(srv3.content),
);

await b.close();
h.finish("01-draft-two-windows");
