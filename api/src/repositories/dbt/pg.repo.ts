import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { getPgDb, type MakoPgDb } from "../../database/pg/client";
import { newDualId, toWireId } from "../../database/pg/id-codec";
import {
  dbtProjects as projects,
  dbtEnvPreferences as prefs,
  dbtJobs as jobs,
  dbtRuns as runs,
  dbtRunLogs as logs,
} from "../../database/pg/schema/dbt";
import { authRepo } from "../auth";
import {
  dbtUuid,
  environmentToJson,
  invalidMarkerToJson,
  jobValues,
  logLineFrom,
  logLineToJson,
  pgEnvPreferenceToRecord,
  pgJobToRecord,
  pgProjectToRecord,
  pgRunToRecord,
  projectValues,
  runValues,
} from "./mapper";
import {
  ACTIVE_DBT_RUN_STATUSES,
  DBT_RUN_MAX_LOG_LINE_CHARS,
  DBT_RUN_MAX_LOG_LINES,
  DbtDuplicateProjectNameError,
  TERMINAL_DBT_RUN_STATUSES,
  type CreateDbtJobInput,
  type CreateDbtProjectInput,
  type CreateDbtRunInput,
  type DbtActiveRunWithLogTail,
  type DbtDeploysAfterClaim,
  type DbtDueScheduledJob,
  type DbtJobRunOutcome,
  type DbtJobScope,
  type DbtJobUpdate,
  type DbtProjectUpdate,
  type DbtRepository,
  type DbtRunGuard,
  type DbtRunStatus,
  type DbtRunLogLine,
  type DbtRunQuery,
  type DbtRunSlotClaim,
  type DbtRunSlotSubject,
  type DbtRunUpdate,
  type ListDbtProjectsOptions,
  type ListDbtRunsOptions,
  type UpsertDbtEnvPreferenceInput,
} from "./types";

export interface PgDbtRepositoryDeps {
  getDb?: () => MakoPgDb;
  resolveUserUuid?: (idOrLegacyId: string) => Promise<string | null>;
}

const now = sql`now()`;
const json = (value: unknown) => sql`${JSON.stringify(value)}::jsonb`;
const active = inArray(runs.status, [...ACTIVE_DBT_RUN_STATUSES]);
const terminal = inArray(runs.status, [...TERMINAL_DBT_RUN_STATUSES]);

function runWhere(q: DbtRunQuery = {}) {
  return and(
    q.workspaceId !== undefined
      ? eq(runs.workspaceId, dbtUuid(q.workspaceId))
      : undefined,
    q.projectId !== undefined
      ? eq(runs.projectId, dbtUuid(q.projectId))
      : undefined,
    q.jobId !== undefined ? eq(runs.jobId, dbtUuid(q.jobId)) : undefined,
    q.excludeRunId !== undefined
      ? ne(runs.id, dbtUuid(q.excludeRunId))
      : undefined,
    q.status === undefined
      ? undefined
      : typeof q.status === "string"
        ? eq(runs.status, q.status)
        : inArray(runs.status, [...q.status]),
    q.environment !== undefined
      ? eq(runs.environment, q.environment)
      : undefined,
    q.triggeredBy !== undefined
      ? eq(runs.triggeredBy, q.triggeredBy)
      : undefined,
    q.lane === "default"
      ? or(eq(runs.lane, "default"), isNull(runs.lane))
      : q.lane && eq(runs.lane, q.lane),
    q.createdBefore && lt(runs.createdAt, q.createdBefore),
    q.durationMsGreaterThan !== undefined
      ? gt(runs.durationMs, q.durationMsGreaterThan)
      : undefined,
    q.manifestKey !== undefined
      ? sql`${runs.artifactKeys}->>'manifest' = ${q.manifestKey}`
      : q.hasManifest
        ? sql`${runs.artifactKeys}->>'manifest' IS NOT NULL`
        : undefined,
    q.hasSemanticManifest
      ? sql`${runs.artifactKeys}->>'semanticManifest' IS NOT NULL`
      : undefined,
    q.hasLocalOverlay ? isNotNull(runs.localOverlay) : undefined,
    q.deploysAfter &&
      eq(runs.deploysAfterWorkspaceId, dbtUuid(q.deploysAfter.workspaceId)),
    q.deploysAfter && eq(runs.deploysAfterSha, q.deploysAfter.sha),
  );
}

