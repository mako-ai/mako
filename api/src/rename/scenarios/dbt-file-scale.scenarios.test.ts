/**
 * SCENARIOS — dbt file renames at realistic upper sizes (kept apart from
 * dbt-file.scenarios.test.ts so that one stays quick): a model referenced
 * by hundreds of files, and old paths behind hundreds of commits. Times
 * are printed (`[scale]`) and bounded.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

vi.mock("../../services/realtime.service", () => ({
  publishRealtimeEvent: vi.fn(),
}));

import { AppWorktree, DbtProject } from "../../database/workspace-schema";
import { seedDbtGitTree } from "../../dbt/test-support/git-tree";
import {
  DEFAULT_BRANCH,
  commitBlobsOnBranch,
  log as repoLog,
  readBlobsBatch,
  repoDirFor,
} from "../../apps/repository.service";
import { resolveObjectRef } from "../registry";
import { renameDbtFile } from "../dbt-file";

let mongo: MongoMemoryServer;
let tmpRoot: string;
let WS = new Types.ObjectId().toString();
const MAIN = `refs/heads/${DEFAULT_BRANCH}`;
const member = () => ({ workspaceId: WS, userId: "u1", role: "member" });

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dbt-scale-scenarios-"));
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
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

beforeEach(async () => {
  WS = new Types.ObjectId().toString();
  await Promise.all([DbtProject.deleteMany({}), AppWorktree.deleteMany({})]);
});

const ORDERS_SQL = [
  "with source as (",
  "  select * from raw.orders",
  "),",
  "renamed as (",
  "  select id as order_id, customer_id, status, amount_cents / 100.0 as amount",
  "  from source",
  ")",
  "select * from renamed",
  "",
].join("\n");

async function seedProject(files: Record<string, string> = {}) {
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
  await seedDbtGitTree(WS, {
    "dbt_project.yml": "name: analytics\n",
    "models/orders.sql": ORDERS_SQL,
    "models/customers.sql": "select 2 as id, 'customer name' as name\n",
    ...files,
  });
}

async function fileAt(rel: string): Promise<string | null> {
  const buf = (await readBlobsBatch(repoDirFor(WS), MAIN, [`dbt/${rel}`])).get(
    `dbt/${rel}`,
  );
  return buf ? buf.toString("utf8") : null;
}

async function commitsOn(): Promise<number> {
  return (await repoLog(repoDirFor(WS), MAIN, 10_000)).length;
}

describe("scale", () => {
  it("a model referenced by 600 of 1200 files: one commit, bounded time", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 1200; i++) {
      files[`models/m${i}.sql`] =
        i % 2 === 0
          ? `select * from {{ ref('orders') }} -- ${i}\n`
          : `select ${i} as id\n`;
    }
    files["jobs/nightly.yml"] =
      "name: Nightly\nenvironment: dev\ncommands:\n  - dbt build --select orders+\nenabled: true\n";
    await seedProject(files);
    const commits = await commitsOn();
    const t = Date.now();
    const r = await renameDbtFile(member(), {
      from: "models/orders.sql",
      to: "models/fct_orders.sql",
    });
    const ms = Date.now() - t;
    console.info(
      `[scale] dbt rename rewriting 600 of 1200 files + a job: ${ms}ms`,
    );
    expect(await commitsOn()).toBe(commits + 1);
    expect(r.commit).toBeTruthy();
    expect(await fileAt("models/m1198.sql")).toBe(
      "select * from {{ ref('fct_orders') }} -- 1198\n",
    );
    expect(await fileAt("models/m1199.sql")).toBe("select 1199 as id\n");
    expect(ms).toBeLessThan(60_000);
  }, 300_000);

  it("an old path behind 600 commits under dbt/: found inside the scan window, honestly null past it", async () => {
    await seedProject({
      "models/deep.sql": ORDERS_SQL.replace("orders", "deep"),
    });
    await renameDbtFile(member(), {
      from: "models/deep.sql",
      to: "models/deep_moved.sql",
      updateRefs: false,
    });
    const repoDir = repoDirFor(WS);
    for (let i = 0; i < 1200; i++) {
      await commitBlobsOnBranch(
        repoDir,
        DEFAULT_BRANCH,
        { writes: { [`dbt/models/noise/n${i}.sql`]: `select ${i}\n` } },
        { message: `noise ${i}` },
      );
    }
    await renameDbtFile(member(), {
      from: "models/customers.sql",
      to: "models/dim_customers.sql",
    });
    let t = Date.now();
    const recent = await resolveObjectRef(
      member(),
      "dbt_file",
      "models/customers.sql",
    );
    const recentMs = Date.now() - t;
    t = Date.now();
    const buried = await resolveObjectRef(
      member(),
      "dbt_file",
      "models/deep.sql",
    );
    const buriedMs = Date.now() - t;
    console.info(
      `[scale] dbt old-path resolve over 600 commits: found ${recentMs}ms, past the window ${buriedMs}ms`,
    );
    expect(recent?.current.slug).toBe("models/dim_customers.sql");
    expect(buried).toBeNull();
    expect(recentMs).toBeLessThan(5_000);
    expect(buriedMs).toBeLessThan(5_000);
  }, 600_000);
});
