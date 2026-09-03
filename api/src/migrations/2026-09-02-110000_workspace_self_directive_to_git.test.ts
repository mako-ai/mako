/**
 * The self-directive cutover must copy Mongo into git for a bound workspace
 * before the later unset migration can drop the field. An existing file wins;
 * a workspace without a GitHub binding is skipped (leftover local git is not
 * a store).
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { initRepo, repoDirFor } from "../apps/repository.service";
import { readWorkspaceSelfDirectiveFile } from "../apps/workspace-prompt";
import {
  bindTestWorkspaceRepo,
  unbindTestWorkspaceRepo,
} from "../apps/bind-test-workspace-repo";
import { Workspace } from "../database/workspace-schema";
import { up } from "./2026-09-02-110000_workspace_self_directive_to_git";

let mongo: MongoMemoryServer;
let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "self-directive-mig-"));
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  process.env.APPS_SANDBOX_PROVIDER = "local";
  delete process.env.APPS_REQUIRE_CONNECTED_REPO;
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await fs.rm(path.join(tmpRoot, "repos"), { recursive: true, force: true });
  await mongoose.connection.collection("workspaces").deleteMany({});
});

async function nativeDb() {
  const db = mongoose.connection.db;
  if (!db) throw new Error("mongoose is not connected");
  return db;
}

describe("self-directive Mongo → git cutover", () => {
  it("copies a non-empty selfDirective into SELF_DIRECTIVE.md when GitHub is bound", async () => {
    const ws = await Workspace.create({
      name: "Bound",
      slug: `bound-${Date.now()}`,
      createdBy: "u1",
      settings: {},
      billing: {},
    });
    const workspaceId = ws._id.toString();
    await bindTestWorkspaceRepo(workspaceId);
    await initRepo(repoDirFor(workspaceId), { "README.md": "x\n" });
    const db = await nativeDb();
    await db
      .collection("workspaces")
      .updateOne(
        { _id: ws._id },
        { $set: { selfDirective: "Never drop prod\n" } },
      );

    await up(db);

    expect(await readWorkspaceSelfDirectiveFile(workspaceId)).toBe(
      "Never drop prod\n",
    );
    const still = await db
      .collection("workspaces")
      .findOne({ _id: ws._id }, { projection: { selfDirective: 1 } });
    expect(still?.selfDirective).toBe("Never drop prod\n");
  });

  it("does not overwrite an existing SELF_DIRECTIVE.md", async () => {
    const ws = await Workspace.create({
      name: "Existing",
      slug: `existing-${Date.now()}`,
      createdBy: "u1",
      settings: {},
      billing: {},
    });
    const workspaceId = ws._id.toString();
    await bindTestWorkspaceRepo(workspaceId);
    await initRepo(repoDirFor(workspaceId), {
      "SELF_DIRECTIVE.md": "authored in git\n",
    });
    const db = await nativeDb();
    await db
      .collection("workspaces")
      .updateOne(
        { _id: ws._id },
        { $set: { selfDirective: "stale mongo blob\n" } },
      );

    await up(db);

    expect(await readWorkspaceSelfDirectiveFile(workspaceId)).toBe(
      "authored in git\n",
    );
  });

  it("skips a repo-less workspace even when leftover local git exists", async () => {
    const ws = await Workspace.create({
      name: "Orphan",
      slug: `orphan-${Date.now()}`,
      createdBy: "u1",
      settings: {},
      billing: {},
    });
    const workspaceId = ws._id.toString();
    await unbindTestWorkspaceRepo(workspaceId);
    await initRepo(repoDirFor(workspaceId), { "README.md": "x\n" });
    const db = await nativeDb();
    await db
      .collection("workspaces")
      .updateOne(
        { _id: ws._id },
        { $set: { selfDirective: "would be lost\n" } },
      );

    await up(db);

    expect(await readWorkspaceSelfDirectiveFile(workspaceId)).toBeNull();
  });
});
