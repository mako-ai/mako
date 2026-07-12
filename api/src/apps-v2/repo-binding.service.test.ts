/**
 * Apps v2 repo binding — unit tests (Mongo only; no GitHub network).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  getAppsRepoBinding,
  isValidRepoSegment,
  linkAppsRepo,
  unlinkAppsRepo,
} from "./repo-binding.service";
import { GitHubInstallation, Workspace } from "../database/workspace-schema";

let mongo: MongoMemoryServer;
let workspaceId: string;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await mongoose.connection.collection("workspaces").deleteMany({});
  await mongoose.connection.collection("github_installations").deleteMany({});
  const ws = await Workspace.create({
    name: "Test",
    slug: `test-${Date.now()}`,
    createdBy: "u1",
    settings: {},
    billing: {},
  });
  workspaceId = ws._id.toString();
});

describe("isValidRepoSegment", () => {
  it("accepts normal names, rejects traversal/odd chars", () => {
    expect(isValidRepoSegment("realadvisor")).toBe(true);
    expect(isValidRepoSegment("test-mako-apps")).toBe(true);
    expect(isValidRepoSegment("..")).toBe(false);
    expect(isValidRepoSegment("a/b")).toBe(false);
    expect(isValidRepoSegment("a b")).toBe(false);
  });
});

describe("link / get / unlink", () => {
  it("links a public repo (no installation) and normalizes the subdirectory", async () => {
    const binding = await linkAppsRepo({
      workspaceId,
      owner: "realadvisor",
      repo: "test-mako-apps",
      defaultBranch: "main",
      subdirectory: "/apps/",
      linkedBy: "u1",
    });
    expect(binding.owner).toBe("realadvisor");
    expect(binding.subdirectory).toBe("apps");
    expect(binding.provider).toBe("github");

    const fetched = await getAppsRepoBinding(workspaceId);
    expect(fetched?.repo).toBe("test-mako-apps");
    expect(fetched?.defaultBranch).toBe("main");

    await unlinkAppsRepo(workspaceId);
    expect(await getAppsRepoBinding(workspaceId)).toBeNull();
  });

  it("defaults subdirectory to 'apps'", async () => {
    const binding = await linkAppsRepo({
      workspaceId,
      owner: "o",
      repo: "r",
      defaultBranch: "main",
      linkedBy: "u1",
    });
    expect(binding.subdirectory).toBe("apps");
  });

  it("rejects invalid owner/repo names", async () => {
    await expect(
      linkAppsRepo({
        workspaceId,
        owner: "bad/owner",
        repo: "r",
        defaultBranch: "main",
        linkedBy: "u1",
      }),
    ).rejects.toThrow(/Invalid owner or repo/);
  });

  it("requires the installation to belong to the workspace (cross-tenant guard)", async () => {
    // installationId not registered for this workspace -> reject
    await expect(
      linkAppsRepo({
        workspaceId,
        owner: "o",
        repo: "r",
        defaultBranch: "main",
        installationId: 999,
        linkedBy: "u1",
      }),
    ).rejects.toThrow(/installation not found/i);

    // Register it, then linking succeeds.
    await GitHubInstallation.create({
      workspaceId: new Types.ObjectId(workspaceId),
      installationId: 999,
      accountLogin: "realadvisor",
      accountType: "Organization",
      repositorySelection: "selected",
      createdBy: "u1",
    });
    const binding = await linkAppsRepo({
      workspaceId,
      owner: "o",
      repo: "r",
      defaultBranch: "main",
      installationId: 999,
      linkedBy: "u1",
    });
    expect(binding.installationId).toBe(999);
  });
});
