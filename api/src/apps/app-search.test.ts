/**
 * search_apps ranking and binding table extraction.
 *
 * Run: npx tsx src/apps/app-search.test.ts
 */
import assert from "node:assert/strict";
import {
  extractTables,
  rankApps,
  tokenize,
  type SearchableApp,
} from "./app-search";

// Tables ------------------------------------------------------------------

assert.deepEqual(
  extractTables(`-- connection: abc
-- materialization: parquet
WITH won AS (SELECT * FROM \`realadvisor-dwh.close.opportunities\` WHERE x)
SELECT l.id FROM close.leads l
JOIN "public"."Users" u ON u.id = l.owner
LEFT JOIN won ON won.lead_id = l.id
WHERE EXTRACT(year FROM l.created_at) = 2026 -- FROM not_a_table`),
  ["close.leads", "public.users", "realadvisor-dwh.close.opportunities"],
);
assert.deepEqual(extractTables("SELECT 1"), []);
assert.deepEqual(extractTables("select * from (select 1) t"), []);

// Ranking -----------------------------------------------------------------

assert.deepEqual(tokenize("Leads by Canton (CH)"), ["leads", "canton", "ch"]);

const apps: SearchableApp[] = [
  {
    appId: "a1",
    path: "apps/Sales/CH/leads-by-canton",
    title: "Leads by canton",
    description: "Weekly CH leads split by canton",
    tables: ["close.leads"],
  },
  {
    appId: "a2",
    path: "apps/Ops/quotas",
    title: "Agent quotas",
    description: "Objectives per agent",
    owner: "joan",
    tables: ["talent.objectives"],
  },
  {
    appId: "a3",
    path: "users/jakub/apps/scratch",
    title: "Scratch",
    tables: ["close.leads", "close.opportunities"],
  },
  {
    appId: "a4",
    path: "apps/marketing/spend",
    title: "Ad spend",
    tables: ["ads.spend"],
  },
];

const leads = rankApps(apps, "leads by canton");
assert.equal(leads[0].appId, "a1");
// A table-only match still surfaces, below the title match.
assert.ok(leads.some(h => h.appId === "a3"));
assert.ok(leads.findIndex(h => h.appId === "a3") > 0);
assert.ok(!leads.some(h => h.appId === "a4"));
assert.ok(leads[0].matchedOn.includes("title"));

// Table names are searchable, prefixes too ("opportunit" → opportunities).
assert.equal(rankApps(apps, "opportunit")[0].appId, "a3");
assert.equal(rankApps(apps, "talent.objectives")[0].appId, "a2");
// Owner handles are searchable.
assert.equal(rankApps(apps, "joan")[0].appId, "a2");
// Nothing to match: nothing returned; stopword-only queries too.
assert.deepEqual(rankApps(apps, "zebra"), []);
assert.deepEqual(rankApps(apps, "the app"), []);
// Usage breaks ties between equal matches, it does not beat relevance.
const twins: SearchableApp[] = [
  { appId: "x", path: "apps/x", title: "Churn", tables: [] },
  { appId: "y", path: "apps/y", title: "Churn", tables: [], usageScore: 20 },
  {
    appId: "z",
    path: "apps/z",
    title: "Other",
    description: "churn",
    tables: [],
    usageScore: 1000,
  },
];
const churn = rankApps(twins, "churn");
assert.deepEqual(churn.map(h => h.appId).slice(0, 2), ["y", "x"]);
// Limit.
assert.equal(rankApps(apps, "leads", { limit: 1 }).length, 1);

console.log("app-search: ok");
