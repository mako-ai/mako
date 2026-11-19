// 2.29: one strings table (locale.js) behind `locale` + `labels` on
// PeriodPicker, FilterBar, Combobox, FilterMenu, MultiSelect, FilterItems and
// DataTable, and rolling `presets` on PeriodPicker. The table checks always
// run; the render tests bundle the TSX with esbuild and skip without esbuild,
// react, radix-ui or jsdom (the publish job runs `node --test` with no install).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { LOCALES, STRINGS, localeLang, localeStrings } from "./locale.js";

const P = await import("./components/period.ts");

test("locale: the language part picks the strings, anything else is English", () => {
  assert.deepEqual(LOCALES, ["en", "fr", "de", "it", "es", "pl", "pt"]);
  assert.equal(localeLang("fr-CH"), "fr");
  assert.equal(localeLang("de_CH"), "de");
  assert.equal(localeLang("PT-br"), "pt");
  assert.equal(localeLang("nl-NL"), "en");
  assert.equal(localeLang(undefined), "en");
  assert.equal(localeStrings("filterBar"), STRINGS.en.filterBar, "no locale, no labels: the English object itself");
  assert.deepEqual(localeStrings("filterBar", "fr-CH", { done: "OK" }), { ...STRINGS.fr.filterBar, done: "OK" }, "labels sit on top of the locale");
});

test("locale: every language has every key, with the same kind of value", () => {
  for (const lang of LOCALES) {
    for (const section of ["period", "filterBar", "filter", "combobox", "refresh", "freshness", ...(lang === "en" ? [] : ["dataTable"])]) {
      const ref = section === "dataTable" ? STRINGS.fr.dataTable : STRINGS.en[section];
      const got = STRINGS[lang][section];
      assert.deepEqual(Object.keys(got).sort(), Object.keys(ref).sort(), `${lang}.${section} keys`);
      for (const k of Object.keys(ref)) assert.equal(typeof got[k], typeof ref[k], `${lang}.${section}.${k}`);
    }
  }
  assert.equal(STRINGS.en.dataTable, undefined, "English DataTable texts stay DATA_TABLE_LABELS");
});

test("locale: the d.ts lists every key of the table", () => {
  const dts = readFileSync(new URL("./locale.d.ts", import.meta.url), "utf8");
  const block = name => dts.slice(dts.indexOf(`interface ${name}`), dts.indexOf("\n}", dts.indexOf(`interface ${name}`)));
  const map = { period: "PeriodPickerLabels", filterBar: "FilterBarLabels", filter: "FilterLabels", combobox: "ComboboxLabels" };
  for (const [section, name] of Object.entries({ ...map, refresh: "RefreshLabels", freshness: "FreshnessLabels" })) {
    for (const k of Object.keys(STRINGS.en[section])) assert.match(block(name), new RegExp(`\\n  ${k}:`), `${name}.${k}`);
  }
  for (const k of Object.keys(STRINGS.fr.dataTable)) assert.match(block("DataTableLocaleStrings"), new RegExp(`\\n  ${k}:`), `DataTableLocaleStrings.${k}`);
  const readme = readFileSync(new URL("./README.md", import.meta.url), "utf8");
  for (const section of Object.keys(map)) {
    for (const k of Object.keys(STRINGS.en[section])) assert.match(readme, new RegExp("`" + k + "[`(]"), `README names ${section}.${k}`);
  }
});

