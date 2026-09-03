/**
 * Data bindings — resolving ONE binding's artifact key.
 *
 * The serving path (`__data/<name>.parquet`) resolves a key per request, and
 * it used to do that by reading every binding file in the app. Each read
 * re-resolves the actor's source — including a "is a sandbox live?" probe over
 * the network — so an app with sixteen bindings paid sixteen of them to answer
 * one small parquet request. These specs pin the two properties that made the
 * narrow read safe: it agrees with the all-bindings read, and a malformed
 * NEIGHBOUR no longer decides whether a healthy binding has data.
 *
 * Real git, a real local sandbox and mongodb-memory-server, like the worktree
 * suite next door — the point is that reads go through the same source
 * resolution the API uses.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  bindingArtifactKey,
  bindingArtifactKeyByName,
  readBindings,
} from "./bindings.service";
import { createProject, ensureWorktree, writeFile } from "./worktree.service";
import { initRepo, repoDirFor } from "./repository.service";
import { seededTemplateFiles } from "./workspace-template";
import { bindTestWorkspaceRepo } from "./bind-test-workspace-repo";
import { startTestGitServer, type TestGitServer } from "./test-git-server";

let mongo: MongoMemoryServer;
let tmpRoot: string;
let gitServer: TestGitServer;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "apps-bindings-test-"));
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  process.env.APPS_SESSIONS_ROOT = path.join(tmpRoot, "sessions");
  process.env.APPS_SANDBOX_PROVIDER = "local";
  process.env.SESSION_SECRET =
    process.env.SESSION_SECRET || "test-secret-for-git-tokens";
  gitServer = await startTestGitServer();
  process.env.APPS_GIT_ORIGIN_URL = gitServer.url;
  // Hermetic: a configured cloud org must never make createProject reach
  // GitHub from a test (e.g. when the shell exports .env).
  delete process.env.MAKO_CLOUD_GITHUB_ORG;
  delete process.env.MAKO_CLOUD_GITHUB_APP_ID;
  delete process.env.MAKO_CLOUD_GITHUB_APP_PRIVATE_KEY;

  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await gitServer?.close();
  await mongoose.disconnect();
  await mongo.stop();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

const WS = new Types.ObjectId().toString();
const USER = "user-1";

beforeEach(async () => {
  await mongoose.connection.collection("app_projects").deleteMany({});
  await mongoose.connection.collection("app_worktrees").deleteMany({});
  await fs.rm(path.join(tmpRoot, "repos"), { recursive: true, force: true });
  await fs.rm(path.join(tmpRoot, "sessions"), { recursive: true, force: true });
  await initRepo(repoDirFor(WS), seededTemplateFiles());
  await bindTestWorkspaceRepo(WS);
});

async function projectWithBindings(files: Record<string, string>) {
  const project = await createProject({
    workspaceId: WS,
    title: "Bindings App",
    userId: USER,
  });
  const handle = await ensureWorktree(project, USER);
  for (const [name, source] of Object.entries(files)) {
    await writeFile(handle, `bindings/${name}.sql`, source);
  }
  return project;
}

describe("bindingArtifactKeyByName", () => {
  it("gives the same key the all-bindings read would", async () => {
    const project = await projectWithBindings({
      revenue: "-- connection: conn-a\nSELECT 1 AS n\n",
      churn: "-- connection: conn-b\n-- materialization: parquet\nSELECT 2\n",
    });

    const all = await readBindings(project, USER);
    expect(all.map(b => b.name).sort()).toEqual(["churn", "revenue"]);
    for (const binding of all) {
      await expect(
        bindingArtifactKeyByName(project, binding.name, USER),
      ).resolves.toBe(bindingArtifactKey(binding));
    }
  });

  it("strips front matter before hashing, so the key is the query's", async () => {
    const project = await projectWithBindings({
      revenue: "-- connection: conn-a\n-- schedule: 0 6 * * *\nSELECT 1 AS n\n",
    });

    await expect(
      bindingArtifactKeyByName(project, "revenue", USER),
    ).resolves.toBe(
      bindingArtifactKey({ connectionId: "conn-a", code: "SELECT 1 AS n" }),
    );
  });

  it("is not taken down by a malformed neighbour", async () => {
    const project = await projectWithBindings({
      revenue: "-- connection: conn-a\nSELECT 1 AS n\n",
      broken: "SELECT 2\n", // no `-- connection:` front matter
    });

    // Reading every binding still refuses, as it always did...
    await expect(readBindings(project, USER)).rejects.toThrow(/no connection/);
    // ...but the healthy binding's data no longer depends on its neighbour.
    await expect(
      bindingArtifactKeyByName(project, "revenue", USER),
    ).resolves.toBe(
      bindingArtifactKey({ connectionId: "conn-a", code: "SELECT 1 AS n" }),
    );
    // The malformed one still says why, rather than reading as "no such data".
    await expect(
      bindingArtifactKeyByName(project, "broken", USER),
    ).rejects.toThrow(/no connection/);
  });

  it("returns null for a name that is not a binding", async () => {
    const project = await projectWithBindings({
      revenue: "-- connection: conn-a\nSELECT 1 AS n\n",
    });

    await expect(
      bindingArtifactKeyByName(project, "not_a_binding", USER),
    ).resolves.toBeNull();
    // A traversal attempt is a name that does not match, not a read.
    await expect(
      bindingArtifactKeyByName(project, "../../etc/passwd", USER),
    ).resolves.toBeNull();
  });
});
