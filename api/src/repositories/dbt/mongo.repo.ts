/** Mongo repository for pre-activation Cloud Run calls and isolated legacy tests. */
import { Types, type ClientSession } from "mongoose";
import {
  DbtEnvPreference,
  DbtJob,
  DbtProject,
  DbtRun,
} from "../../database/models/dbt";
import {
  mongoEnvPreferenceToRecord,
  mongoJobToRecord,
  mongoProjectToRecord,
  mongoRunToRecord,
  mongoRunToRecordWithLogs,
  toMongoEnvironments,
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
  type DbtEnvPreferenceRecord,
  type DbtJobRecord,
  type DbtJobRunOutcome,
  type DbtJobScope,
  type DbtJobUpdate,
  type DbtProjectRecord,
  type DbtProjectUpdate,
  type DbtRepository,
  type DbtRunGuard,
  type DbtRunStatus,
  type DbtRunLane,
  type DbtRunLogLine,
  type DbtRunQuery,
  type DbtRunRecord,
  type DbtRunSlotClaim,
  type DbtRunSlotSubject,
  type DbtRunUpdate,
  type DbtRunWithLogs,
  type ListDbtProjectsOptions,
  type ListDbtRunsOptions,
  type UpsertDbtEnvPreferenceInput,
} from "./types";

type Filter = Record<string, unknown>;

/** A valid ObjectId or null (an unknown id matches nothing). */
function oid(
  id: string | Types.ObjectId | null | undefined,
): Types.ObjectId | null {
  if (!id) return null;
  if (id instanceof Types.ObjectId) return id;
  return Types.ObjectId.isValid(id) && /^[0-9a-fA-F]{24}$/.test(id)
    ? new Types.ObjectId(id)
    : null;
}

function statusFilter(status: DbtRunGuard["status"]): Filter | undefined {
  if (status === undefined) return undefined;
  if (typeof status === "string") return { status };
  return { status: { $in: [...status] } };
}

/** Runs of one lane; runs that predate lanes ran in the default lane. */
function laneFilter(lane: DbtRunLane | null | undefined): Filter {
  return lane === "fast" ? { lane: "fast" } : { lane: { $ne: "fast" } };
}

/** Translate a `DbtRunQuery` to a Mongo filter; null when an id is invalid. */
function runFilter(query: DbtRunQuery = {}): Filter | null {
  const filter: Filter = {};
  if (query.workspaceId !== undefined) {
    const id = oid(query.workspaceId);
    if (!id) return null;
    filter.workspaceId = id;
  }
  if (query.projectId !== undefined) {
    const id = oid(query.projectId);
    if (!id) return null;
    filter.projectId = id;
  }
  if (query.jobId !== undefined) {
    const id = oid(query.jobId);
    if (!id) return null;
    filter.jobId = id;
  }
  Object.assign(filter, statusFilter(query.status) ?? {});
  if (query.environment !== undefined) filter.environment = query.environment;
  if (query.triggeredBy !== undefined) filter.triggeredBy = query.triggeredBy;
  if (query.lane !== undefined) Object.assign(filter, laneFilter(query.lane));
  if (query.excludeRunId !== undefined) {
    const id = oid(query.excludeRunId);
    if (id) filter._id = { $ne: id };
  }
  if (query.createdBefore !== undefined) {
    filter.createdAt = { $lt: query.createdBefore };
  }
  if (query.durationMsGreaterThan !== undefined) {
    filter.durationMs = { $gt: query.durationMsGreaterThan };
  }
  if (query.manifestKey !== undefined) {
    filter["artifactKeys.manifest"] = query.manifestKey;
  } else if (query.hasManifest) {
    filter["artifactKeys.manifest"] = { $exists: true, $ne: null };
  }
  if (query.hasSemanticManifest) {
    filter["artifactKeys.semanticManifest"] = { $exists: true, $ne: null };
  }
  if (query.hasLocalOverlay) filter.localOverlay = { $exists: true };
  if (query.deploysAfter) {
    filter["deploysAfterRun.workspaceId"] = query.deploysAfter.workspaceId;
    filter["deploysAfterRun.sha"] = query.deploysAfter.sha;
  }
  return filter;
}

