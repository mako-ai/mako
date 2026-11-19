// The tooltip total row is bold: its rule must outrank `.mk-tip tbody th` (0,1,1 + 1 element).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("./ui.css", import.meta.url), "utf8");
const spec = sel => {
  const ids = (sel.match(/#[\w-]+/g) || []).length;
  const cls = (sel.match(/\.[\w-]+/g) || []).length;
  const el = sel.replace(/[#.][\w-]+/g, " ").trim().split(/\s+/).filter(Boolean).length;
  return ids * 10000 + cls * 100 + el;
};

test("tooltip total-row label outranks the plain row label", () => {
  const rule = css.match(/([^{}]*mk-tip-total th[^{}]*)\{[^}]*font-weight:\s*600/);
  assert.ok(rule, "a bold rule for .mk-tip-total th exists");
  const totalTh = rule[1].split(",").map(s => s.trim()).find(s => s.endsWith("th"));
  assert.ok(spec(totalTh) > spec(".mk-tip tbody th"), `${totalTh} must outrank .mk-tip tbody th`);
});
