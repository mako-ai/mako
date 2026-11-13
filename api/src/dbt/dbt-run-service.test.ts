/**
 * dbt run service. The first two suites are pure. The rest run the real
 * service and models against mongodb-memory-server and a real bare repo.
 * Inngest and the override helpers are mocked. The config sync is real: two
 * git calls are wrapped so a test can see it run or make a commit fail.
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

vi.mock("../inngest/client", () => ({
  inngest: { send: vi.fn(async () => ({ ids: [] })) },
}));

// The override helpers belong to another package; their contract is all
// this suite relies on.
vi.mock("./dbt-run-overrides", async () => {
  const { DbtCommandValidationError } =
    await vi.importActual<typeof import("./commands")>("./commands");
  class DbtRunOverridesError extends DbtCommandValidationError {}
  return {
    DbtRunOverridesError,
    validateRunOverrides: vi.fn(
      (input: { vars?: unknown; fullRefresh?: unknown } | undefined) => {
        if (!input) return undefined;
        if (input.vars !== undefined && typeof input.vars !== "object") {
          throw new DbtRunOverridesError("vars must be an object");
        }
        return {
          ...(input.vars ? { vars: input.vars } : {}),
          ...(input.fullRefresh === true ? { fullRefresh: true } : {}),
        };
      },
    ),
    applyFullRefresh: vi.fn((commands: string[]) =>
      commands.map(command =>
        /^(run|build|seed)\b/.test(command) &&
        !command.includes("--full-refresh")
          ? `${command} --full-refresh`
          : command,
      ),
    ),
  };
});

// `listTree` is the config sync's read of the tree (a job trigger never
// lists it), and `commitBlobsOnBranch` is the yml write-through.
vi.mock("../apps/repository.service", async () => {
  const actual = await vi.importActual<
    typeof import("../apps/repository.service")
  >("../apps/repository.service");
  return {
    ...actual,
    listTree: vi.fn(actual.listTree),
    commitBlobsOnBranch: vi.fn(actual.commitBlobsOnBranch),
  };
});

import { inngest } from "../inngest/client";
import {
  DbtJob,
  DbtProject,
  DbtRun,
  type IDbtJob,
} from "../database/workspace-schema";
import {
  DEFAULT_BRANCH,
  blobOid,
  commitBlobsOnBranch,
  listTree,
  readBlob,
  repoDirFor,
  resolveCommit,
} from "../apps/repository.service";
import { serializeJobFile, type DbtJobFile } from "./dbt-config-files";
import { syncDbtConfigFromRepo } from "./dbt-config.service";
import {
  applyFullRefresh,
  DbtRunOverridesError,
  validateRunOverrides,
} from "./dbt-run-overrides";
import {
  autoDisableDbtJob,
  DbtJobDefinitionMissingError,
  DbtJobNotScheduledAtCommitError,
  isStaleQueued,
  reconcileStaleQueuedRun,
  reenabledAfterAutoDisableFilter,
  triggerDbtJobRun,
  triggerDbtRun,
  triggerDbtRunRetry,
} from "./dbt-run.service";
import { deleteFromDbtGitTree, seedDbtGitTree } from "./test-support/git-tree";

const sendMock = vi.mocked(inngest.send);
const syncTreeReadMock = vi.mocked(listTree);
const commitMock = vi.mocked(commitBlobsOnBranch);
const validateMock = vi.mocked(validateRunOverrides);
const applyFullRefreshMock = vi.mocked(applyFullRefresh);

function run(overrides: Partial<Parameters<typeof isStaleQueued>[0]> = {}) {
  return {
    _id: new Types.ObjectId(),
    status: "queued",
    createdAt: new Date(0),
    ...overrides,
  } as Parameters<typeof isStaleQueued>[0];
}

describe("isStaleQueued", () => {
  const now = 1_000_000;
  const timeout = 1_000;

  it("is true for a queued run older than the timeout with no startedAt", () => {
    expect(
      isStaleQueued(
        run({ createdAt: new Date(now - timeout - 1) }),
        now,
        timeout,
      ),
    ).toBe(true);
  });

  it("is false when still within the timeout window", () => {
    expect(
      isStaleQueued(
        run({ createdAt: new Date(now - timeout + 1) }),
        now,
        timeout,
      ),
    ).toBe(false);
  });

  it("is false once the run has started (picked up by a worker)", () => {
    expect(
      isStaleQueued(
        run({ createdAt: new Date(now - timeout - 1), startedAt: new Date() }),
        now,
        timeout,
      ),
    ).toBe(false);
  });

  it("is false for any non-queued status", () => {
    for (const status of ["running", "success", "error", "cancelled"]) {
      expect(
        isStaleQueued(
          run({ status, createdAt: new Date(now - timeout - 1) }),
          now,
          timeout,
        ),
      ).toBe(false);
    }
  });

  it("is false when createdAt is missing (can't age it)", () => {
    expect(isStaleQueued(run({ createdAt: undefined }), now, timeout)).toBe(
      false,
    );
  });
});

describe("reenabledAfterAutoDisableFilter", () => {
  const id = new Types.ObjectId();

  it("matches an enabled job at or past the threshold", () => {
    expect(reenabledAfterAutoDisableFilter(id, 10)).toEqual({
      _id: id,
      enabled: true,
      "scheduledRun.consecutiveFailures": { $gte: 10 },
    });
  });

  it("does nothing when auto-disable is off", () => {
    expect(reenabledAfterAutoDisableFilter(id, 0)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Real service + models from here on.
// ---------------------------------------------------------------------------

let mongo: MongoMemoryServer;
let tmpRoot: string;
let WS: Types.ObjectId;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dbt-run-service-"));
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  // The mirror is a local path with nothing in it: a freshen fails at once
  // and serves local state, with no network call.
  process.env.APPS_GITHUB_REMOTE_BASE = `file://${path.join(tmpRoot, "remotes")}`;
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
  vi.clearAllMocks();
  delete process.env.DBT_PROJECT_RUN_CONCURRENCY;
  // A fresh workspace per test: its own repo, and no freshen throttle or
  // sync state carried over.
  WS = new Types.ObjectId();
  await Promise.all([
    DbtProject.deleteMany({}),
    DbtJob.deleteMany({}),
    DbtRun.deleteMany({}),
  ]);
});

async function seedProject() {
  return DbtProject.create({
    workspaceId: WS,
    name: "Analytics",
    environments: [
      {
        name: "dev",
        connectionId: new Types.ObjectId(),
        targetSchema: "dbt_dev",
        threads: 4,
      },
      {
        name: "prod",
        connectionId: new Types.ObjectId(),
        targetSchema: "dbt_prod",
        threads: 4,
      },
    ],
    defaultEnvironment: "dev",
    createdBy: "u1",
  });
}

function jobFile(overrides: Partial<DbtJobFile> = {}): DbtJobFile {
  return {
    name: "Nightly build",
    environment: "prod",
    commands: ["build --select staging"],
    schedule: { cron: "0 6 * * *", timezone: "UTC" },
    enabled: true,
    deferToProduction: false,
    ...overrides,
  };
}

/** Commit dbt/jobs/nightly.yml on main and return the new head. */
async function pushJobFile(contents: string): Promise<string> {
  await seedDbtGitTree(WS, { "jobs/nightly.yml": contents });
  const head = await resolveCommit(
    repoDirFor(WS.toString()),
    `refs/heads/${DEFAULT_BRANCH}`,
  );
  if (!head) throw new Error("no head");
  return head;
}