function slotHolderFilter(run: DbtRunSlotSubject): Filter | null {
  const projectId = oid(run.projectId);
  const runId = oid(run._id);
  if (!projectId || !runId) return null;
  const lanes = laneFilter(run.lane);
  const jobId = oid(run.jobId ?? null);
  return {
    projectId,
    status: "running",
    _id: { $ne: runId },
    ...(jobId ? { $or: [lanes, { jobId }] } : lanes),
  };
}

/** Split a `{ key: value | null }` patch into Mongo `$set` / `$unset`. */
function splitPatch(
  patch: Record<string, unknown>,
  prefix = "",
): { $set: Filter; $unset: Filter } {
  const $set: Filter = {};
  const $unset: Filter = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) $unset[`${prefix}${key}`] = 1;
    else $set[`${prefix}${key}`] = value;
  }
  return { $set, $unset };
}

function updateDoc(
  parts: Array<{ $set: Filter; $unset: Filter }>,
  extra: Filter = {},
): Filter {
  const $set: Filter = {};
  const $unset: Filter = {};
  for (const part of parts) {
    Object.assign($set, part.$set);
    Object.assign($unset, part.$unset);
  }
  return {
    ...(Object.keys($set).length ? { $set } : {}),
    ...(Object.keys($unset).length ? { $unset } : {}),
    ...extra,
  };
}

function capLogLines(lines: readonly DbtRunLogLine[]): DbtRunLogLine[] {
  return lines.slice(-DBT_RUN_MAX_LOG_LINES).map(line => ({
    ts: line.ts,
    level: line.level || "info",
    // A required String path rejects "" on `create`; dbt emits blank spacers.
    line: line.line.slice(0, DBT_RUN_MAX_LOG_LINE_CHARS) || " ",
  }));
}

export class MongoDbtRepository implements DbtRepository {
  constructor(private readonly session: ClientSession | null = null) {}

  // ── Projects ──────────────────────────────────────────────────────────────

  async findProjectById(
    projectId: string,
    workspaceId?: string,
  ): Promise<DbtProjectRecord | null> {
    const _id = oid(projectId);
    if (!_id) return null;
    const filter: Filter = { _id };
    if (workspaceId !== undefined) {
      const ws = oid(workspaceId);
      if (!ws) return null;
      filter.workspaceId = ws;
    }
    const doc = await DbtProject.findOne(filter).session(this.session).lean();
    return doc ? mongoProjectToRecord(doc) : null;
  }

  async listProjectsByWorkspace(
    workspaceId: string,
    options: ListDbtProjectsOptions = {},
  ): Promise<DbtProjectRecord[]> {
    const ws = oid(workspaceId);
    if (!ws) return [];
    const filter: Filter = { workspaceId: ws };
    if (options.projectId !== undefined) {
      const id = oid(options.projectId);
      if (!id) return [];
      filter._id = id;
    }
    let q = DbtProject.find(filter)
      .session(this.session)
      .sort(options.sort === "nameAsc" ? { name: 1 } : { updatedAt: -1 });
    if (options.limit) q = q.limit(options.limit);
    const docs = await q.lean();
    return docs.map(mongoProjectToRecord);
  }

  async workspaceHasProject(workspaceId: string): Promise<boolean> {
    const ws = oid(workspaceId);
    if (!ws) return false;
    return Boolean(
      await DbtProject.exists({ workspaceId: ws }).session(this.session),
    );
  }

  async createProject(input: CreateDbtProjectInput): Promise<DbtProjectRecord> {
    try {
      const doc = await new DbtProject({
        ...(input._id ? { _id: new Types.ObjectId(input._id) } : {}),
        workspaceId: new Types.ObjectId(input.workspaceId),
        name: input.name,
        dbtVersion: input.dbtVersion ?? "1.12",
        environments: toMongoEnvironments(input.environments ?? []),
        defaultEnvironment: input.defaultEnvironment ?? "dev",
        ...(input.prodEnvironment
          ? { prodEnvironment: input.prodEnvironment }
          : {}),
        createdBy: input.createdBy,
      }).save({ session: this.session });
      return mongoProjectToRecord(doc.toObject());
    } catch (error) {
      if ((error as { code?: unknown }).code === 11000) {
        throw new DbtDuplicateProjectNameError(input.name);
      }
      throw error;
    }
  }