function jobWhere(id: string, scope: DbtJobScope = {}) {
  return and(
    eq(jobs.id, dbtUuid(id)),
    scope.projectId !== undefined
      ? eq(jobs.projectId, dbtUuid(scope.projectId))
      : undefined,
    scope.workspaceId !== undefined
      ? eq(jobs.workspaceId, dbtUuid(scope.workspaceId))
      : undefined,
  );
}

async function slotHolder(db: MakoPgDb, subject: DbtRunSlotSubject) {
  const [row] = await db
    .select()
    .from(runs)
    .where(
      and(
        eq(runs.projectId, dbtUuid(subject.projectId)),
        ne(runs.id, dbtUuid(subject._id)),
        eq(runs.status, "running"),
        or(
          runWhere({ lane: subject.lane ?? "default" }),
          subject.jobId ? eq(runs.jobId, dbtUuid(subject.jobId)) : undefined,
        ),
      ),
    )
    .orderBy(asc(runs.startedAt))
    .limit(1);
  return row ? pgRunToRecord(row) : null;
}

/** Absolute, half-open line ranges. Bound chunk size even for a large backfill. */
export function dbtLogChunks(
  runId: string,
  total: number,
  lines: readonly DbtRunLogLine[],
  options: { historical?: boolean } = {},
) {
  const retained = lines.slice(-DBT_RUN_MAX_LOG_LINES);
  const chunks = [];
  for (let i = 0; i < retained.length; i += 128) {
    const batch = retained.slice(i, i + 128).map(line =>
      logLineToJson({
        ...line,
        line: options.historical
          ? line.line
          : line.line.slice(0, DBT_RUN_MAX_LOG_LINE_CHARS),
      }),
    );
    const seqStart = total - retained.length + i;
    chunks.push({
      runId,
      seqStart,
      seqEnd: seqStart + batch.length,
      lines: batch,
    });
  }
  return chunks;
}

export async function insertLogChunks(
  db: MakoPgDb,
  runId: string,
  total: number,
  lines: readonly DbtRunLogLine[],
  options: { historical?: boolean } = {},
) {
  const chunks = dbtLogChunks(runId, total, lines, options);
  if (chunks.length) await db.insert(logs).values(chunks);
}

async function readLogs(db: MakoPgDb, runId: string, since: number) {
  const rows = await db
    .select()
    .from(logs)
    .where(and(eq(logs.runId, runId), gt(logs.seqEnd, since)))
    .orderBy(asc(logs.seqEnd));
  return rows.flatMap(row =>
    row.lines.slice(Math.max(0, since - row.seqStart)).map(logLineFrom),
  );
}

export class PgDbtRepository implements DbtRepository {
  private readonly db;
  private readonly resolveUser;
  constructor(deps: PgDbtRepositoryDeps = {}) {
    this.db = deps.getDb ?? getPgDb;
    this.resolveUser = deps.resolveUserUuid ?? authRepo.resolveUserUuid;
  }

  async findProjectById(id: string, workspaceId?: string) {
    const [row] = await this.db()
      .select()
      .from(projects)
      .where(
        and(
          eq(projects.id, dbtUuid(id)),
          workspaceId !== undefined
            ? eq(projects.workspaceId, dbtUuid(workspaceId))
            : undefined,
        ),
      );
    return row ? pgProjectToRecord(row) : null;
  }

  async listProjectsByWorkspace(
    id: string,
    options: ListDbtProjectsOptions = {},
  ) {
    const query = this.db()
      .select()
      .from(projects)
      .where(
        and(
          eq(projects.workspaceId, dbtUuid(id)),
          options.projectId !== undefined
            ? eq(projects.id, dbtUuid(options.projectId))
            : undefined,
        ),
      )
      .orderBy(
        options.sort === "nameAsc"
          ? asc(projects.name)
          : desc(projects.updatedAt),
      );
    return (await (options.limit ? query.limit(options.limit) : query)).map(
      pgProjectToRecord,
    );
  }

  async workspaceHasProject(id: string) {
    return (
      (
        await this.db()
          .select({ id: projects.id })
          .from(projects)
          .where(eq(projects.workspaceId, dbtUuid(id)))
          .limit(1)
      ).length > 0
    );
  }

