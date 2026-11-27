/**
 * MongoDB (Mongoose) implementation of `AppsMetadataRepository`.
 *
 * Covers all 10 `apps_metadata` collections, including the 3 module-scoped
 * binding models (`AppBindingState`, `AppBindingDraft`, `AppBindingJob`)
 * compiled safely via `mongoose.models.* ?? mongoose.model(...)`.
 */
import mongoose, { Schema, Types } from "mongoose";
import { parseEntityId } from "../../database/pg/id-codec";
import {
  AppDeployCommitStatus,
  AppEmbedding,
  AppIndexEntry,
  AppIndexHead,
  AppLifecycleState,
  AppProject,
  AppWorktree,
  type IAppDeployProgress,
} from "../../database/workspace-schema";
import { PARQUET_CODECS } from "../../utils/parquet-compression";
import {
  mongoAppBindingDraftToRecord,
  mongoAppBindingJobToRecord,
  mongoAppBindingStateToRecord,
  mongoAppDeployCommitStatusToRecord,
  mongoAppEmbeddingToRecord,
  mongoAppIndexEntryToRecord,
  mongoAppIndexHeadToRecord,
  mongoAppLifecycleToRecord,
  mongoAppProjectToRecord,
  mongoAppWorktreeToRecord,
  toMongoObjectId,
  type MongoAppBindingDraftLike,
  type MongoAppBindingJobLike,
  type MongoAppBindingStateLike,
  type MongoAppIndexEntryLike,
  type MongoAppIndexHeadLike,
  type MongoAppLifecycleLike,
  type MongoAppProjectLike,
  type MongoAppWorktreeLike,
} from "./mapper";
import type {
  AppAccessScope,
  AppBindingDraftRecord,
  AppBindingJobProgressRecord,
  AppBindingJobRecord,
  AppBindingRefreshErrorRecord,
  AppBindingRunRecord,
  AppBindingStateRecord,
  AppDeployCommitStatePg,
  AppDeployStage,
  AppEmbeddingMeta,
  AppEmbeddingPathUpdate,
  AppEmbeddingVectorEntry,
  AppEnvVarJson,
  AppIndexEntryRecord,
  AppIndexHeadRecord,
  AppIndexScheduleJson,
  AppLastDeployErrorRecord,
  AppLifecyclePatch,
  AppLifecycleRecord,
  AppProjectRecord,
  AppWorktreeRecord,
  AppsMetadataRepository,
  BindingStateSummaryRecord,
  ClaimPublicBindingRefreshResult,
  CreateAppProjectInput,
  CreateBindingDraftBuildInput,
  CreateBindingJobInput,
  HotWorktreeWorkspaceRecord,
  MarkBindingJobUpdate,
  ProjectMoveSyncUpdate,
  UpdateAppProjectLocationPatch,
  UpdateAppProjectSharingPatch,
  UpsertAppEmbeddingInput,
  UpsertAppIndexEntryInput,
  UpsertBindingDraftFailureInput,
} from "./types";

// Ensure the 3 inline-defined binding Mongoose models are compiled consistently
// whether callers import the repository before or after the binding services.
export function getMongoAppBindingStateModel() {
  return (
    mongoose.models.AppBindingState ??
    mongoose.model(
      "AppBindingState",
      new Schema(
        {
          projectId: { type: Schema.Types.ObjectId, required: true },
          name: { type: String, required: true },
          lastMaterializedAt: { type: Date },
          lastRowCount: { type: Number },
          publicRefreshAt: { type: Date },
          history: {
            type: [
              new Schema(
                {
                  at: { type: Date, required: true },
                  status: { type: String, enum: ["ready", "error"] },
                  rowCount: { type: Number },
                  durationMs: { type: Number },
                  error: { type: String },
                  artifactKey: { type: String },
                  byteSize: { type: Number },
                  compression: { type: String, enum: [...PARQUET_CODECS] },
                },
                { _id: false },
              ),
            ],
            default: undefined,
          },
        },
        { collection: "app_v2_binding_state", timestamps: true },
      ).index({ projectId: 1, name: 1 }, { unique: true }),
    )
  );
}

export function getMongoAppBindingDraftModel() {
  return (
    mongoose.models.AppBindingDraft ??
    mongoose.model(
      "AppBindingDraft",
      new Schema(
        {
          projectId: { type: Schema.Types.ObjectId, required: true },
          hash: { type: String, required: true },
          kind: { type: String, enum: ["build", "failure"], required: true },
          name: { type: String, required: true },
          key: { type: String },
          builtAt: { type: Date },
          rowCount: { type: Number },
          byteSize: { type: Number },
          failures: { type: Number },
          until: { type: Date },
          error: { type: String },
          expiresAt: { type: Date, required: true },
        },
        { collection: "app_binding_drafts", timestamps: true },
      )
        .index({ projectId: 1, hash: 1, kind: 1, expiresAt: -1 })
        .index({ projectId: 1, expiresAt: 1 }),
    )
  );
}

export function getMongoAppBindingJobModel() {
  return (
    mongoose.models.AppBindingJob ??
    mongoose.model(
      "AppBindingJob",
      new Schema(
        {
          workspaceId: { type: String, required: true },
          projectId: { type: String, required: true },
          name: { type: String, required: true },
          kind: { type: String, enum: ["materialize", "dev-build"] },
          actorId: { type: String, required: true },
          userId: { type: String },
          canWrite: { type: Boolean, default: false },
          unregistered: { type: Boolean },
          request: { type: Schema.Types.Mixed, default: {} },
          status: {
            type: String,
            enum: ["queued", "running", "ready", "error"],
            default: "queued",
          },
          result: { type: Schema.Types.Mixed },
          error: { type: String },
          errorStatus: { type: Number },
          heartbeatAt: { type: Date },
          progress: { type: Schema.Types.Mixed },
          expiresAt: { type: Date, required: true },
        },
        { collection: "app_binding_jobs", timestamps: true },
      )
        .index({ projectId: 1, expiresAt: 1 })
        .index({ status: 1, heartbeatAt: 1 }),
    )
  );
}

const OWNERLESS_MONGO_FILTER = {
  $and: [
    {
      $or: [
        { owner_id: { $exists: false } },
        { owner_id: null },
        { owner_id: "" },
      ],
    },
    {
      $or: [
        { createdBy: { $exists: false } },
        { createdBy: null },
        { createdBy: "" },
      ],
    },
  ],
};

function isRealMongooseModel(model: unknown): boolean {
  return (
    typeof model === "function" &&
    typeof (model as { collection?: unknown }).collection === "object" &&
    (model as { collection?: unknown }).collection !== null
  );
}

function toMongoIdOrMockRaw(
  id: string,
  model: unknown,
): Types.ObjectId | string {
  if (parseEntityId(id)) return toMongoObjectId(id);
  if (!isRealMongooseModel(model)) return id;
  return toMongoObjectId(id);
}

async function resolveLean<T>(queryOrPromise: unknown): Promise<T> {
  if (
    queryOrPromise &&
    typeof (queryOrPromise as { lean?: unknown }).lean === "function"
  ) {
    return (queryOrPromise as { lean: () => Promise<T> }).lean();
  }
  return queryOrPromise as Promise<T>;
}

async function resolveSelectLean<T>(
  queryOrPromise: unknown,
  fields: string,
): Promise<T> {
  let current = queryOrPromise;
  if (
    current &&
    typeof (current as { select?: unknown }).select === "function"
  ) {
    current = (current as { select: (f: string) => unknown }).select(fields);
  }
  return resolveLean<T>(current);
}

export class MongoAppsMetadataRepository implements AppsMetadataRepository {
  // ── 1. app_projects ──────────────────────────────────────────────────────