  async updateProject(
    projectId: string,
    update: DbtProjectUpdate,
  ): Promise<DbtProjectRecord | null> {
    const _id = oid(projectId);
    if (!_id) return null;
    const { environments, ...rest } = update;
    const patch = splitPatch({
      ...rest,
      ...(environments
        ? { environments: toMongoEnvironments(environments) }
        : {}),
    });
    const doc = await DbtProject.findOneAndUpdate(
      { _id },
      updateDoc([patch], { $currentDate: { updatedAt: true } }),
      { returnDocument: "after", timestamps: false },
    )
      .session(this.session)
      .lean();
    return doc ? mongoProjectToRecord(doc) : null;
  }

  async promoteProdManifest(params: {
    projectId: string;
    manifestKey: string;
    committedAt: Date;
    sourceSha?: string;
  }): Promise<boolean> {
    const _id = oid(params.projectId);
    if (!_id) return false;
    const set = {
      lastProdManifestKey: params.manifestKey,
      lastProdManifestCommittedAt: params.committedAt,
    };
    const result = await DbtProject.updateOne(
      {
        _id,
        $or: [
          { lastProdManifestCommittedAt: { $exists: false } },
          { lastProdManifestCommittedAt: null },
          { lastProdManifestCommittedAt: { $lte: params.committedAt } },
        ],
      },
      params.sourceSha
        ? { $set: { ...set, lastProdManifestSha: params.sourceSha } }
        : { $set: set, $unset: { lastProdManifestSha: "" } },
    ).session(this.session);
    return result.matchedCount > 0;
  }

  async deleteProject(projectId: string): Promise<boolean> {
    const _id = oid(projectId);
    if (!_id) return false;
    await DbtEnvPreference.deleteMany({ projectId: _id }).session(this.session);
    await DbtJob.deleteMany({ projectId: _id }).session(this.session);
    await DbtRun.deleteMany({ projectId: _id }).session(this.session);
    const res = await DbtProject.deleteOne({ _id }).session(this.session);
    return res.deletedCount > 0;
  }

  async deleteProjectsByWorkspace(workspaceId: string): Promise<number> {
    const ws = oid(workspaceId);
    if (!ws) return 0;
    await DbtEnvPreference.deleteMany({ workspaceId: ws }).session(
      this.session,
    );
    await DbtJob.deleteMany({ workspaceId: ws }).session(this.session);
    await DbtRun.deleteMany({ workspaceId: ws }).session(this.session);
    const res = await DbtProject.deleteMany({ workspaceId: ws }).session(
      this.session,
    );
    return res.deletedCount ?? 0;
  }

  // ── Env preferences ───────────────────────────────────────────────────────

  async findEnvPreference(
    projectId: string,
    userId: string,
  ): Promise<DbtEnvPreferenceRecord | null> {
    const pid = oid(projectId);
    if (!pid) return null;
    const doc = await DbtEnvPreference.findOne({
      projectId: pid,
      userId,
    })
      .session(this.session)
      .lean();
    return doc ? mongoEnvPreferenceToRecord(doc) : null;
  }

  async listEnvPreferencesForUser(
    projectIds: readonly string[],
    userId: string,
  ): Promise<DbtEnvPreferenceRecord[]> {
    const ids = projectIds
      .map(id => oid(id))
      .filter((id): id is Types.ObjectId => !!id);
    if (ids.length === 0) return [];
    const docs = await DbtEnvPreference.find({
      projectId: { $in: ids },
      userId,
    })
      .session(this.session)
      .lean();
    return docs.map(mongoEnvPreferenceToRecord);
  }