  async createProject(input: CreateDbtProjectInput) {
    const [row] = await this.db()
      .insert(projects)
      .values(projectValues(input, await this.resolveUser(input.createdBy)))
      .onConflictDoNothing({ target: [projects.workspaceId, projects.name] })
      .returning();
    if (!row) throw new DbtDuplicateProjectNameError(input.name);
    return pgProjectToRecord(row);
  }

  async updateProject(id: string, update: DbtProjectUpdate) {
    const [row] = await this.db()
      .update(projects)
      .set({
        ...update,
        name: update.name?.trim(),
        environments: update.environments?.map(environmentToJson),
        environmentsInvalid:
          update.environmentsInvalid === undefined
            ? undefined
            : invalidMarkerToJson(update.environmentsInvalid),
        updatedAt: now,
      })
      .where(eq(projects.id, dbtUuid(id)))
      .returning();
    return row ? pgProjectToRecord(row) : null;
  }

  async promoteProdManifest(
    p: Parameters<DbtRepository["promoteProdManifest"]>[0],
  ) {
    const rows = await this.db()
      .update(projects)
      .set({
        lastProdManifestCommittedAt: p.committedAt,
        lastProdManifestSha: p.sourceSha ?? null,
        lastProdManifestKey: p.manifestKey,
        updatedAt: now,
      })
      .where(
        and(
          eq(projects.id, dbtUuid(p.projectId)),
          or(
            isNull(projects.lastProdManifestCommittedAt),
            lte(projects.lastProdManifestCommittedAt, p.committedAt),
          ),
        ),
      )
      .returning({ id: projects.id });
    return rows.length > 0;
  }

  async deleteProject(id: string) {
    return (
      (
        await this.db()
          .delete(projects)
          .where(eq(projects.id, dbtUuid(id)))
          .returning({ id: projects.id })
      ).length > 0
    );
  }

  async deleteProjectsByWorkspace(id: string) {
    return (
      await this.db()
        .delete(projects)
        .where(eq(projects.workspaceId, dbtUuid(id)))
        .returning({ id: projects.id })
    ).length;
  }

  async findEnvPreference(projectId: string, userId: string) {
    return (
      (await this.listEnvPreferencesForUser([projectId], userId))[0] ?? null
    );
  }

  async listEnvPreferencesForUser(ids: readonly string[], userId: string) {
    const user = await this.resolveUser(userId);
    if (!user || !ids.length) return [];
    return (
      await this.db()
        .select()
        .from(prefs)
        .where(
          and(
            inArray(prefs.projectId, ids.map(dbtUuid)),
            eq(prefs.userId, user),
          ),
        )
    ).map(pgEnvPreferenceToRecord);
  }

  async upsertEnvPreference(input: UpsertDbtEnvPreferenceInput) {
    const userId = await this.resolveUser(input.userId);
    if (!userId) throw new Error("Unknown dbt preference user");
    const [row] = await this.db()
      .insert(prefs)
      .values({
        ...input,
        id: newDualId().uuid,
        userId,
        projectId: dbtUuid(input.projectId),
        workspaceId: dbtUuid(input.workspaceId),
      })
      .onConflictDoUpdate({
        target: [prefs.projectId, prefs.userId],
        set: { environment: input.environment, updatedAt: now },
      })
      .returning();
    return pgEnvPreferenceToRecord(row);
  }

  async deleteEnvPreference(projectId: string, userId: string) {
    const user = await this.resolveUser(userId);
    if (!user) return false;
    return (
      (
        await this.db()
          .delete(prefs)
          .where(
            and(
              eq(prefs.projectId, dbtUuid(projectId)),
              eq(prefs.userId, user),
            ),
          )
          .returning({ id: prefs.id })
      ).length > 0
    );
  }

  async findJobById(id: string, scope?: DbtJobScope) {
    const [row] = await this.db()
      .select()
      .from(jobs)
      .where(jobWhere(id, scope));
    return row ? pgJobToRecord(row) : null;
  }

  async findJobBySlug(projectId: string, slug: string) {
    const [row] = await this.db()
      .select()
      .from(jobs)
      .where(and(eq(jobs.projectId, dbtUuid(projectId)), eq(jobs.slug, slug)));
    return row ? pgJobToRecord(row) : null;
  }

