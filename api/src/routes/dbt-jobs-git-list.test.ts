import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// The dbt router and its sub-routers (./dbt/*.ts), read as one source.
const route = [
  join(__dirname, "dbt.routes.ts"),
  ...readdirSync(join(__dirname, "dbt"))
    .filter(name => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map(name => join(__dirname, "dbt", name)),
]
  .map(file => readFileSync(file, "utf8"))
  .join("\n");
const service = readFileSync(
  join(__dirname, "../dbt/dbt-config.service.ts"),
  "utf8",
);
const tools = readFileSync(
  join(__dirname, "../agent-lib/tools/dbt-tools.ts"),
  "utf8",
);

assert.ok(route.includes("loadLiveJobs") && route.includes("liveJobToPlain"));
assert.ok(route.includes("loadLiveJobById"));
assert.ok(
  service.includes("boundRepoDirIfExists") &&
    service.includes("listJobDefinitionsAtMain"),
);
assert.match(
  service,
  /if \(!\(await getWorkspaceRepo\(workspaceId\)\)\) return \[\]/,
);
assert.ok(tools.includes("loadLiveJobs") && tools.includes("liveJobToPlain"));

console.log("dbt jobs git-list tests passed");
