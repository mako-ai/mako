/**
 * Turn-level .makorules resolution: hinted project > sole workspace project >
 * nothing. Runs against an ephemeral Mongo (project lookups) plus a bare
 * workspace repo (the rules file lives in git — apps.md §20).
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

import { resolveDbtRulesBlockForTurn } from "./dbt-rules-turn.service";
import { DbtProject } from "../database/workspace-schema";
import { seedDbtGitTree } from "./test-support/git-tree";

let mongo: MongoMemoryServer;
let tmpRoot: string;
const WS = new Types.ObjectId();
const OTHER_WS = new Types.ObjectId();
const CONN = new Types.ObjectId();
const USER = "u1";

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dbt-rules-turn-test-"));
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
  await DbtProject.deleteMany({});
  await fs.rm(path.join(tmpRoot, "repos"), { recursive: true, force: true });
});

async function seedProject(name: string, workspaceId = WS, rules?: string) {
  const project = await DbtProject.create({
    workspaceId,
    name,
    environments: [
      {
        name: "dev",
        connectionId: CONN,
        targetSchema: "analytics",
        threads: 4,
      },
    ],
    defaultEnvironment: "dev",
    createdBy: "tester",
  });
  if (rules !== undefined) {
    await seedDbtGitTree(workspaceId, { ".makorules.md": rules });
  }
  return project._id.toString();
}

describe("resolveDbtRulesBlockForTurn", () => {
  it("returns '' when the workspace has no dbt projects", async () => {
    expect(
      await resolveDbtRulesBlockForTurn({
        workspaceId: WS.toString(),
        userId: USER,
      }),
    ).toBe("");
  });

  it("uses the sole workspace project when no hint is given", async () => {
    await seedProject("Analytics", WS, "- never select *");
    const block = await resolveDbtRulesBlockForTurn({
      workspaceId: WS.toString(),
      userId: USER,
    });
    expect(block).toContain("- never select *");
    expect(block).toContain("Analytics");
  });

  it("returns '' with several projects and no hint", async () => {
    await seedProject("Analytics", WS, "- rule a");
    await seedProject("Finance", WS, "- rule b");
    expect(
      await resolveDbtRulesBlockForTurn({
        workspaceId: WS.toString(),
        userId: USER,
      }),
    ).toBe("");
  });

  it("uses the hinted project when several exist", async () => {
    await seedProject("Analytics", WS, "- rule a");
    const financeId = await seedProject("Finance", WS, "- rule b");
    const block = await resolveDbtRulesBlockForTurn({
      workspaceId: WS.toString(),
      userId: USER,
      dbtProjectId: financeId,
    });
    expect(block).toContain("- rule b");
    expect(block).not.toContain("- rule a");
  });

  it("returns '' when the resolved project has no rules file", async () => {
    const id = await seedProject("Analytics", WS);
    expect(
      await resolveDbtRulesBlockForTurn({
        workspaceId: WS.toString(),
        userId: USER,
        dbtProjectId: id,
      }),
    ).toBe("");
  });

  it("never crosses the workspace boundary", async () => {
    const foreignId = await seedProject("Foreign", OTHER_WS, "- leaked");
    expect(
      await resolveDbtRulesBlockForTurn({
        workspaceId: WS.toString(),
        userId: USER,
        dbtProjectId: foreignId,
      }),
    ).toBe("");
  });

  it("returns '' for a malformed project id instead of throwing", async () => {
    await seedProject("Analytics", WS, "- rule a");
    expect(
      await resolveDbtRulesBlockForTurn({
        workspaceId: WS.toString(),
        userId: USER,
        dbtProjectId: "not-an-object-id",
      }),
    ).toBe("");
  });
});
