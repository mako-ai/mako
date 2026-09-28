/**
 * Asynchronous binding builds (binding-jobs.ts + binding-job-runner.ts).
 * What these pin:
 *
 *   - a job moves queued → running → ready/error and keeps what the
 *     synchronous route would have answered (artifact key, or error+status);
 *   - materialize jobs build through materializeAppBinding; dev-build jobs
 *     re-plan the submitted text — a stored artifact answers without a build,
 *     a draft is kept under apps/jobs/<project>/<job>;
 *   - a job is only visible within its project, and expired jobs (row +
 *     draft object, never the app's artifact) go when the project makes
 *     another.
 *
 * Real Mongo for the job rows; the builders are injected.
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
import type { IAppProject } from "../database/workspace-schema";
import {
  JOB_LEASE_MS,
  JOB_TTL_MS,
  heartbeatBindingJob,
  sweepStaleBindingJobs,
  createBindingJob,
  getBindingJob,
  getBindingJobById,
  jobDraftKey,
  markBindingJob,
  serializeBindingJob,
  storeJobDraft,
  type BindingJobDoc,
} from "./binding-jobs";
import { runBindingJob, type BindingJobRunnerDeps } from "./binding-job-runner";
import { DevBuildError } from "./binding-dev-build";
import { getDashboardArtifactStore } from "../services/dashboard-artifact-store.service";

let mongo: MongoMemoryServer;
let tmpRoot: string;
const WS = new Types.ObjectId().toString();
const PROJECT = new Types.ObjectId().toString();
const project = {
  _id: new Types.ObjectId(PROJECT),
  workspaceId: new Types.ObjectId(WS),
} as unknown as IAppProject;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "binding-jobs-test-"));
  process.env.DASHBOARD_ARTIFACT_DIR = path.join(tmpRoot, "artifacts");
  delete process.env.DASHBOARD_ARTIFACT_STORE;
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await mongoose.connection.collection("app_binding_jobs").deleteMany({});
});

function newJob(
  overrides: Partial<Parameters<typeof createBindingJob>[0]> = {},
  now?: Date,
) {
  return createBindingJob(
    {
      workspaceId: WS,
      projectId: PROJECT,
      name: "calls_q3",
      kind: "dev-build",
      actorId: "u1",
      userId: "u1",
      canWrite: true,
      request: { source: "-- connection: c\nselect 1" },
      ...overrides,
    },
    now,
  );
}

async function localFile(contents = "PAR1") {
  const file = path.join(tmpRoot, `f-${Date.now()}-${Math.random()}.parquet`);
  await fs.writeFile(file, contents);
  return file;
}

function deps(
  overrides: Partial<BindingJobRunnerDeps> = {},
): BindingJobRunnerDeps {
  return {
    resolveProject: vi.fn(async () => project),
    materialize: vi.fn(async () => ({
      artifactKey: "apps/bindings/c/abc.parquet",
      rowCount: 9,
      byteSize: 90,
      materializedAt: new Date("2026-09-28T10:00:00Z"),
    })),
    plan: vi.fn(async () => ({
      kind: "build" as const,
      run: async () => ({
        kind: "draft" as const,
        filePath: await localFile("PAR1-draft"),
        rowCount: 4,
        byteSize: 10,
        builtAt: new Date("2026-09-28T10:00:00Z"),
      }),
    })),
    mark: markBindingJob,
    storeDraft: storeJobDraft,
    heartbeat: vi.fn(async () => undefined),
    heartbeatMs: 60_000,
    ...overrides,
  };
}

async function reload(job: BindingJobDoc) {
  return (await getBindingJobById(job._id.toString())) as BindingJobDoc;
}

describe("binding jobs", () => {
  it("runs a materialize job through materializeAppBinding", async () => {
    const job = await newJob({ kind: "materialize", request: {} });
    expect(serializeBindingJob(job).status).toBe("queued");
    const d = deps();
    expect(await runBindingJob(job, d)).toBe("ready");
    expect(d.materialize).toHaveBeenCalledWith(project, "calls_q3", "u1");
    expect(serializeBindingJob(await reload(job))).toMatchObject({
      status: "ready",
      build: "materialized",
      rowCount: 9,
      materializedAt: "2026-09-28T10:00:00.000Z",
    });
    expect((await reload(job)).result?.artifactKey).toBe(
      "apps/bindings/c/abc.parquet",
    );
  });

  it("keeps a draft dev-build under the job's own key", async () => {
    const job = await newJob({
      request: { source: "x", dbtEnvironment: "joan" },
    });
    const d = deps();
    expect(await runBindingJob(job, d)).toBe("ready");
    expect(d.plan).toHaveBeenCalledWith(
      expect.objectContaining({
        project,
        name: "calls_q3",
        actorId: "u1",
        canWrite: true,
        source: "x",
        dbtEnvironment: "joan",
      }),
    );
    const key = jobDraftKey(PROJECT, job._id.toString());
    expect((await reload(job)).result).toMatchObject({
      artifactKey: key,
      build: "draft",
      rowCount: 4,
    });
    expect(await getDashboardArtifactStore().exists(key)).toBe(true);
  });

  it("answers from a stored artifact without building", async () => {
    const job = await newJob();
    const d = deps({
      plan: vi.fn(async () => ({
        kind: "artifact" as const,
        artifactKey: "apps/bindings/c/committed.parquet",
        source: "committed" as const,
      })),
    });
    await runBindingJob(job, d);
    expect((await reload(job)).result).toEqual({
      artifactKey: "apps/bindings/c/committed.parquet",
      build: "artifact",
    });
  });

  it("records a failure with the status the synchronous route would use", async () => {
    const job = await newJob();
    await runBindingJob(
      job,
      deps({
        plan: vi.fn(async () => {
          throw new DevBuildError("Unrecognized name: connected", 502);
        }),
      }),
    );
    expect(serializeBindingJob(await reload(job))).toMatchObject({
      status: "error",
      error: "Unrecognized name: connected",
      errorStatus: 502,
    });

    const gone = await newJob();
    await runBindingJob(
      gone,
      deps({ resolveProject: vi.fn(async () => null) }),
    );
    expect(serializeBindingJob(await reload(gone))).toMatchObject({
      status: "error",
      errorStatus: 404,
    });
  });

  it("is visible only within its project, and a finished job until it expires", async () => {
    const job = await newJob();
    const id = job._id.toString();
    expect(await getBindingJob(PROJECT, id)).not.toBeNull();
    expect(await getBindingJob(new Types.ObjectId().toString(), id)).toBeNull();
    expect(await getBindingJob(PROJECT, "not-an-id")).toBeNull();
    // Queued past the TTL: still there for its poller.
    const later = new Date(Date.now() + JOB_TTL_MS + 60_000);
    expect(await getBindingJob(PROJECT, id, later)).not.toBeNull();
    await markBindingJob(id, {
      status: "ready",
      result: { artifactKey: "apps/bindings/c/x.parquet", build: "artifact" },
    });
    expect(await getBindingJob(PROJECT, id, later)).toBeNull();
  });

  it("prunes expired jobs and their draft objects, never the app's artifact", async () => {
    const t0 = new Date(Date.now() - 2 * JOB_TTL_MS);
    const draftJob = await newJob({}, t0);
    const draftKey = await storeJobDraft(draftJob, await localFile());
    await mongoose.connection.collection("app_binding_jobs").updateOne(
      { _id: draftJob._id },
      {
        $set: {
          status: "ready",
          result: { artifactKey: draftKey, build: "draft" },
          expiresAt: new Date(t0.getTime() + JOB_TTL_MS),
        },
      },
    );
    const committedKey = "apps/bindings/c/keep.parquet";
    const committedFile = await localFile();
    await getDashboardArtifactStore().put(committedFile, committedKey);
    const committedJob = await newJob({ kind: "materialize" }, t0);
    await mongoose.connection.collection("app_binding_jobs").updateOne(
      { _id: committedJob._id },
      {
        $set: {
          status: "ready",
          result: { artifactKey: committedKey, build: "materialized" },
          expiresAt: new Date(t0.getTime() + JOB_TTL_MS),
        },
      },
    );

    await newJob();
    const store = getDashboardArtifactStore();
    expect(await store.exists(draftKey)).toBe(false);
    expect(await store.exists(committedKey)).toBe(true);
    expect(await getBindingJobById(draftJob._id.toString())).toBeNull();
    expect(await getBindingJobById(committedJob._id.toString())).toBeNull();
  });
});

describe("leases and expiry", () => {
  it("beats while a build runs and stops after", async () => {
    const job = await newJob({ kind: "materialize", request: {} });
    const heartbeat = vi.fn(async () => undefined);
    await runBindingJob(
      job,
      deps({
        heartbeat,
        heartbeatMs: 5,
        materialize: vi.fn(async () => {
          await new Promise(resolve => setTimeout(resolve, 40));
          return {
            artifactKey: "apps/bindings/c/abc.parquet",
            rowCount: 1,
            byteSize: 1,
            materializedAt: new Date(),
          };
        }),
      }),
    );
    const beats = heartbeat.mock.calls.length;
    expect(beats).toBeGreaterThan(1);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(heartbeat.mock.calls.length).toBe(beats);
  });

  it("a running job never expires under its poller, and a heartbeat extends it", async () => {
    const job = await newJob();
    const id = job._id.toString();
    await markBindingJob(id, { status: "running" });
    const later = new Date(Date.now() + JOB_TTL_MS + 60_000);
    await heartbeatBindingJob(id, new Date(later.getTime() - 1000));
    expect((await getBindingJob(PROJECT, id, later))?.status).toBe("running");
    const row = await getBindingJobById(id);
    expect(row?.expiresAt.getTime()).toBeGreaterThan(later.getTime());
  });

  it("fails a running job whose worker went silent, and deletes its orphaned draft", async () => {
    const job = await newJob();
    const id = job._id.toString();
    await markBindingJob(id, { status: "running" });
    // The worker uploaded its draft, then died before recording it.
    const orphan = await storeJobDraft(job, await localFile());
    const store = getDashboardArtifactStore();
    expect(await store.exists(orphan)).toBe(true);

    const soon = new Date(Date.now() + JOB_LEASE_MS / 2);
    expect((await getBindingJob(PROJECT, id, soon))?.status).toBe("running");

    const stale = new Date(Date.now() + JOB_LEASE_MS + 60_000);
    const polled = await getBindingJob(PROJECT, id, stale);
    expect(serializeBindingJob(polled as BindingJobDoc)).toMatchObject({
      status: "error",
      errorStatus: 502,
    });
    expect(await store.exists(orphan)).toBe(false);
  });

  it("the sweep fails stale running jobs nobody polls, and leaves live ones", async () => {
    const dead = await newJob();
    const alive = await newJob({ name: "other" });
    await markBindingJob(dead._id.toString(), { status: "running" });
    await markBindingJob(alive._id.toString(), { status: "running" });
    const now = new Date(Date.now() + JOB_LEASE_MS + 60_000);
    await heartbeatBindingJob(alive._id.toString(), now);
    expect(await sweepStaleBindingJobs(now)).toBe(1);
    expect((await reload(dead)).status).toBe("error");
    expect((await reload(alive)).status).toBe("running");
  });

  it("pruning never removes queued or running jobs", async () => {
    const t0 = new Date(Date.now() - 3 * JOB_TTL_MS);
    const queued = await newJob({}, t0);
    const running = await newJob({ name: "r" }, t0);
    await mongoose.connection
      .collection("app_binding_jobs")
      .updateOne(
        { _id: running._id },
        { $set: { status: "running", heartbeatAt: new Date() } },
      );
    await newJob({ name: "trigger" });
    expect(await getBindingJobById(queued._id.toString())).not.toBeNull();
    expect(await getBindingJobById(running._id.toString())).not.toBeNull();
  });
});