  async findProjectById(
    id: string,
    workspaceId?: string,
  ): Promise<AppProjectRecord | null> {
    const isReal = isRealMongooseModel(AppProject);
    if (!parseEntityId(id) && isReal) return null;
    if (!workspaceId || typeof AppProject.findOne !== "function") {
      if (typeof AppProject.findById !== "function") return null;
      const doc = await resolveLean<MongoAppProjectLike | null>(
        AppProject.findById(toMongoIdOrMockRaw(id, AppProject)),
      );
      if (!doc) return null;
      if (
        workspaceId &&
        doc.workspaceId &&
        String(doc.workspaceId) !== workspaceId
      ) {
        return null;
      }
      return mongoAppProjectToRecord(doc);
    }
    if (!parseEntityId(workspaceId) && isReal) return null;
    const doc = await resolveLean<MongoAppProjectLike | null>(
      AppProject.findOne({
        _id: toMongoIdOrMockRaw(id, AppProject),
        workspaceId: toMongoIdOrMockRaw(workspaceId, AppProject),
      }),
    );
    return doc ? mongoAppProjectToRecord(doc) : null;
  }

  async findProjectByPath(
    workspaceId: string,
    path: string,
  ): Promise<AppProjectRecord | null> {
    const doc = await AppProject.findOne({
      workspaceId: toMongoObjectId(workspaceId),
      path,
    }).lean<MongoAppProjectLike | null>();
    return doc ? mongoAppProjectToRecord(doc) : null;
  }

  async findProjectBySlug(
    workspaceId: string,
    slug: string,
  ): Promise<AppProjectRecord | null> {
    const doc = await AppProject.findOne({
      workspaceId: toMongoObjectId(workspaceId),
      slug,
    }).lean<MongoAppProjectLike | null>();
    return doc ? mongoAppProjectToRecord(doc) : null;
  }

  async findProjectByShareToken(
    token: string,
  ): Promise<AppProjectRecord | null> {
    const doc = await AppProject.findOne({
      "publicShare.token": token,
      "publicShare.enabled": true,
    }).lean<MongoAppProjectLike | null>();
    return doc ? mongoAppProjectToRecord(doc) : null;
  }

  async findShareTokenOwnerWorkspaceId(
    token: string,
    excludeId?: string,
  ): Promise<string | null> {
    const filter: Record<string, unknown> = { "publicShare.token": token };
    if (excludeId && parseEntityId(excludeId)) {
      filter._id = { $ne: toMongoObjectId(excludeId) };
    }
    const doc = await resolveSelectLean<{
      workspaceId?: Types.ObjectId;
    } | null>(AppProject.findOne(filter), "workspaceId");
    return doc?.workspaceId ? doc.workspaceId.toString() : null;
  }

  async isShareTokenTaken(token: string, excludeId?: string): Promise<boolean> {
    const filter: Record<string, unknown> = { "publicShare.token": token };
    if (excludeId && parseEntityId(excludeId)) {
      filter._id = { $ne: toMongoObjectId(excludeId) };
    }
    return Boolean(await AppProject.exists(filter));
  }

  async projectExistsMatching(params: {
    id: string;
    workspaceId: string;
    path: string;
    slug: string;
  }): Promise<boolean> {
    const ws = toMongoObjectId(params.workspaceId);
    const hit = await AppProject.exists({
      $or: [
        { _id: toMongoObjectId(params.id) },
        { workspaceId: ws, path: params.path },
        { workspaceId: ws, slug: params.slug },
      ],
    });
    return hit !== null;
  }

  async listProjectsByWorkspace(
    workspaceId: string,
  ): Promise<AppProjectRecord[]> {
    const docs = await resolveLean<MongoAppProjectLike[]>(
      AppProject.find({
        workspaceId: toMongoIdOrMockRaw(workspaceId, AppProject),
      }),
    );
    return (docs ?? []).map(mongoAppProjectToRecord);
  }

  async listProjectsByIds(
    workspaceId: string,
    ids: readonly string[],
  ): Promise<AppProjectRecord[]> {
    const isReal = isRealMongooseModel(AppProject);
    const valid = isReal
      ? ids.filter(id => Boolean(parseEntityId(id)))
      : [...ids];
    if (valid.length === 0) return [];
    const docs = await resolveLean<MongoAppProjectLike[]>(
      AppProject.find({
        workspaceId: toMongoIdOrMockRaw(workspaceId, AppProject),
        _id: { $in: valid.map(id => toMongoIdOrMockRaw(id, AppProject)) },
      }),
    );
    return (docs ?? []).map(mongoAppProjectToRecord);
  }

  async listForeignProjectIds(
    excludeWorkspaceId: string,
    candidateIds: readonly string[],
  ): Promise<string[]> {
    const valid = candidateIds.filter(id => Boolean(parseEntityId(id)));
    if (valid.length === 0) return [];
    const docs = await resolveSelectLean<Array<{ _id: Types.ObjectId }>>(
      AppProject.find({
        workspaceId: { $ne: toMongoObjectId(excludeWorkspaceId) },
        _id: { $in: valid.map(toMongoObjectId) },
      }),
      "_id",
    );
    return (docs ?? []).map(d => d._id.toString());
  }

  async listExistingProjectIdWorkspaces(
    ids: readonly string[],
  ): Promise<Array<{ id: string; workspaceId: string }>> {
    const valid = ids.filter(id => Boolean(parseEntityId(id)));
    if (valid.length === 0) return [];
    const docs = await resolveSelectLean<
      Array<{ _id: Types.ObjectId; workspaceId: Types.ObjectId }>
    >(
      AppProject.find({
        _id: { $in: valid.map(toMongoObjectId) },
      }),
      "_id workspaceId",
    );
    return (docs ?? []).map(d => ({
      id: d._id.toString(),
      workspaceId: d.workspaceId.toString(),
    }));
  }

  async listExistingProjectIds(ids: readonly string[]): Promise<string[]> {
    const valid = ids.filter(id => Boolean(parseEntityId(id)));
    if (valid.length === 0) return [];
    const docs = await resolveSelectLean<Array<{ _id: Types.ObjectId }>>(
      AppProject.find({
        _id: { $in: valid.map(toMongoObjectId) },
      }),
      "_id",
    );
    return (docs ?? []).map(d => d._id.toString());
  }

  async listDistinctProjectWorkspaceIds(): Promise<string[]> {
    const ids = await AppProject.distinct("workspaceId");
    return ids.map(id => String(id));
  }

  async listPublishedProjects(): Promise<AppProjectRecord[]> {
    const docs = await resolveSelectLean<MongoAppProjectLike[]>(
      AppProject.find({
        publishedSha: { $ne: null },
      }),
      "",
    );
    return (docs ?? []).map(mongoAppProjectToRecord);
  }

  async listOwnerlessProjects(
    workspaceId?: string,
  ): Promise<AppProjectRecord[]> {
    const filter: Record<string, unknown> = { ...OWNERLESS_MONGO_FILTER };
    if (workspaceId) {
      filter.workspaceId = toMongoIdOrMockRaw(workspaceId, AppProject);
    }
    const docs = await resolveLean<MongoAppProjectLike[]>(
      AppProject.find(filter),
    );
    return (docs ?? []).map(mongoAppProjectToRecord);
  }

  async createProject(input: CreateAppProjectInput): Promise<AppProjectRecord> {
    const created = await AppProject.create({
      ...(input.id ? { _id: toMongoObjectId(input.id) } : {}),
      workspaceId: toMongoObjectId(input.workspaceId),
      title: input.title,
      ...(input.slug !== undefined ? { slug: input.slug } : {}),
      ...(input.path !== undefined ? { path: input.path } : {}),
      ...(input.description !== undefined
        ? { description: input.description }
        : {}),
      access: input.access ?? "private",
      ...(input.workspaceRole !== undefined
        ? { workspaceRole: input.workspaceRole }
        : {}),
      ...(input.sharedWith !== undefined
        ? { sharedWith: input.sharedWith }
        : {}),
      ...(input.owner_id ? { owner_id: input.owner_id } : {}),
      createdBy: input.createdBy ?? "",
      defaultBranch: input.defaultBranch ?? "main",
      ...(input.cloudRepo ? { cloudRepo: input.cloudRepo } : {}),
      ...(input.publishedSha !== undefined
        ? { publishedSha: input.publishedSha }
        : {}),
      ...(input.chatEnabled !== undefined
        ? { chatEnabled: input.chatEnabled }
        : {}),
      ...(input.publishedAt ? { publishedAt: input.publishedAt } : {}),
      ...(input.lastDeployError
        ? { lastDeployError: input.lastDeployError }
        : {}),
      ...(input.bindingRefreshErrors
        ? { bindingRefreshErrors: input.bindingRefreshErrors }
        : {}),
      ...(input.deployProgress ? { deployProgress: input.deployProgress } : {}),
      ...(input.publicShare ? { publicShare: input.publicShare } : {}),
      ...(input.env !== undefined ? { env: input.env } : {}),
    });
    return mongoAppProjectToRecord(
      created.toObject() as unknown as MongoAppProjectLike,
    );
  }

