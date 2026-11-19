// DataTable cell rules must style only the table's own cells, never the cells of a
// plain <table> rendered inside an expanded detail row (2.30.2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("./ui.css", import.meta.url), "utf8");
const SCOPE = ":where(.mk-dt-table > * > tr > *)";

test("every .mk-dt-table rule on td/th is scoped to the table's own cells", () => {
  const leaks = [];
  for (const [, sels] of css.matchAll(/([^{}@]*)\{[^{}]*\}/g)) {
    for (const sel of sels.split(",").map(s => s.trim())) {
      if (!sel.includes(".mk-dt-table")) continue;
      const tail = sel.slice(sel.indexOf(".mk-dt-table"));
      if (!/(^|[\s>+~])(td|th)(?![\w-])/.test(tail)) continue;
      if (!sel.includes(SCOPE)) leaks.push(sel);
    }
  }
  assert.deepEqual(leaks, [], "unscoped DataTable cell rules leak into nested tables");
});
