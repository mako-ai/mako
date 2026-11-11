/**
 * SCALE: renaming a model that half of a 1,200-file project references is
 * one commit, in a time that does not grow with a git process per file.
 * Real bare repo and mongodb-memory-server; the measured time is printed.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

vi.mock("../../services/realtime.service", () => ({
  publishRealtimeEvent: vi.fn(),
}));

import { DbtProject } from "../../database/workspace-schema";
import { seedDbtGitTree } from "../../dbt/test-support/git-tree";
import {
  DEFAULT_BRANCH,
  log as repoLog,
  readBlobsBatch,
  repoDirFor,
} from "../../apps/repository.service";
import { renameDbtFile } from "../dbt-file";

let mongo: MongoMemoryServer;
let tmpRoot: string;
const WS = new Types.ObjectId().toString();

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dbt-file-scale-"));
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  process.env.APPS_GITHUB_REMOTE_BASE = `file://${tmpRoot}/no-mirror`;
  process.env.APPS_SANDBOX_PROVIDER = "local";
  delete process.env.APPS_REQUIRE_CONNECTED_REPO;
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

it("a model referenced by 600 of 1,200 files: one commit, bounded time", async () => {
  const files: Record<string, string> = {
    "dbt_project.yml": "name: analytics\n",
    "models/orders.sql": "select 1 as id\n",
    "jobs/nightly.yml":
      "name: Nightly\nenvironment: dev\ncommands:\n  - dbt build --select orders+\nenabled: true\n",
  };
  for (let i = 0; i < 1200; i++) {
    files[`models/m${i}.sql`] =
      i % 2 === 0
        ? `select * from {{ ref('orders') }} -- ${i}\n`
        : `select ${i} as id\n`;
  }
  await DbtProject.create({
    workspaceId: new Types.ObjectId(WS),
    name: "Analytics",
    environments: [
      {
        name: "dev",
        connectionId: new Types.ObjectId(),
        targetSchema: "dbt_dev",
        threads: 4,
      },
    ],
    defaultEnvironment: "dev",
    createdBy: "tester",
  });
  await seedDbtGitTree(WS, files);
  const repoDir = repoDirFor(WS);
  const commits = (await repoLog(repoDir, DEFAULT_BRANCH, 100)).length;

  const started = performance.now();
  const result = await renameDbtFile(
    { workspaceId: WS, userId: "u1", role: "admin" },
    { from: "models/orders.sql", to: "models/fct_orders.sql" },
  );
  const ms = Math.round(performance.now() - started);
  console.info(`[scale] dbt rename rewriting 600 of 1,200 files: ${ms} ms`);

  expect(result.commit).toBeTruthy();
  expect((await repoLog(repoDir, DEFAULT_BRANCH, 100)).length).toBe(
    commits + 1,
  );
  const read = await readBlobsBatch(repoDir, DEFAULT_BRANCH, [
    "dbt/models/m1198.sql",
    "dbt/models/m1199.sql",
    "dbt/jobs/nightly.yml",
  ]);
  expect(read.get("dbt/models/m1198.sql")?.toString()).toBe(
    "select * from {{ ref('fct_orders') }} -- 1198\n",
  );
  expect(read.get("dbt/models/m1199.sql")?.toString()).toBe(
    "select 1199 as id\n",
  );
  expect(read.get("dbt/jobs/nightly.yml")?.toString()).toContain(
    "--select fct_orders+",
  );
  expect(ms).toBeLessThan(30_000);
}, 300_000);
