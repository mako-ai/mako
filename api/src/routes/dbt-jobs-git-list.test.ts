import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const route = readFileSync(join(__dirname, "dbt.routes.ts"), "utf8");
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
