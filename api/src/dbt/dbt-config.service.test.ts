/**
 * dbt orchestration config as files (apps.md §23): write-through, push-sync
 * reconciliation, adoption. Real bare repo + mongodb-memory-server.
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

// A stand-in mirror (see flow-sync.repo.test.ts): when set, only that
// commit verifies as the mirror's main; unset, the real check runs.
const mirror = vi.hoisted(() => ({ main: null as string | null }));
vi.mock("../apps/cloud-repo.service", async importOriginal => {
  const actual =
    await importOriginal<typeof import("../apps/cloud-repo.service")>();
  return {
    ...actual,
    assertTreeAtMirrorMain: async (workspaceId: string, sha: string) => {
      if (mirror.main === null) {
        return actual.assertTreeAtMirrorMain(workspaceId, sha);
      }
      if (sha !== mirror.main) {
        throw new actual.TreeNotVerifiedError(
          `Refusing: read at ${sha.slice(0, 8)} but the mirror's main is ${mirror.main.slice(0, 8)}`,
        );
      }
    },
  };
});
// A hook inside the sync's per-job schedule registration: lets a test land
// a rename while a push sync is between reading its tree and sweeping.
const scheduleHook = vi.hoisted(() => ({
  fn: null as null | (() => Promise<void>),
}));
vi.mock("./dbt-run.service", async importOriginal => {
  const actual = await importOriginal<typeof import("./dbt-run.service")>();
  return {
    ...actual,
    applyJobScheduleChange: async (
      job: Parameters<typeof actual.applyJobScheduleChange>[0],
    ) => {
      const fn = scheduleHook.fn;
      scheduleHook.fn = null;
      if (fn) await fn();
      return actual.applyJobScheduleChange(job);
    },
  };
});
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { DbtJob, DbtProject } from "../database/workspace-schema";
import {
  DEFAULT_BRANCH,
  blobOid,
  commitBlobsOnBranch,
  initRepo,
  readBlob,
  repoDirFor,
  resolveCommit,
} from "../apps/repository.service";
import {
  DBT_ENVIRONMENTS_PATH,
  jobFilePath,
  parseJobFile,
  serializeEnvironmentsFile,
  serializeJobFile,
} from "./dbt-config-files";
import {
  adoptDbtConfig,
  commitDbtEnvironmentsFile,
  commitDbtJobFile,
  deleteDbtJobFile,
  derivedJobId,
  ensureEnvironmentsDerivedCache,
  loadLiveJobById,
  loadLiveJobs,
  liveJobToPlain,
  reserveJobSlug,
  resetJobFreshenOnMissThrottle,
  resolveLiveJobRow,
  syncDbtConfigFromRepo,
} from "./dbt-config.service";
import {
  bindTestWorkspaceRepo,
  unbindTestWorkspaceRepo,
} from "../apps/bind-test-workspace-repo";

let mongo: MongoMemoryServer;
let tmpRoot: string;
const WS = new Types.ObjectId();
const CONN = new Types.ObjectId();
const MAIN = `refs/heads/${DEFAULT_BRANCH}`;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dbt-config-test-"));
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
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
  mirror.main = null;
  delete process.env.APPS_GITHUB_REMOTE_BASE;
  delete process.env.APPS_CONNECTED_REPO_PUSH;
  resetJobFreshenOnMissThrottle();
  await Promise.all([DbtProject.deleteMany({}), DbtJob.deleteMany({})]);
  await fs.rm(path.join(tmpRoot, "repos"), { recursive: true, force: true });
  await initRepo(repoDirFor(WS.toString()), { "README.md": "x\n" });
  await bindTestWorkspaceRepo(WS.toString());
});

async function seedProject() {
  return DbtProject.create({
    workspaceId: WS,
    name: "Analytics",
    dbtVersion: "1.9",
    environments: [
      { name: "dev", connectionId: CONN, targetSchema: "dbt_dev", threads: 4 },
      {
        name: "prod",
        connectionId: CONN,
        targetSchema: "dbt_prod",
        threads: 8,
      },
    ],
    defaultEnvironment: "dev",
    createdBy: "u1",
  });
}

async function seedJob(project: { _id: Types.ObjectId }, name: string) {
  return DbtJob.create({
    workspaceId: WS,
    projectId: project._id,
    slug: await reserveJobSlug(project._id, name),
    name,
    environment: "prod",
    commands: ["build --select realadvisor"],
    schedule: { cron: "0 6 * * *", timezone: "Europe/Zurich" },
    enabled: true,
    createdBy: "u1",
  });
}

async function fileAt(rel: string): Promise<string | null> {
  try {
    const blob = await readBlob(repoDirFor(WS.toString()), MAIN, rel);
    return blob.isBinary ? null : blob.contents;
  } catch {
    return null;
  }
}

describe("format round-trip", () => {
  it("serialize/parse preserves the definition", () => {
    const file = {
      name: "Nightly build",
      environment: "prod",
      commands: ["build --select realadvisor", "test"],
      schedule: { cron: "0 6 * * *", timezone: "Europe/Zurich" },
      enabled: true,
      deferToProduction: true,
    };
    expect(parseJobFile(serializeJobFile(file))).toEqual(file);
  });

  it("rejects half a schedule and empty commands", () => {
    expect(parseJobFile("name: x\nenvironment: e\ncommands: []\n")).toBeNull();
    expect(
      parseJobFile(
        "name: x\nenvironment: e\ncommands: [build]\nschedule:\n  cron: '* * * * *'\n",
      ),
    ).toBeNull();
  });
});

describe("write-through", () => {
  it("commitDbtJobFile writes dbt/jobs/<slug>.yml and stamps the sha", async () => {
    const project = await seedProject();
    const job = await seedJob(project, "Nightly prod build");
    await commitDbtJobFile(project, job);
    const contents = await fileAt(jobFilePath(job.slug!));
    expect(contents).toContain("Nightly prod build");
    expect(contents).toContain("cron: 0 6 * * *");
    const fresh = await DbtJob.findById(job._id);
    expect(fresh?.sourceBlobSha).toBeTruthy();

    await deleteDbtJobFile(project, job.slug);
    expect(await fileAt(jobFilePath(job.slug!))).toBeNull();
  });

  it("commitDbtJobFile throws when there is no GitHub repo bound and does not stamp the row", async () => {
    // No binding → 412, even if a leftover local git directory exists.
    await unbindTestWorkspaceRepo(WS.toString());
    const project = await seedProject();
    const job = await seedJob(project, "Nightly");
    await expect(commitDbtJobFile(project, job)).rejects.toMatchObject({
      name: "RepoRequiredError",
      status: 412,
    });
    const fresh = await DbtJob.findById(job._id);
    expect(fresh?.sourceBlobSha).toBeFalsy();
  });
});

describe("GET/list from git", () => {
  it("returns empty for unbound leftover git and Mongo", async () => {
    const project = await seedProject();
    const job = await seedJob(project, "Mongo only");
    await commitDbtJobFile(project, job);
    await unbindTestWorkspaceRepo(WS.toString());
    expect(await loadLiveJobs(project)).toEqual([]);
  });

  it("includes git-only jobs and omits Mongo-only rows", async () => {
    const project = await seedProject();
    await seedJob(project, "Mongo only");
    const contents = serializeJobFile({
      name: "Git only",
      environment: "prod",
      commands: ["build"],
      schedule: null,
      enabled: true,
      deferToProduction: false,
    });
    await commitBlobsOnBranch(
      repoDirFor(WS.toString()),
      DEFAULT_BRANCH,
      { writes: { [jobFilePath("git-only")]: contents } },
      { message: "git-only job" },
    );
    const live = await loadLiveJobs(project);
    expect(live.map(job => job.def.slug)).toEqual(["git-only"]);
    expect(live[0]?.row).toBeNull();
    expect(liveJobToPlain(live[0]!, project)).toMatchObject({
      name: "Git only",
    });
    expect(await DbtJob.countDocuments({ projectId: project._id })).toBe(1);
  });

  it("resyncs a stale existing row without creating or scheduling", async () => {
    const project = await seedProject();
    const job = await seedJob(project, "Nightly");
    await commitDbtJobFile(project, job);
    const edited = serializeJobFile({
      name: "Renamed in git",
      environment: "prod",
      commands: ["test"],
      schedule: null,
      enabled: false,
      deferToProduction: false,
    });
    await commitBlobsOnBranch(
      repoDirFor(WS.toString()),
      DEFAULT_BRANCH,
      { writes: { [jobFilePath(job.slug!)]: edited } },
      { message: "edit job" },
    );
    const live = await loadLiveJobs(project);
    expect(liveJobToPlain(live[0]!, project).name).toBe("Renamed in git");
    const fresh = await DbtJob.findById(job._id);
    expect(fresh?.commands).toEqual(["test"]);
    expect(fresh?.scheduledRun?.nextAt).toBeUndefined();
    expect(await DbtJob.countDocuments({ projectId: project._id })).toBe(1);
  });

  it("keeps last-good fields but never presents invalid YAML as live", async () => {
    const project = await seedProject();
    const job = await seedJob(project, "Nightly");
    await commitDbtJobFile(project, job);
    await commitBlobsOnBranch(
      repoDirFor(WS.toString()),
      DEFAULT_BRANCH,
      { writes: { [jobFilePath(job.slug!)]: "name: [broken" } },
      { message: "break yaml" },
    );
    const live = await loadLiveJobs(project);
    const plain = liveJobToPlain(live[0]!, project);
    expect(plain.definitionInvalid).toBeTruthy();
    expect(plain.name).toBe("Nightly");
    expect((await DbtJob.findById(job._id))?.commands).toEqual([
      "build --select realadvisor",
    ]);
    expect(await loadLiveJobById(project, job._id.toString())).not.toBeNull();
  });

  it("a cron edited in git and listed before the push is still re-registered", async () => {
    const project = await seedProject();
    const job = await seedJob(project, "Nightly"); // 0 6 Europe/Zurich
    await commitDbtJobFile(project, job);
    await commitBlobsOnBranch(
      repoDirFor(WS.toString()),
      DEFAULT_BRANCH,
      {
        writes: {
          [jobFilePath(job.slug!)]: serializeJobFile({
            name: "Nightly",
            environment: "prod",
            commands: ["build --select realadvisor"],
            schedule: { cron: "0 9 * * *", timezone: "UTC" },
            enabled: true,
            deferToProduction: false,
          }),
        },
      },
      { message: "move nightly to 09:00 UTC" },
    );
    // The list stamps the row level with the new blob...
    await loadLiveJobs(project);
    const listed = await DbtJob.findById(job._id);
    expect(listed?.schedule?.cron).toBe("0 9 * * *");
    expect(listed?.scheduledRun?.nextAt?.getUTCHours()).toBe(9);
    // ...so push-sync skips it; the registration above must already hold.
    await syncDbtConfigFromRepo(WS.toString());
    const synced = await DbtJob.findById(job._id);
    expect(synced?.scheduledRun?.nextAt?.getUTCHours()).toBe(9);
  });

  it("a bad cron or timezone is flagged in the list and skipped by push-sync without aborting it", async () => {
    const project = await seedProject();
    const file = (schedule: { cron: string; timezone: string }) =>
      serializeJobFile({
        name: "Scheduled",
        environment: "prod",
        commands: ["build"],
        schedule,
        enabled: true,
        deferToProduction: false,
      });
    await commitBlobsOnBranch(
      repoDirFor(WS.toString()),
      DEFAULT_BRANCH,
      {
        writes: {
          // Sorted first so an abort would skip everything after it.
          [jobFilePath("aaa-bad-cron")]: file({
            cron: "99 99 99 99 99",
            timezone: "UTC",
          }),
          [jobFilePath("bad-timezone")]: file({
            cron: "0 9 * * *",
            timezone: "Nope/Zone",
          }),
          [jobFilePath("zzz-good")]: file({
            cron: "0 9 * * *",
            timezone: "UTC",
          }),
        },
      },
      { message: "three git-only jobs" },
    );
    const live = await loadLiveJobs(project);
    const plain = Object.fromEntries(
      live.map(item => [item.def.slug, liveJobToPlain(item, project)]),
    );
    expect(plain["aaa-bad-cron"].definitionInvalid).toMatchObject({
      reason: expect.stringMatching(/^invalid schedule/),
    });
    expect(plain["bad-timezone"].definitionInvalid).toMatchObject({
      reason: expect.stringMatching(/^invalid schedule/),
    });
    expect(plain["aaa-bad-cron"].commands).toEqual([]);
    expect(plain["aaa-bad-cron"].enabled).toBe(false);
    expect(plain["zzz-good"].definitionInvalid).toBeUndefined();

    await expect(syncDbtConfigFromRepo(WS.toString())).resolves.toBeUndefined();
    expect(await DbtJob.countDocuments({ projectId: project._id })).toBe(1);
    const good = await DbtJob.findOne({
      projectId: project._id,
      slug: "zzz-good",
    });
    expect(good?.scheduledRun?.nextAt?.getUTCHours()).toBe(9);
    // The id the list handed out before the push is the id of the row.
    expect(good?._id.toString()).toBe(
      live.find(item => item.def.slug === "zzz-good")!.id.toString(),
    );
    expect(good?._id.toString()).toBe(
      derivedJobId(WS.toString(), "zzz-good").toString(),
    );
  });

  it("reverting a broken file to its previous content clears the invalid marker", async () => {
    const project = await seedProject();
    const job = await seedJob(project, "Nightly");
    await commitDbtJobFile(project, job);
    const good = await fileAt(jobFilePath(job.slug!));
    await commitBlobsOnBranch(
      repoDirFor(WS.toString()),
      DEFAULT_BRANCH,
      { writes: { [jobFilePath(job.slug!)]: "name: [broken" } },
      { message: "break yaml" },
    );
    await loadLiveJobs(project);
    const at = (await DbtJob.findById(job._id))?.definitionInvalid?.at;
    expect(at).toBeInstanceOf(Date);
    // A second list call must not rewrite the marker.
    await loadLiveJobs(project);
    expect((await DbtJob.findById(job._id))?.definitionInvalid?.at).toEqual(at);
    await commitBlobsOnBranch(
      repoDirFor(WS.toString()),
      DEFAULT_BRANCH,
      { writes: { [jobFilePath(job.slug!)]: good! } },
      { message: "revert" },
    );
    await syncDbtConfigFromRepo(WS.toString());
    expect(
      (await DbtJob.findById(job._id))?.definitionInvalid?.reason,
    ).toBeUndefined();
  });
});

describe("environments follow dbt/environments.yml; jobs resolve through the overlay", () => {
  it("a project GET after an external environments edit shows the file, marks a broken one, and clears on revert", async () => {
    const project = await seedProject();
    await commitDbtEnvironmentsFile(project);
    const good = await fileAt(DBT_ENVIRONMENTS_PATH);
    expect(good).toContain("default_environment: dev");

    await commitBlobsOnBranch(
      repoDirFor(WS.toString()),
      DEFAULT_BRANCH,
      {
        writes: {
          [DBT_ENVIRONMENTS_PATH]: serializeEnvironmentsFile({
            defaultEnvironment: "staging",
            environments: [
              {
                name: "staging",
                connectionId: CONN.toString(),
                targetSchema: "dbt_staging",
                threads: 2,
              },
            ],
          }),
        },
      },
      { message: "laptop: staging only" },
    );
    await ensureEnvironmentsDerivedCache(project);
    expect(project.defaultEnvironment).toBe("staging");
    expect(project.environments.map(env => env.name)).toEqual(["staging"]);
    const stored = await DbtProject.findById(project._id);
    expect(stored?.environments.map(env => env.name)).toEqual(["staging"]);
    expect(stored?.environmentsInvalid?.reason).toBeUndefined();

    await commitBlobsOnBranch(
      repoDirFor(WS.toString()),
      DEFAULT_BRANCH,
      { writes: { [DBT_ENVIRONMENTS_PATH]: "environments: [broken" } },
      { message: "break environments" },
    );
    await ensureEnvironmentsDerivedCache(project);
    expect(project.environmentsInvalid?.reason).toBe(
      "unparseable environments.yml",
    );
    // Last-good kept.
    expect(project.environments.map(env => env.name)).toEqual(["staging"]);

    await commitBlobsOnBranch(
      repoDirFor(WS.toString()),
      DEFAULT_BRANCH,
      { writes: { [DBT_ENVIRONMENTS_PATH]: good! } },
      { message: "revert" },
    );
    await ensureEnvironmentsDerivedCache(project);
    expect(project.environmentsInvalid?.reason).toBeUndefined();
    expect(project.defaultEnvironment).toBe("dev");
    expect(
      (await DbtProject.findById(project._id))?.environmentsInvalid?.reason,
    ).toBeUndefined();
  });

  it("resolves a git-only job as 409, a synced one as ok, a deleted file as 404", async () => {
    const project = await seedProject();
    await commitBlobsOnBranch(
      repoDirFor(WS.toString()),
      DEFAULT_BRANCH,
      {
        writes: {
          [jobFilePath("only-git")]: serializeJobFile({
            name: "Only git",
            environment: "prod",
            commands: ["build"],
            schedule: null,
            enabled: true,
            deferToProduction: false,
          }),
        },
      },
      { message: "git-only job" },
    );
    const id = (await loadLiveJobs(project))[0]!.id.toString();
    const gitOnly = await resolveLiveJobRow(project, id);
    expect(gitOnly.ok).toBe(false);
    if (!gitOnly.ok) expect(gitOnly.status).toBe(409);

    await syncDbtConfigFromRepo(WS.toString());
    const synced = await resolveLiveJobRow(project, id);
    expect(synced.ok).toBe(true);

    await commitBlobsOnBranch(
      repoDirFor(WS.toString()),
      DEFAULT_BRANCH,
      { deletes: [jobFilePath("only-git")] },
      { message: "delete job file" },
    );
    const gone = await resolveLiveJobRow(project, id);
    expect(gone.ok).toBe(false);
    if (!gone.ok) expect(gone.status).toBe(404);
  });
});

describe("sync from repo", () => {
  it("an external job edit updates the row and re-registers the schedule; runtime fields survive", async () => {
    const project = await seedProject();
    const job = await seedJob(project, "Nightly prod build");
    await commitDbtJobFile(project, job);
    await DbtJob.updateOne(
      { _id: job._id },
      { $set: { "scheduledRun.consecutiveFailures": 3 } },
    );

    const edited = serializeJobFile({
      name: "Nightly prod build",
      environment: "prod",
      commands: ["build --select realadvisor --full-refresh"],
      schedule: { cron: "30 5 * * *", timezone: "Europe/Zurich" },
      enabled: true,
      deferToProduction: false,
    });
    await commitBlobsOnBranch(
      repoDirFor(WS.toString()),
      DEFAULT_BRANCH,
      { writes: { [jobFilePath(job.slug!)]: edited } },
      { message: "laptop edit" },
    );
    await syncDbtConfigFromRepo(WS.toString());

    const fresh = await DbtJob.findById(job._id);
    expect(fresh?.commands).toEqual([
      "build --select realadvisor --full-refresh",
    ]);
    expect(fresh?.schedule?.cron).toBe("30 5 * * *");
    expect(fresh?.scheduledRun?.nextAt).toBeInstanceOf(Date);
    expect(fresh?.scheduledRun?.consecutiveFailures).toBe(3);
  });

  it("a removed file removes the job; a disallowed command is skipped", async () => {
    const project = await seedProject();
    const job = await seedJob(project, "Doomed job");
    await commitDbtJobFile(project, job);
    const evil = serializeJobFile({
      name: "Evil",
      environment: "prod",
      commands: ["run-operation drop_everything"],
      schedule: null,
      enabled: true,
      deferToProduction: false,
    });
    await commitBlobsOnBranch(
      repoDirFor(WS.toString()),
      DEFAULT_BRANCH,
      {
        writes: { [jobFilePath("evil")]: evil },
        deletes: [jobFilePath(job.slug!)],
      },
      { message: "laptop mischief" },
    );
    await syncDbtConfigFromRepo(WS.toString());
    expect(await DbtJob.findById(job._id)).toBeNull();
    expect(await DbtJob.findOne({ slug: "evil" })).toBeNull();
  });

  it("environments.yml edits reach the project row", async () => {
    const project = await seedProject();
    await adoptDbtConfig(WS.toString());
    const raw = (await fileAt(DBT_ENVIRONMENTS_PATH))!;
    await commitBlobsOnBranch(
      repoDirFor(WS.toString()),
      DEFAULT_BRANCH,
      {
        writes: {
          [DBT_ENVIRONMENTS_PATH]: raw.replace(
            "target_schema: dbt_dev",
            "target_schema: dbt_dev_v2",
          ),
        },
      },
      { message: "laptop env edit" },
    );
    await syncDbtConfigFromRepo(WS.toString());
    const fresh = await DbtProject.findById(project._id);
    expect(fresh?.environments.find(e => e.name === "dev")?.targetSchema).toBe(
      "dbt_dev_v2",
    );
  });

  it("invalid job YAML is marked, not overwritten from Mongo", async () => {
    const project = await seedProject();
    const job = await seedJob(project, "Nightly prod build");
    await commitDbtJobFile(project, job);
    const before = await DbtJob.findById(job._id);
    const commands = [...(before?.commands ?? [])];
    await commitBlobsOnBranch(
      repoDirFor(WS.toString()),
      DEFAULT_BRANCH,
      {
        writes: {
          [jobFilePath(job.slug!)]: "this: is: not: valid: yaml: [",
        },
      },
      { message: "typo" },
    );
    await syncDbtConfigFromRepo(WS.toString());
    const after = await DbtJob.findById(job._id);
    expect(after?.definitionInvalid?.reason).toMatch(/unparseable/i);
    expect(after?.enabled).toBe(false);
    expect(after?.commands).toEqual(commands);
  });
});

describe("a moved job file is the same job (graceful rename)", () => {
  it("an added file whose aliases name the removed slug re-keys the row in place", async () => {
    const project = await seedProject();
    const job = await seedJob(project, "Nightly build");
    await commitDbtJobFile(project, job);
    const before = await DbtJob.findById(job._id);
    // Runtime the scheduler owns, keyed by the row: must survive the move.
    await DbtJob.updateOne(
      { _id: job._id },
      {
        $set: {
          "scheduledRun.runCount": 7,
          "scheduledRun.lastStatus": "success",
        },
      },
    );
    const moved = serializeJobFile({
      name: "Nightly build (renamed)",
      aliases: [job.slug!],
      environment: "prod",
      commands: ["build --select realadvisor"],
      schedule: { cron: "0 6 * * *", timezone: "Europe/Zurich" },
      enabled: true,
      deferToProduction: false,
    });
    await commitBlobsOnBranch(
      repoDirFor(WS.toString()),
      DEFAULT_BRANCH,
      {
        writes: { [jobFilePath("nightly")]: moved },
        deletes: [jobFilePath(job.slug!)],
      },
      { message: "laptop git mv" },
    );
    await syncDbtConfigFromRepo(WS.toString());

    const after = await DbtJob.findById(job._id);
    expect(after).not.toBeNull();
    expect(after!.slug).toBe("nightly");
    expect(after!.name).toBe("Nightly build (renamed)");
    expect(after!.aliases).toEqual([job.slug]);
    expect(after!.scheduledRun?.runCount).toBe(7);
    expect(after!.sourceBlobSha).not.toBe(before!.sourceBlobSha);
    // One row, not a second one under the new slug.
    expect(await DbtJob.countDocuments({ projectId: project._id })).toBe(1);
    // The old slug and the id both still resolve through the live list.
    const live = await loadLiveJobById(project, job._id.toString());
    expect(live?.row?._id.toString()).toBe(job._id.toString());
    // …and so does the id GET/list would have handed out for the new file
    // before the push synced.
    const derived = derivedJobId(WS.toString(), "nightly").toString();
    expect((await loadLiveJobById(project, derived))?.id.toString()).toBe(
      job._id.toString(),
    );
  }, 90_000);

  it("identical content under a new name is a rename; two candidates are not guessed", async () => {
    const project = await seedProject();
    const job = await seedJob(project, "Hourly");
    await commitDbtJobFile(project, job);
    const raw = (await fileAt(jobFilePath(job.slug!)))!;
    await commitBlobsOnBranch(
      repoDirFor(WS.toString()),
      DEFAULT_BRANCH,
      {
        writes: {
          [jobFilePath("hourly-v2")]: raw.replace(
            "name: Hourly",
            "name: Hourly v2",
          ),
        },
        deletes: [jobFilePath(job.slug!)],
      },
      { message: "copy + delete" },
    );
    await syncDbtConfigFromRepo(WS.toString());
    const renamed = await DbtJob.findById(job._id);
    expect(renamed?.slug).toBe("hourly-v2");
    expect(renamed?.aliases).toEqual(["hourly"]);
    // The write-through now carries the alias in the file, so a later edit
    // from the product never drops it.
    await commitDbtJobFile(project, renamed!);
    expect(await fileAt(jobFilePath("hourly-v2"))).toContain(
      "aliases:\n  - hourly",
    );

    // Ambiguous: two new files both claim the old slug → today's behaviour
    // (the row goes, both files become jobs), never a guess.
    const two = raw.replace("name: Hourly", "name: Hourly v3");
    await commitBlobsOnBranch(
      repoDirFor(WS.toString()),
      DEFAULT_BRANCH,
      {
        writes: {
          [jobFilePath("a")]: `aliases: [hourly-v2]\n${two}`,
          [jobFilePath("b")]: `aliases: [hourly-v2]\n${two}`,
        },
        deletes: [jobFilePath("hourly-v2")],
      },
      { message: "ambiguous" },
    );
    await syncDbtConfigFromRepo(WS.toString());
    expect(await DbtJob.findById(job._id)).toBeNull();
    expect(await DbtJob.countDocuments({ projectId: project._id })).toBe(2);
  }, 90_000);
});

describe("review findings (graceful rename)", () => {
  it("[1] a deleted job and an added job that builds something else are never paired", async () => {
    const project = await seedProject();
    const job = await seedJob(project, "Build CH");
    await commitDbtJobFile(project, job);
    await DbtJob.updateOne(
      { _id: job._id },
      { $set: { "scheduledRun.runCount": 9 } },
    );
    const other = serializeJobFile({
      name: "Build FR",
      environment: "dev", // different environment, different selection
      commands: ["build --select realadvisor_fr"],
      schedule: { cron: "0 6 * * *", timezone: "Europe/Zurich" },
      enabled: true,
      deferToProduction: false,
    });
    await commitBlobsOnBranch(
      repoDirFor(WS.toString()),
      DEFAULT_BRANCH,
      {
        writes: { [jobFilePath("build-fr")]: other },
        deletes: [jobFilePath(job.slug!)],
      },
      { message: "swap" },
    );
    await syncDbtConfigFromRepo(WS.toString());
    const fr = await DbtJob.findOne({
      projectId: project._id,
      slug: "build-fr",
    });
    expect(fr).not.toBeNull();
    expect(fr!._id.toString()).not.toBe(job._id.toString());
    expect(fr!.scheduledRun?.runCount ?? 0).toBe(0);
    expect(await DbtJob.findById(job._id)).toBeNull();
  }, 90_000);

  it("[2] a new file at a renamed git-born job's OLD slug: new id, no throw, later files still created, alias released", async () => {
    const { dbtJobRenameHandler } = await import("../rename/handlers/dbt-job");
    const { resolveDbtJobRef } = await import("../rename/dbt-job-rename");
    const project = await seedProject();
    const file = (name: string) =>
      serializeJobFile({
        name,
        environment: "prod",
        commands: ["build --select x"],
        schedule: null,
        enabled: true,
        deferToProduction: false,
      });
    const c = (writes: Record<string, string>) =>
      commitBlobsOnBranch(
        repoDirFor(WS.toString()),
        DEFAULT_BRANCH,
        { writes },
        { message: "push" },
      );
    await c({ [jobFilePath("nightly")]: file("Nightly") });
    await syncDbtConfigFromRepo(WS.toString());
    const nightly = await DbtJob.findOne({
      projectId: project._id,
      slug: "nightly",
    });
    expect(nightly!._id.toString()).toBe(
      derivedJobId(WS.toString(), "nightly").toString(),
    );
    await dbtJobRenameHandler.rename(
      { workspaceId: WS.toString() },
      { ref: "nightly", slug: "nightly-old" },
    );

    await c({
      [jobFilePath("nightly")]: file("Nightly v2"),
      [jobFilePath("zzz")]: file("Zzz"),
    });
    // A live file at main beats the alias, before its row exists.
    const gitOnly = await resolveDbtJobRef(
      { workspaceId: WS.toString() },
      "nightly",
    );
    expect(gitOnly?.via).toBe("current");
    expect(gitOnly?.id).not.toBe(nightly!._id.toString());

    await expect(syncDbtConfigFromRepo(WS.toString())).resolves.toBeUndefined();
    const rows = await DbtJob.find({ projectId: project._id });
    expect(rows.map(r => r.slug).sort()).toEqual([
      "nightly",
      "nightly-old",
      "zzz",
    ]);
    const v2 = rows.find(r => r.slug === "nightly")!;
    const old = rows.find(r => r.slug === "nightly-old")!;
    expect(v2._id.toString()).not.toBe(nightly!._id.toString());
    expect(v2._id.toString()).toBe(gitOnly?.id);
    expect(old._id.toString()).toBe(nightly!._id.toString());
    expect(old.aliases ?? []).toEqual([]);
    const live = await loadLiveJobs(project);
    expect(new Set(live.map(l => l.id.toString())).size).toBe(3);
    expect(
      (await resolveDbtJobRef({ workspaceId: WS.toString() }, "nightly"))?.id,
    ).toBe(v2._id.toString());
  }, 90_000);
});

describe("round 2: lost and racing renames (jobs)", () => {
  const file = (name: string, cron = "0 6 * * *", sel = "x") =>
    serializeJobFile({
      name,
      environment: "prod",
      commands: [`build --select ${sel}`],
      schedule: { cron, timezone: "UTC" },
      enabled: true,
      deferToProduction: false,
    });
  const c = (writes: Record<string, string>, deletes: string[] = []) =>
    commitBlobsOnBranch(
      repoDirFor(WS.toString()),
      DEFAULT_BRANCH,
      { writes, deletes },
      { message: "push" },
    );

  it("[r2-1] a rename landing during a push sync is not swept; the id survives the next sync", async () => {
    const { dbtJobRenameHandler } = await import("../rename/handlers/dbt-job");
    const project = await seedProject();
    await c({ [jobFilePath("nightly")]: file("Nightly") });
    await syncDbtConfigFromRepo(WS.toString());
    const id0 = (await DbtJob.findOne({
      projectId: project._id,
      slug: "nightly",
    }))!._id.toString();
    await c({ [jobFilePath("nightly")]: file("Nightly", "0 7 * * *") });
    scheduleHook.fn = async () => {
      await dbtJobRenameHandler.rename(
        { workspaceId: WS.toString() },
        { ref: "nightly", slug: "nightly-2" },
      );
    };
    await syncDbtConfigFromRepo(WS.toString());
    let rows = await DbtJob.find({ projectId: project._id });
    expect(rows.map(r => [r._id.toString(), r.slug])).toEqual([
      [id0, "nightly-2"],
    ]);
    await syncDbtConfigFromRepo(WS.toString());
    rows = await DbtJob.find({ projectId: project._id });
    expect(rows.map(r => [r._id.toString(), r.slug])).toEqual([
      [id0, "nightly-2"],
    ]);
    expect(rows[0].aliases).toEqual(["nightly"]);
  }, 90_000);

  it("[r2-3] a job rename commit that never reaches main: honoured for a while, then re-keyed back with the edits, same id", async () => {
    const { dbtJobRenameHandler } = await import("../rename/handlers/dbt-job");
    const { runGit } = await import("../apps/git");
    const project = await seedProject();
    await c({ [jobFilePath("nightly")]: file("Nightly") });
    await syncDbtConfigFromRepo(WS.toString());
    const row = await DbtJob.findOne({
      projectId: project._id,
      slug: "nightly",
    });
    const pre = await resolveCommit(repoDirFor(WS.toString()), MAIN);
    await dbtJobRenameHandler.rename(
      { workspaceId: WS.toString() },
      { ref: "nightly", slug: "nightly-2" },
    );
    await runGit([
      "-C",
      repoDirFor(WS.toString()),
      "update-ref",
      MAIN,
      pre as string,
    ]);
    await c({
      // The laptop edit changes the name and the cron — not the environment
      // or the commands: a file under the old name that builds something
      // else is a different job and is not re-keyed onto this row (#5).
      [jobFilePath("nightly")]: file("Nightly edited", "0 9 * * *", "x"),
    });

    await syncDbtConfigFromRepo(WS.toString());
    expect(
      (await DbtJob.find({ projectId: project._id })).map(r => r.slug),
    ).toEqual(["nightly-2"]);

    await DbtJob.updateOne(
      { _id: row!._id },
      { $set: { lastRenameAt: new Date(Date.now() - 11 * 60_000) } },
    );
    await syncDbtConfigFromRepo(WS.toString());
    const rows = await DbtJob.find({ projectId: project._id });
    expect(rows).toHaveLength(1);
    expect(rows[0]._id.toString()).toBe(row!._id.toString());
    expect(rows[0].slug).toBe("nightly");
    expect(rows[0].name).toBe("Nightly edited");
    expect(rows[0].schedule?.cron).toBe("0 9 * * *");
    expect(rows[0].lastRenameCommit).toBeUndefined();
    const live = await loadLiveJobs(project);
    expect(live.map(l => [l.def.slug, l.row?._id.toString()])).toEqual([
      ["nightly", row!._id.toString()],
    ]);
  }, 90_000);
});

describe("round 3: fixing a broken job file from the UI; auto-disable", () => {
  it("[r3-1] a broken push is marked with the blob seen; the UI save and the auto-disable write-through go through; an unseen edit is a 409 conflict", async () => {
    const { DbtConfigConflictError } = await import("./dbt-config.service");
    const project = await seedProject();
    const job = await seedJob(project, "Nightly");
    await commitDbtJobFile(project, job);
    await syncDbtConfigFromRepo(WS.toString());
    const good = (await DbtJob.findById(job._id))!.sourceBlobSha;

    const broken = "name: Nightly\nenvironment: prod\ncommands: []\n"; // no commands → unparseable
    await commitBlobsOnBranch(
      repoDirFor(WS.toString()),
      DEFAULT_BRANCH,
      { writes: { [jobFilePath(job.slug!)]: broken } },
      { message: "laptop breaks it" },
    );
    await syncDbtConfigFromRepo(WS.toString());
    let marked = await DbtJob.findById(job._id);
    expect(marked!.definitionInvalid?.reason).toBe("unparseable job file");
    expect(marked!.sourceBlobSha).toBe(good);
    expect(marked!.lastSeenBlobSha).toBe(blobOid(broken));
    // GET/list's resync marks the same blob (and a different broken blob
    // with the same reason would be recorded too).
    const broken2 = "name: Nightly\nenvironment: nope\ncommands:\n  - build\n"; // unknown environment
    await commitBlobsOnBranch(
      repoDirFor(WS.toString()),
      DEFAULT_BRANCH,
      { writes: { [jobFilePath(job.slug!)]: broken2 } },
      { message: "laptop breaks it differently" },
    );
    await loadLiveJobs(project);
    marked = await DbtJob.findById(job._id);
    expect(marked!.definitionInvalid?.reason).toMatch(/unknown environment/);
    expect(marked!.lastSeenBlobSha).toBe(blobOid(broken2));

    // The user fixes it in the UI (PATCH → commitDbtJobFile): allowed.
    marked!.name = "Nightly fixed";
    await expect(
      commitDbtJobFile(project, marked!, "u1"),
    ).resolves.toBeUndefined();
    const fixedFile = await fileAt(jobFilePath(job.slug!));
    expect(fixedFile).toContain("name: Nightly fixed");
    expect(marked!.lastSeenBlobSha).toBe(blobOid(fixedFile!));
    // The PATCH route then saves the doc and the marker clears on the next
    // resync of the (now valid) file.
    await marked!.save();
    await DbtJob.updateOne(
      { _id: job._id },
      { $unset: { definitionInvalid: 1 } },
    );
    await syncDbtConfigFromRepo(WS.toString());
    const fixed = await DbtJob.findById(job._id);
    expect(fixed!.definitionInvalid?.reason).toBeUndefined();
    expect(fixed!.name).toBe("Nightly fixed");

    // The scheduler's auto-disable path (inngest/functions/dbt-run.ts) on a
    // job whose file was once invalid: the write-through must succeed.
    fixed!.enabled = false;
    await expect(
      commitDbtJobFile(project, fixed!, undefined, "dbt: auto-disable job"),
    ).resolves.toBeUndefined();
    expect(await fileAt(jobFilePath(job.slug!))).toContain("enabled: false");

    // An edit nobody has seen yet is refused with the typed conflict.
    await commitBlobsOnBranch(
      repoDirFor(WS.toString()),
      DEFAULT_BRANCH,
      {
        writes: {
          [jobFilePath(job.slug!)]: fixedFile!.replace(
            "Nightly fixed",
            "Nightly from laptop",
          ),
        },
      },
      { message: "laptop edit" },
    );
    fixed!.name = "Nightly from a stale form";
    await expect(
      commitDbtJobFile(project, fixed!, "u1"),
    ).rejects.toBeInstanceOf(DbtConfigConflictError);
    expect(await fileAt(jobFilePath(job.slug!))).toContain(
      "Nightly from laptop",
    );
  }, 90_000);
});

describe("round 4: a non-UTF-8 job file is stored under git's own oid", () => {
  it("[r4-1] sync, GET/list and the write-through all use the raw-byte oid, so a Latin-1 job can still be saved", async () => {
    const { execFileSync } = await import("node:child_process");
    const { runGit } = await import("../apps/git");
    const { blobOidAt } = await import("../apps/repository.service");
    const project = await seedProject();
    const dir = repoDirFor(WS.toString());
    const text =
      "name: Café nightly\nenvironment: prod\ncommands:\n  - build --select x\n";
    const latin1 = Buffer.from(text, "latin1");
    expect(latin1.toString("utf8")).not.toBe(text);
    const oid = execFileSync(
      "git",
      ["-C", dir, "hash-object", "-w", "--stdin"],
      { input: latin1 },
    )
      .toString()
      .trim();
    const head = (await resolveCommit(dir, MAIN)) as string;
    const index = path.join(tmpRoot, `idx-${Date.now()}`);
    const env = { GIT_DIR: dir, GIT_INDEX_FILE: index };
    await runGit(["read-tree", head], { env, cwd: dir });
    await runGit(["update-index", "--index-info"], {
      env,
      cwd: dir,
      stdin: `100644 ${oid}\t${jobFilePath("cafe")}\n`,
    });
    const tree = (
      await runGit(["write-tree"], { env, cwd: dir })
    ).stdout.trim();
    const commit = (
      await runGit([
        "-C",
        dir,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "commit-tree",
        tree,
        "-p",
        head,
        "-m",
        "raw",
      ])
    ).stdout.trim();
    await runGit(["-C", dir, "update-ref", MAIN, commit]);
    await fs.rm(index, { force: true });

    await syncDbtConfigFromRepo(WS.toString());
    const row = await DbtJob.findOne({ projectId: project._id, slug: "cafe" });
    expect(row).not.toBeNull();
    expect(row!.sourceBlobSha).toBe(oid);
    expect(row!.lastSeenBlobSha).toBe(oid);
    expect(blobOid(latin1.toString("utf8"))).not.toBe(oid);
    expect(await blobOidAt(dir, commit, jobFilePath("cafe"))).toBe(oid);
    const live = await loadLiveJobs(project);
    expect(live.find(l => l.def.slug === "cafe")?.def.oid).toBe(oid);

    row!.name = "Café nightly (edited)";
    await expect(
      commitDbtJobFile(project, row!, "u1"),
    ).resolves.toBeUndefined();
    expect(await fileAt(jobFilePath("cafe"))).toContain(
      "Café nightly (edited)",
    );
  }, 90_000);
});

describe("final: a job rename whose commit is not on the mirror yet; creating onto a git-only slug", () => {
  const file = (name: string) =>
    `name: ${name}\nenvironment: prod\ncommands:\n  - build --select x\nschedule:\n  cron: "0 6 * * *"\n  timezone: UTC\n`;
  const c = (writes: Record<string, string>) =>
    commitBlobsOnBranch(
      repoDirFor(WS.toString()),
      DEFAULT_BRANCH,
      { writes },
      { message: "push" },
    );

  it("[final-1] the guard is not retired on the renaming instance's own main; a stale instance never deletes the renamed job", async () => {
    const { dbtJobRenameHandler } = await import("../rename/handlers/dbt-job");
    const { runGit } = await import("../apps/git");
    const project = await seedProject();
    await c({ [jobFilePath("nightly")]: file("Nightly") });
    await syncDbtConfigFromRepo(WS.toString());
    const orig = (await DbtJob.findOne({
      projectId: project._id,
      slug: "nightly",
    }))!;
    const dir = repoDirFor(WS.toString());
    const pre = (await resolveCommit(dir, MAIN)) as string;
    const renamed = await dbtJobRenameHandler.rename(
      { workspaceId: WS.toString() },
      { ref: "nightly", slug: "nightly-2" },
    );
    // Instance A, mirror still at `pre`: guard kept.
    mirror.main = pre;
    await syncDbtConfigFromRepo(WS.toString());
    expect((await DbtJob.findById(orig._id))?.lastRenameCommit).toBe(
      renamed.commit,
    );

    // Instance B on the mirror's main, objects never fetched: kept.
    await runGit(["-C", dir, "update-ref", MAIN, pre]);
    await runGit(["-C", dir, "reflog", "expire", "--expire=now", "--all"]);
    await runGit(["-C", dir, "gc", "--prune=now", "-q"]);
    await syncDbtConfigFromRepo(WS.toString());
    expect(
      (await DbtJob.find({ projectId: project._id })).map(r => [
        r._id.toString(),
        r.slug,
      ]),
    ).toEqual([[orig._id.toString(), "nightly-2"]]);

    // Guard gone (the reviewer's case): on the mirror's main the file under
    // the old name is the same job → rename back, same id; no delete, no
    // second row.
    await DbtJob.updateOne(
      { _id: orig._id },
      { $unset: { lastRenameCommit: 1, lastRenameAt: 1 } },
    );
    await syncDbtConfigFromRepo(WS.toString());
    const rows = await DbtJob.find({ projectId: project._id });
    expect(rows.map(r => [r._id.toString(), r.slug])).toEqual([
      [orig._id.toString(), "nightly"],
    ]);
    // On a tree that does NOT verify: kept as is instead.
    await DbtJob.updateOne(
      { _id: orig._id },
      { $set: { slug: "nightly-2", aliases: ["nightly"] } },
    );
    mirror.main = renamed.commit as string;
    await syncDbtConfigFromRepo(WS.toString());
    expect(
      (await DbtJob.find({ projectId: project._id })).map(r => [
        r._id.toString(),
        r.slug,
      ]),
    ).toEqual([[orig._id.toString(), "nightly-2"]]);
  }, 90_000);

  it("[final-3] a UI create whose slug is a git-only (broken) file at main reserves the next free slug", async () => {
    const project = await seedProject();
    await c({
      [jobFilePath("nightly")]:
        "name: Nightly\nenvironment: prod\ncommands: oops-not-a-list\n",
    });
    await syncDbtConfigFromRepo(WS.toString());
    const slug = await reserveJobSlug(project._id, "Nightly");
    expect(slug).toBe("nightly-2");
    const job = new DbtJob({
      workspaceId: project.workspaceId,
      projectId: project._id,
      slug,
      name: "Nightly",
      environment: "prod",
      commands: ["build"],
      enabled: true,
      createdBy: "u1",
    });
    await expect(commitDbtJobFile(project, job, "u1")).resolves.toBeUndefined();
    expect(await fileAt(jobFilePath("nightly-2"))).toContain("name: Nightly");
    expect(await fileAt(jobFilePath("nightly"))).toContain("oops-not-a-list");
  });
});

describe("cycle 2 (jobs): lost rename with no push, stale instance, target check", () => {
  const file = (name: string, sel = "x") =>
    `name: ${name}\nenvironment: prod\ncommands:\n  - build --select ${sel}\nschedule:\n  cron: "0 6 * * *"\n  timezone: UTC\n`;
  const c = (writes: Record<string, string>) =>
    commitBlobsOnBranch(
      repoDirFor(WS.toString()),
      DEFAULT_BRANCH,
      { writes },
      { message: "push" },
    );
  async function loseRename(slug: string, to: string) {
    const { dbtJobRenameHandler } = await import("../rename/handlers/dbt-job");
    const { runGit } = await import("../apps/git");
    const pre = (await resolveCommit(
      repoDirFor(WS.toString()),
      MAIN,
    )) as string;
    await dbtJobRenameHandler.rename(
      { workspaceId: WS.toString() },
      { ref: slug, slug: to },
    );
    await runGit(["-C", repoDirFor(WS.toString()), "update-ref", MAIN, pre]);
  }

  it("[c2-1] a lost job rename with no push afterwards is settled by the list: the job is back, same id", async () => {
    const project = await seedProject();
    await c({ [jobFilePath("nightly")]: file("Nightly") });
    await syncDbtConfigFromRepo(WS.toString());
    const row = (await DbtJob.findOne({
      projectId: project._id,
      slug: "nightly",
    }))!;
    await loseRename("nightly", "nightly-2");
    await DbtJob.updateOne(
      { _id: row._id },
      { $set: { lastRenameAt: new Date(Date.now() - 60 * 60_000) } },
    );
    const live = await loadLiveJobs(project);
    expect(live.map(l => [l.def.slug, l.row?._id.toString()])).toEqual([
      ["nightly", row._id.toString()],
    ]);
    const settled = await DbtJob.findById(row._id);
    expect(settled!.slug).toBe("nightly");
    expect(settled!.lastRenameCommit).toBeUndefined();
  });

  it("[c2-2] an instance whose cache predates a job rename fetches once on a miss", async () => {
    const { runGit } = await import("../apps/git");
    const { dbtJobRenameHandler } = await import("../rename/handlers/dbt-job");
    const project = await seedProject();
    await c({ [jobFilePath("nightly")]: file("Nightly") });
    await syncDbtConfigFromRepo(WS.toString());
    const row = (await DbtJob.findOne({
      projectId: project._id,
      slug: "nightly",
    }))!;
    const dir = repoDirFor(WS.toString());
    const pre = (await resolveCommit(dir, MAIN)) as string;
    await dbtJobRenameHandler.rename(
      { workspaceId: WS.toString() },
      { ref: "nightly", slug: "nightly-2" },
    );
    const remotes = path.join(tmpRoot, `remotes-${Date.now()}`);
    await fs.mkdir(path.join(remotes, "test-owner"), { recursive: true });
    await runGit([
      "clone",
      "--bare",
      "-q",
      dir,
      path.join(remotes, "test-owner", "test-repo.git"),
    ]);
    await runGit(["-C", dir, "update-ref", MAIN, pre]);
    process.env.APPS_GITHUB_REMOTE_BASE = `file://${remotes}`;
    process.env.APPS_CONNECTED_REPO_PUSH = "allow";
    const live = await loadLiveJobs(project);
    expect(live.map(l => [l.def.slug, l.row?._id.toString()])).toEqual([
      ["nightly-2", row._id.toString()],
    ]);
    expect((await loadLiveJobById(project, row._id.toString()))?.def.slug).toBe(
      "nightly-2",
    );
  });

  it("[c2-5] an expired job guard re-keys only to an old name whose file builds the same thing", async () => {
    const { dbtJobRenameHandler } = await import("../rename/handlers/dbt-job");
    const project = await seedProject();
    await c({ [jobFilePath("x")]: file("X") });
    await syncDbtConfigFromRepo(WS.toString());
    const row = (await DbtJob.findOne({ projectId: project._id, slug: "x" }))!;
    await dbtJobRenameHandler.rename(
      { workspaceId: WS.toString() },
      { ref: "x", slug: "a" },
    );
    await syncDbtConfigFromRepo(WS.toString());
    await loseRename("a", "b");
    await DbtJob.updateOne(
      { _id: row._id },
      { $set: { lastRenameAt: new Date(Date.now() - 60 * 60_000) } },
    );
    // The oldest name reused for a different job (other commands).
    await c({ [jobFilePath("x")]: file("Unrelated X", "something-else") });
    await syncDbtConfigFromRepo(WS.toString());
    const orig = await DbtJob.findById(row._id);
    expect(orig!.slug).toBe("a");
    expect(orig!.commands).toEqual(["build --select x"]);
    const rows = await DbtJob.find({ projectId: project._id });
    expect(rows.map(r => r.slug).sort()).toEqual(["a", "x"]);
    expect(rows.find(r => r.slug === "x")!._id.toString()).not.toBe(
      row._id.toString(),
    );
  }, 90_000);
});

describe("adoption", () => {
  it("writes files for unstamped jobs + environments once, re-runnable", async () => {
    const project = await seedProject();
    await DbtJob.create({
      workspaceId: WS,
      projectId: project._id,
      name: "Legacy job",
      environment: "dev",
      commands: ["build"],
      enabled: true,
      createdBy: "u1",
    });
    const first = await adoptDbtConfig(WS.toString());
    expect(first).toEqual({ jobs: 1, written: 2 });
    const row = await DbtJob.findOne({ name: "Legacy job" });
    expect(row?.slug).toBe("legacy-job");
    expect(await fileAt(jobFilePath("legacy-job"))).toContain("Legacy job");
    expect(await fileAt(DBT_ENVIRONMENTS_PATH)).toContain("dbt_prod");
    const again = await adoptDbtConfig(WS.toString());
    expect(again.written).toBe(0);
  });
});