  async upsertEnvPreference(
    input: UpsertDbtEnvPreferenceInput,
  ): Promise<DbtEnvPreferenceRecord> {
    const doc = await DbtEnvPreference.findOneAndUpdate(
      { projectId: new Types.ObjectId(input.projectId), userId: input.userId },
      {
        $set: {
          workspaceId: new Types.ObjectId(input.workspaceId),
          environment: input.environment,
        },
      },
      { upsert: true, returnDocument: "after" },
    )
      .session(this.session)
      .lean();
    if (!doc) throw new Error("Failed to upsert dbt environment preference");
    return mongoEnvPreferenceToRecord(doc);
  }

  async deleteEnvPreference(
    projectId: string,
    userId: string,
  ): Promise<boolean> {
    const pid = oid(projectId);
    if (!pid) return false;
    const res = await DbtEnvPreference.deleteOne({
      projectId: pid,
      userId,
    }).session(this.session);
    return res.deletedCount > 0;
  }

  // ── Jobs ──────────────────────────────────────────────────────────────────

  private jobScopeFilter(
    jobId: string,
    scope: DbtJobScope = {},
  ): Filter | null {
    const _id = oid(jobId);
    if (!_id) return null;
    const filter: Filter = { _id };
    if (scope.workspaceId !== undefined) {
      const ws = oid(scope.workspaceId);
      if (!ws) return null;
      filter.workspaceId = ws;
    }
    if (scope.projectId !== undefined) {
      const pid = oid(scope.projectId);
      if (!pid) return null;
      filter.projectId = pid;
    }
    return filter;
  }

  async findJobById(
    jobId: string,
    scope?: DbtJobScope,
  ): Promise<DbtJobRecord | null> {
    const filter = this.jobScopeFilter(jobId, scope);
    if (!filter) return null;
    const doc = await DbtJob.findOne(filter).session(this.session).lean();
    return doc ? mongoJobToRecord(doc) : null;
  }

  async findJobBySlug(
    projectId: string,
    slug: string,
  ): Promise<DbtJobRecord | null> {
    const pid = oid(projectId);
    if (!pid) return null;
    const doc = await DbtJob.findOne({ projectId: pid, slug })
      .session(this.session)
      .lean();
    return doc ? mongoJobToRecord(doc) : null;
  }

  async listJobsByProject(projectId: string): Promise<DbtJobRecord[]> {
    const pid = oid(projectId);
    if (!pid) return [];
    const docs = await DbtJob.find({ projectId: pid })
      .session(this.session)
      .sort({ createdAt: 1, _id: 1 })
      .lean();
    return docs.map(mongoJobToRecord);
  }

  async listJobsByIds(jobIds: readonly string[]): Promise<DbtJobRecord[]> {
    const ids = jobIds
      .map(id => oid(id))
      .filter((id): id is Types.ObjectId => !!id);
    if (ids.length === 0) return [];
    const docs = await DbtJob.find({ _id: { $in: ids } })
      .session(this.session)
      .lean();
    return docs.map(mongoJobToRecord);
  }

  async jobSlugExists(projectId: string, slug: string): Promise<boolean> {
    const pid = oid(projectId);
    if (!pid) return false;
    return Boolean(
      await DbtJob.exists({ projectId: pid, slug }).session(this.session),
    );
  }

  async createJob(input: CreateDbtJobInput): Promise<DbtJobRecord> {
    const doc = await new DbtJob({
      ...(input._id ? { _id: new Types.ObjectId(input._id) } : {}),
      workspaceId: new Types.ObjectId(input.workspaceId),
      projectId: new Types.ObjectId(input.projectId),
      name: input.name,
      ...(input.slug ? { slug: input.slug } : {}),
      ...(input.sourceBlobSha ? { sourceBlobSha: input.sourceBlobSha } : {}),
      ...(input.definitionInvalid
        ? { definitionInvalid: input.definitionInvalid }
        : {}),
      environment: input.environment,
      commands: input.commands ?? [],
      ...(input.schedule ? { schedule: input.schedule } : {}),
      enabled: input.enabled ?? true,
      deferToProduction: input.deferToProduction ?? false,
      createdBy: input.createdBy,
    }).save({ session: this.session });
    return mongoJobToRecord(doc.toObject());
  }

