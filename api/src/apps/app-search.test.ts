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
// dbt-templated references: `{{ dbt_schema }}.model` used to be dropped, and
// `project.{{ dbt_schema }}.model` used to come back as the project alone.
assert.deepEqual(
  extractTables(`SELECT * FROM {{ dbt_schema }}.fct_orders o
JOIN {{dbt_schema}}.dim_customer c USING (customer_id)`),
  ["{{dbt_schema}}.dim_customer", "{{dbt_schema}}.fct_orders"],
);
assert.deepEqual(
  extractTables(
    "select * from realadvisor-prod.{{ dbt_schema }}.fct_orders where true",
  ),
  ["realadvisor-prod.{{dbt_schema}}.fct_orders"],
);
assert.deepEqual(
  extractTables(`select m.*, t.team
from \`realadvisor-prod.{{ dbt_schema }}.dim_sales_team_membership\` m
join \`realadvisor-prod\`.\`{{dbt_schema}}\`.\`dim_team\` t using (team_id)`),
  [
    "realadvisor-prod.{{dbt_schema}}.dim_sales_team_membership",
    "realadvisor-prod.{{dbt_schema}}.dim_team",
  ],
);
// Backticked `project.dataset.table` (whole or per part) and plain
// `dataset.table` keep every part.
assert.deepEqual(
  extractTables(`select * from \`acme-prod.crm_public.organisations\` o
join \`acme-prod\`.\`stripe\`.\`subscriptions\` s on s.org = o.id
join dbt_prod.dim_account a on a.id = o.id
left join Analytics.Events e on e.org = o.id`),
  [
    "acme-prod.crm_public.organisations",
    "acme-prod.stripe.subscriptions",
    "analytics.events",
    "dbt_prod.dim_account",
  ],
);
// A CTE named like a model is still a CTE; a templated one is a table.
assert.deepEqual(
  extractTables(`with fct_orders as (select * from {{ dbt_schema }}.fct_orders)
select * from fct_orders`),
  ["{{dbt_schema}}.fct_orders"],
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

// The templating token is not a word: "schema" must not match every app
// that reads a dbt model, while the model's own name still does.
const templated: SearchableApp[] = [
  {
    appId: "t1",
    path: "apps/t1",
    title: "Orders",
    tables: ["{{dbt_schema}}.fct_orders"],
  },
];
assert.deepEqual(rankApps(templated, "dbt schema"), []);
assert.equal(rankApps(templated, "fct_orders")[0]?.appId, "t1");
process.stdout.write("ok dbt-templated tables: extracted and searchable\n");