  async listJobsByProject(projectId: string) {
    return (
      await this.db()
        .select()
        .from(jobs)
        .where(eq(jobs.projectId, dbtUuid(projectId)))
        .orderBy(asc(jobs.createdAt), asc(jobs.id))
    ).map(pgJobToRecord);
  }

  async listJobsByIds(ids: readonly string[]) {
    return (
      await this.db()
        .select()
        .from(jobs)
        .where(inArray(jobs.id, ids.map(dbtUuid)))
    ).map(pgJobToRecord);
  }

  async jobSlugExists(projectId: string, slug: string) {
    return Boolean(await this.findJobBySlug(projectId, slug));
  }

  async createJob(input: CreateDbtJobInput) {
    const [row] = await this.db()
      .insert(jobs)
      .values(jobValues(input, await this.resolveUser(input.createdBy)))
      .returning();
    return pgJobToRecord(row);
  }

  async updateJob(id: string, update: DbtJobUpdate) {
    const { scheduledRun, definitionInvalid, ...patch } = update;
    const { nextAt, ...stats } = scheduledRun ?? {};
    const [row] = await this.db()
      .update(jobs)
      .set({
        ...patch,
        name: patch.name?.trim(),
        updatedAt: now,
        definitionInvalid:
          definitionInvalid === undefined
            ? undefined
            : invalidMarkerToJson(definitionInvalid),
        scheduledRunNextAt: nextAt,
        scheduledRun: Object.keys(stats).length
          ? sql`jsonb_strip_nulls(coalesce(${jobs.scheduledRun},'{}') || ${json(stats)})`
          : undefined,
      })
      .where(eq(jobs.id, dbtUuid(id)))
      .returning();
    return row ? pgJobToRecord(row) : null;
  }

  async recordJobRunOutcome(id: string, outcome: DbtJobRunOutcome) {
    const stats = {
      lastAt: outcome.completedAt,
      lastStatus: outcome.status,
      lastError: outcome.status === "error" ? outcome.error : null,
      lastDurationMs: outcome.durationMs,
    };
    const failures =
      outcome.status === "error"
        ? sql`coalesce((${jobs.scheduledRun}->>'consecutiveFailures')::integer,0)+1`
        : sql`0`;
    const [row] = await this.db()
      .update(jobs)
      .set({
        updatedAt: now,
        scheduledRun: sql`jsonb_strip_nulls(
          coalesce(${jobs.scheduledRun}, '{}') || ${json(stats)} ||
          jsonb_build_object(
            'runCount', coalesce((${jobs.scheduledRun}->>'runCount')::integer, 0) + 1,
            'consecutiveFailures', ${failures}
          )
        )`,
      })
      .where(eq(jobs.id, dbtUuid(id)))
      .returning();
    return row ? pgJobToRecord(row) : null;
  }

  async resetJobFailuresIfReenabled(id: string, threshold: number) {
    if (threshold <= 0) return false;
    return (
      (
        await this.db()
          .update(jobs)
          .set({
            scheduledRun: sql`${jobs.scheduledRun} || '{"consecutiveFailures":0}'::jsonb`,
            updatedAt: now,
          })
          .where(
            and(
              eq(jobs.id, dbtUuid(id)),
              eq(jobs.enabled, true),
              sql`(${jobs.scheduledRun}->>'consecutiveFailures')::integer >= ${threshold}`,
            ),
          )
          .returning({ id: jobs.id })
      ).length > 0
    );
  }

  async deleteJob(id: string, scope?: DbtJobScope) {
    return (
      (
        await this.db()
          .delete(jobs)
          .where(jobWhere(id, scope))
          .returning({ id: jobs.id })
      ).length > 0
    );
  }

  async findDueScheduledJobs(at: Date) {
    const rows = await this.db()
      .select({
        id: jobs.id,
        workspaceId: jobs.workspaceId,
        nextAt: jobs.scheduledRunNextAt,
        schedule: jobs.schedule,
      })
      .from(jobs)
      .where(
        and(
          eq(jobs.enabled, true),
          lte(jobs.scheduledRunNextAt, at),
          sql`${jobs.schedule}->>'cron' <> ''`,
        ),
      );
    return rows.map(row => ({
      ...row,
      id: toWireId(row.id),
      workspaceId: toWireId(row.workspaceId),
    }));
  }