  async updateJob(
    jobId: string,
    update: DbtJobUpdate,
  ): Promise<DbtJobRecord | null> {
    const _id = oid(jobId);
    if (!_id) return null;
    const { scheduledRun, ...rest } = update;
    const doc = await DbtJob.findOneAndUpdate(
      { _id },
      updateDoc(
        [splitPatch(rest), splitPatch(scheduledRun ?? {}, "scheduledRun.")],
        { $currentDate: { updatedAt: true } },
      ),
      { returnDocument: "after", timestamps: false },
    )
      .session(this.session)
      .lean();
    return doc ? mongoJobToRecord(doc) : null;
  }

  async recordJobRunOutcome(
    jobId: string,
    outcome: DbtJobRunOutcome,
  ): Promise<DbtJobRecord | null> {
    const _id = oid(jobId);
    if (!_id) return null;
    const failed = outcome.status === "error";
    const doc = await DbtJob.findOneAndUpdate(
      { _id },
      {
        $set: {
          "scheduledRun.lastAt": outcome.completedAt,
          "scheduledRun.lastStatus": outcome.status,
          ...(outcome.durationMs !== undefined
            ? { "scheduledRun.lastDurationMs": outcome.durationMs }
            : {}),
          ...(failed
            ? { "scheduledRun.lastError": outcome.error }
            : { "scheduledRun.consecutiveFailures": 0 }),
        },
        ...(failed ? {} : { $unset: { "scheduledRun.lastError": 1 } }),
        $inc: {
          "scheduledRun.runCount": 1,
          ...(failed ? { "scheduledRun.consecutiveFailures": 1 } : {}),
        },
      },
      { returnDocument: "after" },
    )
      .session(this.session)
      .lean();
    return doc ? mongoJobToRecord(doc) : null;
  }

  async resetJobFailuresIfReenabled(
    jobId: string,
    threshold: number,
  ): Promise<boolean> {
    const _id = oid(jobId);
    if (!_id || !(threshold > 0)) return false;
    const res = await DbtJob.updateOne(
      {
        _id,
        enabled: true,
        "scheduledRun.consecutiveFailures": { $gte: threshold },
      },
      { $set: { "scheduledRun.consecutiveFailures": 0 } },
    ).session(this.session);
    return res.modifiedCount > 0;
  }

  async deleteJob(jobId: string, scope?: DbtJobScope): Promise<boolean> {
    const filter = this.jobScopeFilter(jobId, scope);
    if (!filter) return false;
    const res = await DbtJob.deleteOne(filter).session(this.session);
    return res.deletedCount > 0;
  }

  async findDueScheduledJobs(now: Date): Promise<DbtDueScheduledJob[]> {
    const docs = (await DbtJob.find({
      "schedule.cron": { $exists: true, $ne: "" },
      "scheduledRun.nextAt": { $lte: now },
      enabled: true,
    })
      .session(this.session)
      .select("_id workspaceId schedule scheduledRun")
      .lean()) as unknown as Array<{
      _id: Types.ObjectId;
      workspaceId: Types.ObjectId;
      schedule?: { cron?: string | null; timezone?: string | null } | null;
      scheduledRun?: { nextAt?: Date | null } | null;
    }>;
    return docs.map(doc => ({
      id: doc._id.toString(),
      workspaceId: doc.workspaceId.toString(),
      nextAt: doc.scheduledRun?.nextAt ?? null,
      schedule: doc.schedule ?? null,
    }));
  }

  async claimScheduledJob(
    job: DbtDueScheduledJob,
    nextAt: Date,
  ): Promise<{ modifiedCount: number }> {
    const _id = oid(job.id);
    if (!_id) return { modifiedCount: 0 };
    const result = await DbtJob.updateOne(
      { _id, enabled: true, "scheduledRun.nextAt": job.nextAt },
      { $set: { "scheduledRun.nextAt": nextAt } },
    ).session(this.session);
    return { modifiedCount: result.modifiedCount };
  }

  // ── Runs ──────────────────────────────────────────────────────────────────