test("periodLabel with a locale: Intl month names, the English layout, a dot after German days", () => {
  const nov = P.periodOf("month", "2026-11-19");
  assert.equal(P.periodLabel(nov), "Nov 2026", "no locale: 2.28's label");
  assert.equal(P.periodLabel(nov, "fr-CH"), "nov. 2026");
  assert.equal(P.periodLabel(nov, "de-CH"), "Nov 2026");
  assert.equal(P.periodLabel(P.periodOf("week", "2026-11-19"), "de-CH"), "16.–22. Nov 2026");
  assert.equal(P.periodLabel(P.periodOf("week", "2026-12-31"), "fr-CH"), "28 déc. 2026 – 3 janv. 2027");
  assert.equal(P.periodLabel(P.periodOf("quarter", "2026-11-19"), "fr-CH"), "T4 2026");
  assert.equal(P.periodLabel(P.periodOf("quarter", "2026-11-19"), "de-CH"), "Q4 2026");
  assert.equal(P.periodLabel({ unit: "custom", from: "2026-09-01", to: "2026-11-30" }, "it-CH"), "set – nov 2026");
  assert.equal(P.periodLabel(P.periodOf("month", "2026-03-01"), "pl-PL"), "mar 2026");
  assert.equal(P.periodLabel(P.periodOf("month", "2026-10-01"), "pt-PT"), "out. 2026");
});

test("presets: the last N days and month, quarter, year to date, all ending today", () => {
  const today = "2026-11-19";
  assert.deepEqual(P.presetPeriod("28d", today), { unit: "custom", from: "2026-10-23", to: today, preset: "28d" });
  assert.deepEqual(P.presetPeriod("7d", today), { unit: "custom", from: "2026-11-13", to: today, preset: "7d" });
  assert.deepEqual(P.presetPeriod("mtd", today), { unit: "custom", from: "2026-11-01", to: today, preset: "mtd" });
  assert.deepEqual(P.presetPeriod("qtd", today), { unit: "custom", from: "2026-10-01", to: today, preset: "qtd" });
  assert.deepEqual(P.presetPeriod("ytd", today), { unit: "custom", from: "2026-01-01", to: today, preset: "ytd" });
  for (const bad of ["0d", "d", "28", "wtd", "", null, undefined]) assert.equal(P.presetPeriod(bad, today), null, String(bad));
  assert.equal(P.periodLabel(P.presetPeriod("28d", today)), "Last 28 days");
  assert.equal(P.periodLabel(P.presetPeriod("28d", today), "fr-CH"), "28 derniers jours");
  assert.equal(P.periodLabel(P.presetPeriod("mtd", today), "de-CH"), "Dieser Monat");
  assert.equal(P.presetLabel("90d", "it-CH"), "Ultimi 90 giorni");
  // ‹ from a to-date preset is the whole unit before; from N days, the N days before.
  assert.deepEqual(P.shift(P.presetPeriod("mtd", today), -1), P.periodOf("month", "2026-10-01"));
  assert.deepEqual(P.shift(P.presetPeriod("ytd", today), -1), P.periodOf("year", "2025-01-01"));
  assert.deepEqual(P.shift(P.presetPeriod("7d", today), -1), { unit: "custom", from: "2026-11-06", to: "2026-11-12" });
});

async function kit(t) {
  let JSDOM, esbuild;
  try {
    ({ JSDOM } = await import("jsdom"));
    esbuild = await import("esbuild");
    await import("react");
  } catch (e) {
    t.skip("esbuild, react or jsdom not installed here: " + e.message);
    return null;
  }
  const { loadKit, renderCases } = await import("./test-support/locale-baseline-2.28.mjs");
  let loaded;
  try {
    loaded = await loadKit(new URL("./", import.meta.url), { JSDOM, esbuild });
  } catch (e) {
    t.skip("radix-ui or a peer is not installed here: " + e.message);
    return null;
  }
  t.after(loaded.restore);
  const [React, client] = await Promise.all([import("react"), import("react-dom/client")]);
  return { ...loaded, React, client, renderCases };
}

