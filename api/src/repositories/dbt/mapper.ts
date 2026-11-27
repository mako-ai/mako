/**
 * Row <-> record mapping for the `dbt` domain.
 *
 * Records mirror the former Mongoose lean docs (`_id` + wire string ids,
 * unset fields absent). Postgres stores bijective UUIDs (`objectIdToUuid`)
 * and JSONB dates as ISO strings; both are mapped back here.
 */
import { DBT_RUN_ACTOR_KINDS } from "../../dbt/run-actor";
import { Types } from "mongoose";
import { newDualId, parseEntityId, toWireId } from "../../database/pg/id-codec";
import type {
  DbtEnvironmentJson,
  NewDbtProjectRow,
  NewDbtJobRow,
  NewDbtRunRow,
  DbtEnvPreferenceRow,
  DbtJobRow,
  DbtProjectRow,
  DbtRunLogLineJson,
  DbtRunRow,
} from "../../database/pg/schema/dbt";
import type {
  DbtEnvPreferenceRecord,
  CreateDbtProjectInput,
  CreateDbtJobInput,
  CreateDbtRunInput,
  DbtEnvironmentRecord,
  DbtJobRecord,
  DbtJobScheduledRun,
  DbtProjectRecord,
  DbtRunLogLine,
  DbtRunRecord,
  DbtRunStepResult,
  DbtRunWithLogs,
} from "./types";

