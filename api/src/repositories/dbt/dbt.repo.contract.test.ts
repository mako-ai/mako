import {
  activateDbtStore,
  createDbtCutoverRepo,
  dbtUsesPostgres,
} from "./cutover";
import { dbtUuid } from "./mapper";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { MongoClient, type Document } from "mongodb";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DbtProject,
  DbtJob,
  DbtEnvPreference,
} from "../../database/models/dbt";
import { backfillDbt } from "../../database/pg/cli/backfill-dbt";
import type { MakoPgDb } from "../../database/pg/client";
import { generateUuidv7, newDualId } from "../../database/pg/id-codec";
import { runPgliteMigrations } from "../../database/pg/migrate";
import * as schema from "../../database/pg/schema";
import { createTestPglite } from "../../database/pg/test-pglite";
import { PgAuthRepository } from "../auth/pg.repo";
import {
  MongoDbtRepository,
  PgDbtRepository,
  DbtDuplicateProjectNameError,
  type DbtRepository,
} from "./index";

describe("dbt persistence", () => {
  const workspace = newDualId();
  const userId = generateUuidv7();
  const pg = createTestPglite();
  const db = drizzle(pg, { schema }) as unknown as MakoPgDb;
  const auth = new PgAuthRepository({ getDb: () => db });
  const pgRepo = new PgDbtRepository({
    getDb: () => db,
    resolveUserUuid: id => auth.resolveUserUuid(id),
  });
  const mongoRepo = new MongoDbtRepository();
  let mongo: MongoMemoryReplSet;
  let source: MongoClient;
  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create();
    await mongoose.connect(mongo.getUri());
    await Promise.all([
      DbtProject.createIndexes(),
      DbtJob.createIndexes(),
      DbtEnvPreference.createIndexes(),
    ]);
    source = new MongoClient(mongo.getUri());
    await runPgliteMigrations(pg);
    await auth.createUser({ id: userId, email: "dev@example.test" });
    await db.insert(schema.workspaces).values({
      id: workspace.uuid,
      name: "dbt",
      slug: "dbt",
      createdBy: userId,
    });
  });
  afterAll(async () => {
    await source?.close();
    await mongoose.disconnect();
    await mongo?.stop();
    await pg.close();
  });

  describe.each<[string, DbtRepository]>([
    ["Postgres", pgRepo],
    ["Mongo", mongoRepo],
  ])("%s", (_, repo) => {
    const at = new Date("2026-04-01T12:00:00Z");
    async function project(name: string) {
      return repo.createProject({
        name,
        workspaceId: workspace.oid,
        createdBy: userId,
      });
    }
    it("scopes projects, saves preferences, and promotes manifests in commit order", async () => {
      const p = await project("analytics");
      expect(p._id).toMatch(/^[a-f0-9]{24}$/);
      expect(await repo.findProjectById(p._id, newDualId().oid)).toBeNull();
      await expect(project("analytics")).rejects.toBeInstanceOf(
        DbtDuplicateProjectNameError,
      );
      await repo.upsertEnvPreference({
        workspaceId: workspace.oid,
        projectId: p._id,
        userId,
        environment: "first",
      });
      await repo.upsertEnvPreference({
        workspaceId: workspace.oid,
        projectId: p._id,
        userId,
        environment: "second",
      });
      expect((await repo.findEnvPreference(p._id, userId))?.environment).toBe(
        "second",
      );
      expect(
        await repo.promoteProdManifest({
          projectId: p._id,
          manifestKey: "new",
          committedAt: at,
          sourceSha: "abc",
        }),
      ).toBe(true);
      expect(
        await repo.promoteProdManifest({
          projectId: p._id,
          manifestKey: "old",
          committedAt: new Date(+at - 1),
        }),
      ).toBe(false);
      expect(
        await repo.promoteProdManifest({
          projectId: p._id,
          manifestKey: "rebuilt",
          committedAt: at,
        }),
      ).toBe(true);
      expect(
        (await repo.findProjectById(p._id))?.lastProdManifestSha,
      ).toBeUndefined();
      await repo.deleteProject(p._id);
      expect(await repo.findEnvPreference(p._id, userId)).toBeNull();
    });

    it("claims each schedule occurrence once and preserves independently updated job counters", async () => {
      const p = await project("scheduler");
      const job = await repo.createJob({
        _id: newDualId().oid,
        workspaceId: workspace.oid,
        projectId: p._id,
        name: "Build",
        slug: "build",
        environment: "prod",
        createdBy: "sync",
        schedule: { cron: "0 0 * * *", timezone: "UTC" },
      });
      await repo.updateJob(job._id, { scheduledRun: { nextAt: at } });
      const [due] = await repo.findDueScheduledJobs(at);
      const next = new Date(+at + 86400000);
      expect(
        await Promise.all([
          repo.claimScheduledJob(due, next),
          repo.claimScheduledJob(due, next),
        ]).then(results => results.map(r => r.modifiedCount).sort()),
      ).toEqual([0, 1]);
      await Promise.all(
        [1, 2].map(() =>
          repo.recordJobRunOutcome(job._id, {
            completedAt: at,
            status: "error",
            error: "oops",
          }),
        ),
      );
      expect((await repo.findJobById(job._id))?.scheduledRun).toMatchObject({
        runCount: 2,
        consecutiveFailures: 2,
        nextAt: next,
        lastError: "oops",
      });
      expect(await repo.resetJobFailuresIfReenabled(job._id, 2)).toBe(true);
      const result = await repo.recordJobRunOutcome(job._id, {
        completedAt: at,
        status: "success",
      });
      expect(result?.scheduledRun.lastError).toBeUndefined();
      expect(result?.scheduledRun.runCount).toBe(3);
    });

    it("excludes running lane and job peers, and claims each deploy release once", async () => {
      const p = await project("queue");
      const job = await repo.createJob({
        workspaceId: workspace.oid,
        projectId: p._id,
        name: "test",
        environment: "dev",
        createdBy: userId,
      });
      const input = {
        workspaceId: workspace.oid,
        projectId: p._id,
        jobId: job._id,
        environment: "dev",
        trigger: "manual" as const,
        triggeredBy: userId,
        commands: ["test"],
      };
      const first = await repo.createRun({
        ...input,
        deploysAfterRun: {
          workspaceId: workspace.oid,
          appIds: ["a"],
          sha: "abc",
        },
      });
      const second = await repo.createRun({ ...input, lane: "fast" });
      const third = await repo.createRun({ ...input, jobId: undefined });
      expect((await repo.claimRunSlot(first._id, at)).state).toBe("claimed");
      for (const run of [second, third]) {
        expect(await repo.claimRunSlot(run._id)).toEqual({
          state: "busy",
          holderId: first._id,
        });
      }
      expect(await repo.joinDeploysAfterRun(first._id, ["a", "b"])).toBe(true);
      expect(await repo.claimDeploysAfterRelease(first._id)).toBeNull();
      const early = await repo.claimDeploysAfterRelease(first._id, {
        anyStatus: true,
      });
      expect(early?.deploysAfterRun?.appIds.sort()).toEqual(["a", "b"]);
      expect(early?.deploysAfterRun?.releasedEarly).toBe(true);
      expect(await repo.joinDeploysAfterRun(first._id, ["c"])).toBe(false);
      expect(
        await repo.claimDeploysAfterRelease(first._id, { anyStatus: true }),
      ).toBeNull();
      await repo.unclaimDeploysAfterRun(first._id, "releasedAt");
      expect(
        await repo.claimDeploysAfterRelease(first._id, { anyStatus: true }),
      ).toBeTruthy();
      await repo.updateRun(
        first._id,
        {
          status: "success",
          artifactKeys: { manifest: "key" },
          addWarnings: ["w"],
          pushStepResults: [],
        },
        { status: "running" },
      );
      expect(
        await repo.updateRun(
          first._id,
          { status: "error" },
          { status: "running" },
        ),
      ).toBeNull();
      await repo.updateRun(first._id, {
        artifactKeys: { catalog: "cat" },
        addWarnings: ["w", "x"],
      });
      expect(
        (
          await repo.findLatestRun({ projectId: p._id, manifestKey: "key" })
        )?.warnings?.sort(),
      ).toEqual(["w", "x"]);
      const replay = await repo.finishRun(
        first._id,
        { status: "success", completedAt: at },
        "running",
      );
      expect(replay).toBeNull();
      expect(await repo.claimDeploysAfterRerelease(first._id)).toBeTruthy();
      expect(await repo.claimDeploysAfterRerelease(first._id)).toBeNull();
      expect((await repo.claimRunSlot(second._id, at)).state).toBe("claimed");
      await repo.updateRun(second._id, {
        cancelledAt: at,
        cancelledBy: "Joan",
      });
      await repo.finalizeCancelledRun(second._id);
      const cancelled = await repo.findRunById(second._id);
      expect(cancelled).toMatchObject({
        status: "cancelled",
        cancelledBy: "Joan",
        cancelledAt: at,
      });
      await repo.finalizeCancelledRun(second._id, "other");
      expect((await repo.findRunById(second._id))?.completedAt).toEqual(
        cancelled?.completedAt,
      );
    });

    it("retains exactly 5000 lines, reads absolute cursors and prunes terminal history", async () => {
      const p = await project("logs");
      const input = {
        workspaceId: workspace.oid,
        projectId: p._id,
        environment: "dev",
        trigger: "manual" as const,
        triggeredBy: userId,
        commands: ["test"],
      };
      const lines = (a: number, n: number) =>
        Array.from({ length: n }, (_, i) => ({
          ts: at,
          level: "info",
          line: String(a + i),
        }));
      const r = await repo.createRun({ ...input, logs: lines(0, 192) });
      await repo.appendRunLogs(r._id, lines(192, 4950));
      const full = await repo.findRunWithLogs(r._id);
      expect(full?.logTotal).toBe(5142);
      expect(full?.logs).toHaveLength(5000);
      expect(full?.logs[0].line).toBe("142");
      expect(
        (await repo.findRunWithLogs(r._id, undefined, 5141))?.logs,
      ).toEqual(lines(5141, 1));
      expect(
        (await repo.listActiveRunsWithLogTail(2)).find(x => x.run._id === r._id)
          ?.logs,
      ).toEqual(lines(5140, 2));
      expect(await repo.findRunById(r._id)).not.toHaveProperty("logs");
      await repo.pruneTerminalRuns(new Date(Date.now() + 60000));
      expect(await repo.findRunById(r._id)).toBeTruthy();
      await repo.updateRun(r._id, { status: "success" });
      await repo.pruneTerminalRuns(new Date(Date.now() + 60000));
      expect(await repo.findRunById(r._id)).toBeNull();
    });
  });

  it("serializes competing claims and log appends, and cascades the physical log window", async () => {
    const p = await pgRepo.createProject({
      workspaceId: workspace.oid,
      name: "Competing writers",
      createdBy: userId,
    });
    const input = {
      workspaceId: workspace.oid,
      projectId: p._id,
      environment: "dev",
      trigger: "manual" as const,
      triggeredBy: userId,
      commands: ["build"],
    };
    const ids = await Promise.all([
      pgRepo.createRun(input),
      pgRepo.createRun(input),
    ]);
    const claims = await Promise.all(
      ids.map(run => pgRepo.claimRunSlot(run._id)),
    );
    expect(claims.map(c => c.state).sort()).toEqual(["busy", "claimed"]);
    const fast = await pgRepo.createRun({ ...input, lane: "fast" });
    expect((await pgRepo.claimRunSlot(fast._id)).state).toBe("claimed");
    const j = await pgRepo.createJob({
      workspaceId: workspace.oid,
      projectId: p._id,
      name: "Finished job",
      environment: "dev",
      createdBy: "sync",
    });
    const jobRun = await pgRepo.createRun({
      ...input,
      jobId: j._id,
      status: "running",
    });
    const finish = () =>
      pgRepo.finishRun(
        jobRun._id,
        { status: "error", completedAt: new Date(), error: "test failure" },
        "running",
      );
    expect(
      (await Promise.all([finish(), finish()])).filter(Boolean),
    ).toHaveLength(1);
    expect((await pgRepo.findJobById(j._id))?.scheduledRun).toMatchObject({
      runCount: 1,
      consecutiveFailures: 1,
      lastError: "test failure",
    });
    const batch = (line: string) =>
      Array.from({ length: 2501 }, () => ({
        ts: new Date(),
        level: "info",
        line,
      }));
    await Promise.all([
      pgRepo.appendRunLogs(fast._id, batch("a")),
      pgRepo.appendRunLogs(fast._id, batch("b")),
    ]);
    const full = await pgRepo.findRunWithLogs(fast._id);
    expect(full?.logTotal).toBe(5002);
    expect(full?.logs.length).toBe(5000);
    const sizes = full?.logs.reduce(
      (counts, line) => counts.set(line.line, (counts.get(line.line) ?? 0) + 1),
      new Map<string, number>(),
    );
    expect(Array.from(sizes?.values() ?? []).sort()).toEqual([2499, 2501]);
    const retained = async () =>
      (
        await db
          .select({
            n: sql<number>`coalesce(sum(jsonb_array_length(${schema.dbtRunLogs.lines})),0)::int`,
          })
          .from(schema.dbtRunLogs)
          .where(eq(schema.dbtRunLogs.runId, dbtUuid(fast._id)))
      )[0].n;
    expect(await retained()).toEqual(5000);
    await pgRepo.deleteProject(p._id);
    expect(await retained()).toEqual(0);
  });

  it("rejects distinct Mongo records that map to one Postgres ID in each collection", async () => {
    const src = source.db("dbt_id_aliases");
    const id = new mongoose.Types.ObjectId();
    const at = new Date("2026-10-01T00:00:00Z");
    const base = {
      workspaceId: new mongoose.Types.ObjectId(workspace.oid),
      createdAt: at,
      updatedAt: at,
    };
    const records = {
      dbt_projects: { name: "Mixed IDs", createdBy: userId },
      dbt_env_preferences: { projectId: id, userId, environment: "dev" },
      dbt_jobs: {
        projectId: id,
        name: "Mixed IDs",
        createdBy: userId,
        environment: "dev",
      },
      dbt_runs: {
        projectId: id,
        jobId: id,
        status: "success",
        environment: "dev",
        trigger: "schedule",
        triggeredBy: userId,
        logs: [],
      },
    };
    for (const [name, record] of Object.entries(records)) {
      await src.collection(name).insertOne({ ...base, ...record, _id: id });
      await src.collection<{ _id: string } & Document>(name).insertOne({
        ...base,
        ...record,
        _id: id.toHexString(),
        updatedAt: new Date(at.getTime() + 1),
      });
    }
    const result = await backfillDbt(src, db, at, {
      apply: true,
      onException: async () => {},
    });
    for (const table of ["projects", "preferences", "jobs", "runs"] as const) {
      expect(result.counts[table]).toBe(2);
      expect(result.inserted[table]).toBe(1);
      expect(result.skipped[table]).toBe(1);
      expect(result.reasons[`${table}.duplicateSourceId`]).toBe(1);
    }
    expect(result.logs.verifiedRuns).toBe(1);
  });

  it("copies every run and reconciles mutable rows, even when a run finishes without a new log", async () => {
    const src = source.db("dbt_backfill");
    const p = new mongoose.Types.ObjectId();
    const j = new mongoose.Types.ObjectId();
    const r = new mongoose.Types.ObjectId();
    const at = new Date("2026-10-01T00:00:00Z");
    const base = {
      workspaceId: new mongoose.Types.ObjectId(workspace.oid),
      createdAt: at,
      updatedAt: at,
    };
    await src.collection("dbt_projects").insertOne({
      ...base,
      _id: p,
      name: "Imported",
      createdBy: "sync",
      lastProdManifestKey: "imported.json",
    });
    await src
      .collection("dbt_env_preferences")
      .insertOne({ ...base, projectId: p, userId, environment: "dev" });
    await src.collection("dbt_jobs").insertOne({
      ...base,
      _id: j,
      projectId: p,
      environment: "dev",
      name: "Imported job",
      createdBy: "sync",
      scheduledRun: { nextAt: at, runCount: 3 },
    });
    const run = {
      ...base,
      projectId: p,
      jobId: new mongoose.Types.ObjectId(),
      environment: "dev",
      trigger: "manual",
      triggeredBy: userId,
      commands: ["build"],
      status: "success",
      logTotal: 45,
      logs: [{ ts: at, level: "info", line: "last" }],
    };
    await src.collection("dbt_runs").insertMany([
      { ...run, _id: r, status: "running" },
      { ...run, completedAt: new Date(0) },
    ]);
    const backfill = (apply: boolean) =>
      backfillDbt(src, db, at, { apply, onException: async () => {} });
    const plan = await backfill(false);
    expect(plan.history.olderTerminal.sourceRuns).toBe(1);
    expect(plan.wouldInsert).toEqual(plan.counts);
    expect(plan.counts).toEqual({
      projects: 1,
      preferences: 1,
      jobs: 1,
      runs: 2,
    });
    expect(await pgRepo.findProjectById(String(p))).toBeNull();
    expect((await backfill(true)).inserted).toEqual(plan.counts);
    expect((await backfill(true)).inserted).toEqual({
      projects: 0,
      preferences: 0,
      jobs: 0,
      runs: 0,
    });
    expect(
      await pgRepo.findRunWithLogs(String(r), undefined, 44),
    ).toMatchObject({
      createdAt: at,
      updatedAt: at,
      logTotal: 45,
      logs: run.logs,
    });
    expect((await pgRepo.findRunById(String(r)))?.jobId).toBeUndefined();
    expect((await pgRepo.findJobById(String(j)))?.scheduledRun).toMatchObject({
      nextAt: at,
      runCount: 3,
    });
    await src.collection("dbt_runs").updateOne(
      { _id: r },
      {
        $set: {
          status: "success",
          completedAt: at,
          artifactKeys: { manifest: "last.json" },
        },
      },
    );
    await src
      .collection("dbt_jobs")
      .updateOne(
        { _id: j },
        { $set: { enabled: false, "scheduledRun.runCount": 4 } },
      );
    await src
      .collection("dbt_projects")
      .updateOne(
        { _id: p },
        { $set: { name: "New name" }, $unset: { lastProdManifestKey: "" } },
      );
    await src
      .collection("dbt_env_preferences")
      .updateOne({ projectId: p }, { $set: { environment: "prod" } });
    const planned = await backfill(false);
    expect(planned.wouldUpdate).toEqual({
      projects: 1,
      preferences: 1,
      jobs: 1,
      runs: 1,
    });
    const repaired = await backfill(true);
    expect(repaired.reconciled).toEqual(planned.wouldUpdate);
    expect(repaired.history.olderTerminal).toEqual({
      sourceRuns: 1,
      verifiedRuns: 1,
      sourceLines: 1,
      sourceLinesOutsideWindow: 0,
      verifiedLines: 1,
    });
    expect(await pgRepo.findRunById(String(r))).toMatchObject({
      status: "success",
      completedAt: at,
      artifactKeys: { manifest: "last.json" },
      logTotal: 45,
    });
    expect(
      (await pgRepo.findProjectById(String(p)))?.lastProdManifestKey,
    ).toBeUndefined();
    expect((await pgRepo.findJobById(String(j)))?.enabled).toBe(false);
    expect(
      (await pgRepo.findEnvPreference(String(p), userId))?.environment,
    ).toBe("prod");
    const late = { ts: at, level: "error", line: "late buffered output" };
    await src
      .collection("dbt_runs")
      .updateOne(
        { _id: r },
        { $set: { logs: [...run.logs, late], logTotal: 46 } },
      );
    expect((await backfill(true)).reconciled.runs).toBe(1);
    expect(
      (await pgRepo.findRunWithLogs(String(r), undefined, 45))?.logs,
    ).toEqual([late]);
    await pgRepo.updateRun(String(r), { error: "later PG write" });
    await pgRepo.updateJob(String(j), { name: "newer in PG" });
    const protectedRows = await backfill(true);
    expect(protectedRows.reasons["runs.targetChanged"]).toBe(1);
    expect(protectedRows.reasons["jobs.targetChanged"]).toBe(1);
    expect((await pgRepo.findRunById(String(r)))?.error).toBe("later PG write");
    expect((await pgRepo.findJobById(String(j)))?.name).toBe("newer in PG");
  });
  it("verifies persisted chunks across run batches and rolls earlier writes back on a late mismatch", async () => {
    const src = source.db("dbt_bulk_parity");
    const project = new mongoose.Types.ObjectId();
    const base = {
      workspaceId: new mongoose.Types.ObjectId(workspace.oid),
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    await src.collection("dbt_projects").insertOne({
      ...base,
      _id: project,
      name: "Bulk parity",
      createdBy: userId,
    });
    const runs = Array.from({ length: 130 }, (_, index) => ({
      ...base,
      _id: new mongoose.Types.ObjectId(),
      projectId: project,
      environment: "prod",
      trigger: "manual",
      triggeredBy: userId,
      commands: ["build"],
      status: "success",
      logTotal: 42,
      logs: [{ ts: base.createdAt, level: "info", line: "original " + index }],
    }));
    await src.collection("dbt_runs").insertMany(runs);
    const last = runs[runs.length - 1];
    const copy = (tx: MakoPgDb) =>
      backfillDbt(src, tx, new Date(), {
        apply: true,
        onException: async () => {},
      });
    // Preserve count and cursor but damage one persisted historical line.
    await pg.exec(`
      create function corrupt_dbt_fixture() returns trigger language plpgsql as $$
        begin
          if new.run_id = '${dbtUuid(String(last._id))}'::uuid then
            new.lines = jsonb_set(new.lines, '{0,line}', '"changed"'::jsonb);
          end if;
          return new;
        end $$;
      create trigger corrupt_fixture before insert on dbt_run_logs
        for each row execute function corrupt_dbt_fixture();
    `);
    try {
      await expect(db.transaction(copy)).rejects.toThrow(
        "dbt row or retained log verification failed",
      );
      expect(await pgRepo.findProjectById(String(project))).toBeNull();
      expect(await pgRepo.findRunById(String(runs[0]._id))).toBeNull();
    } finally {
      await pg.exec(
        "drop trigger corrupt_fixture on dbt_run_logs; drop function corrupt_dbt_fixture()",
      );
    }
    expect((await db.transaction(copy)).inserted.runs).toBe(runs.length);
    await src
      .collection("dbt_runs")
      .updateOne(
        { _id: last._id },
        { $set: { "logs.0.line": "updated source" } },
      );
    await pgRepo.updateRun(String(runs[0]._id), { error: "later PG edit" });
    const staged = await db.transaction(copy);
    expect(staged).toMatchObject({
      existing: { runs: 128 },
      reconciled: { runs: 1 },
      skipped: { runs: 1 },
      reasons: { "runs.targetChanged": 1 },
    });
    expect(
      (await pgRepo.findRunWithLogs(String(last._id), undefined, 41))?.logs[0]
        .line,
    ).toBe("updated source");
    expect((await pgRepo.findRunById(String(runs[0]._id)))?.error).toBe(
      "later PG edit",
    );
    await src.collection("dbt_runs").deleteOne({ _id: last._id });
    const verify = await backfillDbt(src, db, new Date(), {
      apply: false,
      onException: async () => {},
    });
    expect(verify.targetOnly.runs).toContain(dbtUuid(String(last._id)));
  });

  it("reconciles orphaned and colliding source rows without overwriting replacements", async () => {
    const src = source.db("dbt_exceptions");
    const oid = () => new mongoose.Types.ObjectId();
    const at = new Date("2026-10-01T12:00:00Z");
    const base = {
      workspaceId: new mongoose.Types.ObjectId(workspace.oid),
      createdAt: at,
      updatedAt: at,
    };
    const p = await pgRepo.createProject({
      workspaceId: workspace.oid,
      name: "Replacement project",
      createdBy: userId,
    });
    const projectId = new mongoose.Types.ObjectId(p._id);
    const orphanProject = oid(),
      orphanWorkspace = oid(),
      oldProject = oid();
    const j = await pgRepo.createJob({
      workspaceId: workspace.oid,
      projectId: p._id,
      slug: "nightly",
      name: "Replacement job",
      environment: "prod",
      createdBy: userId,
    });
    await pgRepo.upsertEnvPreference({
      workspaceId: workspace.oid,
      projectId: p._id,
      userId,
      environment: "prod",
    });
    await src.collection("dbt_projects").insertMany([
      { ...base, _id: oldProject, name: p.name, createdBy: "sync" },
      {
        ...base,
        workspaceId: orphanWorkspace,
        name: "Deleted workspace project",
        createdBy: "sync",
      },
    ]);
    const oldJob = oid();
    const job = {
      ...base,
      projectId,
      name: "Historical job",
      slug: "nightly",
      environment: "dev",
      createdBy: "sync",
    };
    await src.collection("dbt_jobs").insertMany([
      { ...job, _id: oldJob },
      { ...job, projectId: oldProject },
      { ...job, workspaceId: orphanWorkspace, projectId: orphanProject },
    ]);
    const missingUserOnly = oid();
    const missingUserAndProject = oid();
    await src.collection("dbt_env_preferences").insertMany([
      { ...base, projectId, userId, environment: "dev" },
      {
        ...base,
        _id: missingUserOnly,
        projectId,
        userId: "api-key",
        environment: "dev",
      },
      {
        ...base,
        _id: missingUserAndProject,
        projectId: orphanProject,
        userId: "deleted-user",
        environment: "dev",
      },
      {
        ...base,
        workspaceId: orphanWorkspace,
        projectId,
        userId,
        environment: "dev",
      },
    ]);
    const id = oid();
    const longLine = "historical 🚀".repeat(400);
    const lines = Array.from({ length: 5003 }, (_, i) => ({
      ts: new Date(+at + i),
      level: i % 2 ? "warn" : "info",
      line: i === 5001 ? longLine : "line " + i,
    }));
    const run = {
      ...base,
      projectId,
      environment: "dev",
      trigger: "manual",
      triggeredBy: userId,
      commands: ["build"],
      status: "success",
      completedAt: at,
    };
    const lostId = oid();
    await src.collection("dbt_runs").insertMany([
      { ...run, _id: id, jobId: oldJob, logTotal: 7000, logs: lines },
      {
        ...run,
        _id: lostId,
        projectId: oldProject,
        logs: [{ ts: at, level: "warn", line: "original orphan log" }],
      },
      {
        ...run,
        workspaceId: orphanWorkspace,
        projectId: orphanProject,
        jobId: oid(),
      },
      { ...run, status: "running", completedAt: null, createdAt: new Date(0) },
      { ...run, completedAt: new Date(0) },
    ]);
    const exceptions = new Map<string, Document>();
    const execute = (apply: boolean, acceptedPreferenceIds?: Set<string>) =>
      backfillDbt(src, db, at, {
        apply,
        acceptedPreferenceIds,
        onException: async entry => {
          exceptions.set(entry.sourceId, entry);
        },
      });
    const dry = await execute(false);
    expect(dry.wouldInsert).toEqual({
      projects: 0,
      preferences: 0,
      jobs: 0,
      runs: 3,
    });
    expect(dry.history.olderTerminal.sourceRuns).toBe(1);
    expect(await pgRepo.findRunById(String(id))).toBeNull();
    exceptions.clear();
    expect(dry.acceptedPreferences).toEqual([]);
    const first = await execute(
      true,
      new Set([String(missingUserOnly), String(missingUserAndProject)]),
    );
    expect(first.acceptedPreferences).toEqual([String(missingUserOnly)]);
    expect(exceptions.get(String(missingUserOnly))?.document.userId).toBe(
      "api-key",
    );
    expect(first.inserted).toEqual(dry.wouldInsert);
    expect(first.skipped).toEqual({
      projects: 2,
      preferences: 4,
      jobs: 3,
      runs: 2,
    });
    expect(first.reasons).toEqual({
      "projects.secondaryKeyCollision": 1,
      "projects.missingWorkspace": 1,
      "preferences.secondaryKeyCollision": 2,
      "preferences.missingUser": 2,
      "preferences.missingProject": 1,
      "preferences.missingWorkspace": 1,
      "preferences.projectWorkspaceMismatch": 1,
      "jobs.secondaryKeyCollision": 1,
      "jobs.missingProject": 2,
      "jobs.missingWorkspace": 1,
      "runs.logPrefixOutsideRetainedWindow": 1,
      "runs.missingProject": 2,
      "runs.missingJob": 2,
      "runs.missingWorkspace": 1,
    });
    expect(first.reasons).toEqual(dry.reasons);
    expect(first.logs).toEqual({
      verifiedRuns: 3,
      verifiedLines: 5000,
      mismatchedRuns: 0,
    });
    expect(exceptions.get(String(lostId))?.document.logs[0].line).toEqual(
      "original orphan log",
    );
    expect(exceptions.get(String(oldProject))?.issues).toEqual([
      { reason: "secondaryKeyCollision", targetId: dbtUuid(p._id) },
    ]);
    expect(exceptions.get(String(id))?.document.jobId.toString()).toBe(
      String(oldJob),
    );
    expect(exceptions.get(String(id))?.issues).toContainEqual({
      reason: "logPrefixOutsideRetainedWindow",
      prefixLines: 3,
    });
    expect(exceptions.get(String(id))?.document.logs).toHaveLength(5003);
    expect(
      first.history.recentOrActive.sourceLinesOutsideWindow +
        first.history.olderTerminal.sourceLinesOutsideWindow,
    ).toBe(3);
    expect((await pgRepo.findRunWithLogs(String(id)))?.logs).toEqual(
      lines.slice(-5000),
    );
    expect(
      (await pgRepo.findRunWithLogs(String(id), undefined, 6998))?.logs,
    ).toEqual(lines.slice(-2));
    expect((await pgRepo.findRunById(String(id)))?.jobId).toBeUndefined();
    expect((await pgRepo.findEnvPreference(p._id, userId))?.environment).toBe(
      "prod",
    );
    expect((await pgRepo.findJobById(j._id))?.name).toBe("Replacement job");
    const replay = await execute(true);
    expect(replay.inserted.runs).toBe(0);
    expect(replay.existing.runs).toBe(3);
    expect(replay.logs).toEqual(first.logs);
    // Same row count and cursor, different payload. Replay reports the exact
    // source row and leaves the target's newer contents intact.
    await db.execute(
      sql`update dbt_run_logs set lines=jsonb_set(lines,'{0,line}','"changed"') where run_id=${dbtUuid(String(id))} and seq_start=2000`,
    );
    const mismatch = await execute(true);
    expect(mismatch.logs.mismatchedRuns).toBe(1);
    expect(exceptions.get(String(id))?.issues).toContainEqual({
      reason: "targetChanged",
      fields: ["retainedLogs"],
      targetId: dbtUuid(String(id)),
    });
    expect((await pgRepo.findRunWithLogs(String(id)))?.logs[0].line).toBe(
      "changed",
    );
  });
  it("keeps dbt on Mongo after failed parity and switches only with a committed activation", async () => {
    const bridge = createDbtCutoverRepo(pgRepo, mongoRepo, () => db);
    const project = await bridge.createProject({
      workspaceId: workspace.oid,
      name: "Handoff",
      createdBy: userId,
    });
    expect(await pgRepo.findProjectById(project._id)).toBeNull();
    await expect(
      activateDbtStore(db, source.db(), async tx => {
        await tx.insert(schema.dbtProjects).values({
          id: dbtUuid(project._id),
          workspaceId: workspace.uuid,
          name: "rollback",
          createdBy: userId,
        });
        throw new Error("failed parity");
      }),
    ).rejects.toThrow("failed parity");
    expect(await dbtUsesPostgres(db)).toBe(false);
    expect(await bridge.findProjectById(project._id)).toMatchObject({
      name: "Handoff",
    });
    expect(await pgRepo.findProjectById(project._id)).toBeNull();
    await activateDbtStore(db, source.db(), async tx => {
      await tx.insert(schema.dbtProjects).values({
        id: dbtUuid(project._id),
        workspaceId: workspace.uuid,
        name: "activated",
        createdBy: userId,
      });
    });
    expect(await bridge.findProjectById(project._id)).toMatchObject({
      name: "activated",
    });
    expect(await mongoRepo.findProjectById(project._id)).toMatchObject({
      name: "Handoff",
    });
  });
});