/** The scheduler row, as the last applied sync left it. */
async function seedJobRow(
  project: { _id: Types.ObjectId },
  file: DbtJobFile,
  extra: Partial<IDbtJob> = {},
) {
  return DbtJob.create({
    workspaceId: WS,
    projectId: project._id,
    slug: "nightly",
    name: file.name,
    environment: file.environment,
    commands: file.commands,
    schedule: file.schedule ?? undefined,
    enabled: file.enabled,
    deferToProduction: file.deferToProduction,
    sourceBlobSha: blobOid(serializeJobFile(file)),
    createdBy: "u1",
    ...extra,
  });
}

/**
 * Let a sync the trigger fired detached finish before the test ends, so it
 * never writes into the next test. A sync requested during a running one
 * resolves after the extra pass.
 */
async function settleConfigSync(): Promise<void> {
  await vi.waitFor(() => expect(syncTreeReadMock).toHaveBeenCalled(), {
    timeout: 15_000,
  });
  await syncDbtConfigFromRepo(WS.toString());
}

function sentEvents(): Array<Record<string, unknown>> {
  return sendMock.mock.calls.map(
    call => (call[0] as { data: Record<string, unknown> }).data,
  );
}

describe("triggerDbtJobRun: definition pinned to the run commit (#1237)", () => {
  it("a scheduled run takes commands, environment and defer from the yml at the commit it builds", async () => {
    const project = await seedProject();
    const job = await seedJobRow(project, jobFile());
    // A push the row has not caught up with: every definition field moved.
    const pushed = jobFile({
      environment: "dev",
      commands: ["build --select marts", "test"],
      deferToProduction: true,
    });
    const head = await pushJobFile(serializeJobFile(pushed));

    const run = await triggerDbtJobRun({
      workspaceId: WS.toString(),
      job,
      trigger: "schedule",
      triggeredBy: "scheduler",
    });

    expect(run.commands).toEqual(["build --select marts", "test"]);
    expect(run.environment).toBe("dev");
    expect(run.deferToProduction).toBe(true);
    expect(run.sourceSha).toBe(head);
    expect(run.definitionSha).toBe(head);
    // The trigger does not wait for the row. It asks for a sync, and the
    // row catches up without any push webhook.
    await settleConfigSync();
    const row = await DbtJob.findById(job._id);
    expect(row?.commands).toEqual(["build --select marts", "test"]);
    expect(row?.sourceBlobSha).toBe(blobOid(serializeJobFile(pushed)));
  });

  it("asks for no sync when the row already matches the file at that commit", async () => {
    const project = await seedProject();
    const file = jobFile({ deferToProduction: true });
    const job = await seedJobRow(project, file);
    const head = await pushJobFile(serializeJobFile(file));

    const run = await triggerDbtJobRun({
      workspaceId: WS.toString(),
      job,
      trigger: "manual",
      triggeredBy: "u1",
    });

    expect(run.definitionSha).toBe(head);
    expect(run.deferToProduction).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(syncTreeReadMock).not.toHaveBeenCalled();
  });

  it("skips a scheduled tick when the file is gone at that commit, and records why", async () => {
    const project = await seedProject();
    const file = jobFile();
    const job = await seedJobRow(project, file);
    await pushJobFile(serializeJobFile(file));
    // Another job stays, so the repo still holds dbt config after the delete.
    await seedDbtGitTree(WS, {
      "jobs/hourly.yml": serializeJobFile(jobFile({ name: "Hourly" })),
    });
    await deleteFromDbtGitTree(WS, ["jobs/nightly.yml"]);

    await expect(
      triggerDbtJobRun({
        workspaceId: WS.toString(),
        job,
        trigger: "schedule",
        triggeredBy: "scheduler",
      }),
    ).rejects.toBeInstanceOf(DbtJobDefinitionMissingError);

    expect(await DbtRun.countDocuments({})).toBe(0);
    expect(sendMock).not.toHaveBeenCalled();
    const fresh = await DbtJob.findById(job._id);
    expect(fresh?.scheduledRun?.skippedCount).toBe(1);
    expect(fresh?.scheduledRun?.lastSkippedAt).toBeInstanceOf(Date);
    expect(fresh?.scheduledRun?.lastSkippedReason).toBe("definition_missing");
    // The sync the trigger asked for removes the row, so the scheduler
    // stops finding the job.
    await settleConfigSync();
    expect(await DbtJob.findById(job._id)).toBeNull();
  });

  // Review B3. The trigger took commands, environment and defer from the
  // file at the commit, and `enabled` and `schedule` from the stale row. A
  // job disabled on main, whose row still said enabled, ran against prod.
  it("skips a scheduled tick when the file at that commit says enabled: false", async () => {
    const project = await seedProject();
    // The row is what fired the tick: still enabled, still scheduled.
    const job = await seedJobRow(project, jobFile());
    const head = await pushJobFile(
      serializeJobFile(jobFile({ enabled: false })),
    );

    const attempt = triggerDbtJobRun({
      workspaceId: WS.toString(),
      job,
      trigger: "schedule",
      triggeredBy: "scheduler",
    });
    await expect(attempt).rejects.toBeInstanceOf(
      DbtJobNotScheduledAtCommitError,
    );
    await expect(attempt).rejects.toMatchObject({
      reason: "disabled_in_file",
      sourceSha: head,
    });
    await expect(attempt).rejects.toThrow(
      /dbt\/jobs\/nightly\.yml at commit [0-9a-f]{7} of the default branch says enabled: false\. The scheduled tick was skipped\. No run started\./,
    );

    // Nothing ran and nothing was queued.
    expect(await DbtRun.countDocuments({})).toBe(0);
    expect(sendMock).not.toHaveBeenCalled();
    // The tick is counted, with its reason.
    const fresh = await DbtJob.findById(job._id);
    expect(fresh?.scheduledRun?.skippedCount).toBe(1);
    expect(fresh?.scheduledRun?.lastSkippedAt).toBeInstanceOf(Date);
    expect(fresh?.scheduledRun?.lastSkippedReason).toBe("disabled_in_file");
    // The sync the trigger asked for brings the row in line, so the
    // scheduler stops picking the job.
    await settleConfigSync();
    expect((await DbtJob.findById(job._id))?.enabled).toBe(false);
  });

  it("skips a scheduled tick when the file at that commit has no schedule any more", async () => {
    const project = await seedProject();
    const job = await seedJobRow(project, jobFile());
    await pushJobFile(serializeJobFile(jobFile({ schedule: null })));

    await expect(
      triggerDbtJobRun({
        workspaceId: WS.toString(),
        job,
        trigger: "schedule",
        triggeredBy: "scheduler",
      }),
    ).rejects.toMatchObject({
      name: "DbtJobNotScheduledAtCommitError",
      reason: "unscheduled_in_file",
    });
    expect(await DbtRun.countDocuments({})).toBe(0);
    const fresh = await DbtJob.findById(job._id);
    expect(fresh?.scheduledRun?.skippedCount).toBe(1);
    expect(fresh?.scheduledRun?.lastSkippedReason).toBe("unscheduled_in_file");
    await settleConfigSync();
  });

  // The decision for a manual trigger: `enabled` and `schedule` govern the
  // schedule only. A person or an agent who triggers a disabled job gets a
  // run, as before this change and as for a row that says enabled: false.
  it("a manual or agent trigger still runs a job its file disables, and counts no skipped tick", async () => {
    const project = await seedProject();
    const job = await seedJobRow(project, jobFile());
    const head = await pushJobFile(
      serializeJobFile(jobFile({ enabled: false, schedule: null })),
    );

    for (const trigger of ["manual", "agent"] as const) {
      const run = await triggerDbtJobRun({
        workspaceId: WS.toString(),
        job,
        trigger,
        triggeredBy: "u1",
      });
      expect(run.status).toBe("queued");
      expect(run.definitionSha).toBe(head);
    }
    expect(await DbtRun.countDocuments({})).toBe(2);
    expect(
      (await DbtJob.findById(job._id))?.scheduledRun?.skippedCount,
    ).toBeUndefined();
    await settleConfigSync();
  });

  it("a scheduled tick still runs when the file at that commit keeps the job enabled and scheduled", async () => {
    const project = await seedProject();
    const job = await seedJobRow(project, jobFile());
    // The cron moved. The job is still enabled and scheduled: it runs.
    await pushJobFile(
      serializeJobFile(
        jobFile({ schedule: { cron: "0 7 * * *", timezone: "UTC" } }),
      ),
    );
    const run = await triggerDbtJobRun({
      workspaceId: WS.toString(),
      job,
      trigger: "schedule",
      triggeredBy: "scheduler",
    });
    expect(run.status).toBe("queued");
    expect(
      (await DbtJob.findById(job._id))?.scheduledRun?.skippedCount,
    ).toBeUndefined();
    await settleConfigSync();
  });

  it("refuses a manual run of a deleted job without counting a skipped tick", async () => {
    const project = await seedProject();
    const file = jobFile();
    const job = await seedJobRow(project, file);
    await pushJobFile(serializeJobFile(file));
    await deleteFromDbtGitTree(WS, ["jobs/nightly.yml"]);

    await expect(
      triggerDbtJobRun({
        workspaceId: WS.toString(),
        job,
        trigger: "manual",
        triggeredBy: "u1",
      }),
    ).rejects.toThrow(/dbt\/jobs\/nightly\.yml does not exist at commit/);
    expect(await DbtRun.countDocuments({})).toBe(0);
    expect(
      (await DbtJob.findById(job._id))?.scheduledRun?.skippedCount,
    ).toBeUndefined();
    await settleConfigSync();
  });

  it("falls back to the row when the file does not parse, and leaves definitionSha unset", async () => {
    const project = await seedProject();
    const lastGood = jobFile({ deferToProduction: true });
    const job = await seedJobRow(project, lastGood);
    const head = await pushJobFile("name: [unterminated\n");

    const run = await triggerDbtJobRun({
      workspaceId: WS.toString(),
      job,
      trigger: "schedule",
      triggeredBy: "scheduler",
    });

    expect(run.commands).toEqual(lastGood.commands);
    expect(run.environment).toBe("prod");
    expect(run.deferToProduction).toBe(true);
    // The tree is still pinned; only the definition came from the row.
    expect(run.sourceSha).toBe(head);
    expect(run.definitionSha).toBeUndefined();
    // The sync flags the broken file on the row, as a push would.
    await settleConfigSync();
    expect((await DbtJob.findById(job._id))?.definitionInvalid?.reason).toBe(
      "unparseable job file",
    );
  });

  it("falls back to the row when the file parses but would be refused by the sync", async () => {
    const project = await seedProject();
    const lastGood = jobFile();
    const job = await seedJobRow(project, lastGood);
    for (const refused of [
      jobFile({ commands: ["run-operation drop_everything"] }),
      jobFile({ environment: "no_such_environment" }),
    ]) {
      await DbtRun.deleteMany({});
      await pushJobFile(serializeJobFile(refused));
      const run = await triggerDbtJobRun({
        workspaceId: WS.toString(),
        job,
        trigger: "manual",
        triggeredBy: "u1",
      });
      expect(run.commands).toEqual(lastGood.commands);
      expect(run.environment).toBe("prod");
      expect(run.definitionSha).toBeUndefined();
      await settleConfigSync();
    }
  });

  it("uses the row when there is no repo to read", async () => {
    const project = await seedProject();
    const job = await seedJobRow(project, jobFile());

    const run = await triggerDbtJobRun({
      workspaceId: WS.toString(),
      job,
      trigger: "schedule",
      triggeredBy: "scheduler",
    });

    expect(run.commands).toEqual(["build --select staging"]);
    expect(run.sourceSha).toBeUndefined();
    expect(run.definitionSha).toBeUndefined();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(syncTreeReadMock).not.toHaveBeenCalled();
  });
});

