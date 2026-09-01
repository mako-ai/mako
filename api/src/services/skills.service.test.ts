/**
 * Skill discipline (apps.md §22): agent saves are proposals, the per-turn
 * index is capped, and the exposure counter is separate from the honest
 * use counter. Real bare repo + mongodb-memory-server, embeddings off.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Skill } from "../database/workspace-schema";
import {
  initRepo,
  readBlob,
  repoDirFor,
  DEFAULT_BRANCH,
} from "../apps/repository.service";
import { retrieveRelevantSkills, saveSkill } from "./skills.service";

let mongo: MongoMemoryServer;
let tmpRoot: string;
const WS = new Types.ObjectId().toString();

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "skills-discipline-"));
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  process.env.APPS_SANDBOX_PROVIDER = "local";
  delete process.env.APPS_REQUIRE_CONNECTED_REPO;
  delete process.env.OPENAI_API_KEY;
  delete process.env.AI_GATEWAY_API_KEY;
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await Skill.deleteMany({});
  await fs.rm(path.join(tmpRoot, "repos"), { recursive: true, force: true });
  await initRepo(repoDirFor(WS), { "README.md": "x\n" });
});

const input = (name: string) => ({
  name,
  loadWhen: `when asked about ${name}`,
  body: `How to handle ${name}.`,
});

describe("agent saves are proposals", () => {
  it("a NEW agent-origin skill starts suppressed in Mongo AND in the file", async () => {
    const result = await saveSkill(WS, input("mrr_walkthrough"), "agent", {
      origin: "agent",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.skill.pendingApproval).toBe(true);

    const row = await Skill.findOne({ name: "mrr_walkthrough" });
    expect(row?.suppressed).toBe(true);
    const blob = await readBlob(
      repoDirFor(WS),
      `refs/heads/${DEFAULT_BRANCH}`,
      "skills/mrr_walkthrough/SKILL.md",
    );
    expect(blob.contents).toContain("suppressed: true");

    // Suppressed proposals never reach the injected index.
    const retrieval = await retrieveRelevantSkills(WS, "mrr walkthrough");
    expect(retrieval.index.some(e => e.name === "mrr_walkthrough")).toBe(false);
  });

  it("a user-origin save is active immediately; agent UPDATES keep state", async () => {
    const user = await saveSkill(WS, input("churn_definitions"), "u1", {
      origin: "user",
    });
    expect(user.success && !user.skill.pendingApproval).toBe(true);
    expect(
      (await Skill.findOne({ name: "churn_definitions" }))?.suppressed,
    ).toBe(false);

    // Agent improving the existing ACTIVE skill must not deactivate it.
    const update = await saveSkill(
      WS,
      { ...input("churn_definitions"), body: "Better body." },
      "agent",
      { origin: "agent" },
    );
    expect(update.success).toBe(true);
    expect(
      (await Skill.findOne({ name: "churn_definitions" }))?.suppressed,
    ).toBe(false);
  });
});

describe("index cap + honest counters", () => {
  it("shows at most 30 workspace entries and reports the omission count", async () => {
    for (let i = 0; i < 35; i++) {
      await Skill.create({
        workspaceId: new Types.ObjectId(WS),
        name: `skill_${i}`,
        loadWhen: `topic ${i}`,
        body: "b",
        entities: [],
        scopeType: "workspace",
        createdBy: "u1",
        suppressed: false,
        useCount: 0,
      });
    }
    const result = await retrieveRelevantSkills(WS, "anything at all");
    const workspaceShown = result.index.filter(e => e.scope === "workspace");
    expect(workspaceShown.length).toBe(30);
    expect(result.omittedFromIndex).toBe(5);
  });

  it("auto-injection bumps injectedCount, never useCount", async () => {
    await Skill.create({
      workspaceId: new Types.ObjectId(WS),
      name: "stripe_mrr_churn",
      loadWhen: "stripe mrr churn analysis",
      body: "the playbook",
      entities: ["stripe", "mrr", "churn"],
      scopeType: "workspace",
      createdBy: "u1",
      suppressed: false,
      useCount: 0,
    });
    const result = await retrieveRelevantSkills(WS, "analyze stripe mrr churn");
    expect(result.injected.map(i => i.name)).toContain("stripe_mrr_churn");
    // The bump is fire-and-forget; give it a beat.
    await new Promise(r => setTimeout(r, 150));
    const row = await Skill.findOne({ name: "stripe_mrr_churn" });
    expect(row?.injectedCount).toBe(1);
    expect(row?.useCount).toBe(0);
  });
});