  async claimOwnerlessProjectRow(
    workspaceId: string,
    id: string,
    ownerId: string,
  ): Promise<boolean> {
    const res = await AppProject.updateOne(
      {
        _id: toMongoObjectId(id),
        workspaceId: toMongoObjectId(workspaceId),
        owner_id: { $in: [null, ""] },
        createdBy: { $in: [null, ""] },
      },
      { $set: { owner_id: ownerId, createdBy: ownerId } },
    );
    return res.modifiedCount > 0;
  }

  async updateProjectSharing(
    workspaceId: string,
    id: string,
    patch: UpdateAppProjectSharingPatch,
  ): Promise<void> {
    const $set: Record<string, unknown> = {};
    const $unset: Record<string, 1> = {};
    if (patch.access !== undefined) $set.access = patch.access;
    if (patch.workspaceRole !== undefined) {
      $set.workspaceRole = patch.workspaceRole;
    }
    if (patch.sharedWith !== undefined) $set.sharedWith = patch.sharedWith;
    if (patch.chatEnabled !== undefined) $set.chatEnabled = patch.chatEnabled;
    if (patch.publicShare === null) {
      $unset.publicShare = 1;
    } else if (patch.publicShare !== undefined) {
      $set.publicShare = patch.publicShare;
    }
    const update: Record<string, unknown> = {};
    if (Object.keys($set).length > 0) update.$set = $set;
    if (Object.keys($unset).length > 0) update.$unset = $unset;
    if (Object.keys(update).length === 0) return;
    await AppProject.updateOne(
      { _id: toMongoObjectId(id), workspaceId: toMongoObjectId(workspaceId) },
      update,
    );
  }

  async updateProjectEnv(
    workspaceId: string,
    id: string,
    env: AppEnvVarJson[],
  ): Promise<void> {
    await AppProject.updateOne(
      { _id: toMongoObjectId(id), workspaceId: toMongoObjectId(workspaceId) },
      { $set: { env } },
    );
  }

  async updateProjectLocation(
    workspaceId: string,
    id: string,
    patch: UpdateAppProjectLocationPatch,
    expectedPath?: string,
  ): Promise<void> {
    const filter: Record<string, unknown> = {
      _id: toMongoObjectId(id),
      workspaceId: toMongoObjectId(workspaceId),
    };
    if (expectedPath !== undefined) filter.path = expectedPath;

    const $set: Record<string, unknown> = {};
    const $unset: Record<string, 1> = {};
    if (patch.path === null) $unset.path = 1;
    else if (patch.path !== undefined) $set.path = patch.path;
    if (patch.slug !== undefined) $set.slug = patch.slug;
    if (patch.title !== undefined) $set.title = patch.title;
    if (patch.access !== undefined) $set.access = patch.access;
    if (patch.ownerId === null) $set.owner_id = null;
    else if (patch.ownerId !== undefined) $set.owner_id = patch.ownerId;

    const update: Record<string, unknown> = {};
    if (Object.keys($set).length > 0) update.$set = $set;
    if (Object.keys($unset).length > 0) update.$unset = $unset;
    if (Object.keys(update).length === 0) return;

    await AppProject.updateOne(filter, update);
  }

  async unsetProjectsPath(
    workspaceId: string,
    ids: readonly string[],
  ): Promise<void> {
    const valid = ids.filter(id => Boolean(parseEntityId(id)));
    if (valid.length === 0) return;
    await AppProject.updateMany(
      {
        _id: { $in: valid.map(toMongoObjectId) },
        workspaceId: toMongoObjectId(workspaceId),
      },
      { $unset: { path: 1 } },
    );
  }

  async syncMovedProjects(
    workspaceId: string,
    updates: readonly ProjectMoveSyncUpdate[],
  ): Promise<void> {
    if (updates.length === 0) return;
    const ws = toMongoObjectId(workspaceId);
    await AppProject.bulkWrite(
      updates.map(u => ({
        updateOne: {
          filter: { _id: toMongoObjectId(u.appId), workspaceId: ws },
          update: {
            $set: {
              path: u.path,
              slug: u.slug,
              title: u.title,
              ...(u.access !== undefined ? { access: u.access } : {}),
              ...(u.ownerId !== undefined ? { owner_id: u.ownerId } : {}),
            },
          },
        },
      })),
      { ordered: false },
    );
  }

  async setDeployProgressQueued(
    workspaceId: string,
    id: string,
    progress: IAppDeployProgress,
  ): Promise<void> {
    await AppProject.updateOne(
      {
        _id: toMongoIdOrMockRaw(id, AppProject),
        ...(workspaceId
          ? { workspaceId: toMongoIdOrMockRaw(workspaceId, AppProject) }
          : {}),
      },
      { $set: { deployProgress: progress } },
    );
  }

  async advanceDeployProgressStage(
    workspaceId: string,
    id: string,
    sha: string,
    stage: AppDeployStage,
    now: Date,
    staleBefore: Date,
  ): Promise<void> {
    const _id = toMongoIdOrMockRaw(id, AppProject);
    const wsFilter = workspaceId
      ? { workspaceId: toMongoIdOrMockRaw(workspaceId, AppProject) }
      : {};
    const res = await AppProject.updateOne(
      { _id, ...wsFilter, "deployProgress.sha": sha },
      {
        $set: {
          "deployProgress.stage": stage,
          "deployProgress.stageStartedAt": now,
          "deployProgress.updatedAt": now,
        },
        $unset: { "deployProgress.bindings": 1 },
      },
    );
    if ((res?.matchedCount ?? 0) > 0) return;
    await AppProject.updateOne(
      {
        _id,
        ...wsFilter,
        $or: [
          { deployProgress: { $exists: false } },
          { deployProgress: null },
          { "deployProgress.updatedAt": { $lt: staleBefore } },
        ],
      },
      {
        $set: {
          deployProgress: {
            sha,
            stage,
            startedAt: now,
            stageStartedAt: now,
            updatedAt: now,
          },
        },
      },
    );
  }

  async updateDeployProgressBindings(
    workspaceId: string,
    id: string,
    sha: string,
    bindings: NonNullable<IAppDeployProgress["bindings"]>,
    now: Date,
  ): Promise<void> {
    await AppProject.updateOne(
      {
        _id: toMongoIdOrMockRaw(id, AppProject),
        ...(workspaceId
          ? { workspaceId: toMongoIdOrMockRaw(workspaceId, AppProject) }
          : {}),
        "deployProgress.sha": sha,
      },
      {
        $set: {
          "deployProgress.bindings": bindings,
          "deployProgress.updatedAt": now,
        },
      },
    );
  }

  async clearDeployProgress(
    workspaceId: string,
    id: string,
    sha: string,
  ): Promise<void> {
    await AppProject.updateOne(
      {
        _id: toMongoIdOrMockRaw(id, AppProject),
        ...(workspaceId
          ? { workspaceId: toMongoIdOrMockRaw(workspaceId, AppProject) }
          : {}),
        "deployProgress.sha": sha,
      },
      { $unset: { deployProgress: 1 } },
    );
  }