describe("skipped scheduled ticks are counted (#1239)", () => {
  it("a tick that collapses onto a queued or running run of the job is counted, not dropped", async () => {
    const project = await seedProject();
    const job = await seedJobRow(project, jobFile());
    const first = await triggerDbtJobRun({
      workspaceId: WS.toString(),
      job,
      trigger: "schedule",
      triggeredBy: "scheduler",
    });
    expect(sendMock).toHaveBeenCalledTimes(1);

    // Still queued at the next tick.
    const second = await triggerDbtJobRun({
      workspaceId: WS.toString(),
      job,
      trigger: "schedule",
      triggeredBy: "scheduler",
    });
    // Running at the one after.
    await DbtRun.updateOne({ _id: first._id }, { $set: { status: "running" } });
    const third = await triggerDbtJobRun({
      workspaceId: WS.toString(),
      job,
      trigger: "schedule",
      triggeredBy: "scheduler",
    });

    expect(second._id.toString()).toBe(first._id.toString());
    expect(third._id.toString()).toBe(first._id.toString());
    expect(await DbtRun.countDocuments({})).toBe(1);
    expect(sendMock).toHaveBeenCalledTimes(1);
    const fresh = await DbtJob.findById(job._id);
    expect(fresh?.scheduledRun?.skippedCount).toBe(2);
    expect(fresh?.scheduledRun?.lastSkippedAt).toBeInstanceOf(Date);
  });

  it("counts nothing once the run finished, and never for a manual trigger", async () => {
    const project = await seedProject();
    const job = await seedJobRow(project, jobFile());
    const first = await triggerDbtJobRun({
      workspaceId: WS.toString(),
      job,
      trigger: "schedule",
      triggeredBy: "scheduler",
    });
    // A manual trigger stacks behind the active run instead of collapsing.
    const manual = await triggerDbtJobRun({
      workspaceId: WS.toString(),
      job,
      trigger: "manual",
      triggeredBy: "u1",
    });
    expect(manual._id.toString()).not.toBe(first._id.toString());

    await DbtRun.updateMany({}, { $set: { status: "success" } });
    const next = await triggerDbtJobRun({
      workspaceId: WS.toString(),
      job,
      trigger: "schedule",
      triggeredBy: "scheduler",
    });
    expect(next._id.toString()).not.toBe(first._id.toString());
    expect(
      (await DbtJob.findById(job._id))?.scheduledRun?.skippedCount,
    ).toBeUndefined();
  });
});

