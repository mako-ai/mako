/**
 * dbt mutations must commit the file before persisting the derived row.
 *
 * Issue #956: git is the store. Mongo-first (save then commitDbtJobFile)
 * is the split-brain that lets a failed commit leave a definition with
 * no file.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const routes = fs.readFileSync(path.join(__dirname, "dbt.routes.ts"), "utf8");
const tools = fs.readFileSync(
  path.join(__dirname, "../agent-lib/tools/dbt-tools.ts"),
  "utf8",
);

const saveThenCommitJob =
  /await job\.save\(\);[\s\S]{0,280}commitDbtJobFile\(/.test(routes);
assert.equal(
  saveThenCommitJob,
  false,
  "dbt job mutations must commit the file before job.save() — git is the store",
);

const createThenCommitJob =
  /await DbtJob\.create\([\s\S]{0,500}commitDbtJobFile\(/.test(routes);
assert.equal(
  createThenCommitJob,
  false,
  "dbt job create must commit the file before persisting the row",
);

const deleteThenCommit =
  /await DbtJob\.deleteOne\([\s\S]{0,200}deleteDbtJobFile\(/.test(routes);
assert.equal(
  deleteThenCommit,
  false,
  "dbt job delete must remove the file before dropping the derived row",
);

const saveThenCommitEnv =
  /await project\.save\(\);[\s\S]{0,240}commitDbtEnvironmentsFile\(/.test(
    routes,
  );
assert.equal(
  saveThenCommitEnv,
  false,
  "dbt environment mutations must commit environments.yml before project.save()",
);

const toolsSaveThenCommit =
  /await job\.save\(\);[\s\S]{0,280}commitDbtJobFile\(/.test(tools);
assert.equal(
  toolsSaveThenCommit,
  false,
  "dbt agent tools must commit the job file before job.save()",
);

assert.ok(
  routes.includes("RepoRequiredError"),
  "dbt routes must map RepoRequiredError so a missing repo is a 412, not a 500",
);

console.log("dbt write-through honesty: all assertions passed");
