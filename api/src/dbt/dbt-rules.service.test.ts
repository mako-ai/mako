/**
 * .makorules resolution + rendering.
 *
 * Runs the REAL working-tree service against an ephemeral mongodb-memory-server
 * so draft-over-base precedence is exercised for real: a user's uncommitted
 * .makorules draft must govern their own agent turns before it is committed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

import {
  DBT_RULES_MAX_CHARS,
  DBT_RULES_PATHS,
  renderDbtRulesBlock,
  resolveDbtRules,
} from "./dbt-rules.service";
import {
  DbtFile,
  DbtFileDraft,
  DbtProject,
  type IDbtProject,
} from "../database/workspace-schema";

let mongo: MongoMemoryServer;
const WS = new Types.ObjectId();
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

async function seedProject(): Promise<IDbtProject> {
  const project = await DbtProject.create({
    workspaceId: WS,
    name: "Analytics",
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
    repo: {
      provider: "github",
      owner: "acme",
      repo: "analytics",
      branch: "main",
      installationId: 123,
    },
  });
  return project as unknown as IDbtProject;
}

async function seedBase(project: IDbtProject, path: string, content: string) {
  await DbtFile.create({
    workspaceId: project.workspaceId,
    projectId: project._id,
    branch: "main",
    path,
    content,
    updatedBy: "sync",
  });
}

describe("resolveDbtRules", () => {
  it("returns null when the project has no rules file", async () => {
    const project = await seedProject();
    await seedBase(project, "models/a.sql", "select 1");
    expect(await resolveDbtRules(project, USER)).toBeNull();
  });

  it("reads .makorules.md", async () => {
    const project = await seedProject();
    await seedBase(project, ".makorules.md", "- never select *");
    expect(await resolveDbtRules(project, USER)).toEqual({
      path: ".makorules.md",
      contents: "- never select *",
      truncated: false,
    });
  });

  it("falls back to .makorules when .makorules.md is absent", async () => {
    const project = await seedProject();
    await seedBase(project, ".makorules", "- snake_case only");
    expect(await resolveDbtRules(project, USER)).toEqual({
      path: ".makorules",
      contents: "- snake_case only",
      truncated: false,
    });
  });

  it("prefers .makorules.md when both exist", async () => {
    const project = await seedProject();
    await seedBase(project, ".makorules.md", "markdown wins");
    await seedBase(project, ".makorules", "bare loses");
    const rules = await resolveDbtRules(project, USER);
    expect(rules?.path).toBe(".makorules.md");
    expect(rules?.contents).toBe("markdown wins");
  });

  it("treats a whitespace-only rules file as absent", async () => {
    const project = await seedProject();
    await seedBase(project, ".makorules.md", "   \n\t\n  ");
    expect(await resolveDbtRules(project, USER)).toBeNull();
  });

  it("falls through to .makorules when .makorules.md is blank", async () => {
    const project = await seedProject();
    await seedBase(project, ".makorules.md", "  \n ");
    await seedBase(project, ".makorules", "- real rules");
    expect((await resolveDbtRules(project, USER))?.path).toBe(".makorules");
  });

  it("lets an uncommitted user draft shadow the committed base", async () => {
    const project = await seedProject();
    await seedBase(project, ".makorules.md", "committed rules");
    await DbtFileDraft.create({
      workspaceId: project.workspaceId,
      projectId: project._id,
      userId: USER,
      branch: "main",
      path: ".makorules.md",
      content: "draft rules",
    });
    expect((await resolveDbtRules(project, USER))?.contents).toBe(
      "draft rules",
    );
  });

  it("truncates oversized rules and flags it", async () => {
    const project = await seedProject();
    await seedBase(
      project,
      ".makorules.md",
      "x".repeat(DBT_RULES_MAX_CHARS + 500),
    );
    const rules = await resolveDbtRules(project, USER);
    expect(rules?.truncated).toBe(true);
    expect(rules?.contents).toHaveLength(DBT_RULES_MAX_CHARS);
  });

  it("exposes the recognized paths in precedence order", () => {
    expect(DBT_RULES_PATHS).toEqual([".makorules.md", ".makorules"]);
  });
});

describe("renderDbtRulesBlock", () => {
  const rules = {
    path: ".makorules.md",
    contents: "- never select *",
    truncated: false,
  };

  it("names the file, the project, and the precedence order", () => {
    const block = renderDbtRulesBlock(rules, "Analytics");
    expect(block).toContain(".makorules.md");
    expect(block).toContain("Analytics");
    expect(block).toContain("- never select *");
    expect(block.toLowerCase()).toContain("binding");
    // Project rules outrank the workspace prompt and the dbt skill.
    expect(block.indexOf("project rules")).toBeLessThan(
      block.indexOf("workspace instructions"),
    );
  });

  it("marks truncated rules explicitly", () => {
    const block = renderDbtRulesBlock(
      { ...rules, truncated: true },
      "Analytics",
    );
    expect(block).toContain("truncated");
    expect(block).toContain(String(DBT_RULES_MAX_CHARS));
  });

  it("does not mark untruncated rules", () => {
    expect(renderDbtRulesBlock(rules, "Analytics")).not.toContain("truncated");
  });
});