describe("lanes and concurrency keys on the run event (#1239)", () => {
  it("a job run is in the job lane and locks on its job", async () => {
    const project = await seedProject();
    const job = await seedJobRow(project, jobFile());
    const run = await triggerDbtJobRun({
      workspaceId: WS.toString(),
      job,
      trigger: "schedule",
      triggeredBy: "scheduler",
    });

    expect(run.lane).toBe("job");
    expect(sentEvents()).toEqual([
      {
        workspaceId: WS.toString(),
        projectId: project._id.toString(),
        runId: run._id.toString(),
        jobId: job._id.toString(),
        laneKey: `${project._id.toString()}:job`,
        lockKey: `job:${job._id.toString()}`,
      },
    ]);
  });

  it("parse, compile and show from a person or an agent go to the interactive lane", async () => {
    const project = await seedProject();
    const base = {
      workspaceId: WS.toString(),
      projectId: project._id.toString(),
      environment: "dev",
      triggeredBy: "agent",
      workingTreeUserId: "u1",
    };
    const parse = await triggerDbtRun({
      ...base,
      commands: ["parse"],
      trigger: "agent",
    });
    const show = await triggerDbtRun({
      ...base,
      commands: ["compile --select stg_orders", "show --select stg_orders"],
      trigger: "manual",
    });
    const build = await triggerDbtRun({
      ...base,
      commands: ["compile", "build --select stg_orders"],
      trigger: "agent",
    });

    expect([parse.lane, show.lane, build.lane]).toEqual([
      "interactive",
      "interactive",
      "job",
    ]);
    const lane = `${project._id.toString()}:`;
    expect(sentEvents().map(event => [event.laneKey, event.lockKey])).toEqual([
      [`${lane}interactive`, `run:${parse._id.toString()}`],
      [`${lane}interactive`, `run:${show._id.toString()}`],
      [`${lane}job`, `run:${build._id.toString()}`],
    ]);
  });

  it("a CI validation run stays in the job lane", async () => {
    const project = await seedProject();
    const run = await triggerDbtRun({
      workspaceId: WS.toString(),
      projectId: project._id.toString(),
      environment: "dev",
      commands: ["compile"],
      trigger: "ci",
      triggeredBy: "ci",
    });
    expect(run.lane).toBe("job");
  });
});

