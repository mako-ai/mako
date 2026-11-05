/**
 * dbt working-tree reads and writes against a local clone that is behind its
 * mirror — the multi-instance case.
 *
 * Every API instance keeps its own bare clone; GitHub is the source of truth.
 * "Another instance committed" is simulated by committing straight to the
 * file:// mirror, which is exactly what this instance sees when a sibling's
 * mirror push lands.
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

const state = vi.hoisted(() => ({
  binding: null as null | { owner: string; repo: string },
}));

vi.mock("../services/workspace-repos.service", () => ({
  getWorkspaceRepo: vi.fn(async () => state.binding),
  findWorkspaceIdByRepoBinding: vi.fn(async () => null),
  findWorkspaceIdsByRepoBinding: vi.fn(async () => []),
}));
vi.mock("../integrations/github/app-auth", () => ({
  resolveRepoToken: async () => undefined,
}));

import { DbtProject, type IDbtProject } from "../database/workspace-schema";
import { runGit } from "../apps/git";
import { ensureLocalRepo, mirrorPushNow } from "../apps/cloud-repo.service";
import {
  DEFAULT_BRANCH,
  commitBlobsOnBranch,
  initRepo,
} from "../apps/repository.service";
import {
  DbtSaveNotMirroredError,
  listWorkingFiles,
  loadWorkingTreeContents,
  readWorkingFile,
  resolveWorkingTreeCommit,
  writeWorkingFile,
} from "./dbt-working-tree.service";
import { listJobDefinitionsAtMain } from "./dbt-config.service";

let mongo: MongoMemoryServer;
let tmpRoot: string;
let remotesRoot: string;
let WS: Types.ObjectId;
let remoteDir: string;
const USER = "u1";

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dbt-wt-freshen-"));
  remotesRoot = path.join(tmpRoot, "remotes");
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  process.env.APPS_GITHUB_REMOTE_BASE = `file://${remotesRoot}`;
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
  WS = new Types.ObjectId();
  await DbtProject.deleteMany({});
  process.env.APPS_CONNECTED_REPO_PUSH = "allow";
  const repo = `ws-${WS.toString()}`;
  remoteDir = path.join(remotesRoot, "acme", `${repo}.git`);
  await fs.mkdir(path.dirname(remoteDir), { recursive: true });
  state.binding = { owner: "acme", repo };
});

async function seedProject(): Promise<IDbtProject> {
  return DbtProject.create({
    workspaceId: WS,
    name: "Analytics",
    dbtVersion: "1.9",
    environments: [
      {
        name: "prod",
        connectionId: new Types.ObjectId(),
        targetSchema: "dbt_prod",
        threads: 8,
      },
    ],
    defaultEnvironment: "prod",
    createdBy: USER,
  });
}

/** A sibling instance's commit, as this instance sees it: on the mirror only. */
async function commitOnMirror(writes: Record<string, string>): Promise<void> {
  await commitBlobsOnBranch(
    remoteDir,
    DEFAULT_BRANCH,
    { writes },
    { message: "commit from another instance" },
  );
}

async function mirrorMainFiles(): Promise<string[]> {
  const { stdout } = await runGit([
    "-C",
    remoteDir,
    "ls-tree",
    "-r",
    "--name-only",
    DEFAULT_BRANCH,
  ]);
  return stdout.split("\n").filter(Boolean);
}

describe("dbt working tree behind its mirror", () => {
  it("lists and reads what another instance committed", async () => {
    await initRepo(remoteDir, { "dbt/dbt_project.yml": "name: a\n" });
    await ensureLocalRepo(WS.toString());
    const project = await seedProject();

    await commitOnMirror({ "dbt/models/orders.sql": "select 2\n" });

    const files = (await listWorkingFiles(project, USER)).map(f => f.path);
    expect(files).toContain("models/orders.sql");
    expect(
      (await readWorkingFile(project, USER, "models/orders.sql"))?.content,
    ).toBe("select 2\n");
    const tree = await loadWorkingTreeContents(project, {});
    expect(tree.map(f => f.path)).toContain("models/orders.sql");
  });

  it("keeps a save made while this instance was behind", async () => {
    await initRepo(remoteDir, { "dbt/dbt_project.yml": "name: a\n" });
    await ensureLocalRepo(WS.toString());
    const project = await seedProject();

    await commitOnMirror({ "dbt/models/sibling.sql": "select 1\n" });
    const result = await writeWorkingFile(
      project,
      USER,
      "models/mine.sql",
      "select 3\n",
    );
    expect(result.commitOid).toBeTruthy();
    await mirrorPushNow(WS.toString()).catch(() => undefined);

    // Both saves reported success, so both must be on the mirror's main.
    const onMirror = await mirrorMainFiles();
    expect(onMirror).toContain("dbt/models/sibling.sql");
    expect(onMirror).toContain("dbt/models/mine.sql");
  });

  it("recovers a clone made while the mirror was still empty", async () => {
    // This instance cloned the brand-new, empty GitHub repo…
    await runGit(["init", "--bare", "--quiet", remoteDir]);
    await ensureLocalRepo(WS.toString());
    const project = await seedProject();
    // …then a sibling instance seeded main and created the project.
    await fs.rm(remoteDir, { recursive: true, force: true });
    await initRepo(remoteDir, { "dbt/dbt_project.yml": "name: a\n" });

    const files = (await listWorkingFiles(project, USER)).map(f => f.path);
    expect(files).toContain("dbt_project.yml");
    await expect(
      writeWorkingFile(project, USER, "models/x.sql", "select 1\n"),
    ).resolves.toBeTruthy();
  });

  it("fails a save the mirror refuses instead of reporting success", async () => {
    await initRepo(remoteDir, { "dbt/dbt_project.yml": "name: a\n" });
    await ensureLocalRepo(WS.toString());
    const project = await seedProject();
    // The mirror rejects every push, the way GitHub rejects one that is not a
    // fast-forward or that a branch protection rule blocks.
    const hook = path.join(remoteDir, "hooks", "pre-receive");
    await fs.writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });

    await expect(
      writeWorkingFile(project, USER, "models/x.sql", "select 1\n"),
    ).rejects.toBeInstanceOf(DbtSaveNotMirroredError);
  });

  it("lists a job file another instance committed", async () => {
    await initRepo(remoteDir, { "dbt/dbt_project.yml": "name: a\n" });
    await ensureLocalRepo(WS.toString());

    await commitOnMirror({ "dbt/jobs/nightly.yml": "name: Nightly\n" });

    const defs = await listJobDefinitionsAtMain(WS.toString());
    expect(defs.map(d => d.slug)).toContain("nightly");
  });

  it("pins a run to the mirror's head, not this instance's", async () => {
    await initRepo(remoteDir, { "dbt/dbt_project.yml": "name: a\n" });
    await ensureLocalRepo(WS.toString());
    const project = await seedProject();

    await commitOnMirror({ "dbt/models/new.sql": "select 1\n" });
    const mirrorHead = (
      await runGit(["-C", remoteDir, "rev-parse", DEFAULT_BRANCH])
    ).stdout.trim();

    expect(await resolveWorkingTreeCommit(project, {})).toBe(mirrorHead);
  });
});