  private idFilter(runId: string, query?: DbtRunQuery): Filter | null {
    const _id = oid(runId);
    if (!_id) return null;
    const filter = runFilter(query);
    if (!filter) return null;
    return { ...filter, _id };
  }

  async findRunById(
    runId: string,
    query?: DbtRunQuery,
  ): Promise<DbtRunRecord | null> {
    const filter = this.idFilter(runId, query);
    if (!filter) return null;
    const doc = await DbtRun.findOne(filter)
      .session(this.session)
      .select("-logs")
      .lean();
    return doc ? mongoRunToRecord(doc) : null;
  }

  async findRunWithLogs(
    runId: string,
    query?: DbtRunQuery,
    since = 0,
  ): Promise<DbtRunWithLogs | null> {
    const filter = this.idFilter(runId, query);
    if (!filter) return null;
    const doc = await DbtRun.findOne(filter).session(this.session).lean();
    if (!doc) return null;
    const run = mongoRunToRecordWithLogs(doc);
    run.logs = run.logs.slice(
      Math.max(0, since - (run.logTotal - run.logs.length)),
    );
    return run;
  }

  async findLatestArtifactRun(query: DbtRunQuery, includeSteps = false) {
    const filter = runFilter(query);
    if (!filter) return null;
    return DbtRun.findOne(filter)
      .session(this.session)
      .select({
        environment: 1,
        artifactKeys: 1,
        createdAt: 1,
        ...(includeSteps ? { stepResults: 1 } : {}),
      })
      .sort({ createdAt: -1 })
      .lean();
  }

  async findLatestRun(query: DbtRunQuery): Promise<DbtRunRecord | null> {
    const filter = runFilter(query);
    if (!filter) return null;
    const doc = await DbtRun.findOne(filter)
      .session(this.session)
      .select("-logs")
      .sort({ createdAt: -1 })
      .lean();
    return doc ? mongoRunToRecord(doc) : null;
  }

  async listRuns(
    query: DbtRunQuery,
    options: ListDbtRunsOptions = {},
  ): Promise<DbtRunRecord[]> {
    const filter = runFilter(query);
    if (!filter) return [];
    let q = DbtRun.find(filter)
      .session(this.session)
      .select("-logs")
      .sort({ createdAt: options.sort === "createdAtAsc" ? 1 : -1 });
    if (options.limit) q = q.limit(options.limit);
    const docs = await q.lean();
    return docs.map(mongoRunToRecord);
  }

  async runExists(query: DbtRunQuery): Promise<boolean> {
    const filter = runFilter(query);
    if (!filter) return false;
    return Boolean(await DbtRun.exists(filter).session(this.session));
  }

  async createRun(input: CreateDbtRunInput): Promise<DbtRunRecord> {
    const { logs, _id, workspaceId, projectId, jobId, retryOfRunId, ...rest } =
      input;
    const capped = logs?.length ? capLogLines(logs) : undefined;
    const doc = await new DbtRun({
      ...(_id ? { _id: new Types.ObjectId(_id) } : {}),
      ...rest,
      workspaceId: new Types.ObjectId(workspaceId),
      projectId: new Types.ObjectId(projectId),
      ...(jobId ? { jobId: new Types.ObjectId(jobId) } : {}),
      ...(retryOfRunId
        ? { retryOfRunId: new Types.ObjectId(retryOfRunId) }
        : {}),
      status: input.status ?? "queued",
      ...(capped ? { logs: capped, logTotal: logs?.length ?? 0 } : {}),
    }).save({ session: this.session });
    return mongoRunToRecord(doc.toObject());
  }

  async updateRun(
    runId: string,
    update: DbtRunUpdate,
    guard: DbtRunGuard = {},
  ): Promise<DbtRunRecord | null> {
    const _id = oid(runId);
    if (!_id) return null;
    const { artifactKeys, pushStepResults, addWarnings, ...rest } = update;
    const doc = await DbtRun.findOneAndUpdate(
      { _id, ...(statusFilter(guard.status) ?? {}) },
      updateDoc(
        [splitPatch(rest), splitPatch({ ...artifactKeys }, "artifactKeys.")],
        {
          ...(pushStepResults?.length
            ? { $push: { stepResults: { $each: pushStepResults } } }
            : {}),
          ...(addWarnings?.length
            ? { $addToSet: { warnings: { $each: addWarnings } } }
            : {}),
        },
      ),
      { returnDocument: "after" },
    )
      .session(this.session)
      .select("-logs")
      .lean();
    return doc ? mongoRunToRecord(doc) : null;
  }