// Lean Mongo documents and the native-driver backfill may predate optional
// schema fields. Normalize each stored value at the repository boundary.
type StoredFields<T> = Partial<Record<keyof T, unknown>>;
type StoredRun = StoredFields<DbtRunWithLogs>;
type DocumentFields = Record<string, unknown>;
function isDocument(value: unknown): value is DocumentFields {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function idString(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  return String(value);
}

function optString(value: unknown): string | undefined {
  if (value == null || value === "") return undefined;
  return idString(value);
}

function optDate(value: unknown): Date | undefined {
  if (value == null || value === "") return undefined;
  const date = value instanceof Date ? value : new Date(value as string);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function reqDate(value: unknown): Date {
  return optDate(value) ?? new Date(0);
}

function optNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/** Drop `undefined` keys so records look like lean docs (absent, not undefined). */
function compact<T extends object>(value: T): T {
  for (const key of Object.keys(value) as Array<keyof T>) {
    if (value[key] === undefined) delete value[key];
  }
  return value;
}

function isoOrUndefined(
  value: Date | string | null | undefined,
): string | undefined {
  if (value == null) return undefined;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

// ── Environments ────────────────────────────────────────────────────────────

export function environmentToRecord(env: {
  name: unknown;
  connectionId: unknown;
  readConnectionId?: unknown;
  targetSchema: unknown;
  threads?: unknown;
  vars?: unknown;
  ownerUserId?: unknown;
}): DbtEnvironmentRecord {
  return compact({
    name: idString(env.name),
    connectionId: idString(env.connectionId),
    readConnectionId: optString(env.readConnectionId),
    targetSchema: idString(env.targetSchema),
    threads: optNumber(env.threads) ?? 4,
    vars: isDocument(env.vars) ? env.vars : undefined,
    ownerUserId: optString(env.ownerUserId),
  });
}

export function environmentToJson(
  env: DbtEnvironmentRecord,
): DbtEnvironmentJson {
  return compact({
    name: env.name.trim(),
    connectionId: String(env.connectionId),
    readConnectionId: env.readConnectionId
      ? String(env.readConnectionId)
      : undefined,
    targetSchema: env.targetSchema.trim(),
    threads: env.threads ?? 4,
    vars: env.vars,
    ownerUserId: env.ownerUserId,
  });
}

/** Records -> Mongoose subdocs (ObjectId connection ids). */
export function toMongoEnvironments(
  envs: readonly DbtEnvironmentRecord[],
): DocumentFields[] {
  return envs.map(env =>
    compact({
      name: env.name.trim(),
      connectionId: new Types.ObjectId(env.connectionId),
      readConnectionId: env.readConnectionId
        ? new Types.ObjectId(env.readConnectionId)
        : undefined,
      targetSchema: env.targetSchema.trim(),
      threads: env.threads ?? 4,
      vars: env.vars,
      ownerUserId: env.ownerUserId,
    }),
  );
}

// ── Shared nested shapes ────────────────────────────────────────────────────

function invalidMarker(
  value: unknown,
): { reason: string; at: Date; path?: string } | undefined {
  if (!isDocument(value) || !value.reason) return undefined;
  return compact({
    reason: String(value.reason),
    at: reqDate(value.at),
    path: optString(value.path),
  });
}

function scheduledRunFrom(
  value: unknown,
  nextAt?: unknown,
): DbtJobScheduledRun {
  const v = isDocument(value) ? value : {};
  return compact({
    nextAt: optDate(nextAt !== undefined ? nextAt : v.nextAt),
    lastAt: optDate(v.lastAt),
    lastStatus:
      v.lastStatus === "success" || v.lastStatus === "error"
        ? v.lastStatus
        : undefined,
    lastError: optString(v.lastError),
    lastDurationMs: optNumber(v.lastDurationMs),
    runCount: optNumber(v.runCount) ?? 0,
    consecutiveFailures: optNumber(v.consecutiveFailures) ?? 0,
  });
}

function scheduleFrom(value: unknown) {
  if (!isDocument(value) || !value.cron) return undefined;
  return {
    cron: String(value.cron),
    timezone: String(value.timezone ?? "UTC"),
  };
}

function stepResultsFrom(value: unknown): DbtRunStepResult[] {
  if (!Array.isArray(value)) return [];
  return value.map((s: DocumentFields) =>
    compact({
      uniqueId: String(s.uniqueId),
      name: String(s.name),
      resourceType: String(s.resourceType ?? "model"),
      status: String(s.status),
      executionTimeMs: optNumber(s.executionTimeMs) ?? 0,
      rowsAffected: optNumber(s.rowsAffected),
      message: optString(s.message),
    }),
  );
}

function artifactKeysFrom(value: unknown) {
  const v = isDocument(value) ? value : {};
  return compact({
    manifest: optString(v.manifest),
    semanticManifest: optString(v.semanticManifest),
    runResults: optString(v.runResults),
    catalog: optString(v.catalog),
    sources: optString(v.sources),
  });
}

function restoreKeysFrom(value: unknown) {
  if (!isDocument(value)) return undefined;
  const keys = compact({
    runResults: optString(value.runResults),
    manifest: optString(value.manifest),
  });
  return Object.keys(keys).length ? keys : undefined;
}

function outputFrom(value: unknown) {
  if (!isDocument(value) || value.kind !== "show-preview") return undefined;
  return { kind: "show-preview" as const, text: String(value.text ?? "") };
}

function deploysAfterFrom(value: unknown) {
  if (!isDocument(value) || !value.sha) return undefined;
  return compact({
    workspaceId: idString(value.workspaceId),
    appIds: Array.isArray(value.appIds) ? value.appIds.map(String) : [],
    sha: String(value.sha),
    releasedAt: optDate(value.releasedAt),
    releasedEarly:
      typeof value.releasedEarly === "boolean"
        ? value.releasedEarly
        : undefined,
    rereleasedAt: optDate(value.rereleasedAt),
  });
}

function localOverlayFrom(value: unknown) {
  if (!isDocument(value) || !value.key) return undefined;
  return compact({
    key: String(value.key),
    baseSha: optString(value.baseSha),
    files: optNumber(value.files) ?? 0,
    deletes: optNumber(value.deletes) ?? 0,
  });
}

function ciFrom(value: unknown) {
  if (!isDocument(value) || value.prNumber == null) return undefined;
  return compact({
    prNumber: Number(value.prNumber),
    headSha: String(value.headSha),
    headRef: String(value.headRef),
    baseRef: String(value.baseRef),
    owner: String(value.owner),
    repo: String(value.repo),
    installationId: optNumber(value.installationId),
  });
}

function actorFrom(value: unknown) {
  if (!isDocument(value) || !value.kind) return undefined;
  const kind = DBT_RUN_ACTOR_KINDS.find(kind => kind === value.kind);
  if (!kind) return undefined;
  const actor = { ...value };
  if (isDocument(actor.push)) {
    actor.push = compact({
      ...actor.push,
      mergedAt: optDate(actor.push.mergedAt),
    });
  }
  return { ...actor, kind };
}

export function logLineFrom(value: {
  ts: unknown;
  line: unknown;
  level: unknown;
}): DbtRunLogLine {
  return {
    ts: reqDate(value.ts),
    level: String(value.level ?? "info"),
    line: String(value.line ?? ""),
  };
}

export function logLineToJson(line: DbtRunLogLine): DbtRunLogLineJson {
  return {
    ts: isoOrUndefined(line.ts) ?? new Date().toISOString(),
    level: line.level ?? "info",
    line: line.line,
  };
}

// ── Mongo docs -> records ───────────────────────────────────────────────────

export function mongoProjectToRecord(
  doc: StoredFields<DbtProjectRecord>,
): DbtProjectRecord {
  return compact({
    _id: idString(doc._id),
    workspaceId: idString(doc.workspaceId),
    name: String(doc.name),
    dbtVersion: String(doc.dbtVersion ?? "1.12"),
    environments: Array.isArray(doc.environments)
      ? doc.environments.map(environmentToRecord)
      : [],
    defaultEnvironment: String(doc.defaultEnvironment ?? "dev"),
    prodEnvironment: optString(doc.prodEnvironment),
    lastProdManifestKey: optString(doc.lastProdManifestKey),
    lastProdManifestCommittedAt: optDate(doc.lastProdManifestCommittedAt),
    lastProdManifestSha: optString(doc.lastProdManifestSha),
    environmentsInvalid: invalidMarker(doc.environmentsInvalid) as
      DbtProjectRecord["environmentsInvalid"] | undefined,
    createdBy: idString(doc.createdBy),
    createdAt: reqDate(doc.createdAt),
    updatedAt: reqDate(doc.updatedAt),
  });
}

export function mongoEnvPreferenceToRecord(
  doc: StoredFields<DbtEnvPreferenceRecord>,
): DbtEnvPreferenceRecord {
  return {
    _id: idString(doc._id),
    workspaceId: idString(doc.workspaceId),
    projectId: idString(doc.projectId),
    userId: idString(doc.userId),
    environment: String(doc.environment),
    createdAt: reqDate(doc.createdAt),
    updatedAt: reqDate(doc.updatedAt),
  };
}

export function mongoJobToRecord(
  doc: StoredFields<DbtJobRecord>,
): DbtJobRecord {
  return compact({
    _id: idString(doc._id),
    workspaceId: idString(doc.workspaceId),
    projectId: idString(doc.projectId),
    name: String(doc.name),
    slug: optString(doc.slug),
    sourceBlobSha: optString(doc.sourceBlobSha),
    definitionInvalid: invalidMarker(doc.definitionInvalid),
    environment: String(doc.environment),
    commands: Array.isArray(doc.commands) ? doc.commands.map(String) : [],
    schedule: scheduleFrom(doc.schedule),
    scheduledRun: scheduledRunFrom(doc.scheduledRun),
    enabled: doc.enabled !== false,
    deferToProduction: doc.deferToProduction === true,
    lane: doc.lane === "fast" || doc.lane === "default" ? doc.lane : undefined,
    laneEvaluatedAt: optDate(doc.laneEvaluatedAt),
    laneMedianMs: optNumber(doc.laneMedianMs),
    createdBy: idString(doc.createdBy),
    createdAt: reqDate(doc.createdAt),
    updatedAt: reqDate(doc.updatedAt),
  });
}

function runCommon(
  doc: StoredRun,
): Omit<
  DbtRunRecord,
  "_id" | "workspaceId" | "projectId" | "jobId" | "retryOfRunId" | "logTotal"
> {
  const { status, trigger } = doc;
  if (
    status !== "queued" &&
    status !== "running" &&
    status !== "success" &&
    status !== "error" &&
    status !== "cancelled"
  ) {
    throw new Error("Invalid persisted dbt run status");
  }
  if (
    trigger !== "agent" &&
    trigger !== "ci" &&
    trigger !== "manual" &&
    trigger !== "schedule"
  ) {
    throw new Error("Invalid persisted dbt run trigger");
  }
  return compact({
    environment: String(doc.environment),
    commands: Array.isArray(doc.commands) ? doc.commands.map(String) : [],
    status,
    trigger,
    triggeredBy: idString(doc.triggeredBy),
    actor: actorFrom(doc.actor),
    lane: doc.lane === "fast" || doc.lane === "default" ? doc.lane : undefined,
    gitBranch: optString(doc.gitBranch),
    workingTreeUserId: optString(doc.workingTreeUserId),
    sourceBranch: optString(doc.sourceBranch),
    sourceSha: optString(doc.sourceSha),
    deferToProduction:
      typeof doc.deferToProduction === "boolean"
        ? doc.deferToProduction
        : undefined,
    localOverlay: localOverlayFrom(doc.localOverlay),
    ci: ciFrom(doc.ci),
    deploysAfterRun: deploysAfterFrom(doc.deploysAfterRun),
    startedAt: optDate(doc.startedAt),
    completedAt: optDate(doc.completedAt),
    durationMs: optNumber(doc.durationMs),
    cancelledAt: optDate(doc.cancelledAt),
    cancelledBy: optString(doc.cancelledBy),
    stepResults: stepResultsFrom(doc.stepResults),
    output: outputFrom(doc.output),
    artifactKeys: artifactKeysFrom(doc.artifactKeys),
    restoreArtifactKeys: restoreKeysFrom(doc.restoreArtifactKeys),
    error: optString(doc.error),
    warnings: Array.isArray(doc.warnings)
      ? doc.warnings.map(String)
      : undefined,
    inngestRunId: optString(doc.inngestRunId),
    createdAt: reqDate(doc.createdAt),
    updatedAt: reqDate(doc.updatedAt),
  });
}

export function mongoRunToRecord(doc: StoredRun): DbtRunRecord {
  const logs = Array.isArray(doc.logs) ? doc.logs : undefined;
  return compact({
    _id: idString(doc._id),
    workspaceId: idString(doc.workspaceId),
    projectId: idString(doc.projectId),
    jobId: optString(doc.jobId),
    retryOfRunId: optString(doc.retryOfRunId),
    logTotal: Math.max(optNumber(doc.logTotal) ?? 0, logs?.length ?? 0),
    ...runCommon(doc),
  }) as DbtRunRecord;
}

export function mongoRunToRecordWithLogs(doc: StoredRun): DbtRunWithLogs {
  const logs = Array.isArray(doc.logs) ? doc.logs.map(logLineFrom) : [];
  return { ...mongoRunToRecord(doc), logs };
}

// ── Postgres rows -> records ────────────────────────────────────────────────

function wire(uuid: string): string {
  return toWireId(uuid);
}

function optWire(uuid: string | null | undefined): string | undefined {
  return uuid ? toWireId(uuid) : undefined;
}

export function pgProjectToRecord(row: DbtProjectRow): DbtProjectRecord {
  return compact({
    _id: wire(row.id),
    workspaceId: wire(row.workspaceId),
    name: row.name,
    dbtVersion: row.dbtVersion,
    environments: (row.environments ?? []).map(environmentToRecord),
    defaultEnvironment: row.defaultEnvironment,
    prodEnvironment: optString(row.prodEnvironment),
    lastProdManifestKey: optString(row.lastProdManifestKey),
    lastProdManifestCommittedAt: optDate(row.lastProdManifestCommittedAt),
    lastProdManifestSha: optString(row.lastProdManifestSha),
    environmentsInvalid: invalidMarker(row.environmentsInvalid) as
      DbtProjectRecord["environmentsInvalid"] | undefined,
    createdBy: row.createdBy,
    createdAt: reqDate(row.createdAt),
    updatedAt: reqDate(row.updatedAt),
  });
}

export function pgEnvPreferenceToRecord(
  row: DbtEnvPreferenceRow,
): DbtEnvPreferenceRecord {
  return {
    _id: wire(row.id),
    workspaceId: wire(row.workspaceId),
    projectId: wire(row.projectId),
    userId: row.userId.toLowerCase(),
    environment: row.environment,
    createdAt: reqDate(row.createdAt),
    updatedAt: reqDate(row.updatedAt),
  };
}

export function pgJobToRecord(row: DbtJobRow): DbtJobRecord {
  return compact({
    _id: wire(row.id),
    workspaceId: wire(row.workspaceId),
    projectId: wire(row.projectId),
    name: row.name,
    slug: optString(row.slug),
    sourceBlobSha: optString(row.sourceBlobSha),
    definitionInvalid: invalidMarker(row.definitionInvalid),
    environment: row.environment,
    commands: row.commands ?? [],
    schedule: scheduleFrom(row.schedule),
    scheduledRun: scheduledRunFrom(row.scheduledRun, row.scheduledRunNextAt),
    enabled: row.enabled,
    deferToProduction: row.deferToProduction,
    lane: row.lane ?? undefined,
    laneEvaluatedAt: optDate(row.laneEvaluatedAt),
    laneMedianMs: optNumber(row.laneMedianMs),
    createdBy: row.createdBy,
    createdAt: reqDate(row.createdAt),
    updatedAt: reqDate(row.updatedAt),
  });
}

export function pgRunToRecord(row: DbtRunRow): DbtRunRecord {
  return compact({
    _id: wire(row.id),
    workspaceId: wire(row.workspaceId),
    projectId: wire(row.projectId),
    jobId: optWire(row.jobId),
    retryOfRunId: optWire(row.retryOfRunId),
    logTotal: row.logTotal ?? 0,
    ...runCommon(row),
  }) as DbtRunRecord;
}

// ── Records -> Postgres JSON ────────────────────────────────────────────────

export function invalidMarkerToJson(
  value: { reason: string; at: Date; path?: string } | null | undefined,
): { reason: string; at: string; path?: string } | null {
  if (!value) return null;
  return compact({
    reason: value.reason,
    at: isoOrUndefined(value.at) ?? new Date().toISOString(),
    path: value.path,
  });
}

export function deploysAfterToJson(
  value: DbtRunRecord["deploysAfterRun"] | null | undefined,
) {
  if (!value) return null;
  return compact({
    workspaceId: String(value.workspaceId),
    appIds: [...(value.appIds ?? [])],
    sha: value.sha,
    releasedAt: isoOrUndefined(value.releasedAt),
    releasedEarly: value.releasedEarly,
    rereleasedAt: isoOrUndefined(value.rereleasedAt),
  });
}

export function actorToJson(actor: DbtRunRecord["actor"] | null | undefined) {
  if (!actor) return null;
  // JSON.stringify turns `push.mergedAt` into an ISO string; actorFrom maps it back.
  return JSON.parse(JSON.stringify(actor)) as NonNullable<
    DbtRunRecord["actor"]
  >;
}

export function dbtUuid(id: string): string {
  const parsed = parseEntityId(id);
  if (!parsed) throw new Error("Invalid dbt entity id");
  return parsed.uuid;
}

export function projectValues(
  input: CreateDbtProjectInput,
  createdByUserId: string | null,
): NewDbtProjectRow {
  return {
    ...input,
    name: input.name.trim(),
    id: input._id ? dbtUuid(input._id) : newDualId().uuid,
    workspaceId: dbtUuid(input.workspaceId),
    createdByUserId,
    environments: input.environments?.map(environmentToJson),
  };
}

export function jobValues(
  input: CreateDbtJobInput,
  createdByUserId: string | null,
): NewDbtJobRow {
  return {
    ...input,
    name: input.name.trim(),
    id: input._id ? dbtUuid(input._id) : newDualId().uuid,
    workspaceId: dbtUuid(input.workspaceId),
    projectId: dbtUuid(input.projectId),
    createdByUserId,
    definitionInvalid: invalidMarkerToJson(input.definitionInvalid),
  };
}

export function runValues(input: CreateDbtRunInput): NewDbtRunRow {
  return {
    ...input,
    id: input._id ? dbtUuid(input._id) : newDualId().uuid,
    workspaceId: dbtUuid(input.workspaceId),
    projectId: dbtUuid(input.projectId),
    jobId: input.jobId && dbtUuid(input.jobId),
    retryOfRunId: input.retryOfRunId && dbtUuid(input.retryOfRunId),
    actor: actorToJson(input.actor),
    deploysAfterRun: deploysAfterToJson(input.deploysAfterRun),
    deploysAfterWorkspaceId:
      input.deploysAfterRun && dbtUuid(input.deploysAfterRun.workspaceId),
    deploysAfterSha: input.deploysAfterRun?.sha,
  };
}
