/**
 * Lossless mappers, compatibility adapters, and canonicalizers for `apps_metadata`.
 *
 * Security invariants:
 *   - `app_projects.env[].valueEncrypted`, `app_projects.publicShare.passwordEncrypted`,
 *     and `app_projects.publicShare.passwordHash` are copied verbatim as opaque strings —
 *     NEVER decrypted by mappers and ALWAYS redacted in `shadow-compare`.
 *   - `app_projects.sharedWith[].{userId, addedBy}` are rewritten via `resolveUserUuid()`
 *     on Postgres writes/backfills per Decision #3.
 */
import { Types } from "mongoose";
import {
  isObjectIdHex,
  isObjectIdUuid,
  optionalToWireId,
  parseEntityId,
  toWireId,
  uuidToObjectId,
} from "../../database/pg/id-codec";
import type {
  AppBindingDraftRow,
  AppBindingJobProgressJson,
  AppBindingJobRow,
  AppBindingRefreshErrorJson,
  AppBindingRunJson,
  AppBindingStateRowPg,
  AppDeployCommitStatusRow,
  AppDeployProgressJson,
  AppEmbeddingRow,
  AppIndexHeadRow,
  AppIndexRowPg,
  AppLastDeployErrorJson,
  AppLifecycleRow,
  AppProjectRow,
  AppShareEntryJson,
  AppWorktreeRow,
} from "../../database/pg/schema/apps-metadata";
import type {
  IAppDeployProgress,
  IAppProject,
  IAppWorktree,
  IPublicShare,
  IResourceShareEntry,
} from "../../database/workspace-schema";
import type { ParquetCodec } from "../../utils/parquet-compression";
import type {
  AppBindingDraftRecord,
  AppBindingJobProgressRecord,
  AppBindingJobRecord,
  AppBindingRefreshErrorRecord,
  AppBindingRunRecord,
  AppBindingStateRecord,
  AppDeployCommitStatusRecord,
  AppEmbeddingRecord,
  AppIndexEntryRecord,
  AppIndexHeadRecord,
  AppLastDeployErrorRecord,
  AppLifecycleRecord,
  AppProjectRecord,
  AppWorktreeRecord,
  UpdateAppProjectSharingPatch,
} from "./types";

export function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

export function toOptionalDate(
  value: Date | string | null | undefined,
): Date | undefined {
  if (value == null) return undefined;
  return value instanceof Date ? value : new Date(value);
}

export function toWireStringId(
  value: { toString(): string } | string | null | undefined,
): string {
  if (value == null) return "";
  return typeof value === "string" ? value : value.toString();
}

export function entityIdToPgUuid(id: string): string {
  const parsed = parseEntityId(id);
  if (!parsed) {
    throw new Error(`Invalid entity ID: ${JSON.stringify(id)}`);
  }
  return parsed.uuid;
}

export function optionalEntityIdToPgUuid(
  id: string | null | undefined,
): string | null {
  if (!id) return null;
  return entityIdToPgUuid(id);
}

export function toMongoObjectId(id: string): Types.ObjectId {
  if (isObjectIdHex(id)) return new Types.ObjectId(id);
  if (isObjectIdUuid(id)) return new Types.ObjectId(uuidToObjectId(id));
  return new Types.ObjectId(id);
}

// ── JSONB date serialization helpers ─────────────────────────────────────────

export function serializeShareEntries(
  entries: IResourceShareEntry[] | undefined,
  rewriteUser?: (raw: string) => string,
): AppShareEntryJson[] | null {
  if (entries === undefined) return null;
  return entries.map(e => ({
    userId: rewriteUser ? rewriteUser(e.userId) : e.userId,
    role: e.role,
    addedAt: toDate(e.addedAt).toISOString(),
    ...(e.addedBy
      ? { addedBy: rewriteUser ? rewriteUser(e.addedBy) : e.addedBy }
      : {}),
  }));
}

export function deserializeShareEntries(
  entries: AppShareEntryJson[] | null | undefined,
): IResourceShareEntry[] | undefined {
  if (entries == null) return undefined;
  return entries.map(e => ({
    userId: e.userId,
    role: e.role,
    addedAt: toDate(e.addedAt),
    ...(e.addedBy ? { addedBy: e.addedBy } : {}),
  }));
}

export function serializeLastDeployError(
  err: AppLastDeployErrorRecord | undefined,
): AppLastDeployErrorJson | null {
  if (!err) return null;
  return {
    sha: err.sha,
    stage: err.stage,
    message: err.message,
    at: toDate(err.at).toISOString(),
  };
}

export function deserializeLastDeployError(
  err: AppLastDeployErrorJson | null | undefined,
): AppLastDeployErrorRecord | undefined {
  if (!err) return undefined;
  return {
    sha: err.sha,
    stage: err.stage,
    message: err.message,
    at: toDate(err.at),
  };
}

export function serializeBindingRefreshErrors(
  errors: Record<string, AppBindingRefreshErrorRecord> | undefined,
): Record<string, AppBindingRefreshErrorJson> | null {
  if (!errors) return null;
  const out: Record<string, AppBindingRefreshErrorJson> = {};
  for (const [k, v] of Object.entries(errors)) {
    if (!v) continue;
    out[k] = {
      sha: v.sha,
      message: v.message,
      attempts: v.attempts,
      at: toDate(v.at).toISOString(),
    };
  }
  return out;
}

export function deserializeBindingRefreshErrors(
  errors: Record<string, AppBindingRefreshErrorJson> | null | undefined,
): Record<string, AppBindingRefreshErrorRecord> | undefined {
  if (!errors) return undefined;
  const out: Record<string, AppBindingRefreshErrorRecord> = {};
  for (const [k, v] of Object.entries(errors)) {
    if (!v) continue;
    out[k] = {
      sha: v.sha,
      message: v.message,
      attempts: v.attempts,
      at: toDate(v.at),
    };
  }
  return out;
}