test("no locale, labels or presets: PeriodPicker, FilterBar, MultiSelect, FilterMenu and Combobox render exactly as SDK 2.28.0", async t => {
  const env = await kit(t);
  if (!env) return;
  const baseline = JSON.parse(readFileSync(new URL("./test-support/locale-baseline-2.28.json", import.meta.url), "utf8"));
  assert.equal(Object.keys(baseline).length, 22);
  const now = await env.renderCases(env);
  for (const name of Object.keys(baseline)) assert.equal(now[name], baseline[name], name);
  // The props set to undefined are the same as left out.
  const off = { locale: undefined, labels: undefined };
  const unset = await env.renderCases(env, { period: { ...off, presets: undefined }, filterBar: off, filter: off, combobox: off });
  for (const name of Object.keys(baseline)) assert.equal(unset[name], baseline[name], `${name}, props undefined`);
});

test("fr-CH and de-CH: every fixed text comes from the strings table, labels win over it", async t => {
  const env = await kit(t);
  if (!env) return;
  const fr = await env.renderCases(env, { period: { locale: "fr-CH" }, filterBar: { locale: "fr-CH" }, filter: { locale: "fr-CH" }, combobox: { locale: "fr-CH" } });
  const text = html => html.replace(/<[^>]+>/g, "|");
  assert.match(fr["pp-closed"], /aria-label="Hires: mars 2025"/);
  assert.match(fr["pp-closed-quarter"], /aria-label="Période: T1 2025"/, "the default trigger name");
  assert.match(fr["pp-closed"], /aria-label="Période précédente"[\s\S]*aria-label="Période suivante"/);
  assert.match(text(fr["pp-open-week"]), /\|Semaine\|\|Mois\|\|Trimestre\|\|Année\|\|Personnalisé\|/);
  assert.match(fr["pp-open-week"], /aria-label="Choisir une période"/);
  assert.match(text(fr["pp-open-week"]), /\|10–16 mars 2025\|/);
  assert.match(text(fr["pp-open-custom"]), /\|Du\|[\s\S]*\|Au\|[\s\S]*\|Appliquer\|/);
  assert.match(text(fr["fb-sheet"]), /\|Filtres \|[\s\S]*\|Terminé\|[\s\S]*\|Réinitialiser\|/);
  assert.match(fr["fb-sheet"], /title="Revenir aux filtres par défaut"/);
  assert.match(text(fr["ms-open"]), /\|Tous\|[\s\S]*\|Seulement\|/);
  assert.match(text(fr["ms-open"]), new RegExp(`\\|${(1234).toLocaleString("fr-CH")}\\|`), "counts in the locale");
  assert.match(text(fr["ms-many"]), /\|2 sélectionnés\|/);
  assert.match(fr["ms-open-search"], /placeholder="Rechercher"/);
  assert.match(text(fr["fm-items-root"]), /\|Bots \(tout\)\|/);
  assert.match(fr["fm-items"], /aria-label="Bots \(tout\)"/);
  assert.match(text(fr["fm-closed-flat"]), /\|3 sélectionnés\|/);
  assert.match(text(fr["cb-closed"]), /\|Choisir…\|/);
  assert.match(fr["cb-open-empty"], /placeholder="Rechercher…"/);
  assert.match(text(fr["cb-open-empty"]), /\|Aucun résultat\.\|/);

  const de = await env.renderCases(env, { period: { locale: "de-CH" }, filterBar: { locale: "de-CH", labels: { done: "Schliessen" } }, filter: { locale: "de-CH", allLabel: "Alle Märkte" }, combobox: { locale: "de-CH" } });
  assert.match(de["pp-closed"], /aria-label="Hires: Mär 2025"/);
  assert.match(text(de["pp-open-quarter"]), /\|Q1 2025\|/);
  assert.match(text(de["fb-sheet"]), /\|Schliessen\|[\s\S]*\|Zurücksetzen\|/, "labels override one string, the rest stay German");
  assert.match(text(de["ms-open"]), /\|Alle Märkte\|[\s\S]*\|Nur\|/, "an explicit allLabel wins over the locale");
  assert.match(text(de["ms-open"]), new RegExp(`\\|${(1234).toLocaleString("de-CH")}\\|`), "de-CH groups its way");
});

