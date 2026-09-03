import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * GET/list for flows must serve git at main. A missing GitHub binding is
 * an empty list (200), not 412 — leftover local git is not a read surface
 * (issue #956, after #961 made git the write store).
 */

const flows = readFileSync(join(__dirname, "flows.ts"), "utf8");
const sync = readFileSync(
  join(__dirname, "../services/flow-sync.service.ts"),
  "utf8",
);

assert.ok(
  flows.includes("loadLiveFlows") && flows.includes("liveFlowToPlain"),
  "GET /flows must list from loadLiveFlows, not Flow.aggregate on Mongo",
);

assert.ok(
  !/Flow\.aggregate\(/.test(flows),
  "GET/list must not aggregate Mongo as the definition store",
);

assert.ok(
  /success:\s*true,\s*data:\s*\[\]/.test(flows.replace(/\s+/g, "")) ||
    flows.includes("{ success: true, data: [] }"),
  "GET /flows must return 200 { data: [] } when no GitHub repo is bound",
);

assert.ok(
  flows.includes("loadLiveFlowById") &&
    flows.includes('error: "Flow not found"'),
  "GET /{flowId} must 404 when the file is missing or the workspace is unbound",
);

assert.ok(
  sync.includes("boundRepoDirIfExists") &&
    sync.includes("listFlowDefinitionsAtMain") &&
    sync.includes("loadLiveFlows"),
  "flow GET/list must read git via boundRepoDirIfExists / listFlowDefinitionsAtMain",
);

assert.ok(
  /if \(!\(await getWorkspaceRepo\(workspaceId\)\)\) return none/.test(sync),
  "readFlowFilesAtMain must refuse leftover local git without a GitHub binding",
);

assert.ok(
  !/await ensureLocalRepo\(workspaceId\);\s*const repoDir = repoDirFor\(workspaceId\)/.test(
    sync,
  ),
  "ensureFlowDerivedCache / readFlowFilesAtMain must not treat leftover local git as a repo",
);

console.log("flows git-list tests passed");