  async setPublishedSha(
    workspaceId: string,
    id: string,
    sha: string,
    publishedAt: Date,
    expectedSha?: string | null,
  ): Promise<{ matched: boolean }> {
    const res = await AppProject.updateOne(
      {
        _id: toMongoIdOrMockRaw(id, AppProject),
        ...(workspaceId
          ? { workspaceId: toMongoIdOrMockRaw(workspaceId, AppProject) }
          : {}),
        ...(expectedSha !== undefined ? { publishedSha: expectedSha } : {}),
      },
      { $set: { publishedSha: sha, publishedAt } },
    );
    return { matched: (res?.matchedCount ?? 0) > 0 };
  }

  async clearPublishedSha(workspaceId: string, id: string): Promise<void> {
    await AppProject.updateOne(
      {
        _id: toMongoIdOrMockRaw(id, AppProject),
        ...(workspaceId
          ? { workspaceId: toMongoIdOrMockRaw(workspaceId, AppProject) }
          : {}),
      },
      { $unset: { publishedSha: 1, publishedAt: 1, lastDeployError: 1 } },
    );
  }

  async setLastDeployError(
    workspaceId: string,
    id: string,
    error: AppLastDeployErrorRecord,
  ): Promise<void> {
    await AppProject.updateOne(
      {
        _id: toMongoIdOrMockRaw(id, AppProject),
        ...(workspaceId
          ? { workspaceId: toMongoIdOrMockRaw(workspaceId, AppProject) }
          : {}),
      },
      { $set: { lastDeployError: error } },
    );
  }

  async clearLastDeployErrorIfSha(
    workspaceId: string,
    id: string,
    failedSha: string,
  ): Promise<void> {
    await AppProject.updateOne(
      {
        _id: toMongoIdOrMockRaw(id, AppProject),
        ...(workspaceId
          ? { workspaceId: toMongoIdOrMockRaw(workspaceId, AppProject) }
          : {}),
        "lastDeployError.sha": failedSha,
      },
      { $unset: { lastDeployError: 1 } },
    );
  }

  async setBindingRefreshError(
    workspaceId: string,
    id: string,
    binding: string,
    error: AppBindingRefreshErrorRecord,
  ): Promise<void> {
    await AppProject.updateOne(
      {
        _id: toMongoIdOrMockRaw(id, AppProject),
        ...(workspaceId
          ? { workspaceId: toMongoIdOrMockRaw(workspaceId, AppProject) }
          : {}),
      },
      { $set: { [`bindingRefreshErrors.${binding}`]: error } },
    );
  }

  async clearBindingRefreshError(
    workspaceId: string,
    id: string,
    binding: string,
  ): Promise<void> {
    await AppProject.updateOne(
      {
        _id: toMongoIdOrMockRaw(id, AppProject),
        ...(workspaceId
          ? { workspaceId: toMongoIdOrMockRaw(workspaceId, AppProject) }
          : {}),
        [`bindingRefreshErrors.${binding}`]: { $exists: true },
      },
      { $unset: { [`bindingRefreshErrors.${binding}`]: 1 } },
    );
  }

  async deleteProjectIfPresent(
    workspaceId: string,
    id: string,
  ): Promise<boolean> {
    if (!parseEntityId(id) || !parseEntityId(workspaceId)) return false;
    const res = await AppProject.deleteOne({
      _id: toMongoObjectId(id),
      workspaceId: toMongoObjectId(workspaceId),
    });
    return (res.deletedCount ?? 0) > 0;
  }

  async deleteProject(workspaceId: string, id: string): Promise<void> {
    await this.deleteProjectIfPresent(workspaceId, id);
  }

  async deleteProjectsByWorkspace(workspaceId: string): Promise<number> {
    const res = await AppProject.deleteMany({
      workspaceId: toMongoObjectId(workspaceId),
    });
    return res.deletedCount ?? 0;
  }

  // ── 2. app_index ─────────────────────────────────────────────────────────

  async listIndexEntriesByWorkspace(
    workspaceId: string,
  ): Promise<AppIndexEntryRecord[]> {
    const docs = await AppIndexEntry.find({
      workspaceId: toMongoObjectId(workspaceId),
    }).lean<MongoAppIndexEntryLike[]>();
    return docs.map(mongoAppIndexEntryToRecord);
  }

  async findIndexEntryByAppId(
    appId: string,
    workspaceId?: string,
  ): Promise<AppIndexEntryRecord | null> {
    const filter: Record<string, unknown> = { appId };
    if (workspaceId) filter.workspaceId = toMongoObjectId(workspaceId);
    const doc = await AppIndexEntry.findOne(
      filter,
    ).lean<MongoAppIndexEntryLike | null>();
    return doc ? mongoAppIndexEntryToRecord(doc) : null;
  }

  async indexEntryExistsByAppId(appId: string): Promise<boolean> {
    return (await AppIndexEntry.exists({ appId })) !== null;
  }

  async listIndexEntriesBySlugAndScope(
    slug: string,
    scope: AppAccessScope,
    limit: number,
  ): Promise<Array<{ workspaceId: string; appId: string }>> {
    const docs = await AppIndexEntry.find({ slug, scope })
      .select("workspaceId appId")
      .limit(limit)
      .lean<Array<{ workspaceId: Types.ObjectId; appId: string }>>();
    return docs.map(d => ({
      workspaceId: d.workspaceId.toString(),
      appId: d.appId,
    }));
  }

  async listIndexEntriesWithSchedules(): Promise<
    Array<{
      workspaceId: string;
      appId: string;
      schedules: AppIndexScheduleJson[];
    }>
  > {
    const docs = await AppIndexEntry.find({ "schedules.0": { $exists: true } })
      .select("workspaceId appId schedules")
      .lean<
        Array<{
          workspaceId: Types.ObjectId;
          appId: string;
          schedules: AppIndexScheduleJson[];
        }>
      >();
    return docs.map(d => ({
      workspaceId: d.workspaceId.toString(),
      appId: d.appId,
      schedules: d.schedules ?? [],
    }));
  }

  async listIndexEntriesByAppIds(
    appIds: readonly string[],
  ): Promise<Array<{ workspaceId: string; appId: string; path: string }>> {
    if (appIds.length === 0) return [];
    const docs = await AppIndexEntry.find({ appId: { $in: [...appIds] } })
      .select("appId workspaceId path")
      .lean<
        Array<{ workspaceId: Types.ObjectId; appId: string; path: string }>
      >();
    return docs.map(d => ({
      workspaceId: d.workspaceId.toString(),
      appId: d.appId,
      path: d.path,
    }));
  }

  async listForeignIndexAppIds(
    excludeWorkspaceId: string,
    candidateIds: readonly string[],
  ): Promise<string[]> {
    if (candidateIds.length === 0) return [];
    const docs = await AppIndexEntry.find({
      workspaceId: { $ne: toMongoObjectId(excludeWorkspaceId) },
      appId: { $in: [...candidateIds] },
    })
      .select("appId")
      .lean<Array<{ appId: string }>>();
    return docs.map(d => d.appId);
  }

  async listDistinctWorkspaceIdsWithThumbnails(): Promise<string[]> {
    const ids = await AppIndexEntry.distinct("workspaceId", {
      thumbnail: { $exists: true },
    });
    return ids.map(id => String(id));
  }

  async listDistinctIndexWorkspaceIds(): Promise<string[]> {
    const ids = await AppIndexEntry.distinct("workspaceId");
    return ids.map(id => String(id));
  }