export function serializeDeployProgress(
  progress: IAppDeployProgress | undefined,
): AppDeployProgressJson | null {
  if (!progress) return null;
  return {
    sha: progress.sha,
    stage: progress.stage,
    startedAt: toDate(progress.startedAt).toISOString(),
    stageStartedAt: toDate(progress.stageStartedAt).toISOString(),
    updatedAt: toDate(progress.updatedAt).toISOString(),
    ...(progress.bindings ? { bindings: progress.bindings } : {}),
  };
}

export function deserializeDeployProgress(
  progress: AppDeployProgressJson | null | undefined,
): IAppDeployProgress | undefined {
  if (!progress) return undefined;
  return {
    sha: progress.sha,
    stage: progress.stage,
    startedAt: toDate(progress.startedAt),
    stageStartedAt: toDate(progress.stageStartedAt),
    updatedAt: toDate(progress.updatedAt),
    ...(progress.bindings ? { bindings: progress.bindings } : {}),
  };
}

export function serializeBindingRun(
  run: AppBindingRunRecord,
): AppBindingRunJson {
  return {
    at: toDate(run.at).toISOString(),
    status: run.status,
    ...(run.rowCount !== undefined ? { rowCount: run.rowCount } : {}),
    ...(run.durationMs !== undefined ? { durationMs: run.durationMs } : {}),
    ...(run.error !== undefined ? { error: run.error } : {}),
    ...(run.artifactKey !== undefined ? { artifactKey: run.artifactKey } : {}),
    ...(run.byteSize !== undefined ? { byteSize: run.byteSize } : {}),
    ...(run.compression !== undefined ? { compression: run.compression } : {}),
  };
}

export function deserializeBindingRun(
  run: AppBindingRunJson,
): AppBindingRunRecord {
  return {
    at: toDate(run.at),
    status: run.status,
    ...(run.rowCount !== undefined ? { rowCount: run.rowCount } : {}),
    ...(run.durationMs !== undefined ? { durationMs: run.durationMs } : {}),
    ...(run.error !== undefined ? { error: run.error } : {}),
    ...(run.artifactKey !== undefined ? { artifactKey: run.artifactKey } : {}),
    ...(run.byteSize !== undefined ? { byteSize: run.byteSize } : {}),
    ...(run.compression !== undefined
      ? { compression: run.compression as ParquetCodec | null }
      : {}),
  };
}

export function serializeJobProgress(
  progress: AppBindingJobProgressRecord | null | undefined,
): AppBindingJobProgressJson | null {
  if (!progress) return null;
  return {
    phase: progress.phase,
    ...(progress.rowsWritten !== undefined
      ? { rowsWritten: progress.rowsWritten }
      : {}),
    ...(progress.bytes !== undefined ? { bytes: progress.bytes } : {}),
    at: toDate(progress.at).toISOString(),
  };
}

export function deserializeJobProgress(
  progress: AppBindingJobProgressJson | null | undefined,
): AppBindingJobProgressRecord | null {
  if (!progress) return null;
  return {
    phase: progress.phase,
    ...(progress.rowsWritten !== undefined
      ? { rowsWritten: progress.rowsWritten }
      : {}),
    ...(progress.bytes !== undefined ? { bytes: progress.bytes } : {}),
    at: toDate(progress.at),
  };
}

// ── Mongo -> Record mappers ──────────────────────────────────────────────────

