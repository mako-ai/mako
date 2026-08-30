/**
 * Workspace repos — unit tests (Mongo only; no GitHub network).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  connectWorkspaceRepo,
  disconnectWorkspaceRepo,
  isValidRepoSegment,
  listWorkspaceRepos,
} from "./workspace-repos.service";
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

describe("connect / list / disconnect", () => {
  it("connects a repo and normalizes the Mako root ('' = repo root)", async () => {
    const binding = await connectWorkspaceRepo({
      workspaceId,
      owner: "realadvisor",
      repo: "test-mako-apps",
      defaultBranch: "main",
      subdirectory: "/mako/",
      linkedBy: "u1",
    });
    expect(binding.owner).toBe("realadvisor");
    expect(binding.subdirectory).toBe("mako");
    expect(binding.provider).toBe("github");

    const repos = await listWorkspaceRepos(workspaceId);
    expect(repos).toHaveLength(1);
    expect(repos[0].repo).toBe("test-mako-apps");

    await disconnectWorkspaceRepo(workspaceId, "realadvisor", "test-mako-apps");
    expect(await listWorkspaceRepos(workspaceId)).toHaveLength(0);
  });

  it("defaults the Mako root to '' and treats '/' as root", async () => {
    const root = await connectWorkspaceRepo({
      workspaceId,
      owner: "o",
      repo: "r",
      defaultBranch: "main",
      linkedBy: "u1",
    });
    expect(root.subdirectory).toBe("");
    // Re-connecting the SAME repo with "/" normalizes to root.
    const slash = await connectWorkspaceRepo({
      workspaceId,
      owner: "o",
      repo: "r",
      defaultBranch: "main",
      subdirectory: "/",
      linkedBy: "u1",
    });
    expect(slash.subdirectory).toBe("");
  });

  it("enforces one repo per workspace (§10) and upserts the same repo in place", async () => {
    await connectWorkspaceRepo({
      workspaceId,
      owner: "o",
      repo: "a",
      defaultBranch: "main",
      linkedBy: "u1",
    });
    // Connecting a DIFFERENT repo while one exists is refused.
    await expect(
      connectWorkspaceRepo({
        workspaceId,
        owner: "o",
        repo: "b",
        defaultBranch: "main",
        linkedBy: "u1",
      }),
    ).rejects.toThrow(/exactly one repository/);
    // Reconnecting "a" with a new root updates in place, no duplicate.
    await connectWorkspaceRepo({
      workspaceId,
      owner: "o",
      repo: "a",
      defaultBranch: "dev",
      subdirectory: "mako",
      linkedBy: "u1",
    });
    const repos = await listWorkspaceRepos(workspaceId);
    expect(repos).toHaveLength(1);
    expect(repos[0].defaultBranch).toBe("dev");
    expect(repos[0].subdirectory).toBe("mako");
    // getWorkspaceRepo is the singular read API.
    const { getWorkspaceRepo } = await import("./workspace-repos.service");
    expect((await getWorkspaceRepo(workspaceId))?.repo).toBe("a");
  });

  it("falls back to the legacy appsRepo binding until migrated", async () => {
    await Workspace.updateOne(
      { _id: new Types.ObjectId(workspaceId) },
      {
        $set: {
          appsRepo: {
            provider: "github",
            owner: "legacy",
            repo: "old",
            defaultBranch: "main",
            subdirectory: "",
          },
        },
      },
    );
    const repos = await listWorkspaceRepos(workspaceId);
    expect(repos).toHaveLength(1);
    expect(repos[0].owner).toBe("legacy");
    // §10: the legacy binding counts as THE workspace repo — a different
    // repo is refused until it is disconnected.
    await expect(
      connectWorkspaceRepo({
        workspaceId,
        owner: "o",
        repo: "new",
        defaultBranch: "main",
        linkedBy: "u1",
      }),
    ).rejects.toThrow(/exactly one repository/);
    await disconnectWorkspaceRepo(workspaceId, "legacy", "old");
    await connectWorkspaceRepo({
      workspaceId,
      owner: "o",
      repo: "new",
      defaultBranch: "main",
      linkedBy: "u1",
    });
    const ws = await Workspace.findById(workspaceId).lean();
    expect(ws?.appsRepo).toBeUndefined();
    expect(ws?.workspaceRepos).toHaveLength(1);
    expect(ws?.workspaceRepos?.[0].repo).toBe("new");
  });

  it("rejects invalid owner/repo names", async () => {
    await expect(
      connectWorkspaceRepo({
        workspaceId,
        owner: "bad/owner",
        repo: "r",
        defaultBranch: "main",
        linkedBy: "u1",
      }),
    ).rejects.toThrow(/Invalid owner or repo/);
  });

  it("requires the installation to belong to the workspace (cross-tenant guard)", async () => {
    await expect(
      connectWorkspaceRepo({
        workspaceId,
        owner: "o",
        repo: "r",
        defaultBranch: "main",
        installationId: 999,
        linkedBy: "u1",
      }),
    ).rejects.toThrow(/installation not found/i);

    await GitHubInstallation.create({
      workspaceId: new Types.ObjectId(workspaceId),
      installationId: 999,
      accountLogin: "realadvisor",
      accountType: "Organization",
      repositorySelection: "selected",
      createdBy: "u1",
    });
    const binding = await connectWorkspaceRepo({
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