test("PeriodPicker presets: a first tab of rolling windows, named in the locale; a pick emits the preset", async t => {
  const env = await kit(t);
  if (!env) return;
  const { React, client, win, kit: k } = env;
  const h = React.createElement;
  const emits = [];
  function App() {
    const [v, setV] = React.useState(P.periodOf("month", "2025-03-01"));
    return h(k.PeriodPicker, { value: v, onChange: p => { emits.push(p); setV(p); }, locale: "fr-CH", presets: ["7d", "28d", "mtd", "ytd"] });
  }
  win.document.body.innerHTML = "<div id=root></div>";
  const root = client.createRoot(win.document.getElementById("root"));
  await React.act(() => root.render(h(App)));
  const $ = s => win.document.querySelector(s);
  const click = async el => {
    await React.act(async () => {
      el.dispatchEvent(new win.PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      el.click();
    });
    await React.act(async () => {});
  };
  await click($('[data-slot="period-picker-trigger"]'));
  const tabs = [...win.document.querySelectorAll("[role=tab]")].map(b => b.textContent);
  assert.deepEqual(tabs, ["Raccourcis", "Mois", "Trimestre", "Année", "Personnalisé"]);
  await click([...win.document.querySelectorAll("[role=tab]")][0]);
  const options = () => [...win.document.querySelectorAll('[data-slot="period-picker-grid"] button')];
  assert.deepEqual(options().map(b => b.textContent), ["7 derniers jours", "28 derniers jours", "Ce mois-ci", "Cette année"], "no 'en cours' under each: every preset runs to today");
  await click(options()[1]);
  const today = P.todayIso();
  assert.deepEqual(emits.at(-1), P.presetPeriod("28d", today));
  assert.equal($('[data-slot="period-picker-trigger"]').textContent, "28 derniers jours");
  assert.ok($('[data-slot="period-picker-trigger"]').hasAttribute("data-current"), "a preset is in progress");
  // Reopened on a preset, the picker opens on its tab with the preset marked.
  await click($('[data-slot="period-picker-trigger"]'));
  assert.equal(win.document.querySelector("[role=tab][aria-selected=true]").textContent, "Raccourcis");
  assert.match(options()[1].className, /border-brand/);
  await React.act(() => root.unmount());
});

test("DataTable locale: the footer, pager and default noun in French; no locale is 2.28's table", async t => {
  let React, server, ui;
  try {
    React = await import("react");
    server = await import("react-dom/server");
    ui = await import("./ui.js");
  } catch (e) {
    t.skip("react not installed here: " + e.message);
    return;
  }
  const rows = Array.from({ length: 312 }, (_, i) => ({ id: i, mrr: i }));
  const columns = [{ id: "mrr", label: "MRR", num: true, value: r => r.mrr }];
  const html = props => server.renderToStaticMarkup(React.createElement(ui.DataTable, { rows, columns, exportFilename: "x", ...props }));
  assert.equal(html({ locale: undefined }), html({}));
  const fr = html({ locale: "fr-CH" });
  assert.match(fr, /<b>1–50<\/b> sur <b>312<\/b> lignes/);
  assert.match(fr, /Page 1 sur 7/);
  assert.match(fr, /50 par page/);
  assert.match(fr, /aria-label="Page suivante"/);
  assert.match(fr, /Exporter en CSV/);
  assert.match(fr, /title="MRR · cliquer pour trier"/);
  assert.match(html({ locale: "fr-CH", noun: "clients" }), /<\/b> clients</, "noun wins over the locale's default");
  assert.match(html({ locale: "fr-CH", labels: { exportCsv: "CSV" } }), />CSV</, "labels win over the locale");
  assert.match(server.renderToStaticMarkup(React.createElement(ui.DataTable, { rows: [], columns, locale: "de-CH" })), /0 Zeilen/);
  assert.equal(ui.dataTableLabels().page(2, 7), "Page 2 of 7");
  assert.equal(ui.dataTableLabels("it-CH").page(2, 7), "Pagina 2 di 7");
});
