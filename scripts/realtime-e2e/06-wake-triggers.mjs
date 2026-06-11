/**
 * Scenario 06 — wake triggers for side-by-side windows.
 *
 * Two side-by-side windows are both permanently "visible", so switching
 * between them never fires visibilitychange. This scenario verifies:
 *   (1) a window FOCUS event repairs missed updates in ONE switch, even on
 *       a silently-dead stream (the user's "I have to switch several times
 *       to wake it up" report);
 *   (2) a focus arriving while the stream has been silent past the
 *       staleness window forces an immediate reconnect (no 70s watchdog
 *       wait);
 *   (3) a remote update deferred only by typing recency self-applies once
 *       the tab goes quiescent (deferred re-evaluation) — no banner left
 *       behind, no user interaction needed.
 */
import * as h from "./helpers.mjs";

h.requireConfig();
const b = await h.launch();
const A = await h.newWindow(b);
const B = await h.newWindow(b);

// Shared draft: A creates it, B hydrates the same tab set.
await A.page.locator('button:has-text("Open Console")').click();
await A.page.waitForTimeout(800);
const tabId = Object.keys(await h.getTabs(A.page))[0];
await h.clickEditorAndType(A.page, tabId, "select 1 -- wake base");
await A.page.waitForTimeout(3500);
const storeRaw = await A.page.evaluate(() =>
  localStorage.getItem("console-store"),
);
await B.page.evaluate(raw => localStorage.setItem("console-store", raw), storeRaw);
await B.page.reload({ waitUntil: "domcontentloaded" });
await B.page.waitForTimeout(3000);

// ---- (1) dead stream + ONE focus event = converged content ---------------
await h.killRealtimeSilently(B.page);
await h.clickEditorAndType(A.page, tabId, "\n-- A edit while B dead");
await A.page.waitForTimeout(3500); // autosave + (lost) poke

let bText = await h.getEditorTextByTabId(B.page, tabId);
h.check(
  "B is stale while its stream is silently dead (precondition)",
  !bText?.includes("A edit while B dead"),
  bText,
);

await B.page.evaluate(() => window.dispatchEvent(new Event("focus")));
const afterFocus = await h.waitFor(
  async () => {
    const text = await h.getEditorTextByTabId(B.page, tabId);
    return text?.includes("A edit while B dead") ? text : null;
  },
  { timeoutMs: 8_000 },
);
h.check(
  "ONE focus event repaired B's content (no repeated switching needed)",
  Boolean(afterFocus),
  afterFocus,
);

// ---- (2) focus during a stale-silent stream forces reconnect -------------
// The stream is still the dead one (focus only reconciled). Backdate
// activity by waiting is too slow (40s), so verify the mechanism: count
// EventSource instances, dispatch focus after the staleness window via a
// clock-independent check — here we simply wait out the watchdog-free
// window using the wake path: kill again, wait 45s (> WAKE_STALE_MS),
// then focus and expect a NEW EventSource within a couple of seconds
// (the 70s watchdog alone could not have fired yet... it requires 70s).
const esBefore = await B.page.evaluate(() => window.__esInstances.length);
await B.page.waitForTimeout(45_000);
await B.page.evaluate(() => window.dispatchEvent(new Event("focus")));
const reconnected = await h.waitFor(
  async () =>
    (await B.page.evaluate(() => window.__esInstances.length)) > esBefore,
  { timeoutMs: 5_000 },
);
h.check(
  "focus on a silent-past-threshold stream reconnected immediately (<5s, not the 70s watchdog)",
  Boolean(reconnected),
  { esBefore },
);

// ---- (3) typing-recency deferral self-applies on quiescence ---------------
// B types a char and immediately undoes it (recency marked, content back to
// base, autosave hash-skips). A edits inside B's 3s recency window → B
// defers to the banner; after the window passes, the deferred re-sync must
// apply and clear the banner with NO user interaction.
await B.page.waitForTimeout(2000); // let the reconnect's sync settle
await h.clickEditorAndType(B.page, tabId, "x", { append: true });
await B.page.keyboard.press("Backspace");
await h.clickEditorAndType(A.page, tabId, "\n-- A edit during B recency");
const autoApplied = await h.waitFor(
  async () => {
    const text = await h.getEditorTextByTabId(B.page, tabId);
    const tabs = await h.getTabs(B.page);
    return text?.includes("A edit during B recency") &&
      !tabs[tabId]?.remoteUpdate
      ? text
      : null;
  },
  { timeoutMs: 15_000 },
);
h.check(
  "update deferred by typing recency self-applied once B went quiescent (banner cleared)",
  Boolean(autoApplied),
  autoApplied,
);

await b.close();
h.finish("06-wake-triggers");
