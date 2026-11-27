/**
 * Workspace repo bindings and disconnect cleanup without GitHub network access.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  connectWorkspaceRepo,
  disconnectWorkspaceRepo,
  findWorkspaceIdsByRepoBinding,
  getWorkspaceRepo,
  isValidRepoSegment,
  storedBindings,
  WorkspaceRepoNotBoundError,
} from "./workspace-repos.service";
import {
  consoleFolders,
  githubInstallations,
  savedConsoles,
  workspaces,
} from "../database/pg/schema";
import { Flow } from "../database/workspace-schema";
import { dbtRepo } from "../repositories/dbt";
import {
  mongoWorkspaceToRecord,
  workspaceRecordToPgRow,
} from "../repositories/workspaces/mapper";
import { workspaceRepo } from "../repositories/workspaces";
import {
  ensureTestWorkspace,
  ensureTestUser,
  setupPgTestDb,
  type PgTestDb,
  type TestWorkspace,
} from "../test-support/pg-test";

/** The workspace's repo binding as a list: [] when unbound (§10: at most one). */
async function boundRepos(workspaceId: string) {
  const repo = await getWorkspaceRepo(workspaceId);
  return repo ? [repo] : [];
}

let pg: PgTestDb;
let mongo: MongoMemoryServer;
let workspace: TestWorkspace;
let workspaceId: string;

beforeAll(async () => {
  pg = await setupPgTestDb();
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await pg?.close();
  await mongoose.disconnect();
  await mongo?.stop();
});

