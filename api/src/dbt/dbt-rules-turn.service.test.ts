/**
 * Turn-level .makorules resolution: hinted project > sole workspace project >
 * nothing. Runs against an ephemeral Mongo so the DbtProject lookups are real.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

import { resolveDbtRulesBlockForTurn } from "./dbt-rules-turn.service";
import {
  DbtFile,
  DbtFileDraft,
  DbtProject,
} from "../database/workspace-schema";

let mongo: MongoMemoryServer;
const WS = new Types.ObjectId();
const OTHER_WS = new Types.ObjectId();
const CONN = new Types.ObjectId();
const USER = "u1";

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await Promise.all([
    DbtFile.deleteMany({}),
    DbtFileDraft.deleteMany({}),
    DbtProject.deleteMany({}),
  ]);
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
    await DbtFile.create({
      workspaceId,
      projectId: project._id,
      path: ".makorules.md",
      content: rules,
      updatedBy: "tester",
    });
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
