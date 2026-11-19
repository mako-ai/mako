// 2.30.3: a 1-day preset reads "Today" in every language, and labels.lastDays reaches preset names.
import { test } from "node:test";
import assert from "node:assert/strict";
import { STRINGS, localeStrings } from "./locale.js";

test("lastDays(1) reads Today in all 7 languages; other counts keep their wording", () => {
  const want = { en: "Today", fr: "Aujourd'hui", de: "Heute", it: "Oggi", es: "Hoy", pl: "Dzisiaj", pt: "Hoje" };
  for (const [lang, word] of Object.entries(want)) {
    assert.equal(STRINGS[lang].period.lastDays(1), word, lang);
    assert.notEqual(STRINGS[lang].period.lastDays(28), word, lang);
  }
  assert.equal(STRINGS.en.period.lastDays(28), "Last 28 days");
  assert.equal(STRINGS.fr.period.lastDays(7), "7 derniers jours");
});

test("presetLabel and periodLabel honour labels.lastDays", async t => {
  let P;
  try { P = await import("./components/period.ts"); } catch (e) { t.skip("TypeScript loader not available here: " + e.message); return; }
  const labels = { lastDays: n => (n === 1 ? "Aujourd'hui seulement" : `${n} j`) };
  assert.equal(P.presetLabel("1d", "fr-FR", labels), "Aujourd'hui seulement");
  assert.equal(P.presetLabel("28d", "fr-FR", labels), "28 j");
  const p = P.presetPeriod("28d", "2026-11-19");
  assert.equal(P.periodLabel(p, "fr-FR", labels), "28 j");
  assert.equal(P.periodLabel(p, "fr-FR"), "28 derniers jours");
});
