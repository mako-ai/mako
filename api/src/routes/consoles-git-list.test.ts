import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * GET/list for consoles must serve git at main. A missing GitHub binding is
 * an empty list (200), not 412 — leftover local git is not a read surface
 * (issue #956, after #961 made git the write store).
 */

const consoles = readFileSync(join(__dirname, "consoles.ts"), "utf8");
const manager = readFileSync(
  join(__dirname, "../utils/console-manager.ts"),
  "utf8",
);

assert.ok(
  consoles.includes("emptyConsoleTree()") &&
    consoles.includes("error instanceof RepoRequiredError"),
  "GET /consoles must return an empty tree on RepoRequiredError, not 412",
);

assert.ok(
  /success:\s*true,\s*consoles:\s*\[\],\s*total:\s*0/.test(
    consoles.replace(/\s+/g, ""),
  ) || consoles.includes("{ success: true, consoles: [], total: 0 }"),
  "GET /consoles/list must return 200 { consoles: [] } when no GitHub repo is bound",
);

assert.ok(
  manager.includes("loadLiveConsoles") &&
    manager.includes("boundRepoDirIfExists"),
  "listConsoles must read git via loadLiveConsoles / boundRepoDirIfExists",
);

assert.ok(
  /if \(bound == null\) return \[\]/.test(manager) ||
    /if \(bound == null\) \{\s*return \{ myConsoles: \[\], sharedWithWorkspace: \[\] \}/.test(
      manager,
    ),
  "Unbound GET/list must be empty — leftover Mongo is not a live definition",
);

console.log("consoles git-list tests passed");
