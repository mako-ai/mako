/**
 * A stale local tip must not delete a dbt job.
 *
 * `syncDbtConfigNow` reconciles Mongo against the repo by deleting every job
 * row whose file is absent from the tree it read. That is correct only if the
 * tree it read is current. The local bare repo is a CACHE — `ensureLocalRepo`
 * returns early once the directory exists and never refreshes it — so on a
 * long-lived Cloud Run instance "the repo is present" says nothing about
 * whether it is up to date, and a push that arrived at GitHub from somebody's
 * laptop is invisible here until something fetches it.
 *
 * So the failure this guards is not a stale read, it is a destructive one: a
 * job added on the mirror is missing from the stale tree, its row is deleted,
 * and its schedule is deregistered with it. Nothing else in the system would
 * notice, because deleting a job whose file is gone is exactly what this code
 * is supposed to do.
 *
 * Lives in its own file rather than joining dbt-config.service.test.ts
 * because it needs the connected-mirror mocks, and `vi.mock` is file-wide —
 * pulling them into the existing suite would put every case there behind a
 * mirror it does not want. Covered by vitest.config.ts's `src/dbt/**` glob.
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

import { DbtJob, DbtProject } from "../database/workspace-schema";
import { runGit } from "../apps/git";
import { mirrorPushNow } from "../apps/cloud-repo.service";
import {
  DEFAULT_BRANCH,
  commitBlobsOnBranch,
  initRepo,
  repoDirFor,
} from "../apps/repository.service";
import { jobFilePath, serializeJobFile } from "./dbt-config-files";
import {
  adoptDbtConfig,
  reserveJobSlug,
  syncDbtConfigFromRepo,
} from "./dbt-config.service";

let mongo: MongoMemoryServer;
let tmpRoot: string;
let remotesRoot: string;
// A fresh workspace per test. cloud-repo.service keeps per-workspace state —
// the mirror push is coalesced and fire-and-forget, so a push queued by one
// test can execute during the next one, against that test's mirror, from a
// repo mid-clone. Sharing one id makes the two cases fail each other in ways
// that have nothing to do with what they assert.
let WS: Types.ObjectId;
const CONN = new Types.ObjectId();

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dbt-freshen-test-"));
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
  await Promise.all([DbtProject.deleteMany({}), DbtJob.deleteMany({})]);
  await fs.rm(path.join(tmpRoot, "repos"), { recursive: true, force: true });
  await fs.rm(remotesRoot, { recursive: true, force: true });
  state.binding = null;
  process.env.APPS_CONNECTED_REPO_PUSH = "allow";
});

async function seedProject() {
  return DbtProject.create({
    workspaceId: WS,
    name: "Analytics",
    dbtVersion: "1.9",
    environments: [
      {
        name: "prod",
        connectionId: CONN,
        targetSchema: "dbt_prod",
        threads: 8,
      },
    ],
    defaultEnvironment: "prod",
    createdBy: "u1",
  });
}

function jobYaml(name: string): string {
  return serializeJobFile({
    name,
    environment: "prod",
    commands: ["build --select realadvisor"],
    schedule: { cron: "0 6 * * *", timezone: "Europe/Zurich" },
    enabled: true,
    deferToProduction: false,
  });
}

describe("a stale local tip", () => {
  it("does not delete a job whose file exists on the mirror", async () => {
    // The workspace has a connected mirror, and the local repo is a clone of
    // it that is about to fall behind.
    const remoteDir = path.join(remotesRoot, "acme", "warehouse.git");
    await fs.mkdir(path.dirname(remoteDir), { recursive: true });
    // Seeded, not empty: the local repo is a CLONE of this, so the mirror is
    // where main comes from.
    await initRepo(remoteDir, { "README.md": "warehouse\n" });
    state.binding = { owner: "acme", repo: "warehouse" };

    const project = await seedProject();
    const kept = await DbtJob.create({
      workspaceId: WS,
      projectId: project._id,
      slug: await reserveJobSlug(project._id, "Nightly build"),
      name: "Nightly build",
      environment: "prod",
      commands: ["build --select realadvisor"],
      schedule: { cron: "0 6 * * *", timezone: "Europe/Zurich" },
      enabled: true,
      createdBy: "u1",
    });
    // Adoption writes the environments file and this job's file, and pushes.
    await adoptDbtConfig(WS.toString());
    // adoptDbtConfig already queued the mirror push; await THAT rather than
    // pushing by hand, which races it for the same ref lock. mirrorPushNow
    // shares the per-workspace serialization the queued push uses.
    await mirrorPushNow(WS.toString());

    // A colleague adds a second job from their laptop: it lands on GitHub,
    // and this instance's cache knows nothing about it.
    const added = await DbtJob.create({
      workspaceId: WS,
      projectId: project._id,
      slug: "laptop-added",
      name: "Laptop added",
      environment: "prod",
      commands: ["build --select realadvisor"],
      schedule: { cron: "0 7 * * *", timezone: "Europe/Zurich" },
      enabled: true,
      createdBy: "u2",
    });
    await commitBlobsOnBranch(
      remoteDir,
      DEFAULT_BRANCH,
      { writes: { [jobFilePath("laptop-added")]: jobYaml("Laptop added") } },
      { message: "add a job from a laptop" },
    );

    // The local tip is now genuinely behind the mirror — the precondition.
    const localBefore = (
      await runGit([
        "-C",
        repoDirFor(WS.toString()),
        "rev-parse",
        `refs/heads/${DEFAULT_BRANCH}`,
      ])
    ).stdout.trim();
    const remoteHead = (
      await runGit([
        "-C",
        remoteDir,
        "rev-parse",
        `refs/heads/${DEFAULT_BRANCH}`,
      ])
    ).stdout.trim();
    expect(localBefore).not.toBe(remoteHead);

    await syncDbtConfigFromRepo(WS.toString());

    // Without the freshen the sync reads the stale tree, does not see
    // laptop-added.yml, and deletes the row — silently, and taking the
    // schedule with it.
    expect(await DbtJob.findById(added._id)).not.toBeNull();
    expect(await DbtJob.findById(kept._id)).not.toBeNull();
    // …and the cache caught up rather than merely being read around.
    const localAfter = (
      await runGit([
        "-C",
        repoDirFor(WS.toString()),
        "rev-parse",
        `refs/heads/${DEFAULT_BRANCH}`,
      ])
    ).stdout.trim();
    expect(localAfter).toBe(remoteHead);
  });

  it("still deletes a job whose file was genuinely removed on the mirror", async () => {
    // The freshen must not turn the reconciler off: a file deleted on the
    // mirror must still delete its row, or a stale-tip fix would quietly
    // become "never delete anything".
    const remoteDir = path.join(remotesRoot, "acme", "warehouse2.git");
    await fs.mkdir(path.dirname(remoteDir), { recursive: true });
    await initRepo(remoteDir, { "README.md": "warehouse\n" });
    state.binding = { owner: "acme", repo: "warehouse2" };

    const project = await seedProject();
    const doomed = await DbtJob.create({
      workspaceId: WS,
      projectId: project._id,
      slug: await reserveJobSlug(project._id, "Doomed job"),
      name: "Doomed job",
      environment: "prod",
      commands: ["build --select realadvisor"],
      schedule: { cron: "0 6 * * *", timezone: "Europe/Zurich" },
      enabled: true,
      createdBy: "u1",
    });
    await adoptDbtConfig(WS.toString());
    // adoptDbtConfig already queued the mirror push; await THAT rather than
    // pushing by hand, which races it for the same ref lock. mirrorPushNow
    // shares the per-workspace serialization the queued push uses.
    await mirrorPushNow(WS.toString());

    await commitBlobsOnBranch(
      remoteDir,
      DEFAULT_BRANCH,
      { deletes: [jobFilePath(doomed.slug!)] },
      { message: "remove the job on the mirror" },
    );

    await syncDbtConfigFromRepo(WS.toString());
    expect(await DbtJob.findById(doomed._id)).toBeNull();
  });
});