  async finishRun(
    runId: string,
    outcome: DbtJobRunOutcome,
    expectedStatus: DbtRunStatus,
  ) {
    const run = await this.updateRun(runId, outcome, {
      status: expectedStatus,
    });
    if (!run) return null;
    const job = run.jobId
      ? await this.recordJobRunOutcome(run.jobId, outcome)
      : null;
    return { run, job };
  }

  async finalizeCancelledRun(
    runId: string,
    fallbackCancelledBy?: string,
  ): Promise<void> {
    const _id = oid(runId);
    if (!_id) return;
    await DbtRun.updateOne(
      { _id, status: { $in: [...ACTIVE_DBT_RUN_STATUSES] } },
      [
        {
          $set: {
            status: "cancelled",
            completedAt: "$$NOW",
            cancelledAt: { $ifNull: ["$cancelledAt", "$$NOW"] },
            cancelledBy: {
              $ifNull: ["$cancelledBy", fallbackCancelledBy ?? "user"],
            },
            error: { $ifNull: ["$error", "Cancelled"] },
            durationMs: {
              $cond: [
                { $ifNull: ["$startedAt", false] },
                {
                  $dateDiff: {
                    startDate: "$startedAt",
                    endDate: "$$NOW",
                    unit: "millisecond",
                  },
                },
                "$durationMs",
              ],
            },
          },
        },
      ],
      { updatePipeline: true },
    ).session(this.session);
  }

  async findRunSlotHolder(
    run: DbtRunSlotSubject,
  ): Promise<DbtRunRecord | null> {
    const filter = slotHolderFilter(run);
    if (!filter) return null;
    const doc = await DbtRun.findOne(filter)
      .session(this.session)
      .sort({ startedAt: 1 })
      .select("-logs")
      .lean();
    return doc ? mongoRunToRecord(doc) : null;
  }

  async claimRunSlot(
    runId: string,
    now: Date = new Date(),
  ): Promise<DbtRunSlotClaim> {
    const _id = oid(runId);
    if (!_id) return { state: "gone" };
    const queued = await DbtRun.findOne({ _id, status: "queued" })
      .session(this.session)
      .select("_id projectId jobId lane")
      .lean();
    if (!queued) return { state: "gone" };
    const subject: DbtRunSlotSubject = {
      _id: queued._id.toString(),
      projectId: queued.projectId.toString(),
      jobId: queued.jobId?.toString() ?? null,
      lane: queued.lane ?? null,
    };
    const before = await this.findRunSlotHolder(subject);
    if (before) return { state: "busy", holderId: before._id };

    const claimed = await DbtRun.findOneAndUpdate(
      { _id, status: "queued" },
      { $set: { status: "running", startedAt: now } },
      { returnDocument: "after" },
    )
      .session(this.session)
      .select("-logs")
      .lean();
    if (!claimed) return { state: "gone" };

    const after = await this.findRunSlotHolder(subject);
    if (after) {
      await DbtRun.updateOne(
        { _id, status: "running" },
        { $set: { status: "queued" }, $unset: { startedAt: 1 } },
      ).session(this.session);
      return { state: "busy", holderId: after._id };
    }
    return { state: "claimed", run: mongoRunToRecord(claimed) };
  }

  async appendRunLogs(
    runId: string,
    lines: readonly DbtRunLogLine[],
  ): Promise<void> {
    const _id = oid(runId);
    if (!_id || lines.length === 0) return;
    await DbtRun.updateOne(
      { _id },
      {
        $push: {
          logs: {
            $each: lines.map(line => ({
              ts: line.ts,
              level: line.level,
              line: line.line.slice(0, DBT_RUN_MAX_LOG_LINE_CHARS),
            })),
            $slice: -DBT_RUN_MAX_LOG_LINES,
          },
        },
        $inc: { logTotal: lines.length },
      },
    ).session(this.session);
  }