  async replaceWorkspaceIndexEntriesReturningDeletedIds(
    workspaceId: string,
    staleEntryIds: readonly string[],
    entries: readonly UpsertAppIndexEntryInput[],
  ): Promise<string[]> {
    const ws = toMongoObjectId(workspaceId);
    // Keep unique index guarantee matching sync.ts.
    await AppIndexEntry.collection.createIndex({ appId: 1 }, { unique: true });

    let deletedIds: string[] = [];
    const validStaleIds = staleEntryIds.filter(id =>
      Boolean(parseEntityId(id)),
    );
    if (validStaleIds.length > 0) {
      const staleOids = validStaleIds.map(toMongoObjectId);
      const matched = await AppIndexEntry.find({
        workspaceId: ws,
        _id: { $in: staleOids },
      })
        .select("_id")
        .lean<Array<{ _id: Types.ObjectId }>>();
      deletedIds = matched.map(d => d._id.toString());
      if (deletedIds.length > 0) {
        await AppIndexEntry.deleteMany({
          workspaceId: ws,
          _id: { $in: matched.map(d => d._id) },
        });
      }
    }
    if (entries.length > 0) {
      await AppIndexEntry.bulkWrite(
        entries.map(row => ({
          updateOne: {
            filter: { workspaceId: ws, appId: row.appId },
            update: {
              $set: {
                path: row.path,
                slug: row.slug,
                scope: row.scope,
                ownerId: row.ownerId ?? null,
                treeOid: row.treeOid,
                title: row.title,
                description: row.description ?? null,
                hasManifestId: row.hasManifestId,
                duplicateOf: row.duplicateOf ?? null,
                schedules: row.schedules,
                tables: row.tables,
                bindingTables: row.bindingTables ?? [],
                bindings: row.bindings,
                authorEmail: row.authorEmail ?? null,
                firstCommitAt: row.firstCommitAt ?? null,
                thumbnail: row.thumbnail ?? null,
                icon: row.icon ?? null,
                indexedSha: row.indexedSha,
              },
              ...(row.id
                ? { $setOnInsert: { _id: toMongoObjectId(row.id) } }
                : {}),
            },
            upsert: true,
          },
        })),
        { ordered: false },
      );
    }
    return deletedIds;
  }

  async replaceWorkspaceIndexEntries(
    workspaceId: string,
    staleEntryIds: readonly string[],
    entries: readonly UpsertAppIndexEntryInput[],
  ): Promise<void> {
    await this.replaceWorkspaceIndexEntriesReturningDeletedIds(
      workspaceId,
      staleEntryIds,
      entries,
    );
  }

  // ── 3. app_index_heads ───────────────────────────────────────────────────

  async findIndexHeadByWorkspace(
    workspaceId: string,
  ): Promise<AppIndexHeadRecord | null> {
    const doc = await AppIndexHead.findOne({
      workspaceId: toMongoObjectId(workspaceId),
    }).lean<MongoAppIndexHeadLike | null>();
    return doc ? mongoAppIndexHeadToRecord(doc) : null;
  }

  async upsertIndexHead(
    workspaceId: string,
    input: {
      sha: string;
      schemaVersion: number;
      folders: string[];
      id?: string;
    },
  ): Promise<void> {
    await AppIndexHead.updateOne(
      { workspaceId: toMongoObjectId(workspaceId) },
      {
        $set: {
          sha: input.sha,
          schemaVersion: input.schemaVersion,
          folders: input.folders,
        },
        ...(input.id
          ? { $setOnInsert: { _id: toMongoObjectId(input.id) } }
          : {}),
      },
      { upsert: true },
    );
  }

  // ── 4. app_embeddings ────────────────────────────────────────────────────

  async listEmbeddingsMetaByWorkspace(
    workspaceId: string,
  ): Promise<AppEmbeddingMeta[]> {
    const docs = await AppEmbedding.find({
      workspaceId: toMongoObjectId(workspaceId),
    })
      .select("appId path treeOid docHash embeddingModel")
      .lean<AppEmbeddingMeta[]>();
    return docs.map(d => ({
      appId: d.appId,
      path: d.path,
      treeOid: d.treeOid,
      docHash: d.docHash,
      embeddingModel: d.embeddingModel,
    }));
  }

  async listEmbeddingsByWorkspaceAndModel(
    workspaceId: string,
    embeddingModel: string,
  ): Promise<AppEmbeddingVectorEntry[]> {
    const docs = await AppEmbedding.find({
      workspaceId: toMongoObjectId(workspaceId),
      embeddingModel,
    })
      .select("appId vector terms")
      .lean<Array<{ appId: string; vector: number[]; terms?: string[] }>>();
    return docs.map(d => ({
      appId: d.appId,
      vector: [...d.vector],
      ...(d.terms !== undefined ? { terms: [...d.terms] } : {}),
    }));
  }

  async deleteEmbeddingsByAppIdsReturningIds(
    workspaceId: string,
    appIds: readonly string[],
  ): Promise<string[]> {
    if (appIds.length === 0) return [];
    const ws = toMongoObjectId(workspaceId);
    const matched = await AppEmbedding.find({
      workspaceId: ws,
      appId: { $in: [...appIds] },
    })
      .select("_id")
      .lean<Array<{ _id: Types.ObjectId }>>();
    const deletedIds = matched.map(d => d._id.toString());
    if (deletedIds.length > 0) {
      await AppEmbedding.deleteMany({
        workspaceId: ws,
        _id: { $in: matched.map(d => d._id) },
      });
    }
    return deletedIds;
  }

  async deleteEmbeddingsByAppIds(
    workspaceId: string,
    appIds: readonly string[],
  ): Promise<void> {
    await this.deleteEmbeddingsByAppIdsReturningIds(workspaceId, appIds);
  }

  async upsertEmbeddingsBatch(
    workspaceId: string,
    fullUpserts: readonly UpsertAppEmbeddingInput[],
    pathOnlyUpdates: readonly AppEmbeddingPathUpdate[],
  ): Promise<void> {
    const ws = toMongoObjectId(workspaceId);
    const ops = [
      ...fullUpserts.map(r => ({
        updateOne: {
          filter: { workspaceId: ws, appId: r.appId },
          update: {
            $set: {
              path: r.path,
              treeOid: r.treeOid,
              docHash: r.docHash,
              embeddingModel: r.embeddingModel,
              vector: r.vector,
              terms: r.terms,
            },
            ...(r.id ? { $setOnInsert: { _id: toMongoObjectId(r.id) } } : {}),
          },
          upsert: true,
        },
      })),
      ...pathOnlyUpdates.map(r => ({
        updateOne: {
          filter: { workspaceId: ws, appId: r.appId },
          update: { $set: { path: r.path, treeOid: r.treeOid } },
        },
      })),
    ];
    if (ops.length > 0) {
      await AppEmbedding.bulkWrite(ops, { ordered: false });
    }
  }

  // ── 5. app_lifecycle ─────────────────────────────────────────────────────

  async listLifecycleByWorkspace(
    workspaceId: string,
  ): Promise<AppLifecycleRecord[]> {
    const docs = await AppLifecycleState.find({
      workspaceId: toMongoObjectId(workspaceId),
    }).lean<MongoAppLifecycleLike[]>();
    return docs.map(mongoAppLifecycleToRecord);
  }

  async listLifecycleByArchivedTo(
    workspaceId: string,
    archivedToPaths: readonly string[],
  ): Promise<Array<{ archivedTo: string; archivedFrom: string }>> {
    if (archivedToPaths.length === 0) return [];
    const docs = await AppLifecycleState.find({
      workspaceId: toMongoObjectId(workspaceId),
      archivedTo: { $in: [...archivedToPaths] },
    })
      .select("archivedTo archivedFrom")
      .lean<Array<{ archivedTo?: string; archivedFrom?: string }>>();
    return docs
      .filter((d): d is { archivedTo: string; archivedFrom: string } =>
        Boolean(d.archivedTo && d.archivedFrom),
      )
      .map(d => ({ archivedTo: d.archivedTo, archivedFrom: d.archivedFrom }));
  }

  async listVerifiedAppIds(workspaceId: string): Promise<string[]> {
    const ids = await AppLifecycleState.distinct("appId", {
      workspaceId: toMongoObjectId(workspaceId),
      verifiedAt: { $exists: true },
    });
    return ids.map(String);
  }

