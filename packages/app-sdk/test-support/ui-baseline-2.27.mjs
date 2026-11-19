// The DataTable fixtures behind ui-baseline-2.27.json, rendered by SDK 2.27.0
// before wrapHeaders, expandable rows, header info and totalRow existed.
// Regenerate only on purpose:
//   node test-support/ui-baseline-2.27.mjs > test-support/ui-baseline-2.27.json

/** Every fixture: a name and the DataTable props. `extra` props are added on top in the options-off test. */
export function baselineCases() {
  const rows = Array.from({ length: 60 }, (_, i) => ({ id: i, name: `Org ${i}`, country: ["FR", "ES", "IT"][i % 3], mrr: (i * 37) % 101, note: i % 4 ? `Note ${i}` : null }));
  const columns = [
    { id: "name", label: "Customer", value: r => r.name, sticky: true, hint: "Account name" },
    { id: "country", label: "Country", value: r => r.country, align: "center", width: 90 },
    { id: "mrr", label: "MRR", num: true, value: r => r.mrr },
    { id: "note", label: "Note", value: r => r.note, truncate: false, sortable: false },
  ];
  const grouped = [
    { id: "name", label: "Customer", value: r => r.name, sticky: true },
    { id: "country", label: "Country", value: r => r.country, group: "where" },
    { id: "mrr", label: "MRR", num: true, value: r => r.mrr, group: "money", render: r => `€${r.mrr}` },
  ];
  return [
    { name: "plain", props: { rows, columns } },
    { name: "sorted-page2", props: { rows, columns, defaultSort: { id: "mrr", dir: "desc" }, page: 2, pageSize: 25, noun: "customers" } },
    { name: "export-title", props: { rows: rows.slice(0, 5), columns, title: "Customers", description: "All", exportFilename: "c", maxHeight: 300 } },
    { name: "click-tint", props: { rows: rows.slice(0, 6), columns, onRowClick: () => {}, rowLabel: r => `Open ${r.name}`, rowClassName: r => (r.mrr > 50 ? "hot" : undefined), rowKey: r => `k${r.id}` } },
    { name: "groups", props: { rows: rows.slice(0, 4), columns: grouped, groups: [{ id: "where", label: "Where", className: "tone" }], fill: true, className: "x", style: { border: 0 } } },
    { name: "empty", props: { rows: [], columns, noun: "customers" } },
  ];
}

export async function renderBaselineCases(React, server, ui, extra = {}) {
  const out = {};
  for (const c of baselineCases()) {
    out[c.name] = server.renderToStaticMarkup(React.createElement(ui.DataTable, { ...c.props, ...extra }));
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const React = await import("react");
  const server = await import("react-dom/server");
  const ui = await import("../ui.js");
  process.stdout.write(JSON.stringify(await renderBaselineCases(React, server, ui), null, 2) + "\n");
}