  async claimScheduledJob(job: DbtDueScheduledJob, nextAt: Date) {
    if (!job.nextAt) return { modifiedCount: 0 };
    const rows = await this.db()
      .update(jobs)
      .set({ scheduledRunNextAt: nextAt, updatedAt: now })
      .where(
        and(
          eq(jobs.id, dbtUuid(job.id)),
          eq(jobs.enabled, true),
          eq(jobs.scheduledRunNextAt, new Date(job.nextAt)),
        ),
      )
      .returning({ id: jobs.id });
    return { modifiedCount: rows.length };
  }

  async findRunById(id: string, q?: DbtRunQuery) {
    const [row] = await this.db()
      .select()
      .from(runs)
      .where(and(eq(runs.id, dbtUuid(id)), runWhere(q)));
    return row ? pgRunToRecord(row) : null;
  }

  async findRunWithLogs(id: string, q?: DbtRunQuery, since = 0) {
    return this.db().transaction(
      async tx => {
        const [row] = await tx
          .select()
          .from(runs)
          .where(and(eq(runs.id, dbtUuid(id)), runWhere(q)));
        if (!row) return null;
        return {
          ...pgRunToRecord(row),
          logs: await readLogs(
            tx,
            row.id,
            Math.min(
              row.logTotal,
              Math.max(0, row.logTotal - DBT_RUN_MAX_LOG_LINES, since),
            ),
          ),
        };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  async findLatestArtifactRun(query: DbtRunQuery, includeSteps = false) {
    const [row] = await this.db()
      .select({
        environment: runs.environment,
        artifactKeys: runs.artifactKeys,
        createdAt: runs.createdAt,
        ...(includeSteps ? { stepResults: runs.stepResults } : {}),
      })
      .from(runs)
      .where(runWhere(query))
      .orderBy(sql`${runs.createdAt} DESC NULLS LAST`)
      .limit(1);
    return row ?? null;
  }

  async findLatestRun(q: DbtRunQuery) {
    return (await this.listRuns(q, { limit: 1 }))[0] ?? null;
  }

  async listRuns(q: DbtRunQuery, options: ListDbtRunsOptions = {}) {
    const query = this.db()
      .select()
      .from(runs)
      .where(runWhere(q))
      .orderBy(
        // The ascending order is the backward scan of the same index.
        options.sort === "createdAtAsc"
          ? sql`${runs.createdAt} ASC NULLS FIRST`
          : sql`${runs.createdAt} DESC NULLS LAST`,
      );
    return (
      await (options.limit ? query.limit(Math.abs(options.limit)) : query)
    ).map(pgRunToRecord);
  }

  async runExists(q: DbtRunQuery) {
    return (
      (
        await this.db()
          .select({ id: runs.id })
          .from(runs)
          .where(runWhere(q))
          .limit(1)
      ).length > 0
    );
  }

  async createRun(input: CreateDbtRunInput) {
    return this.db().transaction(async tx => {
      const lines = input.logs ?? [];
      const [row] = await tx
        .insert(runs)
        .values({ ...runValues(input), logTotal: lines.length })
        .returning();
      await insertLogChunks(tx, row.id, lines.length, lines);
      return pgRunToRecord(row);
    });
  }

  async updateRun(id: string, update: DbtRunUpdate, guard: DbtRunGuard = {}) {
    const { artifactKeys, addWarnings, pushStepResults, ...patch } = update;
    const [row] = await this.db()
      .update(runs)
      .set({
        ...patch,
        updatedAt: now,
        artifactKeys:
          artifactKeys && sql`${runs.artifactKeys} || ${json(artifactKeys)}`,
        stepResults:
          pushStepResults &&
          sql`${runs.stepResults} || ${json(pushStepResults)}`,
        warnings:
          addWarnings &&
          sql`array(
            select value from unnest(coalesce(${runs.warnings}, '{}') ||
              array(select jsonb_array_elements_text(${json(addWarnings)}))) with ordinality as w(value, ord)
            group by value order by min(ord)
          )`,
      })
      .where(and(eq(runs.id, dbtUuid(id)), runWhere(guard)))
      .returning();
    return row ? pgRunToRecord(row) : null;
  }

  async finishRun(
    runId: string,
    outcome: DbtJobRunOutcome,
    expectedStatus: DbtRunStatus,
  ) {
    return this.db().transaction(async tx => {
      const repo = new PgDbtRepository({
        getDb: () => tx,
        resolveUserUuid: this.resolveUser,
      });
      const run = await repo.updateRun(runId, outcome, {
        status: expectedStatus,
      });
      if (!run) return null;
      const job = run.jobId
        ? await repo.recordJobRunOutcome(run.jobId, outcome)
        : null;
      return { run, job };
    });
  }

  async finalizeCancelledRun(id: string, by = "user") {
    await this.db()
      .update(runs)
      .set({
        status: "cancelled",
        completedAt: sql`coalesce(${runs.completedAt},now())`,
        cancelledAt: sql`coalesce(${runs.cancelledAt},now())`,
        cancelledBy: sql`coalesce(${runs.cancelledBy},${by})`,
        error: sql`coalesce(${runs.error},'Cancelled')`,
        durationMs: sql`coalesce(
          floor(extract(epoch from (coalesce(${runs.completedAt}, now()) - ${runs.startedAt})) * 1000)::bigint,
          ${runs.durationMs}
        )`,
        updatedAt: now,
      })
      .where(and(eq(runs.id, dbtUuid(id)), active));
  }

  async findRunSlotHolder(subject: DbtRunSlotSubject) {
    return slotHolder(this.db(), subject);
  }

  async claimRunSlot(id: string, at = new Date()): Promise<DbtRunSlotClaim> {
    return this.db().transaction(async tx => {
      const [row] = await tx
        .select()
        .from(runs)
        .where(and(eq(runs.id, dbtUuid(id)), eq(runs.status, "queued")));
      if (!row) return { state: "gone" };
      // Every claimant locks lane first, then job. Job exclusion spans lanes.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${row.projectId + ":" + (row.lane ?? "default")}))`,
      );
      if (row.jobId) {
        await tx.execute(
          sql`select pg_advisory_xact_lock(1,hashtext(${row.jobId}))`,
        );
      }
      const holder = await slotHolder(tx, pgRunToRecord(row));
      if (holder) return { state: "busy", holderId: holder._id };
      const [claimed] = await tx
        .update(runs)
        .set({ status: "running", startedAt: at, updatedAt: now })
        .where(and(eq(runs.id, row.id), eq(runs.status, "queued")))
        .returning();
      return claimed
        ? { state: "claimed", run: pgRunToRecord(claimed) }
        : { state: "gone" };
    });
  }

  async appendRunLogs(id: string, lines: readonly DbtRunLogLine[]) {
    if (!lines.length) return;
    const runId = dbtUuid(id);
    await this.db().transaction(async tx => {
      const [row] = await tx
        .update(runs)
        .set({
          logTotal: sql`${runs.logTotal} + ${lines.length}`,
          updatedAt: now,
        })
        .where(eq(runs.id, runId))
        .returning({ total: runs.logTotal });
      if (!row) return;
      await insertLogChunks(tx, runId, row.total, lines);
      const cutoff = row.total - DBT_RUN_MAX_LOG_LINES;
      if (cutoff <= 0) return;
      await tx
        .delete(logs)
        .where(and(eq(logs.runId, runId), lte(logs.seqEnd, cutoff)));
      await tx
        .update(logs)
        .set({
          seqStart: cutoff,
          lines: sql`(
            select jsonb_agg(value order by ord)
            from jsonb_array_elements(${logs.lines}) with ordinality as l(value, ord)
            where ord > ${cutoff} - ${logs.seqStart}
          )`,
        })
        .where(
          and(
            eq(logs.runId, runId),
            lt(logs.seqStart, cutoff),
            gt(logs.seqEnd, cutoff),
          ),
        );
    });
  }

  async listActiveRunsWithLogTail(tail: number) {
    const cutoff = sql<number>`greatest(0, ${runs.logTotal} - ${Math.max(1, tail)})`;
    const rows = await this.db()
      .select({
        id: runs.id,
        jobId: runs.jobId,
        status: runs.status,
        createdAt: runs.createdAt,
        startedAt: runs.startedAt,
        cutoff,
        seqStart: logs.seqStart,
        lines: logs.lines,
      })
      .from(runs)
      .leftJoin(logs, and(eq(logs.runId, runs.id), gt(logs.seqEnd, cutoff)))
      .where(active)
      .orderBy(runs.id, logs.seqEnd);
    const grouped = new Map<string, DbtActiveRunWithLogTail>();
    for (const row of rows) {
      let entry = grouped.get(row.id);
      if (!entry) {
        entry = {
          run: {
            _id: toWireId(row.id),
            jobId: row.jobId ? toWireId(row.jobId) : undefined,
            status: row.status,
            createdAt: row.createdAt,
            startedAt: row.startedAt ?? undefined,
          },
          logs: [],
        };
        grouped.set(row.id, entry);
      }
      if (row.lines && row.seqStart !== null) {
        entry.logs.push(
          ...row.lines
            .slice(Math.max(0, row.cutoff - row.seqStart))
            .map(logLineFrom),
        );
      }
    }
    return Array.from(grouped.values());
  }

  async pruneTerminalRuns(cutoff: Date) {
    return (
      await this.db()
        .delete(runs)
        .where(
          and(
            terminal,
            or(
              lt(runs.completedAt, cutoff),
              and(isNull(runs.completedAt), lt(runs.createdAt, cutoff)),
            ),
          ),
        )
        .returning({ id: runs.id })
    ).length;
  }

  async joinDeploysAfterRun(id: string, appIds: readonly string[]) {
    return (
      (
        await this.db()
          .update(runs)
          .set({
            updatedAt: now,
            deploysAfterRun: sql`jsonb_set(${runs.deploysAfterRun}, '{appIds}', (
              select coalesce(jsonb_agg(distinct value), '[]') from jsonb_array_elements(
                coalesce(${runs.deploysAfterRun}->'appIds', '[]') || ${json(appIds)}
              )
            ))`,
          })
          .where(
            and(
              eq(runs.id, dbtUuid(id)),
              active,
              isNotNull(runs.deploysAfterRun),
              sql`not (${runs.deploysAfterRun} ? 'releasedAt')`,
            ),
          )
          .returning({ id: runs.id })
      ).length > 0
    );
  }

  async claimDeploysAfterRelease(
    id: string,
    opts: { anyStatus?: boolean } = {},
  ) {
    const extra = opts.anyStatus
      ? sql`jsonb_build_object('releasedEarly',${active})`
      : sql`'{}'::jsonb`;
    const [row] = await this.db()
      .update(runs)
      .set({
        updatedAt: now,
        deploysAfterRun: sql`${runs.deploysAfterRun} || jsonb_build_object('releasedAt',now()) || ${extra}`,
      })
      .where(
        and(
          eq(runs.id, dbtUuid(id)),
          opts.anyStatus ? undefined : terminal,
          isNotNull(runs.deploysAfterRun),
          sql`not (${runs.deploysAfterRun} ? 'releasedAt')`,
        ),
      )
      .returning();
    return row ? pgRunToRecord(row) : null;
  }

  async claimDeploysAfterRerelease(id: string) {
    const [row] = await this.db()
      .update(runs)
      .set({
        updatedAt: now,
        deploysAfterRun: sql`${runs.deploysAfterRun} || jsonb_build_object('rereleasedAt',now())`,
      })
      .where(
        and(
          eq(runs.id, dbtUuid(id)),
          eq(runs.status, "success"),
          sql`${runs.deploysAfterRun} @> '{"releasedEarly":true}' and not (${runs.deploysAfterRun} ? 'rereleasedAt')`,
        ),
      )
      .returning();
    return row ? pgRunToRecord(row) : null;
  }

  async unclaimDeploysAfterRun(id: string, claim: DbtDeploysAfterClaim) {
    await this.db()
      .update(runs)
      .set({
        updatedAt: now,
        deploysAfterRun:
          claim === "releasedAt"
            ? sql`${runs.deploysAfterRun} - 'releasedAt' - 'releasedEarly'`
            : sql`${runs.deploysAfterRun} - 'rereleasedAt'`,
      })
      .where(eq(runs.id, dbtUuid(id)));
  }
}