export interface MongoAppProjectLike {
  _id: { toString(): string } | string;
  workspaceId: { toString(): string } | string;
  title: string;
  slug?: string;
  path?: string;
  description?: string;
  access?: "private" | "workspace";
  workspaceRole?: "viewer" | "editor";
  sharedWith?: IResourceShareEntry[];
  owner_id?: string | null;
  createdBy?: string | null;
  defaultBranch?: string;
  cloudRepo?: { owner: string; repo: string };
  publishedSha?: string;
  chatEnabled?: boolean;
  publishedAt?: Date | string;
  lastDeployError?: {
    sha: string;
    stage: "bindings" | "build" | "publish";
    message: string;
    at: Date | string;
  };
  bindingRefreshErrors?: Record<
    string,
    { sha: string; message: string; attempts: number; at: Date | string }
  >;
  deployProgress?: {
    sha: string;
    stage: IAppDeployProgress["stage"];
    startedAt: Date | string;
    stageStartedAt: Date | string;
    updatedAt: Date | string;
    bindings?: { total: number; prepared: number; current?: string };
  };
  publicShare?: IPublicShare;
  env?: Array<{ key: string; valueEncrypted: string; secret: boolean }>;
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

export function mongoAppProjectToRecord(
  doc: MongoAppProjectLike,
): AppProjectRecord {
  const bindingRefreshErrors = doc.bindingRefreshErrors
    ? Object.fromEntries(
        Object.entries(doc.bindingRefreshErrors)
          .filter(([, v]) => Boolean(v))
          .map(([k, v]) => [
            k,
            {
              sha: v.sha,
              message: v.message,
              attempts: v.attempts,
              at: toDate(v.at),
            },
          ]),
      )
    : undefined;

  const publicShare: IPublicShare | undefined = doc.publicShare
    ? {
        enabled: Boolean(doc.publicShare.enabled),
        ...(doc.publicShare.token ? { token: doc.publicShare.token } : {}),
        ...(doc.publicShare.passwordHash !== undefined
          ? { passwordHash: doc.publicShare.passwordHash }
          : {}),
        ...(doc.publicShare.passwordEncrypted !== undefined
          ? { passwordEncrypted: doc.publicShare.passwordEncrypted }
          : {}),
        ...(doc.publicShare.createdAt
          ? { createdAt: toDate(doc.publicShare.createdAt) }
          : {}),
        ...(doc.publicShare.createdBy
          ? { createdBy: doc.publicShare.createdBy }
          : {}),
        allowLiveQueries: Boolean(doc.publicShare.allowLiveQueries),
      }
    : undefined;

  return {
    id: toWireStringId(doc._id),
    workspaceId: toWireStringId(doc.workspaceId),
    title: doc.title,
    ...(doc.slug !== undefined ? { slug: doc.slug } : {}),
    ...(doc.path !== undefined ? { path: doc.path } : {}),
    ...(doc.description !== undefined ? { description: doc.description } : {}),
    access: doc.access ?? "private",
    ...(doc.workspaceRole !== undefined
      ? { workspaceRole: doc.workspaceRole }
      : {}),
    ...(doc.sharedWith !== undefined
      ? {
          sharedWith: doc.sharedWith.map(s => ({
            userId: s.userId,
            role: s.role,
            addedAt: toDate(s.addedAt),
            ...(s.addedBy ? { addedBy: s.addedBy } : {}),
          })),
        }
      : {}),
    ...(doc.owner_id ? { owner_id: doc.owner_id } : {}),
    createdBy: doc.createdBy ?? "",
    defaultBranch: doc.defaultBranch ?? "main",
    ...(doc.cloudRepo
      ? { cloudRepo: { owner: doc.cloudRepo.owner, repo: doc.cloudRepo.repo } }
      : {}),
    ...(doc.publishedSha !== undefined
      ? { publishedSha: doc.publishedSha }
      : {}),
    ...(doc.chatEnabled !== undefined ? { chatEnabled: doc.chatEnabled } : {}),
    ...(doc.publishedAt ? { publishedAt: toDate(doc.publishedAt) } : {}),
    ...(doc.lastDeployError
      ? {
          lastDeployError: {
            sha: doc.lastDeployError.sha,
            stage: doc.lastDeployError.stage,
            message: doc.lastDeployError.message,
            at: toDate(doc.lastDeployError.at),
          },
        }
      : {}),
    ...(bindingRefreshErrors && Object.keys(bindingRefreshErrors).length > 0
      ? { bindingRefreshErrors }
      : {}),
    ...(doc.deployProgress
      ? {
          deployProgress: {
            sha: doc.deployProgress.sha,
            stage: doc.deployProgress.stage,
            startedAt: toDate(doc.deployProgress.startedAt),
            stageStartedAt: toDate(doc.deployProgress.stageStartedAt),
            updatedAt: toDate(doc.deployProgress.updatedAt),
            ...(doc.deployProgress.bindings
              ? { bindings: doc.deployProgress.bindings }
              : {}),
          },
        }
      : {}),
    ...(publicShare ? { publicShare } : {}),
    ...(doc.env !== undefined
      ? {
          env: doc.env.map(v => ({
            key: v.key,
            valueEncrypted: v.valueEncrypted,
            secret: Boolean(v.secret),
          })),
        }
      : {}),
    createdAt: doc.createdAt ? toDate(doc.createdAt) : new Date(0),
    updatedAt: doc.updatedAt ? toDate(doc.updatedAt) : new Date(0),
  };
}

export interface MongoAppIndexEntryLike {
  _id: { toString(): string } | string;
  workspaceId: { toString(): string } | string;
  appId: string;
  path: string;
  slug: string;
  scope: "workspace" | "private";
  ownerId?: string | null;
  treeOid: string;
  title: string;
  description?: string | null;
  hasManifestId?: boolean;
  duplicateOf?: string | null;
  schedules?: Array<{ binding: string; cron: string; timezone?: string }>;
  tables?: string[];
  bindingTables?: Array<{ binding: string; tables: string[] }>;
  bindings?: string[];
  authorEmail?: string | null;
  firstCommitAt?: Date | string | null;
  thumbnail?: { file: string; oid: string } | null;
  icon?: { file: string; oid: string } | null;
  indexedSha: string;
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

export function mongoAppIndexEntryToRecord(
  doc: MongoAppIndexEntryLike,
): AppIndexEntryRecord {
  return {
    id: toWireStringId(doc._id),
    workspaceId: toWireStringId(doc.workspaceId),
    appId: doc.appId,
    path: doc.path,
    slug: doc.slug,
    scope: doc.scope,
    ...(doc.ownerId ? { ownerId: doc.ownerId } : {}),
    treeOid: doc.treeOid,
    title: doc.title,
    ...(doc.description != null ? { description: doc.description } : {}),
    hasManifestId: Boolean(doc.hasManifestId),
    ...(doc.duplicateOf ? { duplicateOf: doc.duplicateOf } : {}),
    schedules: (doc.schedules ?? []).map(s => ({
      binding: s.binding,
      cron: s.cron,
      ...(s.timezone ? { timezone: s.timezone } : {}),
    })),
    ...(doc.tables !== undefined ? { tables: doc.tables } : {}),
    ...(doc.bindingTables !== undefined
      ? {
          bindingTables: doc.bindingTables.map(bt => ({
            binding: bt.binding,
            tables: [...(bt.tables ?? [])],
          })),
        }
      : {}),
    ...(doc.bindings !== undefined ? { bindings: doc.bindings } : {}),
    ...(doc.authorEmail != null ? { authorEmail: doc.authorEmail } : {}),
    ...(doc.firstCommitAt ? { firstCommitAt: toDate(doc.firstCommitAt) } : {}),
    ...(doc.thumbnail
      ? { thumbnail: { file: doc.thumbnail.file, oid: doc.thumbnail.oid } }
      : {}),
    ...(doc.icon ? { icon: { file: doc.icon.file, oid: doc.icon.oid } } : {}),
    indexedSha: doc.indexedSha,
    createdAt: doc.createdAt ? toDate(doc.createdAt) : new Date(0),
    updatedAt: doc.updatedAt ? toDate(doc.updatedAt) : new Date(0),
  };
}

export interface MongoAppIndexHeadLike {
  _id: { toString(): string } | string;
  workspaceId: { toString(): string } | string;
  sha: string;
  schemaVersion?: number;
  folders?: string[];
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

export function mongoAppIndexHeadToRecord(
  doc: MongoAppIndexHeadLike,
): AppIndexHeadRecord {
  return {
    id: toWireStringId(doc._id),
    workspaceId: toWireStringId(doc.workspaceId),
    sha: doc.sha,
    ...(doc.schemaVersion !== undefined
      ? { schemaVersion: doc.schemaVersion }
      : {}),
    folders: doc.folders ?? [],
    createdAt: doc.createdAt ? toDate(doc.createdAt) : new Date(0),
    updatedAt: doc.updatedAt ? toDate(doc.updatedAt) : new Date(0),
  };
}

export interface MongoAppEmbeddingLike {
  _id: { toString(): string } | string;
  workspaceId: { toString(): string } | string;
  appId: string;
  path: string;
  treeOid: string;
  docHash: string;
  embeddingModel: string;
  vector: number[];
  terms?: string[];
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

export function mongoAppEmbeddingToRecord(
  doc: MongoAppEmbeddingLike,
): AppEmbeddingRecord {
  return {
    id: toWireStringId(doc._id),
    workspaceId: toWireStringId(doc.workspaceId),
    appId: doc.appId,
    path: doc.path,
    treeOid: doc.treeOid,
    docHash: doc.docHash,
    embeddingModel: doc.embeddingModel,
    vector: [...doc.vector],
    ...(doc.terms !== undefined ? { terms: [...doc.terms] } : {}),
    createdAt: doc.createdAt ? toDate(doc.createdAt) : new Date(0),
    updatedAt: doc.updatedAt ? toDate(doc.updatedAt) : new Date(0),
  };
}

export interface MongoAppLifecycleLike {
  _id: { toString(): string } | string;
  workspaceId: { toString(): string } | string;
  appId: string;
  verifiedAt?: Date | string;
  verifiedBy?: string;
  staleSince?: Date | string;
  staleNotifiedTo?: string[];
  schedulesPausedAt?: Date | string;
  archivedAt?: Date | string;
  archivedFrom?: string;
  archivedTo?: string;
  restoredAt?: Date | string;
  restoredBy?: string;
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

export function mongoAppLifecycleToRecord(
  doc: MongoAppLifecycleLike,
): AppLifecycleRecord {
  return {
    id: toWireStringId(doc._id),
    workspaceId: toWireStringId(doc.workspaceId),
    appId: doc.appId,
    ...(doc.verifiedAt ? { verifiedAt: toDate(doc.verifiedAt) } : {}),
    ...(doc.verifiedBy ? { verifiedBy: doc.verifiedBy } : {}),
    ...(doc.staleSince ? { staleSince: toDate(doc.staleSince) } : {}),
    ...(doc.staleNotifiedTo !== undefined
      ? { staleNotifiedTo: [...doc.staleNotifiedTo] }
      : {}),
    ...(doc.schedulesPausedAt
      ? { schedulesPausedAt: toDate(doc.schedulesPausedAt) }
      : {}),
    ...(doc.archivedAt ? { archivedAt: toDate(doc.archivedAt) } : {}),
    ...(doc.archivedFrom !== undefined
      ? { archivedFrom: doc.archivedFrom }
      : {}),
    ...(doc.archivedTo !== undefined ? { archivedTo: doc.archivedTo } : {}),
    ...(doc.restoredAt ? { restoredAt: toDate(doc.restoredAt) } : {}),
    ...(doc.restoredBy ? { restoredBy: doc.restoredBy } : {}),
    createdAt: doc.createdAt ? toDate(doc.createdAt) : new Date(0),
    updatedAt: doc.updatedAt ? toDate(doc.updatedAt) : new Date(0),
  };
}

export interface MongoAppDeployCommitStatusLike {
  _id: { toString(): string } | string;
  workspaceId: { toString(): string } | string;
  appId: string;
  sha: string;
  state: AppDeployCommitStatusRecord["state"];
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

export function mongoAppDeployCommitStatusToRecord(
  doc: MongoAppDeployCommitStatusLike,
): AppDeployCommitStatusRecord {
  return {
    id: toWireStringId(doc._id),
    workspaceId: toWireStringId(doc.workspaceId),
    appId: doc.appId,
    sha: doc.sha,
    state: doc.state,
    createdAt: doc.createdAt ? toDate(doc.createdAt) : new Date(0),
    updatedAt: doc.updatedAt ? toDate(doc.updatedAt) : new Date(0),
  };
}

export interface MongoAppWorktreeLike {
  _id: { toString(): string } | string;
  workspaceId: { toString(): string } | string;
  projectId?: { toString(): string } | string;
  userId: string;
  branch?: string;
  lastActivityAt?: Date | string;
  activeUntil?: Date | string;
  idlePausedAt?: Array<Date | string>;
  idlePauseHoldUntil?: Date | string;
  idlePauseHoldSetAt?: Date | string;
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

export function mongoAppWorktreeToRecord(
  doc: MongoAppWorktreeLike,
): AppWorktreeRecord {
  return {
    id: toWireStringId(doc._id),
    workspaceId: toWireStringId(doc.workspaceId),
    ...(doc.projectId ? { projectId: toWireStringId(doc.projectId) } : {}),
    userId: doc.userId,
    branch: doc.branch ?? "main",
    ...(doc.lastActivityAt
      ? { lastActivityAt: toDate(doc.lastActivityAt) }
      : {}),
    ...(doc.activeUntil ? { activeUntil: toDate(doc.activeUntil) } : {}),
    ...(doc.idlePausedAt !== undefined
      ? { idlePausedAt: doc.idlePausedAt.map(toDate) }
      : {}),
    ...(doc.idlePauseHoldUntil
      ? { idlePauseHoldUntil: toDate(doc.idlePauseHoldUntil) }
      : {}),
    ...(doc.idlePauseHoldSetAt
      ? { idlePauseHoldSetAt: toDate(doc.idlePauseHoldSetAt) }
      : {}),
    createdAt: doc.createdAt ? toDate(doc.createdAt) : new Date(0),
    updatedAt: doc.updatedAt ? toDate(doc.updatedAt) : new Date(0),
  };
}

export interface MongoAppBindingStateLike {
  _id: { toString(): string } | string;
  projectId: { toString(): string } | string;
  name: string;
  lastMaterializedAt?: Date | string;
  lastRowCount?: number;
  publicRefreshAt?: Date | string;
  history?: Array<{
    at: Date | string;
    status: "ready" | "error";
    rowCount?: number | null;
    durationMs?: number | null;
    error?: string | null;
    artifactKey?: string | null;
    byteSize?: number | null;
    compression?: ParquetCodec | null;
  }>;
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

export function mongoAppBindingStateToRecord(
  doc: MongoAppBindingStateLike,
): AppBindingStateRecord {
  return {
    id: toWireStringId(doc._id),
    projectId: toWireStringId(doc.projectId),
    name: doc.name,
    ...(doc.lastMaterializedAt
      ? { lastMaterializedAt: toDate(doc.lastMaterializedAt) }
      : {}),
    ...(doc.lastRowCount !== undefined
      ? { lastRowCount: doc.lastRowCount }
      : {}),
    ...(doc.publicRefreshAt
      ? { publicRefreshAt: toDate(doc.publicRefreshAt) }
      : {}),
    ...(doc.history !== undefined
      ? {
          history: doc.history.map(h => ({
            at: toDate(h.at),
            status: h.status,
            ...(h.rowCount !== undefined ? { rowCount: h.rowCount } : {}),
            ...(h.durationMs !== undefined ? { durationMs: h.durationMs } : {}),
            ...(h.error !== undefined ? { error: h.error } : {}),
            ...(h.artifactKey !== undefined
              ? { artifactKey: h.artifactKey }
              : {}),
            ...(h.byteSize !== undefined ? { byteSize: h.byteSize } : {}),
            ...(h.compression !== undefined
              ? { compression: h.compression }
              : {}),
          })),
        }
      : {}),
    createdAt: doc.createdAt ? toDate(doc.createdAt) : new Date(0),
    updatedAt: doc.updatedAt ? toDate(doc.updatedAt) : new Date(0),
  };
}

export interface MongoAppBindingDraftLike {
  _id: { toString(): string } | string;
  projectId: { toString(): string } | string;
  hash: string;
  kind: "build" | "failure";
  name: string;
  key?: string | null;
  builtAt?: Date | string | null;
  rowCount?: number | null;
  byteSize?: number | null;
  failures?: number;
  until?: Date | string | null;
  error?: string | null;
  expiresAt: Date | string;
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

export function mongoAppBindingDraftToRecord(
  doc: MongoAppBindingDraftLike,
): AppBindingDraftRecord {
  return {
    id: toWireStringId(doc._id),
    projectId: toWireStringId(doc.projectId),
    hash: doc.hash,
    kind: doc.kind,
    name: doc.name,
    ...(doc.key !== undefined ? { key: doc.key } : {}),
    ...(doc.builtAt !== undefined
      ? { builtAt: doc.builtAt ? toDate(doc.builtAt) : null }
      : {}),
    ...(doc.rowCount !== undefined ? { rowCount: doc.rowCount } : {}),
    ...(doc.byteSize !== undefined ? { byteSize: doc.byteSize } : {}),
    ...(doc.failures !== undefined ? { failures: doc.failures } : {}),
    ...(doc.until !== undefined
      ? { until: doc.until ? toDate(doc.until) : null }
      : {}),
    ...(doc.error !== undefined ? { error: doc.error } : {}),
    expiresAt: toDate(doc.expiresAt),
    createdAt: doc.createdAt ? toDate(doc.createdAt) : new Date(0),
    updatedAt: doc.updatedAt ? toDate(doc.updatedAt) : new Date(0),
  };
}

export interface MongoAppBindingJobLike {
  _id: { toString(): string } | string;
  workspaceId: { toString(): string } | string;
  projectId: { toString(): string } | string;
  name: string;
  kind?: "materialize" | "dev-build";
  actorId: string;
  userId?: string;
  canWrite?: boolean;
  unregistered?: boolean;
  request?: AppBindingJobRecord["request"];
  status: AppBindingJobRecord["status"];
  result?: AppBindingJobRecord["result"];
  error?: string | null;
  errorStatus?: number | null;
  heartbeatAt?: Date | string | null;
  progress?: {
    phase: string;
    rowsWritten?: number;
    bytes?: number;
    at: Date | string;
  } | null;
  expiresAt: Date | string;
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

export function mongoAppBindingJobToRecord(
  doc: MongoAppBindingJobLike,
): AppBindingJobRecord {
  return {
    id: toWireStringId(doc._id),
    workspaceId: toWireStringId(doc.workspaceId),
    projectId: toWireStringId(doc.projectId),
    name: doc.name,
    ...(doc.kind !== undefined ? { kind: doc.kind } : {}),
    actorId: doc.actorId,
    ...(doc.userId !== undefined ? { userId: doc.userId } : {}),
    canWrite: Boolean(doc.canWrite),
    ...(doc.unregistered !== undefined
      ? { unregistered: doc.unregistered }
      : {}),
    request: doc.request ?? {},
    status: doc.status,
    ...(doc.result !== undefined ? { result: doc.result } : {}),
    ...(doc.error !== undefined ? { error: doc.error } : {}),
    ...(doc.errorStatus !== undefined ? { errorStatus: doc.errorStatus } : {}),
    ...(doc.heartbeatAt !== undefined
      ? { heartbeatAt: doc.heartbeatAt ? toDate(doc.heartbeatAt) : null }
      : {}),
    ...(doc.progress !== undefined
      ? {
          progress: doc.progress
            ? {
                phase: doc.progress.phase,
                ...(doc.progress.rowsWritten !== undefined
                  ? { rowsWritten: doc.progress.rowsWritten }
                  : {}),
                ...(doc.progress.bytes !== undefined
                  ? { bytes: doc.progress.bytes }
                  : {}),
                at: toDate(doc.progress.at),
              }
            : null,
        }
      : {}),
    expiresAt: toDate(doc.expiresAt),
    createdAt: doc.createdAt ? toDate(doc.createdAt) : new Date(0),
    updatedAt: doc.updatedAt ? toDate(doc.updatedAt) : new Date(0),
  };
}

// ── PG Row -> Record mappers ─────────────────────────────────────────────────

export function pgAppProjectToRecord(row: AppProjectRow): AppProjectRecord {
  const hasPublicShare =
    row.publicShareEnabled ||
    row.publicShareToken != null ||
    row.publicSharePasswordHash != null ||
    row.publicSharePasswordEncrypted != null ||
    row.publicShareCreatedAt != null ||
    row.publicShareCreatedBy != null ||
    row.publicShareAllowLiveQueries;

  const publicShare: IPublicShare | undefined = hasPublicShare
    ? {
        enabled: row.publicShareEnabled,
        ...(row.publicShareToken != null
          ? { token: row.publicShareToken }
          : {}),
        passwordHash: row.publicSharePasswordHash ?? null,
        passwordEncrypted: row.publicSharePasswordEncrypted ?? null,
        ...(row.publicShareCreatedAt != null
          ? { createdAt: toDate(row.publicShareCreatedAt) }
          : {}),
        ...(row.publicShareCreatedBy != null
          ? { createdBy: row.publicShareCreatedBy.toLowerCase() }
          : {}),
        allowLiveQueries: row.publicShareAllowLiveQueries,
      }
    : undefined;

  const sharedWith = deserializeShareEntries(row.sharedWith);
  const lastDeployError = deserializeLastDeployError(row.lastDeployError);
  const bindingRefreshErrors = deserializeBindingRefreshErrors(
    row.bindingRefreshErrors,
  );
  const deployProgress = deserializeDeployProgress(row.deployProgress);

  return {
    id: toWireId(row.id),
    workspaceId: toWireId(row.workspaceId),
    title: row.title,
    ...(row.slug != null ? { slug: row.slug } : {}),
    ...(row.path != null ? { path: row.path } : {}),
    ...(row.description != null ? { description: row.description } : {}),
    access: row.access,
    ...(row.workspaceRole != null ? { workspaceRole: row.workspaceRole } : {}),
    ...(sharedWith !== undefined ? { sharedWith } : {}),
    ...(row.ownerId != null ? { owner_id: row.ownerId.toLowerCase() } : {}),
    createdBy: row.createdBy ? row.createdBy.toLowerCase() : "",
    defaultBranch: row.defaultBranch,
    ...(row.cloudRepoOwner != null && row.cloudRepoName != null
      ? { cloudRepo: { owner: row.cloudRepoOwner, repo: row.cloudRepoName } }
      : {}),
    ...(row.publishedSha != null ? { publishedSha: row.publishedSha } : {}),
    ...(row.chatEnabled != null ? { chatEnabled: row.chatEnabled } : {}),
    ...(row.publishedAt != null
      ? { publishedAt: toDate(row.publishedAt) }
      : {}),
    ...(lastDeployError ? { lastDeployError } : {}),
    ...(bindingRefreshErrors && Object.keys(bindingRefreshErrors).length > 0
      ? { bindingRefreshErrors }
      : {}),
    ...(deployProgress ? { deployProgress } : {}),
    ...(publicShare ? { publicShare } : {}),
    ...(row.env != null ? { env: row.env } : {}),
    createdAt: toDate(row.createdAt),
    updatedAt: toDate(row.updatedAt),
  };
}

export function pgAppIndexEntryToRecord(
  row: AppIndexRowPg,
): AppIndexEntryRecord {
  const duplicateOf = optionalToWireId(row.duplicateOf);
  return {
    id: toWireId(row.id),
    workspaceId: toWireId(row.workspaceId),
    appId: toWireId(row.appId),
    path: row.path,
    slug: row.slug,
    scope: row.scope,
    ...(row.ownerId != null ? { ownerId: row.ownerId.toLowerCase() } : {}),
    treeOid: row.treeOid,
    title: row.title,
    ...(row.description != null ? { description: row.description } : {}),
    hasManifestId: row.hasManifestId,
    ...(duplicateOf ? { duplicateOf } : {}),
    schedules: row.schedules ?? [],
    ...(row.tables != null ? { tables: row.tables } : {}),
    ...(row.bindingTables != null ? { bindingTables: row.bindingTables } : {}),
    ...(row.bindings != null ? { bindings: row.bindings } : {}),
    ...(row.authorEmail != null ? { authorEmail: row.authorEmail } : {}),
    ...(row.firstCommitAt != null
      ? { firstCommitAt: toDate(row.firstCommitAt) }
      : {}),
    ...(row.thumbnail != null ? { thumbnail: row.thumbnail } : {}),
    ...(row.icon != null ? { icon: row.icon } : {}),
    indexedSha: row.indexedSha,
    createdAt: toDate(row.createdAt),
    updatedAt: toDate(row.updatedAt),
  };
}

export function pgAppIndexHeadToRecord(
  row: AppIndexHeadRow,
): AppIndexHeadRecord {
  return {
    id: toWireId(row.id),
    workspaceId: toWireId(row.workspaceId),
    sha: row.sha,
    ...(row.schemaVersion != null ? { schemaVersion: row.schemaVersion } : {}),
    folders: row.folders ?? [],
    createdAt: toDate(row.createdAt),
    updatedAt: toDate(row.updatedAt),
  };
}

export function pgAppEmbeddingToRecord(
  row: AppEmbeddingRow,
): AppEmbeddingRecord {
  return {
    id: toWireId(row.id),
    workspaceId: toWireId(row.workspaceId),
    appId: toWireId(row.appId),
    path: row.path,
    treeOid: row.treeOid,
    docHash: row.docHash,
    embeddingModel: row.embeddingModel,
    vector: Array.isArray(row.vector) ? row.vector.map(Number) : [],
    ...(row.terms != null ? { terms: row.terms } : {}),
    createdAt: toDate(row.createdAt),
    updatedAt: toDate(row.updatedAt),
  };
}

export function pgAppLifecycleToRecord(
  row: AppLifecycleRow,
): AppLifecycleRecord {
  return {
    id: toWireId(row.id),
    workspaceId: toWireId(row.workspaceId),
    appId: toWireId(row.appId),
    ...(row.verifiedAt != null ? { verifiedAt: toDate(row.verifiedAt) } : {}),
    ...(row.verifiedBy != null
      ? { verifiedBy: row.verifiedBy.toLowerCase() }
      : {}),
    ...(row.staleSince != null ? { staleSince: toDate(row.staleSince) } : {}),
    ...(row.staleNotifiedTo != null
      ? { staleNotifiedTo: row.staleNotifiedTo }
      : {}),
    ...(row.schedulesPausedAt != null
      ? { schedulesPausedAt: toDate(row.schedulesPausedAt) }
      : {}),
    ...(row.archivedAt != null ? { archivedAt: toDate(row.archivedAt) } : {}),
    ...(row.archivedFrom != null ? { archivedFrom: row.archivedFrom } : {}),
    ...(row.archivedTo != null ? { archivedTo: row.archivedTo } : {}),
    ...(row.restoredAt != null ? { restoredAt: toDate(row.restoredAt) } : {}),
    ...(row.restoredBy != null
      ? { restoredBy: row.restoredBy.toLowerCase() }
      : {}),
    createdAt: toDate(row.createdAt),
    updatedAt: toDate(row.updatedAt),
  };
}

export function pgAppDeployCommitStatusToRecord(
  row: AppDeployCommitStatusRow,
): AppDeployCommitStatusRecord {
  return {
    id: toWireId(row.id),
    workspaceId: toWireId(row.workspaceId),
    appId: toWireId(row.appId),
    sha: row.sha,
    state: row.state,
    createdAt: toDate(row.createdAt),
    updatedAt: toDate(row.updatedAt),
  };
}

export function pgAppWorktreeToRecord(row: AppWorktreeRow): AppWorktreeRecord {
  const projectId = optionalToWireId(row.projectId);
  return {
    id: toWireId(row.id),
    workspaceId: toWireId(row.workspaceId),
    ...(projectId ? { projectId } : {}),
    userId: row.userId ? row.userId.toLowerCase() : row.actorId,
    branch: row.branch,
    ...(row.lastActivityAt != null
      ? { lastActivityAt: toDate(row.lastActivityAt) }
      : {}),
    ...(row.activeUntil != null
      ? { activeUntil: toDate(row.activeUntil) }
      : {}),
    ...(row.idlePausedAt != null
      ? { idlePausedAt: row.idlePausedAt.map(toDate) }
      : {}),
    ...(row.idlePauseHoldUntil != null
      ? { idlePauseHoldUntil: toDate(row.idlePauseHoldUntil) }
      : {}),
    ...(row.idlePauseHoldSetAt != null
      ? { idlePauseHoldSetAt: toDate(row.idlePauseHoldSetAt) }
      : {}),
    createdAt: toDate(row.createdAt),
    updatedAt: toDate(row.updatedAt),
  };
}

export function pgAppBindingStateToRecord(
  row: AppBindingStateRowPg,
): AppBindingStateRecord {
  return {
    id: toWireId(row.id),
    projectId: toWireId(row.projectId),
    name: row.name,
    ...(row.lastMaterializedAt != null
      ? { lastMaterializedAt: toDate(row.lastMaterializedAt) }
      : {}),
    ...(row.lastRowCount != null
      ? { lastRowCount: Number(row.lastRowCount) }
      : {}),
    ...(row.publicRefreshAt != null
      ? { publicRefreshAt: toDate(row.publicRefreshAt) }
      : {}),
    ...(row.history != null
      ? { history: row.history.map(deserializeBindingRun) }
      : {}),
    createdAt: toDate(row.createdAt),
    updatedAt: toDate(row.updatedAt),
  };
}

export function pgAppBindingDraftToRecord(
  row: AppBindingDraftRow,
): AppBindingDraftRecord {
  return {
    id: toWireId(row.id),
    projectId: toWireId(row.projectId),
    hash: row.hash,
    kind: row.kind,
    name: row.name,
    ...(row.key !== null ? { key: row.key } : {}),
    ...(row.builtAt !== null ? { builtAt: toDate(row.builtAt) } : {}),
    ...(row.rowCount !== null ? { rowCount: Number(row.rowCount) } : {}),
    ...(row.byteSize !== null ? { byteSize: Number(row.byteSize) } : {}),
    ...(row.failures !== null ? { failures: row.failures } : {}),
    ...(row.until !== null ? { until: toDate(row.until) } : {}),
    ...(row.error !== null ? { error: row.error } : {}),
    expiresAt: toDate(row.expiresAt),
    createdAt: toDate(row.createdAt),
    updatedAt: toDate(row.updatedAt),
  };
}

export function pgAppBindingJobToRecord(
  row: AppBindingJobRow,
): AppBindingJobRecord {
  return {
    id: toWireId(row.id),
    workspaceId: toWireId(row.workspaceId),
    projectId: toWireId(row.projectId),
    name: row.name,
    ...(row.kind != null ? { kind: row.kind } : {}),
    actorId: row.actorId,
    ...(row.userId != null ? { userId: row.userId.toLowerCase() } : {}),
    canWrite: row.canWrite,
    ...(row.unregistered != null ? { unregistered: row.unregistered } : {}),
    request: row.request ?? {},
    status: row.status,
    ...(row.result !== null ? { result: row.result } : {}),
    ...(row.error !== null ? { error: row.error } : {}),
    ...(row.errorStatus !== null ? { errorStatus: row.errorStatus } : {}),
    ...(row.heartbeatAt !== null
      ? { heartbeatAt: toDate(row.heartbeatAt) }
      : {}),
    ...(row.progress !== null
      ? { progress: deserializeJobProgress(row.progress) }
      : {}),
    expiresAt: toDate(row.expiresAt),
    createdAt: toDate(row.createdAt),
    updatedAt: toDate(row.updatedAt),
  };
}

/**
 * Canonical projection of an `AppProjectRecord` for live Stage 3/4 shadow-compare.
 * Normalizes Mongoose empty-array defaults (`sharedWith: []`, `env: []`) vs PG `NULL`,
 * ensures `publicShare` fields are uniformly shaped, and omits dual-write wall-clock
 * jitter (`createdAt`, `updatedAt`) while preserving EVERY business and secret field
 * (so secret drift is detected and redacted via `APPS_METADATA_SHADOW_OPTIONS`).
 */
export function canonicalizeProjectForShadow(
  record: AppProjectRecord | null,
): Record<string, unknown> | null {
  if (!record) return null;
  const {
    createdAt: _c,
    updatedAt: _u,
    sharedWith,
    env,
    publicShare,
    ...rest
  } = record;
  return {
    ...rest,
    ...(sharedWith && sharedWith.length > 0 ? { sharedWith } : {}),
    ...(env && env.length > 0 ? { env } : {}),
    ...(publicShare
      ? {
          publicShare: {
            enabled: Boolean(publicShare.enabled),
            ...(publicShare.token ? { token: publicShare.token } : {}),
            ...(publicShare.passwordHash != null
              ? { passwordHash: publicShare.passwordHash }
              : {}),
            ...(publicShare.passwordEncrypted != null
              ? { passwordEncrypted: publicShare.passwordEncrypted }
              : {}),
            ...(publicShare.createdAt
              ? { createdAt: publicShare.createdAt }
              : {}),
            ...(publicShare.createdBy
              ? { createdBy: publicShare.createdBy }
              : {}),
            allowLiveQueries: Boolean(publicShare.allowLiveQueries),
          },
        }
      : {}),
  };
}

// ── Mongoose-compatible DTO adapters for callers expecting `IAppProject` / `IAppWorktree` ──

/**
 * Wrap an `AppProjectRecord` into a plain object matching `IAppProject` field types
 * (`_id: Types.ObjectId`, `workspaceId: Types.ObjectId`). Optional `onSave` bridges
 * shared route helpers (`collaborator-routes`, `public-share-routes`) through the repo.
 */
function toCompatId(id: string): Types.ObjectId | string {
  return parseEntityId(id) ? toMongoObjectId(id) : id;
}

export function buildProjectSharingPatch(
  doc: IAppProject,
  modifiedPaths: ReadonlySet<string>,
): UpdateAppProjectSharingPatch {
  const patch: UpdateAppProjectSharingPatch = {};
  if (modifiedPaths.has("access")) {
    patch.access = doc.access;
  }
  if (modifiedPaths.has("workspaceRole")) {
    patch.workspaceRole = doc.workspaceRole;
  }
  if (modifiedPaths.has("sharedWith")) {
    patch.sharedWith = doc.sharedWith ?? [];
  }
  if (modifiedPaths.has("publicShare")) {
    patch.publicShare = doc.publicShare ?? null;
  }
  if (modifiedPaths.has("chatEnabled")) {
    patch.chatEnabled = doc.chatEnabled;
  }
  return patch;
}

export function toAppProjectCompat(
  record: AppProjectRecord,
  onSave?: (
    doc: IAppProject,
    modifiedPaths: ReadonlySet<string>,
  ) => Promise<void>,
): IAppProject {
  const modifiedPaths = new Set<string>();
  const obj = {
    ...record,
    _id: toCompatId(record.id),
    ...(record.workspaceId
      ? { workspaceId: toCompatId(record.workspaceId) }
      : {}),
    markModified: (path?: string) => {
      if (typeof path === "string" && path.length > 0) {
        modifiedPaths.add(path.split(".")[0]);
      }
    },
    save: async function saveCompat(this: IAppProject) {
      if (onSave) {
        const snapshot = new Set(modifiedPaths);
        await onSave(this, snapshot);
        for (const path of snapshot) {
          modifiedPaths.delete(path);
        }
      }
      return this;
    },
  };
  const proxy = new Proxy(obj, {
    set(target, prop, value, receiver) {
      if (typeof prop === "string") {
        modifiedPaths.add(prop);
      }
      return Reflect.set(target, prop, value, receiver);
    },
    deleteProperty(target, prop) {
      if (typeof prop === "string") {
        modifiedPaths.add(prop);
      }
      return Reflect.deleteProperty(target, prop);
    },
  });
  return proxy as unknown as IAppProject;
}

/**
 * Wrap an `AppWorktreeRecord` into a plain object matching `IAppWorktree` field types
 * (`_id: Types.ObjectId`, `workspaceId: Types.ObjectId`) with optional repo-backed `.save()`.
 */
export function toAppWorktreeCompat(
  record: AppWorktreeRecord,
  onSave?: (doc: IAppWorktree) => Promise<void>,
): IAppWorktree {
  const obj = {
    ...record,
    _id: toCompatId(record.id),
    ...(record.workspaceId
      ? { workspaceId: toCompatId(record.workspaceId) }
      : {}),
    ...(record.projectId ? { projectId: toCompatId(record.projectId) } : {}),
    save: async function saveCompat(this: IAppWorktree) {
      if (onSave) {
        await onSave(this);
      }
      return this;
    },
  };
  return obj as unknown as IAppWorktree;
}