  async listPausedScheduleEntries(): Promise<
    Array<{ workspaceId: string; appId: string }>
  > {
    const docs = await AppLifecycleState.find({
      schedulesPausedAt: { $exists: true },
    })
      .select("workspaceId appId")
      .lean<Array<{ workspaceId: Types.ObjectId; appId: string }>>();
    return docs.map(d => ({
      workspaceId: d.workspaceId.toString(),
      appId: d.appId,
    }));
  }

  async listPausedScheduleAppIds(): Promise<string[]> {
    const ids = await AppLifecycleState.distinct("appId", {
      schedulesPausedAt: { $exists: true },
    });
    return ids.map(String);
  }

  async clearStaleAndPausedOnOpen(
    workspaceId: string,
    appId: string,
  ): Promise<void> {
    await AppLifecycleState.updateOne(
      {
        workspaceId: toMongoObjectId(workspaceId),
        appId,
        $or: [
          { schedulesPausedAt: { $exists: true } },
          { staleSince: { $exists: true } },
        ],
      },
      { $unset: { schedulesPausedAt: 1, staleSince: 1, staleNotifiedTo: 1 } },
    );
  }

  async markAppRestored(
    workspaceId: string,
    appId: string,
    restoredAt: Date,
    restoredBy?: string,
    id?: string,
  ): Promise<void> {
    await AppLifecycleState.updateOne(
      { workspaceId: toMongoObjectId(workspaceId), appId },
      {
        $set: {
          restoredAt,
          ...(restoredBy ? { restoredBy } : {}),
        },
        $unset: {
          staleSince: 1,
          staleNotifiedTo: 1,
          schedulesPausedAt: 1,
          archivedAt: 1,
          archivedFrom: 1,
          archivedTo: 1,
        },
        ...(id ? { $setOnInsert: { _id: toMongoObjectId(id) } } : {}),
      },
      { upsert: true },
    );
  }

  async upsertLifecyclePatch(
    workspaceId: string,
    appId: string,
    patch: AppLifecyclePatch,
    id?: string,
  ): Promise<void> {
    const update: Record<string, unknown> = {};
    if (patch.set && Object.keys(patch.set).length > 0) {
      update.$set = patch.set;
    }
    if (patch.unset && patch.unset.length > 0) {
      update.$unset = Object.fromEntries(patch.unset.map(k => [k, 1]));
    }
    if (id && patch.set && Object.keys(patch.set).length > 0) {
      update.$setOnInsert = { _id: toMongoObjectId(id) };
    }
    if (Object.keys(update).length === 0) return;
    await AppLifecycleState.updateOne(
      { workspaceId: toMongoObjectId(workspaceId), appId },
      update,
      { upsert: Boolean(patch.set && Object.keys(patch.set).length > 0) },
    );
  }

  // ── 6. app_deploy_commit_statuses ────────────────────────────────────────

  async listPendingCommitStatusesExcludingSha(
    workspaceId: string,
    appId: string,
    excludeSha: string,
  ): Promise<string[]> {
    const docs = await AppDeployCommitStatus.find({
      workspaceId: toMongoObjectId(workspaceId),
      appId,
      state: "pending",
      sha: { $ne: excludeSha },
    })
      .select("sha")
      .lean<Array<{ sha: string }>>();
    return docs.map(d => d.sha);
  }

  async casResolvePendingCommitStatus(
    workspaceId: string,
    appId: string,
    sha: string,
    newState: AppDeployCommitStatePg,
  ): Promise<boolean> {
    const won = await AppDeployCommitStatus.findOneAndUpdate(
      {
        workspaceId: toMongoObjectId(workspaceId),
        appId,
        sha,
        state: "pending",
      },
      { $set: { state: newState } },
    );
    return won !== null;
  }

  async upsertCommitStatus(
    workspaceId: string,
    appId: string,
    sha: string,
    state: AppDeployCommitStatePg,
    id?: string,
  ): Promise<void> {
    await AppDeployCommitStatus.updateOne(
      { workspaceId: toMongoObjectId(workspaceId), appId, sha },
      {
        $set: { state },
        ...(id ? { $setOnInsert: { _id: toMongoObjectId(id) } } : {}),
      },
      { upsert: true },
    );
  }

  // ── 7. app_worktrees ─────────────────────────────────────────────────────

  async findWorktree(
    workspaceId: string,
    actorId: string,
  ): Promise<AppWorktreeRecord | null> {
    const doc = await resolveLean<MongoAppWorktreeLike | null>(
      AppWorktree.findOne({
        workspaceId: toMongoIdOrMockRaw(workspaceId, AppWorktree),
        userId: actorId,
      }),
    );
    return doc ? mongoAppWorktreeToRecord(doc) : null;
  }

  async ensureWorktreeRow(
    workspaceId: string,
    actorId: string,
    defaultBranch: string,
    id?: string,
  ): Promise<AppWorktreeRecord> {
    const doc = await AppWorktree.findOneAndUpdate(
      { workspaceId: toMongoObjectId(workspaceId), userId: actorId },
      {
        $setOnInsert: {
          branch: defaultBranch,
          ...(id ? { _id: toMongoObjectId(id) } : {}),
        },
      },
      { returnDocument: "after", upsert: true },
    ).lean<MongoAppWorktreeLike>();
    return mongoAppWorktreeToRecord(doc);
  }

  async updateWorktreeBranch(
    workspaceId: string,
    actorId: string,
    branch: string,
  ): Promise<void> {
    await AppWorktree.updateOne(
      { workspaceId: toMongoObjectId(workspaceId), userId: actorId },
      { $set: { branch } },
    );
  }

  async bumpWorktreeActivity(
    workspaceId: string,
    actorId: string,
    lastActivityAt: Date,
    activeUntil?: Date,
  ): Promise<void> {
    await AppWorktree.updateOne(
      { workspaceId: toMongoObjectId(workspaceId), userId: actorId },
      {
        $max: {
          lastActivityAt,
          ...(activeUntil ? { activeUntil } : {}),
        },
      },
      { timestamps: false },
    );
  }

  async listWorktreesActivity(
    pairs: ReadonlyArray<{ workspaceId: string; actorId: string }>,
  ): Promise<
    Array<{
      workspaceId: string;
      userId: string;
      lastActivityAt: Date | null;
      activeUntil: Date | null;
    }>
  > {
    if (pairs.length === 0) return [];
    const docs = await AppWorktree.find(
      {
        $or: pairs.map(p => ({
          workspaceId: toMongoObjectId(p.workspaceId),
          userId: p.actorId,
        })),
      },
      { workspaceId: 1, userId: 1, lastActivityAt: 1, activeUntil: 1 },
    ).lean<
      Array<{
        workspaceId: Types.ObjectId;
        userId: string;
        lastActivityAt?: Date;
        activeUntil?: Date;
      }>
    >();
    return docs.map(d => ({
      workspaceId: d.workspaceId.toString(),
      userId: d.userId,
      lastActivityAt: d.lastActivityAt ?? null,
      activeUntil: d.activeUntil ?? null,
    }));
  }

  async getWorktreePauseHistory(
    workspaceId: string,
    actorId: string,
  ): Promise<{
    pausedAt: Date[];
    holdUntil: Date | null;
    holdSetAt: Date | null;
  }> {
    const doc = await AppWorktree.findOne(
      { workspaceId: toMongoObjectId(workspaceId), userId: actorId },
      { idlePausedAt: 1, idlePauseHoldUntil: 1, idlePauseHoldSetAt: 1 },
    ).lean<{
      idlePausedAt?: Date[];
      idlePauseHoldUntil?: Date;
      idlePauseHoldSetAt?: Date;
    } | null>();
    return {
      pausedAt: doc?.idlePausedAt ?? [],
      holdUntil: doc?.idlePauseHoldUntil ?? null,
      holdSetAt: doc?.idlePauseHoldSetAt ?? null,
    };
  }

  async recordWorktreePause(
    workspaceId: string,
    actorId: string,
    at: Date,
  ): Promise<void> {
    await AppWorktree.updateOne(
      { workspaceId: toMongoObjectId(workspaceId), userId: actorId },
      { $push: { idlePausedAt: { $each: [at], $slice: -5 } } },
      { timestamps: false },
    );
  }