  async listActiveRunsWithLogTail(
    tail: number,
  ): Promise<DbtActiveRunWithLogTail[]> {
    const docs = await DbtRun.find({
      status: { $in: [...ACTIVE_DBT_RUN_STATUSES] },
    })
      .session(this.session)
      .slice("logs", -Math.max(1, tail))
      .lean();
    return docs.map(doc => {
      const withLogs = mongoRunToRecordWithLogs(doc);
      const { logs, ...run } = withLogs;
      return { run, logs };
    });
  }

  async pruneTerminalRuns(cutoff: Date): Promise<number> {
    const result = await DbtRun.deleteMany({
      status: { $in: [...TERMINAL_DBT_RUN_STATUSES] },
      $or: [
        { completedAt: { $lt: cutoff } },
        { completedAt: { $exists: false }, createdAt: { $lt: cutoff } },
        { completedAt: null, createdAt: { $lt: cutoff } },
      ],
    }).session(this.session);
    return result.deletedCount ?? 0;
  }

  // ── Held app deploys ──────────────────────────────────────────────────────

  async joinDeploysAfterRun(
    runId: string,
    appIds: readonly string[],
  ): Promise<boolean> {
    const _id = oid(runId);
    if (!_id) return false;
    const res = await DbtRun.updateOne(
      {
        _id,
        status: { $in: [...ACTIVE_DBT_RUN_STATUSES] },
        deploysAfterRun: { $exists: true },
        "deploysAfterRun.releasedAt": { $exists: false },
      },
      { $addToSet: { "deploysAfterRun.appIds": { $each: [...appIds] } } },
    ).session(this.session);
    return res.matchedCount === 1;
  }

  async claimDeploysAfterRelease(
    runId: string,
    opts: { anyStatus?: boolean } = {},
  ): Promise<DbtRunRecord | null> {
    const _id = oid(runId);
    if (!_id) return null;
    const terminal = [...TERMINAL_DBT_RUN_STATUSES];
    const doc = await DbtRun.findOneAndUpdate(
      {
        _id,
        ...(opts.anyStatus ? {} : { status: { $in: terminal } }),
        deploysAfterRun: { $exists: true },
        "deploysAfterRun.releasedAt": { $exists: false },
      },
      [
        {
          $set: {
            "deploysAfterRun.releasedAt": "$$NOW",
            ...(opts.anyStatus
              ? {
                  "deploysAfterRun.releasedEarly": {
                    $not: [{ $in: ["$status", terminal] }],
                  },
                }
              : {}),
          },
        },
      ],
      { returnDocument: "after", updatePipeline: true },
    )
      .session(this.session)
      .select("-logs")
      .lean();
    return doc ? mongoRunToRecord(doc) : null;
  }

  async claimDeploysAfterRerelease(
    runId: string,
  ): Promise<DbtRunRecord | null> {
    const _id = oid(runId);
    if (!_id) return null;
    const doc = await DbtRun.findOneAndUpdate(
      {
        _id,
        status: "success",
        "deploysAfterRun.releasedEarly": true,
        "deploysAfterRun.rereleasedAt": { $exists: false },
      },
      { $set: { "deploysAfterRun.rereleasedAt": new Date() } },
      { returnDocument: "after" },
    )
      .session(this.session)
      .select("-logs")
      .lean();
    return doc ? mongoRunToRecord(doc) : null;
  }

  async unclaimDeploysAfterRun(
    runId: string,
    claim: DbtDeploysAfterClaim,
  ): Promise<void> {
    const _id = oid(runId);
    if (!_id) return;
    await DbtRun.updateOne(
      { _id },
      {
        $unset: {
          [`deploysAfterRun.${claim}`]: 1,
          ...(claim === "releasedAt"
            ? { "deploysAfterRun.releasedEarly": 1 }
            : {}),
        },
      },
    ).session(this.session);
  }
}