beforeEach(async () => {
  await Promise.all([pg.reset(), Flow.deleteMany({})]);
  workspace = await ensureTestWorkspace(pg.db, { ownerUserId: "u1" });
  workspaceId = workspace.id;
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

    const repos = await boundRepos(workspaceId);
    expect(repos).toHaveLength(1);
    expect(repos[0].repo).toBe("test-mako-apps");

    await disconnectWorkspaceRepo(workspaceId, "realadvisor", "test-mako-apps");
    expect(await boundRepos(workspaceId)).toHaveLength(0);
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
    const repos = await boundRepos(workspaceId);
    expect(repos).toHaveLength(1);
    expect(repos[0].defaultBranch).toBe("dev");
    expect(repos[0].subdirectory).toBe("mako");
    // getWorkspaceRepo is the singular read API.
    const { getWorkspaceRepo } = await import("./workspace-repos.service");
    expect((await getWorkspaceRepo(workspaceId))?.repo).toBe("a");
  });

  it("lists every binding a pre-§10 workspace still holds", async () => {
    const binding = (repo: string) => ({
      provider: "github" as const,
      owner: "acme",
      repo,
      defaultBranch: "main",
      subdirectory: "",
    });
    await pg.db
      .update(workspaces)
      .set({ workspaceRepos: [binding("a"), binding("b")] })
      .where(eq(workspaces.id, workspace.uuid));
    // Both are shown (connect refuses while either exists), while the
    // singular read still answers with the first.
    const all = await storedBindings(workspaceId);
    expect(all.map(r => r.repo)).toEqual(["a", "b"]);
    expect((await getWorkspaceRepo(workspaceId))?.repo).toBe("a");
  });

  it("uses a migrated legacy appsRepo binding until it is disconnected", async () => {
    const legacyWorkspace = mongoWorkspaceToRecord({
      _id: new Types.ObjectId(workspaceId),
      name: "Legacy",
      slug: workspace.slug,
      createdBy: "u1",
      appsRepo: {
        provider: "github",
        owner: "legacy",
        repo: "old",
        defaultBranch: "main",
        subdirectory: "",
      },
    });
    const migrated = workspaceRecordToPgRow(legacyWorkspace, () => null);
    await pg.db
      .update(workspaces)
      .set({ workspaceRepos: migrated.workspaceRepos })
      .where(eq(workspaces.id, workspace.uuid));
    const repos = await boundRepos(workspaceId);
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
    const row = await workspaceRepo.findById(workspaceId);
    expect(row).not.toHaveProperty("appsRepo");
    expect(row?.workspaceRepos).toHaveLength(1);
    expect(row?.workspaceRepos?.[0].repo).toBe("new");
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

    const installer = await ensureTestUser(pg.db, { id: "u1" });
    await pg.db.insert(githubInstallations).values({
      workspaceId: workspace.uuid,
      installationId: 999,
      accountLogin: "realadvisor",
      accountType: "Organization",
      repositorySelection: "selected",
      createdBy: installer.id,
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

describe("git is the only store (issue #956)", () => {
  it("fans out webhook routing to every workspace bound to the same repo", async () => {
    const other = await ensureTestWorkspace(pg.db, { ownerUserId: "u1" });
    await connectWorkspaceRepo({
      workspaceId,
      owner: "mako-ai",
      repo: "test-workspace",
      defaultBranch: "main",
      linkedBy: "u1",
    });
    await connectWorkspaceRepo({
      workspaceId: other.id,
      owner: "mako-ai",
      repo: "test-workspace",
      defaultBranch: "main",
      linkedBy: "u1",
    });
    const ids = await findWorkspaceIdsByRepoBinding(
      "mako-ai",
      "test-workspace",
    );
    expect(ids.sort()).toEqual([workspaceId, other.id].sort());
  });

  it("a mismatched unlink does not purge derived content or drop the binding", async () => {
    await connectWorkspaceRepo({
      workspaceId,
      owner: "mako-ai",
      repo: "test-workspace",
      defaultBranch: "main",
      linkedBy: "u1",
    });
    await Flow.create({
      workspaceId: new Types.ObjectId(workspaceId),
      type: "scheduled",
      slug: "keep",
      name: "Keep",
      sourceType: "database",
      databaseSource: {
        connectionId: new Types.ObjectId(),
        database: "demo",
        query: "select 1",
      },
      destinationDatabaseId: new Types.ObjectId(),
      syncMode: "full",
      schedule: { enabled: false },
      createdBy: "u1",
    });
    await expect(
      disconnectWorkspaceRepo(workspaceId, "mako-ai", "typo-workspace"),
    ).rejects.toBeInstanceOf(WorkspaceRepoNotBoundError);
    expect(await Flow.countDocuments({ workspaceId })).toBe(1);
    const repos = await boundRepos(workspaceId);
    expect(repos).toHaveLength(1);
    expect(repos[0].owner).toBe("mako-ai");
    expect(repos[0].repo).toBe("test-workspace");
  });

  it("disconnect purges derived flow index rows", async () => {
    await connectWorkspaceRepo({
      workspaceId,
      owner: "mako-ai",
      repo: "test-workspace",
      defaultBranch: "main",
      linkedBy: "u1",
    });
    await Flow.create({
      workspaceId: new Types.ObjectId(workspaceId),
      type: "scheduled",
      slug: "gone",
      name: "Gone",
      sourceType: "database",
      databaseSource: {
        connectionId: new Types.ObjectId(),
        database: "demo",
        query: "select 1",
      },
      destinationDatabaseId: new Types.ObjectId(),
      syncMode: "full",
      schedule: { enabled: false },
      createdBy: "u1",
    });
    expect(await Flow.countDocuments({ workspaceId })).toBe(1);
    await disconnectWorkspaceRepo(workspaceId, "mako-ai", "test-workspace");
    expect(await Flow.countDocuments({ workspaceId })).toBe(0);
    expect(await boundRepos(workspaceId)).toHaveLength(0);
  });

  it("disconnect purges every console row and folder, not only saved files", async () => {
    await connectWorkspaceRepo({
      workspaceId,
      owner: "mako-ai",
      repo: "test-workspace",
      defaultBranch: "main",
      linkedBy: "u1",
    });
    const user = await ensureTestUser(pg.db, { id: "u1" });
    await pg.db.insert(consoleFolders).values({
      workspaceId: workspace.uuid,
      name: "scratch",
      isPrivate: false,
      access: "workspace",
    });
    await pg.db.insert(savedConsoles).values([
      {
        workspaceId: workspace.uuid,
        name: "draft.sql",
        code: "select 1",
        language: "sql",
        isSaved: false,
        createdBy: user.id,
        ownerId: user.id,
        access: "private",
        isPrivate: true,
      },
      {
        workspaceId: workspace.uuid,
        name: "saved.sql",
        code: "select 2",
        language: "sql",
        isSaved: true,
        createdBy: user.id,
        ownerId: user.id,
        access: "workspace",
        isPrivate: false,
      },
    ]);
    await disconnectWorkspaceRepo(workspaceId, "mako-ai", "test-workspace");
    expect(
      await pg.db
        .select()
        .from(savedConsoles)
        .where(eq(savedConsoles.workspaceId, workspace.uuid)),
    ).toHaveLength(0);
    expect(
      await pg.db
        .select()
        .from(consoleFolders)
        .where(eq(consoleFolders.workspaceId, workspace.uuid)),
    ).toHaveLength(0);
  });

  it("disconnect deletes dbt project rows, not just their environments", async () => {
    await connectWorkspaceRepo({
      workspaceId,
      owner: "mako-ai",
      repo: "test-workspace",
      defaultBranch: "main",
      linkedBy: "u1",
    });
    await dbtRepo.createProject({
      workspaceId,
      name: "ghost",
      createdBy: "u1",
      environments: [
        {
          name: "dev",
          connectionId: String(new Types.ObjectId()),
          targetSchema: "analytics",
          threads: 4,
        },
      ],
    });
    expect(await dbtRepo.listProjectsByWorkspace(workspaceId)).toHaveLength(1);
    await disconnectWorkspaceRepo(workspaceId, "mako-ai", "test-workspace");
    expect(await dbtRepo.listProjectsByWorkspace(workspaceId)).toHaveLength(0);
  });
});