  async holdWorktreePausing(
    workspaceId: string,
    actorId: string,
    until: Date,
    setAt: Date,
  ): Promise<void> {
    await AppWorktree.updateOne(
      { workspaceId: toMongoObjectId(workspaceId), userId: actorId },
      { $set: { idlePauseHoldUntil: until, idlePauseHoldSetAt: setAt } },
      { timestamps: false },
    );
  }

  async listHotWorktreeWorkspacesSince(
    since: Date,
  ): Promise<HotWorktreeWorkspaceRecord[]> {
    const rows = await AppWorktree.aggregate<{ _id: unknown; at: Date }>([
      { $match: { updatedAt: { $gte: since } } },
      { $group: { _id: "$workspaceId", at: { $max: "$updatedAt" } } },
    ]);
    return rows.map(r => ({
      workspaceId: String(r._id),
      at: r.at instanceof Date ? r.at : new Date(r.at),
    }));
  }

  // ── 8. app_binding_state ─────────────────────────────────────────────────

  async getBindingState(
    projectId: string,
    name: string,
  ): Promise<AppBindingStateRecord | null> {
    const Model = getMongoAppBindingStateModel();
    const doc = (await Model.findOne({
      projectId: toMongoObjectId(projectId),
      name,
    }).lean()) as MongoAppBindingStateLike | null;
    return doc ? mongoAppBindingStateToRecord(doc) : null;
  }

  async listBindingStatesByProjects(
    _workspaceId: string,
    projectIds: readonly string[],
  ): Promise<BindingStateSummaryRecord[]> {
    const valid = projectIds.filter(id => Boolean(parseEntityId(id)));
    if (valid.length === 0) return [];
    const Model = getMongoAppBindingStateModel();
    const docs = (await Model.find({
      projectId: { $in: valid.map(toMongoObjectId) },
    })
      .select({
        projectId: 1,
        name: 1,
        lastMaterializedAt: 1,
        history: { $slice: 1 },
      })
      .lean()) as unknown as MongoAppBindingStateLike[];
    return docs.map(d => {
      const rec = mongoAppBindingStateToRecord(d);
      return {
        projectId: rec.projectId,
        name: rec.name,
        ...(rec.lastMaterializedAt
          ? { lastMaterializedAt: rec.lastMaterializedAt }
          : {}),
        ...(rec.history ? { history: rec.history } : {}),
      };
    });
  }

  async recordBindingRun(
    projectId: string,
    name: string,
    run: AppBindingRunRecord,
    _workspaceId?: string,
    id?: string,
  ): Promise<void> {
    const Model = getMongoAppBindingStateModel();
    await Model.updateOne(
      { projectId: toMongoObjectId(projectId), name },
      {
        ...(run.status === "ready"
          ? {
              $set: {
                lastMaterializedAt: run.at,
                lastRowCount: run.rowCount ?? 0,
              },
            }
          : {}),
        $push: { history: { $each: [run], $position: 0, $slice: 20 } },
        ...(id ? { $setOnInsert: { _id: toMongoObjectId(id) } } : {}),
      },
      { upsert: true },
    );
  }

  async claimPublicBindingRefresh(
    projectId: string,
    name: string,
    cooldownMs: number,
    now: Date = new Date(),
    _workspaceId?: string,
    id?: string,
  ): Promise<ClaimPublicBindingRefreshResult> {
    const Model = getMongoAppBindingStateModel();
    const filter = { projectId: toMongoObjectId(projectId), name };
    try {
      await Model.updateOne(
        {
          ...filter,
          publicRefreshAt: {
            $not: { $gt: new Date(now.getTime() - cooldownMs) },
          },
        },
        {
          $set: { publicRefreshAt: now },
          ...(id ? { $setOnInsert: { _id: toMongoObjectId(id) } } : {}),
        },
        { upsert: true },
      );
      return { claimed: true };
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
    }
    const existing = (await Model.findOne(filter).lean()) as {
      publicRefreshAt?: Date;
    } | null;
    const last = existing?.publicRefreshAt?.getTime() ?? now.getTime();
    return {
      claimed: false,
      retryAfterMs: Math.max(1000, cooldownMs - (now.getTime() - last)),
    };
  }

  // ── 9. app_binding_drafts ────────────────────────────────────────────────

  async findActiveDraftBuild(
    projectId: string,
    hash: string,
    now: Date,
  ): Promise<AppBindingDraftRecord | null> {
    const Model = getMongoAppBindingDraftModel();
    const doc = (await Model.findOne({
      projectId: toMongoObjectId(projectId),
      hash,
      kind: "build",
      expiresAt: { $gt: now },
    })
      .sort({ builtAt: -1 })
      .lean()) as MongoAppBindingDraftLike | null;
    return doc ? mongoAppBindingDraftToRecord(doc) : null;
  }

  async findDraftFailure(
    projectId: string,
    hash: string,
  ): Promise<AppBindingDraftRecord | null> {
    const Model = getMongoAppBindingDraftModel();
    const doc = (await Model.findOne({
      projectId: toMongoObjectId(projectId),
      hash,
      kind: "failure",
    }).lean()) as MongoAppBindingDraftLike | null;
    return doc ? mongoAppBindingDraftToRecord(doc) : null;
  }

  async createDraftBuild(
    input: CreateBindingDraftBuildInput,
  ): Promise<AppBindingDraftRecord> {
    const Model = getMongoAppBindingDraftModel();
    const created = await Model.create({
      ...(input.id ? { _id: toMongoObjectId(input.id) } : {}),
      projectId: toMongoObjectId(input.projectId),
      hash: input.hash,
      kind: "build",
      name: input.name,
      key: input.key,
      builtAt: input.builtAt,
      rowCount: input.rowCount,
      byteSize: input.byteSize,
      expiresAt: input.expiresAt,
    });
    return mongoAppBindingDraftToRecord(
      created.toObject() as unknown as MongoAppBindingDraftLike,
    );
  }

  async deleteDraftFailuresReturningIds(
    projectId: string,
    hash: string,
  ): Promise<string[]> {
    const Model = getMongoAppBindingDraftModel();
    const filter = {
      projectId: toMongoObjectId(projectId),
      hash,
      kind: "failure" as const,
    };
    const matched = (await Model.find(filter)
      .select("_id")
      .lean()) as unknown as Array<{
      _id: Types.ObjectId;
    }>;
    const deletedIds = matched.map(d => d._id.toString());
    if (deletedIds.length > 0) {
      await Model.deleteMany({ _id: { $in: matched.map(d => d._id) } });
    }
    return deletedIds;
  }

  async deleteDraftFailures(projectId: string, hash: string): Promise<void> {
    await this.deleteDraftFailuresReturningIds(projectId, hash);
  }

  async deleteDraftBuildByKeyReturningId(
    projectId: string,
    key: string,
  ): Promise<string | null> {
    const Model = getMongoAppBindingDraftModel();
    const removed = (await Model.findOneAndDelete({
      projectId: toMongoObjectId(projectId),
      kind: "build",
      key,
    })
      .select("_id")
      .lean()) as { _id: Types.ObjectId } | null;
    return removed ? removed._id.toString() : null;
  }

  async deleteDraftBuildByKey(projectId: string, key: string): Promise<void> {
    await this.deleteDraftBuildByKeyReturningId(projectId, key);
  }

  async upsertDraftFailure(
    input: UpsertBindingDraftFailureInput,
  ): Promise<void> {
    const Model = getMongoAppBindingDraftModel();
    await Model.updateOne(
      {
        projectId: toMongoObjectId(input.projectId),
        hash: input.hash,
        kind: "failure",
      },
      {
        $set: {
          name: input.name,
          failures: input.failures,
          until: input.until,
          error: input.error,
          expiresAt: input.expiresAt,
        },
        ...(input.id
          ? { $setOnInsert: { _id: toMongoObjectId(input.id) } }
          : {}),
      },
      { upsert: true },
    );
  }