describe("the stale-queue watchdog knows the lanes (#1239)", () => {
  const stale = (projectId: Types.ObjectId, lane?: string) => ({
    _id: new Types.ObjectId(),
    projectId,
    status: "queued",
    lane,
    createdAt: new Date(Date.now() - 60 * 60_000),
  });

  async function seedRunning(projectId: Types.ObjectId, lane?: string) {
    return DbtRun.create({
      workspaceId: WS,
      projectId,
      environment: "dev",
      commands: ["build"],
      status: "running",
      trigger: "manual",
      triggeredBy: "u1",
      startedAt: new Date(),
      ...(lane ? { lane } : {}),
    });
  }

  it("a queued run whose lane is full is waiting, not lost", async () => {
    const project = await seedProject();
    await seedRunning(project._id, "job");
    const run = await reconcileStaleQueuedRun(stale(project._id, "job"), {
      persist: false,
    });
    expect(run.status).toBe("queued");
    // A running run from before lanes existed counts as the job lane.
    await DbtRun.deleteMany({});
    await seedRunning(project._id);
    expect(
      (await reconcileStaleQueuedRun(stale(project._id), { persist: false }))
        .status,
    ).toBe("queued");
  });

  it("a build in the job lane does not excuse a lost interactive run", async () => {
    const project = await seedProject();
    await seedRunning(project._id, "job");
    const run = await reconcileStaleQueuedRun(
      stale(project._id, "interactive"),
      { persist: false },
    );
    expect(run.status).toBe("error");
  });

  it("with 2 slots, one running peer leaves a slot free, so a stale queued run is lost", async () => {
    process.env.DBT_PROJECT_RUN_CONCURRENCY = "2";
    const project = await seedProject();
    await seedRunning(project._id, "job");
    expect(
      (
        await reconcileStaleQueuedRun(stale(project._id, "job"), {
          persist: false,
        })
      ).status,
    ).toBe("error");
    await seedRunning(project._id, "job");
    expect(
      (
        await reconcileStaleQueuedRun(stale(project._id, "job"), {
          persist: false,
        })
      ).status,
    ).toBe("queued");
  });
});

describe("run overrides (#1244)", () => {
  it("validates against the job's commands, applies full refresh, and stores both on the run only", async () => {
    const project = await seedProject();
    const file = jobFile({ commands: ["build --select staging", "test"] });
    const job = await seedJobRow(project, file);
    await pushJobFile(serializeJobFile(file));

    const run = await triggerDbtJobRun({
      workspaceId: WS.toString(),
      job,
      trigger: "agent",
      triggeredBy: "agent",
      overrides: { vars: { run_date: "2026-01-01" }, fullRefresh: true },
    });

    expect(validateMock).toHaveBeenCalledWith(
      { vars: { run_date: "2026-01-01" }, fullRefresh: true },
      ["build --select staging", "test"],
    );
    expect(applyFullRefreshMock).toHaveBeenCalledWith([
      "build --select staging",
      "test",
    ]);
    const stored = await DbtRun.findById(run._id).lean();
    expect(stored?.commands).toEqual([
      "build --select staging --full-refresh",
      "test",
    ]);
    expect(stored?.overrides).toEqual({
      vars: { run_date: "2026-01-01" },
      fullRefresh: true,
    });
    // Nothing is written to the job: not the row, not the file's sha.
    const row = await DbtJob.findById(job._id).lean();
    expect(row?.commands).toEqual(["build --select staging", "test"]);
    expect(row?.sourceBlobSha).toBe(blobOid(serializeJobFile(file)));
    // No commit beyond the one that seeded the file.
    expect(commitMock).toHaveBeenCalledTimes(1);
  });

  it("vars alone leave the commands untouched", async () => {
    const project = await seedProject();
    const job = await seedJobRow(project, jobFile());
    const run = await triggerDbtJobRun({
      workspaceId: WS.toString(),
      job,
      trigger: "manual",
      triggeredBy: "u1",
      overrides: { vars: { limit: 10 } },
    });
    expect(run.commands).toEqual(["build --select staging"]);
    expect(run.overrides?.vars).toEqual({ limit: 10 });
    expect(run.overrides?.fullRefresh).toBeUndefined();
    expect(applyFullRefreshMock).not.toHaveBeenCalled();
  });

  it("a plain trigger never reaches the validator and stores no overrides", async () => {
    const project = await seedProject();
    const job = await seedJobRow(project, jobFile());
    const run = await triggerDbtJobRun({
      workspaceId: WS.toString(),
      job,
      trigger: "manual",
      triggeredBy: "u1",
    });
    expect(validateMock).not.toHaveBeenCalled();
    expect((await DbtRun.findById(run._id).lean())?.overrides).toBeUndefined();
  });

  it("refuses overrides on a scheduled run, and surfaces a validation error before any run exists", async () => {
    const project = await seedProject();
    const job = await seedJobRow(project, jobFile());
    await expect(
      triggerDbtJobRun({
        workspaceId: WS.toString(),
        job,
        trigger: "schedule",
        triggeredBy: "scheduler",
        overrides: { fullRefresh: true },
      }),
    ).rejects.toBeInstanceOf(DbtRunOverridesError);
    await expect(
      triggerDbtJobRun({
        workspaceId: WS.toString(),
        job,
        trigger: "manual",
        triggeredBy: "u1",
        overrides: {
          vars: "not an object" as unknown as Record<string, unknown>,
        },
      }),
    ).rejects.toBeInstanceOf(DbtRunOverridesError);
    expect(await DbtRun.countDocuments({})).toBe(0);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("a retry keeps the overrides and the job lock of the run it retries", async () => {
    const project = await seedProject();
    const job = await seedJobRow(project, jobFile());
    const source = await DbtRun.create({
      workspaceId: WS,
      projectId: project._id,
      jobId: job._id,
      environment: "prod",
      commands: ["build --select staging --full-refresh"],
      status: "error",
      trigger: "manual",
      triggeredBy: "u1",
      sourceSha: "a".repeat(40),
      definitionSha: "a".repeat(40),
      overrides: { vars: { run_date: "2026-01-01" }, fullRefresh: true },
      artifactKeys: { runResults: "dbt-artifacts/x/run_results.json" },
    });

    const retry = await triggerDbtRunRetry({
      workspaceId: WS.toString(),
      runId: source._id.toString(),
      triggeredBy: "u1",
    });

    const stored = await DbtRun.findById(retry?._id).lean();
    expect(stored?.commands).toEqual(["retry"]);
    expect(stored?.overrides).toEqual({
      vars: { run_date: "2026-01-01" },
      fullRefresh: true,
    });
    expect(stored?.definitionSha).toBe("a".repeat(40));
    expect(stored?.lane).toBe("job");
    expect(sentEvents()[0]).toMatchObject({
      laneKey: `${project._id.toString()}:job`,
      lockKey: `job:${job._id.toString()}`,
    });
  });
});

describe("autoDisableDbtJob", () => {
  async function seedFailingJob() {
    const project = await seedProject();
    const job = await seedJobRow(project, jobFile(), {
      scheduledRun: {
        nextAt: new Date(Date.now() + 60_000),
        runCount: 12,
        consecutiveFailures: 10,
      },
    } as Partial<IDbtJob>);
    await pushJobFile(serializeJobFile(jobFile()));
    commitMock.mockClear();
    return job;
  }

  async function ymlAtMain(): Promise<string> {
    const blob = await readBlob(
      repoDirFor(WS.toString()),
      `refs/heads/${DEFAULT_BRANCH}`,
      "dbt/jobs/nightly.yml",
    );
    return blob.contents;
  }

  it("disables the row even when the yml commit fails", async () => {
    const job = await seedFailingJob();
    commitMock.mockRejectedValueOnce(new Error("push rejected"));

    await expect(
      autoDisableDbtJob(job, 10, 'dbt command "build" exited with code 1'),
    ).resolves.toBeUndefined();

    // The write-through was attempted and failed: the file still says enabled.
    expect(commitMock).toHaveBeenCalledTimes(1);
    expect(await ymlAtMain()).toContain("enabled: true");
    const fresh = await DbtJob.findById(job._id);
    expect(fresh?.enabled).toBe(false);
    expect(fresh?.scheduledRun?.nextAt).toBeUndefined();
    expect(fresh?.scheduledRun?.lastError).toBe(
      'Auto-disabled after 10 consecutive failures. Last error: dbt command "build" exited with code 1',
    );
    // The row still carries the file's sha, so the next sync sees it as
    // level and does not read `enabled: true` back from the file.
    expect(fresh?.sourceBlobSha).toBe(job.sourceBlobSha);
    await syncDbtConfigFromRepo(WS.toString());
    expect((await DbtJob.findById(job._id))?.enabled).toBe(false);
  });

  it("writes `enabled: false` through to the yml when the commit works", async () => {
    const job = await seedFailingJob();

    await autoDisableDbtJob(job, 10, "boom");

    expect((await DbtJob.findById(job._id))?.enabled).toBe(false);
    expect(commitMock).toHaveBeenCalledTimes(1);
    expect(commitMock.mock.calls[0]?.[3]).toMatchObject({
      message: 'dbt: auto-disable job "Nightly build" after 10 failures',
    });
    expect(await ymlAtMain()).toContain("enabled: false");
  });
});