  async listExpiredDrafts(
    projectId: string,
    now: Date,
    limit: number,
  ): Promise<Array<{ id: string; key: string | null }>> {
    const Model = getMongoAppBindingDraftModel();
    const docs = (await Model.find({
      projectId: toMongoObjectId(projectId),
      expiresAt: { $lte: now },
    })
      .select("_id key")
      .limit(limit)
      .lean()) as unknown as Array<{
      _id: Types.ObjectId;
      key?: string | null;
    }>;
    return docs.map(d => ({ id: d._id.toString(), key: d.key ?? null }));
  }

  async deleteDraftsByIdsReturningIds(
    projectId: string,
    ids: readonly string[],
  ): Promise<string[]> {
    const valid = ids.filter(id => Boolean(parseEntityId(id)));
    if (valid.length === 0 || !parseEntityId(projectId)) return [];
    const Model = getMongoAppBindingDraftModel();
    const matched = (await Model.find({
      projectId: toMongoObjectId(projectId),
      _id: { $in: valid.map(toMongoObjectId) },
    })
      .select("_id")
      .lean()) as unknown as Array<{ _id: Types.ObjectId }>;
    const deletedIds = matched.map(d => d._id.toString());
    if (deletedIds.length > 0) {
      await Model.deleteMany({
        projectId: toMongoObjectId(projectId),
        _id: { $in: matched.map(d => d._id) },
      });
    }
    return deletedIds;
  }

  async deleteDraftsByIds(
    projectId: string,
    ids: readonly string[],
  ): Promise<void> {
    await this.deleteDraftsByIdsReturningIds(projectId, ids);
  }

  // ── 10. app_binding_jobs ─────────────────────────────────────────────────

  async createBindingJob(
    input: CreateBindingJobInput,
  ): Promise<AppBindingJobRecord> {
    const Model = getMongoAppBindingJobModel();
    const created = await Model.create({
      ...(input.id ? { _id: toMongoObjectId(input.id) } : {}),
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      name: input.name,
      ...(input.kind ? { kind: input.kind } : {}),
      actorId: input.actorId,
      ...(input.userId ? { userId: input.userId } : {}),
      canWrite: input.canWrite,
      ...(input.unregistered !== undefined
        ? { unregistered: input.unregistered }
        : {}),
      request: input.request,
      status: "queued",
      expiresAt: input.expiresAt,
    });
    return mongoAppBindingJobToRecord(
      created.toObject() as unknown as MongoAppBindingJobLike,
    );
  }

  async findBindingJobById(
    jobId: string,
    projectId?: string,
  ): Promise<AppBindingJobRecord | null> {
    if (!parseEntityId(jobId)) return null;
    const Model = getMongoAppBindingJobModel();
    const filter: Record<string, unknown> = { _id: toMongoObjectId(jobId) };
    if (projectId) filter.projectId = projectId;
    const doc = (await Model.findOne(
      filter,
    ).lean()) as MongoAppBindingJobLike | null;
    return doc ? mongoAppBindingJobToRecord(doc) : null;
  }

  async casFailStaleBindingJob(
    jobId: string,
    staleBefore: Date,
    error: string,
    errorStatus: number,
    newExpiresAt: Date,
  ): Promise<AppBindingJobRecord | null> {
    const Model = getMongoAppBindingJobModel();
    const updated = (await Model.findOneAndUpdate(
      {
        _id: toMongoObjectId(jobId),
        status: "running",
        $or: [{ heartbeatAt: { $lte: staleBefore } }, { heartbeatAt: null }],
      },
      {
        $set: {
          status: "error",
          error,
          errorStatus,
          expiresAt: newExpiresAt,
        },
      },
      { returnDocument: "after" },
    ).lean()) as MongoAppBindingJobLike | null;
    return updated ? mongoAppBindingJobToRecord(updated) : null;
  }

  async listStaleRunningBindingJobs(
    staleBefore: Date,
    limit: number,
  ): Promise<
    Array<{
      id: string;
      workspaceId: string;
      projectId: string;
      heartbeatAt: Date | null;
    }>
  > {
    const Model = getMongoAppBindingJobModel();
    const docs = (await Model.find({
      status: "running",
      $or: [{ heartbeatAt: { $lte: staleBefore } }, { heartbeatAt: null }],
    })
      .select("_id workspaceId projectId heartbeatAt")
      .limit(limit)
      .lean()) as unknown as Array<{
      _id: Types.ObjectId;
      workspaceId: string;
      projectId: string;
      heartbeatAt?: Date | null;
    }>;
    return docs.map(d => ({
      id: d._id.toString(),
      workspaceId: String(d.workspaceId),
      projectId: d.projectId,
      heartbeatAt: d.heartbeatAt ?? null,
    }));
  }

  async heartbeatBindingJob(
    jobId: string,
    now: Date,
    newExpiresAt: Date,
  ): Promise<void> {
    const Model = getMongoAppBindingJobModel();
    await Model.updateOne(
      { _id: toMongoObjectId(jobId), status: "running" },
      { $set: { heartbeatAt: now, expiresAt: newExpiresAt } },
    );
  }

  async updateBindingJobProgress(
    jobId: string,
    progress: AppBindingJobProgressRecord,
  ): Promise<void> {
    const Model = getMongoAppBindingJobModel();
    await Model.updateOne(
      { _id: toMongoObjectId(jobId), status: "running" },
      { $set: { progress } },
    );
  }

  async markBindingJob(
    jobId: string,
    update: MarkBindingJobUpdate,
    newExpiresAt: Date,
    heartbeatAt?: Date,
  ): Promise<void> {
    const Model = getMongoAppBindingJobModel();
    await Model.updateOne(
      { _id: toMongoObjectId(jobId) },
      {
        $set: {
          ...update,
          expiresAt: newExpiresAt,
          ...(heartbeatAt ? { heartbeatAt } : {}),
        },
      },
    );
  }

  async listExpiredFinishedBindingJobs(
    projectId: string,
    now: Date,
    limit: number,
  ): Promise<Array<{ id: string; result: AppBindingJobRecord["result"] }>> {
    const Model = getMongoAppBindingJobModel();
    const docs = (await Model.find({
      projectId,
      status: { $in: ["ready", "error"] },
      expiresAt: { $lte: now },
    })
      .select("_id result")
      .limit(limit)
      .lean()) as unknown as Array<{
      _id: Types.ObjectId;
      result?: AppBindingJobRecord["result"];
    }>;
    return docs.map(d => ({ id: d._id.toString(), result: d.result ?? null }));
  }

  async deleteBindingJobsByIdsReturningIds(
    projectId: string,
    ids: readonly string[],
  ): Promise<string[]> {
    const valid = ids.filter(id => Boolean(parseEntityId(id)));
    if (valid.length === 0) return [];
    const Model = getMongoAppBindingJobModel();
    const matched = (await Model.find({
      projectId,
      _id: { $in: valid.map(toMongoObjectId) },
    })
      .select("_id")
      .lean()) as unknown as Array<{ _id: Types.ObjectId }>;
    const deletedIds = matched.map(d => d._id.toString());
    if (deletedIds.length > 0) {
      await Model.deleteMany({
        projectId,
        _id: { $in: matched.map(d => d._id) },
      });
    }
    return deletedIds;
  }

  async deleteBindingJobsByIds(
    projectId: string,
    ids: readonly string[],
  ): Promise<void> {
    await this.deleteBindingJobsByIdsReturningIds(projectId, ids);
  }
}

export {
  mongoAppBindingDraftToRecord,
  mongoAppBindingJobToRecord,
  mongoAppBindingStateToRecord,
  mongoAppDeployCommitStatusToRecord,
  mongoAppEmbeddingToRecord,
  mongoAppIndexEntryToRecord,
  mongoAppIndexHeadToRecord,
  mongoAppLifecycleToRecord,
  mongoAppProjectToRecord,
  mongoAppWorktreeToRecord,
};
