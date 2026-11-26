/**
 * MongoDB (Mongoose) implementation of `WorkspaceRepository` for all 10 tables
 * of the Phase 1B `workspaces_core` + `github_installations` domain.
 *
 * Cross-domain boundaries:
 *   - User joins (`listMembersWithUsers`, `findPendingInviteByToken`,
 *     `listPendingInvitesForWorkspace`, `listPendingInvitesForEmail`, `addMember`,
 *     `updateMemberRole`) resolve emails via `authRepo.findUsersByIds` rather than
 *     Mongoose `.populate("userId")` so `workspaces_core` stays coherent even
 *     after Phase 1A (`auth`) cuts over to `pg_only`.
 *   - `Session.updateMany` is intentionally NOT inside `createWorkspaceWithOwner`
 *     or `getOrCreateDefaultWorkspaceAttempt`; `workspace.service.ts` updates
 *     sessions through `authRepo.setActiveWorkspaceForUser`.
 */
import { Types, type ClientSession } from "mongoose";
import { AcpPlanGrant } from "../../database/acp-plan-grant-schema";
import {
  McpOAuthClient,
  McpOAuthCode,
  McpOAuthToken,
} from "../../database/mcp-oauth-schema";
import { newDualId } from "../../database/pg/id-codec";
import {
  GitHubInstallation,
  Workspace,
  WorkspaceInvite,
  WorkspaceMember,
  WorkspaceUserHandle,
} from "../../database/workspace-schema";
import { normalizeEmail } from "../../utils/email.utils";
import { authRepo } from "../auth";
import {
  isEntityId,
  mongoAcpGrantToRecord,
  mongoApiKeyToRecord,
  mongoGitHubInstallationToRecord,
  mongoHandleToRecord,
  mongoInviteToRecord,
  mongoMcpClientToRecord,
  mongoMcpCodeToRecord,
  mongoMcpTokenToRecord,
  mongoMemberToRecord,
  mongoWorkspaceToRecord,
  toWire,
  toWireOrRaw,
  type MongoAcpGrantLike,
  type MongoApiKeyLike,
  type MongoGitHubInstallationLike,
  type MongoHandleLike,
  type MongoInviteLike,
  type MongoMcpClientLike,
  type MongoMcpCodeLike,
  type MongoMcpTokenLike,
  type MongoMemberLike,
  type MongoWorkspaceLike,
} from "./mapper";
import {
  WorkspaceSlugConflictError,
  type AcpPlanGrantRecord,
  type AddMemberInput,
  type CreateApiKeyInput,
  type CreateInviteInput,
  type CreateMcpClientInput,
  type CreateMcpCodeInput,
  type CreateMcpTokenInput,
  type CreateWorkspaceWithOwnerInput,
  type GitHubInstallationRecord,
  type McpConnectionSummary,
  type McpOAuthClientRecord,
  type McpOAuthCodeRecord,
  type McpOAuthTokenRecord,
  type RotateMcpRefreshTokenInput,
  type UpdateBillingPatch,
  type UpdateWorkspacePatch,
  type UpsertAcpGrantInput,
  type UpsertGitHubInstallationInput,
  type WorkspaceApiKeyRecord,
  type WorkspaceApiKeyScope,
  type WorkspaceAutoJoin,
  type WorkspaceInviteRecord,
  type WorkspaceInviteWithRefs,
  type WorkspaceMemberRecord,
  type WorkspaceMemberRole,
  type WorkspaceMemberWithUser,
  type WorkspaceRecord,
  type WorkspaceRepoBinding,
  type WorkspaceRepository,
  type WorkspaceUserHandleRecord,
} from "./types";

const DEFAULT_LAST_USED_MIN_INTERVAL_MS = 60_000;

function oid(id: string): Types.ObjectId {
  return new Types.ObjectId(toWire(id));
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getMongoErrorCode(err: unknown): number | undefined {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "number" ? code : undefined;
  }
  return undefined;
}

function isMongoDupKey(err: unknown): boolean {
  return getMongoErrorCode(err) === 11000;
}

function isMongoDupSlug(err: unknown): boolean {
  if (!isMongoDupKey(err)) {
    return false;
  }
  const keyPattern = (err as { keyPattern?: Record<string, unknown> })
    .keyPattern;
  if (keyPattern && "slug" in keyPattern) {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("slug");
}

function isMongoDupDefaultMember(err: unknown): boolean {
  if (!isMongoDupKey(err)) {
    return false;
  }
  const keyPattern = (err as { keyPattern?: Record<string, unknown> })
    .keyPattern;
  if (keyPattern && "userId" in keyPattern) {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("userId") || message.includes("isDefaultMembership");
}

function isTransactionsUnsupportedError(err: unknown): boolean {
  const code = getMongoErrorCode(err);
  if (code === 20 || code === 251) {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes("Transaction numbers are only allowed on a replica set") ||
    message.includes("does not support retryable writes") ||
    message.includes("Standalone servers do not support transactions")
  );
}

function isStandaloneMongoTopology(): boolean {
  try {
    const client = Workspace.db.getClient() as unknown as {
      topology?: { description?: { type?: string } };
    };
    return client?.topology?.description?.type === "Single";
  } catch {
    return false;
  }
}

async function runInMongoTransaction<T>(
  work: (session: ClientSession | undefined) => Promise<T>,
): Promise<T> {
  if (isStandaloneMongoTopology()) {
    return work(undefined);
  }
  const session = await Workspace.db.startSession();
  try {
    session.startTransaction();
    try {
      const result = await work(session);
      await session.commitTransaction();
      return result;
    } catch (error) {
      await session.abortTransaction().catch(() => undefined);
      if (isTransactionsUnsupportedError(error)) {
        return work(undefined);
      }
      throw error;
    }
  } finally {
    await session.endSession();
  }
}

async function loadUserEmailMap(
  userIds: readonly string[],
): Promise<Map<string, { id: string; email: string }>> {
  const unique = [...new Set(userIds.filter(Boolean))];
  const out = new Map<string, { id: string; email: string }>();
  if (unique.length === 0) {
    return out;
  }
  const found = await authRepo.findUsersByIds(unique);
  for (const u of found) {
    const summary = { id: u.id, email: u.email };
    out.set(u.id, summary);
    out.set(u.id.toLowerCase(), summary);
    if (u.legacyId) {
      out.set(u.legacyId, summary);
    }
  }
  return out;
}

async function loadWorkspaceNameMap(
  workspaceIds: readonly string[],
): Promise<Map<string, { id: string; name: string }>> {
  const unique = [...new Set(workspaceIds.filter(isEntityId))];
  const out = new Map<string, { id: string; name: string }>();
  if (unique.length === 0) {
    return out;
  }
  const docs = await Workspace.find({ _id: { $in: unique.map(oid) } })
    .select("_id name")
    .lean<Array<{ _id: Types.ObjectId; name?: string }>>();
  for (const doc of docs) {
    const id = toWire(doc._id);
    out.set(id, { id, name: doc.name ?? "" });
  }
  return out;
}

export class MongoWorkspaceRepository implements WorkspaceRepository {
  // ── 1. Workspaces ────────────────────────────────────────────────────

  async findById(workspaceId: string): Promise<WorkspaceRecord | null> {
    if (!isEntityId(workspaceId)) {
      return null;
    }
    const doc = await Workspace.findById(
      oid(workspaceId),
    ).lean<MongoWorkspaceLike | null>();
    return doc ? mongoWorkspaceToRecord(doc) : null;
  }

  async findByIds(workspaceIds: readonly string[]): Promise<WorkspaceRecord[]> {
    const valid = [...new Set(workspaceIds.filter(isEntityId))];
    if (valid.length === 0) {
      return [];
    }
    const docs = await Workspace.find({ _id: { $in: valid.map(oid) } }).lean<
      MongoWorkspaceLike[]
    >();
    return docs.map(mongoWorkspaceToRecord);
  }

  async findBySlug(slug: string): Promise<WorkspaceRecord | null> {
    const normalized = slug.trim().toLowerCase();
    if (!normalized) {
      return null;
    }
    const doc = await Workspace.findOne({
      slug: normalized,
    }).lean<MongoWorkspaceLike | null>();
    return doc ? mongoWorkspaceToRecord(doc) : null;
  }

  async findByStripeCustomerId(
    stripeCustomerId: string,
  ): Promise<WorkspaceRecord | null> {
    if (!stripeCustomerId) {
      return null;
    }
    const doc = await Workspace.findOne({
      "billing.stripeCustomerId": stripeCustomerId,
    }).lean<MongoWorkspaceLike | null>();
    return doc ? mongoWorkspaceToRecord(doc) : null;
  }

  async listPaidActiveBilling(): Promise<WorkspaceRecord[]> {
    const docs = await Workspace.find({
      "billing.plan": { $in: ["pro", "enterprise"] },
      "billing.stripeCustomerId": { $ne: null },
      "billing.stripeSubscriptionId": { $ne: null },
      "billing.subscriptionStatus": "active",
    }).lean<MongoWorkspaceLike[]>();
    return docs.map(mongoWorkspaceToRecord);
  }

  async listIdsWithDeployedWorkflows(): Promise<string[]> {
    const docs = await Workspace.find({ "workflows.live": { $exists: true } })
      .select("_id")
      .lean<Array<{ _id: Types.ObjectId }>>();
    return docs.map(d => toWire(d._id));
  }

  async listWithHatchetToken(workspaceId?: string): Promise<WorkspaceRecord[]> {
    if (workspaceId && !isEntityId(workspaceId)) {
      return [];
    }
    const docs = await Workspace.find({
      "workflows.hatchetToken": { $exists: true, $ne: null },
      ...(workspaceId ? { _id: oid(workspaceId) } : {}),
    }).lean<MongoWorkspaceLike[]>();
    return docs.map(mongoWorkspaceToRecord);
  }

  async findOtherWorkspaceWithHatchetToken(
    excludeWorkspaceId: string,
  ): Promise<{ id: string; slug: string } | null> {
    const filter: Record<string, unknown> = {
      "workflows.hatchetToken": { $exists: true, $ne: null },
    };
    if (isEntityId(excludeWorkspaceId)) {
      filter._id = { $ne: oid(excludeWorkspaceId) };
    }
    const doc = await Workspace.findOne(filter)
      .select("_id slug")
      .lean<{ _id: Types.ObjectId; slug?: string } | null>();
    return doc ? { id: toWire(doc._id), slug: doc.slug ?? "" } : null;
  }

  async findWorkspaceIdsByRepoBinding(
    owner: string,
    repo: string,
  ): Promise<string[]> {
    const docs = await Workspace.find({
      $or: [
        { workspaceRepos: { $elemMatch: { owner, repo } } },
        { "appsRepo.owner": owner, "appsRepo.repo": repo },
      ],
    })
      .select("_id")
      .lean<Array<{ _id: Types.ObjectId }>>();
    return docs.map(d => toWire(d._id));
  }

  async createWorkspaceWithOwner(
    input: CreateWorkspaceWithOwnerInput,
  ): Promise<{ workspace: WorkspaceRecord; member: WorkspaceMemberRecord }> {
    const wsId = input.workspaceId
      ? oid(input.workspaceId)
      : new Types.ObjectId(newDualId().oid);
    const memberId = input.memberId
      ? oid(input.memberId)
      : new Types.ObjectId(newDualId().oid);
    const now = new Date();
    const slug = input.slug.trim().toLowerCase();

    try {
      return await runInMongoTransaction(async session => {
        const wsDoc = new Workspace({
          _id: wsId,
          name: input.name,
          slug,
          createdBy: input.userId,
          settings: {
            maxDatabases: input.settings?.maxDatabases ?? 5,
            maxMembers: input.settings?.maxMembers ?? 10,
            billingTier: input.settings?.billingTier ?? "free",
            ...(input.settings?.disabledModelIds
              ? { disabledModelIds: input.settings.disabledModelIds }
              : {}),
            ...(input.settings?.autoJoin
              ? { autoJoin: input.settings.autoJoin }
              : {}),
            ...(input.settings?.linkPreviews !== undefined
              ? { linkPreviews: input.settings.linkPreviews }
              : {}),
          },
        });
        await wsDoc.save(session ? { session } : undefined);

        const memberDoc = new WorkspaceMember({
          _id: memberId,
          workspaceId: wsId,
          userId: input.userId,
          role: "owner",
          joinedAt: now,
          ...(input.isDefaultMembership ? { isDefaultMembership: true } : {}),
        });
        await memberDoc.save(session ? { session } : undefined);

        return {
          workspace: mongoWorkspaceToRecord(
            wsDoc.toObject() as unknown as MongoWorkspaceLike,
          ),
          member: mongoMemberToRecord(
            memberDoc.toObject() as unknown as MongoMemberLike,
          ),
        };
      });
    } catch (error) {
      if (isMongoDupSlug(error)) {
        throw new WorkspaceSlugConflictError(slug, { cause: error });
      }
      throw error;
    }
  }

  async getOrCreateDefaultWorkspaceAttempt(input: {
    userId: string;
    name: string;
    slug: string;
  }): Promise<{
    workspace: WorkspaceRecord;
    member: WorkspaceMemberRecord;
    created: boolean;
  }> {
    const existingMember = await WorkspaceMember.findOne({
      userId: input.userId,
    }).lean<MongoMemberLike | null>();
    if (existingMember) {
      const ws = await Workspace.findById(
        existingMember.workspaceId,
      ).lean<MongoWorkspaceLike | null>();
      if (ws) {
        return {
          workspace: mongoWorkspaceToRecord(ws),
          member: mongoMemberToRecord(existingMember),
          created: false,
        };
      }
      await WorkspaceMember.deleteOne({ _id: oid(toWire(existingMember._id)) });
    }

    try {
      const { workspace, member } = await this.createWorkspaceWithOwner({
        name: input.name,
        slug: input.slug,
        userId: input.userId,
        isDefaultMembership: true,
      });
      return { workspace, member, created: true };
    } catch (error) {
      if (isMongoDupDefaultMember(error)) {
        const winningMember =
          (await WorkspaceMember.findOne({
            userId: input.userId,
            isDefaultMembership: true,
          }).lean<MongoMemberLike | null>()) ??
          (await WorkspaceMember.findOne({
            userId: input.userId,
          }).lean<MongoMemberLike | null>());
        if (winningMember) {
          const winningWorkspace = await Workspace.findById(
            winningMember.workspaceId,
          ).lean<MongoWorkspaceLike | null>();
          if (winningWorkspace) {
            return {
              workspace: mongoWorkspaceToRecord(winningWorkspace),
              member: mongoMemberToRecord(winningMember),
              created: false,
            };
          }
        }
        throw new Error(
          "Failed to get or create workspace after concurrent request",
          { cause: error },
        );
      }
      throw error;
    }
  }

  async deleteWorkspaceCascade(workspaceId: string): Promise<boolean> {
    if (!isEntityId(workspaceId)) {
      return false;
    }
    const wsOid = oid(workspaceId);
    return runInMongoTransaction(async session => {
      const opts = session ? { session } : undefined;
      const res = await Workspace.deleteOne({ _id: wsOid }, opts);
      await WorkspaceMember.deleteMany({ workspaceId: wsOid }, opts);
      await WorkspaceInvite.deleteMany({ workspaceId: wsOid }, opts);
      return (res.deletedCount ?? 0) > 0;
    });
  }

  async updateWorkspace(
    workspaceId: string,
    patch: UpdateWorkspacePatch,
  ): Promise<WorkspaceRecord | null> {
    if (!isEntityId(workspaceId)) {
      return null;
    }
    const set: Record<string, unknown> = {};
    const unset: Record<string, ""> = {};
    if (patch.name !== undefined) {
      set.name = patch.name;
    }
    if (patch.settings) {
      const s = patch.settings;
      if (s.maxDatabases !== undefined) {
        set["settings.maxDatabases"] = s.maxDatabases;
      }
      if (s.maxMembers !== undefined) {
        set["settings.maxMembers"] = s.maxMembers;
      }
      if (s.billingTier !== undefined) {
        set["settings.billingTier"] = s.billingTier;
      }
      if (s.disabledModelIds !== undefined) {
        set["settings.disabledModelIds"] = s.disabledModelIds;
      }
      if (s.autoJoin !== undefined) {
        if (s.autoJoin === null) {
          unset["settings.autoJoin"] = "";
        } else {
          set["settings.autoJoin"] = s.autoJoin;
        }
      }
      if (s.linkPreviews !== undefined) {
        if (s.linkPreviews === null) {
          unset["settings.linkPreviews"] = "";
        } else {
          set["settings.linkPreviews"] = s.linkPreviews;
        }
      }
    }
    const update: Record<string, unknown> = {};
    if (Object.keys(set).length > 0) {
      update.$set = set;
    }
    if (Object.keys(unset).length > 0) {
      update.$unset = unset;
    }
    if (Object.keys(update).length === 0) {
      return this.findById(workspaceId);
    }
    const doc = await Workspace.findByIdAndUpdate(oid(workspaceId), update, {
      returnDocument: "after",
    }).lean<MongoWorkspaceLike | null>();
    return doc ? mongoWorkspaceToRecord(doc) : null;
  }

  async setAutoJoin(
    workspaceId: string,
    autoJoin: WorkspaceAutoJoin | null,
  ): Promise<void> {
    if (!isEntityId(workspaceId)) {
      return;
    }
    await Workspace.updateOne(
      { _id: oid(workspaceId) },
      autoJoin
        ? { $set: { "settings.autoJoin": autoJoin } }
        : { $unset: { "settings.autoJoin": 1 } },
      { runValidators: true },
    );
  }

  async setLinkPreviews(workspaceId: string, enabled: boolean): Promise<void> {
    if (!isEntityId(workspaceId)) {
      return;
    }
    await Workspace.updateOne(
      { _id: oid(workspaceId) },
      { $set: { "settings.linkPreviews": enabled } },
    );
  }

  async setDisabledModelIds(
    workspaceId: string,
    disabledModelIds: string[],
  ): Promise<WorkspaceRecord | null> {
    if (!isEntityId(workspaceId)) {
      return null;
    }
    const doc = await Workspace.findByIdAndUpdate(
      oid(workspaceId),
      { $set: { "settings.disabledModelIds": disabledModelIds } },
      { returnDocument: "after" },
    ).lean<MongoWorkspaceLike | null>();
    return doc ? mongoWorkspaceToRecord(doc) : null;
  }

  async unsetLegacyCustomPrompt(
    workspaceId: string,
    options: { includeSelfDirective?: boolean } = {},
  ): Promise<void> {
    if (!isEntityId(workspaceId)) {
      return;
    }
    const unset: Record<string, ""> = { "settings.customPrompt": "" };
    if (options.includeSelfDirective) {
      unset.selfDirective = "";
    }
    await Workspace.updateOne({ _id: oid(workspaceId) }, { $unset: unset });
  }

  // ── Billing ──────────────────────────────────────────────────────────

  async updateBilling(
    workspaceId: string,
    patch: UpdateBillingPatch,
  ): Promise<WorkspaceRecord | null> {
    if (!isEntityId(workspaceId)) {
      return null;
    }
    const set: Record<string, unknown> = {};
    if (patch.stripeCustomerId !== undefined) {
      set["billing.stripeCustomerId"] = patch.stripeCustomerId;
    }
    if (patch.stripeSubscriptionId !== undefined) {
      set["billing.stripeSubscriptionId"] = patch.stripeSubscriptionId;
    }
    if (patch.subscriptionStatus !== undefined) {
      set["billing.subscriptionStatus"] = patch.subscriptionStatus;
    }
    if (patch.currentPeriodStart !== undefined) {
      set["billing.currentPeriodStart"] = patch.currentPeriodStart;
    }
    if (patch.currentPeriodEnd !== undefined) {
      set["billing.currentPeriodEnd"] = patch.currentPeriodEnd;
    }
    if (patch.usageQuotaUsd !== undefined) {
      set["billing.usageQuotaUsd"] = patch.usageQuotaUsd;
    }
    if (patch.hardLimitUsd !== undefined) {
      set["billing.hardLimitUsd"] = patch.hardLimitUsd;
    }
    if (patch.plan !== undefined) {
      set["billing.plan"] = patch.plan;
    }
    if (patch.lastReportedOverageCents !== undefined) {
      set["billing.lastReportedOverageCents"] = patch.lastReportedOverageCents;
    }
    if (patch.pendingReportedOverageCents !== undefined) {
      set["billing.pendingReportedOverageCents"] =
        patch.pendingReportedOverageCents;
    }
    if (patch.pendingMeterEventIdempotencyKey !== undefined) {
      set["billing.pendingMeterEventIdempotencyKey"] =
        patch.pendingMeterEventIdempotencyKey;
    }
    if (patch.settingsBillingTier !== undefined) {
      set["settings.billingTier"] = patch.settingsBillingTier;
    }
    if (Object.keys(set).length === 0) {
      return this.findById(workspaceId);
    }
    const doc = await Workspace.findByIdAndUpdate(
      oid(workspaceId),
      { $set: set },
      { returnDocument: "after" },
    ).lean<MongoWorkspaceLike | null>();
    return doc ? mongoWorkspaceToRecord(doc) : null;
  }

  async claimStripeCustomerIdIfUnset(
    workspaceId: string,
    stripeCustomerId: string,
  ): Promise<boolean> {
    if (!isEntityId(workspaceId)) {
      return false;
    }
    const updated = await Workspace.findOneAndUpdate(
      {
        _id: oid(workspaceId),
        $or: [
          { "billing.stripeCustomerId": null },
          { "billing.stripeCustomerId": { $exists: false } },
        ],
      },
      { $set: { "billing.stripeCustomerId": stripeCustomerId } },
      { returnDocument: "after" },
    ).lean();
    return Boolean(updated);
  }

  async markStripeCustomerPastDue(
    stripeCustomerId: string,
  ): Promise<string | null> {
    const updated = await Workspace.findOneAndUpdate(
      { "billing.stripeCustomerId": stripeCustomerId },
      { $set: { "billing.subscriptionStatus": "past_due" } },
      { returnDocument: "after" },
    )
      .select("_id")
      .lean<{ _id: Types.ObjectId } | null>();
    return updated ? toWire(updated._id) : null;
  }

  async claimPendingOverage(
    workspaceId: string,
    expectedLastCents: number,
    targetCents: number,
    idempotencyKey: string,
  ): Promise<boolean> {
    if (!isEntityId(workspaceId)) {
      return false;
    }
    const res = await Workspace.updateOne(
      {
        _id: oid(workspaceId),
        "billing.lastReportedOverageCents": expectedLastCents,
        $or: [
          { "billing.pendingReportedOverageCents": null },
          { "billing.pendingReportedOverageCents": { $exists: false } },
        ],
      },
      {
        $set: {
          "billing.pendingReportedOverageCents": targetCents,
          "billing.pendingMeterEventIdempotencyKey": idempotencyKey,
        },
      },
    );
    return res.modifiedCount === 1;
  }

  async commitPendingOverage(
    workspaceId: string,
    targetCents: number,
    idempotencyKey: string,
  ): Promise<boolean> {
    if (!isEntityId(workspaceId)) {
      return false;
    }
    const res = await Workspace.updateOne(
      {
        _id: oid(workspaceId),
        "billing.pendingReportedOverageCents": targetCents,
        "billing.pendingMeterEventIdempotencyKey": idempotencyKey,
      },
      {
        $set: { "billing.lastReportedOverageCents": targetCents },
        $unset: {
          "billing.pendingReportedOverageCents": "",
          "billing.pendingMeterEventIdempotencyKey": "",
        },
      },
    );
    return res.modifiedCount === 1;
  }

  // ── Workspace repos ──────────────────────────────────────────────────

  async setWorkspaceRepos(
    workspaceId: string,
    repos: WorkspaceRepoBinding[] | null,
  ): Promise<WorkspaceRecord | null> {
    if (!isEntityId(workspaceId)) {
      return null;
    }
    const update =
      repos === null
        ? { $unset: { workspaceRepos: "", appsRepo: "" } }
        : { $set: { workspaceRepos: repos }, $unset: { appsRepo: "" } };
    const doc = await Workspace.findByIdAndUpdate(oid(workspaceId), update, {
      returnDocument: "after",
    }).lean<MongoWorkspaceLike | null>();
    return doc ? mongoWorkspaceToRecord(doc) : null;
  }

  async upsertTestWorkspaceWithRepo(
    workspaceId: string,
    repo: WorkspaceRepoBinding,
  ): Promise<void> {
    const id = oid(workspaceId);
    const wire = toWire(id);
    await Workspace.findOneAndUpdate(
      { _id: id },
      {
        $setOnInsert: {
          name: "test-ws",
          slug: `test-${wire}`,
          createdBy: "test",
          settings: {},
          billing: {},
        },
        $set: { workspaceRepos: [repo] },
      },
      { upsert: true },
    );
  }

  // ── Workflows ────────────────────────────────────────────────────────

  async setWorkflowHatchetToken(
    workspaceId: string,
    encryptedToken: string | null,
  ): Promise<void> {
    if (!isEntityId(workspaceId)) {
      return;
    }
    await Workspace.updateOne(
      { _id: oid(workspaceId) },
      encryptedToken !== null
        ? { $set: { "workflows.hatchetToken": encryptedToken } }
        : { $unset: { "workflows.hatchetToken": "" } },
    );
  }

  async setWorkflowLiveTarget(
    workspaceId: string,
    target: { sha: string; tree: string; names: string[] } | null,
  ): Promise<void> {
    if (!isEntityId(workspaceId)) {
      return;
    }
    await Workspace.updateOne(
      { _id: oid(workspaceId) },
      target
        ? {
            $set: {
              "workflows.live.sha": target.sha,
              "workflows.live.tree": target.tree,
              "workflows.live.names": target.names,
            },
          }
        : { $unset: { "workflows.live": "" } },
    );
  }

  async reportWorkflowLiveStatus(
    workspaceId: string,
    sha: string,
    error?: string,
  ): Promise<boolean> {
    if (!isEntityId(workspaceId)) {
      return false;
    }
    const res = await Workspace.updateOne(
      { _id: oid(workspaceId), "workflows.live.sha": sha },
      typeof error === "string"
        ? { $set: { "workflows.live.failed": { sha, error } } }
        : {
            $set: { "workflows.live.running": { sha } },
            $unset: { "workflows.live.failed": "" },
          },
    );
    return res.matchedCount > 0;
  }

  async setWorkflowTrigger(
    workspaceId: string,
    name: string,
    change: { active?: boolean; encryptedWebhookSecret?: string | null },
  ): Promise<void> {
    if (!isEntityId(workspaceId)) {
      return;
    }
    const path = `workflows.webhooks.${name}`;
    const update: Record<string, unknown> = {};
    if (change.active === true) {
      update.$addToSet = { "workflows.active": name };
    } else if (change.active === false) {
      update.$pull = { "workflows.active": name };
    }
    if (typeof change.encryptedWebhookSecret === "string") {
      update.$set = { [path]: change.encryptedWebhookSecret };
    } else if (change.encryptedWebhookSecret === null) {
      update.$unset = { [path]: "" };
    }
    if (Object.keys(update).length > 0) {
      await Workspace.updateOne({ _id: oid(workspaceId) }, update);
    }
  }

  async touchWorkflowLastNeededAt(
    workspaceId: string,
    at: Date = new Date(),
  ): Promise<void> {
    if (!isEntityId(workspaceId)) {
      return;
    }
    await Workspace.updateOne(
      { _id: oid(workspaceId) },
      { $set: { "workflows.lastNeededAt": at } },
    );
  }

  // ── 2. Workspace API keys ────────────────────────────────────────────

  async findApiKeyByHash(
    keyHash: string,
  ): Promise<{
    workspace: WorkspaceRecord;
    apiKey: WorkspaceApiKeyRecord;
  } | null> {
    if (!keyHash) {
      return null;
    }
    const doc = await Workspace.findOne({
      "apiKeys.keyHash": keyHash,
    }).lean<MongoWorkspaceLike | null>();
    if (!doc) {
      return null;
    }
    const rawKey = (doc.apiKeys ?? []).find(k => k.keyHash === keyHash);
    if (!rawKey) {
      return null;
    }
    const workspace = mongoWorkspaceToRecord(doc);
    return { workspace, apiKey: mongoApiKeyToRecord(workspace.id, rawKey) };
  }

  async listApiKeys(workspaceId: string): Promise<WorkspaceApiKeyRecord[]> {
    if (!isEntityId(workspaceId)) {
      return [];
    }
    const doc = await Workspace.findById(oid(workspaceId))
      .select("_id apiKeys")
      .lean<{ _id: Types.ObjectId; apiKeys?: MongoApiKeyLike[] } | null>();
    if (!doc) {
      return [];
    }
    const wsId = toWire(doc._id);
    return (doc.apiKeys ?? []).map(k => mongoApiKeyToRecord(wsId, k));
  }

  async createApiKey(input: CreateApiKeyInput): Promise<WorkspaceApiKeyRecord> {
    const keyOid = input.id
      ? oid(input.id)
      : new Types.ObjectId(newDualId().oid);
    const createdAt = input.createdAt ?? new Date();
    const subdoc: Record<string, unknown> = {
      _id: keyOid,
      name: input.name.trim(),
      keyHash: input.keyHash,
      prefix: input.prefix,
      createdAt,
      createdBy: input.createdBy,
    };
    if (input.scopes !== undefined) {
      subdoc.scopes = input.scopes;
    }
    if (input.agentRun !== undefined) {
      subdoc.agentRun = input.agentRun;
    }
    if (input.recordWrites !== undefined) {
      subdoc.recordWrites = input.recordWrites;
    }
    await Workspace.updateOne(
      { _id: oid(input.workspaceId) },
      { $push: { apiKeys: subdoc } },
      { timestamps: false },
    );
    return mongoApiKeyToRecord(
      input.workspaceId,
      subdoc as unknown as MongoApiKeyLike,
    );
  }

  async replaceApiKeyByName(
    input: CreateApiKeyInput,
  ): Promise<WorkspaceApiKeyRecord> {
    const wsOid = oid(input.workspaceId);
    await Workspace.updateOne(
      { _id: wsOid },
      { $pull: { apiKeys: { name: input.name } } },
      { timestamps: false },
    );
    return this.createApiKey(input);
  }

  async updateApiKeyScopesByName(
    workspaceId: string,
    name: string,
    scopes: WorkspaceApiKeyScope[],
  ): Promise<boolean> {
    if (!isEntityId(workspaceId)) {
      return false;
    }
    const res = await Workspace.updateOne(
      { _id: oid(workspaceId), "apiKeys.name": name },
      { $set: { "apiKeys.$.scopes": scopes } },
      { timestamps: false },
    );
    return res.matchedCount > 0;
  }

  async deleteApiKey(workspaceId: string, keyId: string): Promise<boolean> {
    if (!isEntityId(workspaceId) || !isEntityId(keyId)) {
      return false;
    }
    const res = await Workspace.updateOne(
      { _id: oid(workspaceId) },
      { $pull: { apiKeys: { _id: oid(keyId) } } },
      { timestamps: false },
    );
    return res.modifiedCount > 0;
  }

  async deleteApiKeysByName(
    workspaceId: string,
    name: string,
  ): Promise<number> {
    if (!isEntityId(workspaceId)) {
      return 0;
    }
    const res = await Workspace.updateOne(
      { _id: oid(workspaceId) },
      { $pull: { apiKeys: { name } } },
      { timestamps: false },
    );
    return res.modifiedCount;
  }

  async deleteApiKeysByCreator(
    workspaceId: string,
    createdBy: string,
  ): Promise<number> {
    if (!isEntityId(workspaceId)) {
      return 0;
    }
    const res = await Workspace.updateOne(
      { _id: oid(workspaceId) },
      { $pull: { apiKeys: { createdBy } } },
      { timestamps: false },
    );
    return res.modifiedCount;
  }

  async pruneExpiredApiKeysByNamePrefix(
    workspaceId: string,
    namePrefix: string,
    createdBefore: Date,
  ): Promise<number> {
    if (!isEntityId(workspaceId)) {
      return 0;
    }
    const res = await Workspace.updateOne(
      { _id: oid(workspaceId) },
      {
        $pull: {
          apiKeys: {
            name: { $regex: `^${escapeRegex(namePrefix)}` },
            createdAt: { $lt: createdBefore },
          },
        },
      },
      { timestamps: false },
    );
    return res.modifiedCount;
  }

  async touchApiKeyLastUsed(
    workspaceId: string,
    keyId: string,
    now: Date = new Date(),
    minIntervalMs: number = DEFAULT_LAST_USED_MIN_INTERVAL_MS,
  ): Promise<void> {
    if (!isEntityId(workspaceId) || !isEntityId(keyId)) {
      return;
    }
    const cutoff = new Date(now.getTime() - minIntervalMs);
    await Workspace.updateOne(
      {
        _id: oid(workspaceId),
        apiKeys: {
          $elemMatch: {
            _id: oid(keyId),
            $or: [
              { lastUsedAt: { $exists: false } },
              { lastUsedAt: null },
              { lastUsedAt: { $lt: cutoff } },
            ],
          },
        },
      },
      { $set: { "apiKeys.$.lastUsedAt": now } },
      { timestamps: false },
    );
  }

  // ── 3. Workspace members ─────────────────────────────────────────────

  async findMember(
    workspaceId: string,
    userId: string,
  ): Promise<WorkspaceMemberRecord | null> {
    if (!isEntityId(workspaceId) || !userId) {
      return null;
    }
    const doc = await WorkspaceMember.findOne({
      workspaceId: oid(workspaceId),
      userId,
    }).lean<MongoMemberLike | null>();
    return doc ? mongoMemberToRecord(doc) : null;
  }

  async findWorkspacesForUser(
    userId: string,
  ): Promise<Array<{ workspace: WorkspaceRecord; role: WorkspaceMemberRole }>> {
    if (!userId) {
      return [];
    }
    const rows = await WorkspaceMember.aggregate<{
      workspace: MongoWorkspaceLike;
      role: WorkspaceMemberRole;
    }>([
      { $match: { userId } },
      {
        $lookup: {
          from: "workspaces",
          localField: "workspaceId",
          foreignField: "_id",
          as: "workspace",
        },
      },
      { $unwind: "$workspace" },
      { $project: { workspace: 1, role: 1 } },
    ]);
    return rows.map(r => ({
      workspace: mongoWorkspaceToRecord(r.workspace),
      role: r.role,
    }));
  }

  async listMembers(
    workspaceId: string,
    roles?: readonly WorkspaceMemberRole[],
  ): Promise<WorkspaceMemberRecord[]> {
    if (!isEntityId(workspaceId)) {
      return [];
    }
    const filter: Record<string, unknown> = { workspaceId: oid(workspaceId) };
    if (roles && roles.length > 0) {
      filter.role = { $in: [...roles] };
    }
    const docs = await WorkspaceMember.find(filter)
      .sort({ joinedAt: 1 })
      .lean<MongoMemberLike[]>();
    return docs.map(mongoMemberToRecord);
  }

  async listMembersWithUsers(
    workspaceId: string,
  ): Promise<WorkspaceMemberWithUser[]> {
    const members = await this.listMembers(workspaceId);
    const userMap = await loadUserEmailMap(members.map(m => m.userId));
    return members.map(m => ({
      ...m,
      user: userMap.get(m.userId) ?? null,
    }));
  }

  async findMatchingMemberUserIds(
    workspaceId: string,
    userIds: readonly string[],
    role?: WorkspaceMemberRole,
  ): Promise<string[]> {
    if (!isEntityId(workspaceId) || userIds.length === 0) {
      return [];
    }
    const unique = [...new Set(userIds.filter(Boolean))];
    const filter: Record<string, unknown> = {
      workspaceId: oid(workspaceId),
      userId: { $in: unique },
    };
    if (role) {
      filter.role = role;
    }
    const docs = await WorkspaceMember.find(filter)
      .select("userId")
      .lean<Array<{ userId: string }>>();
    return docs.map(d => String(d.userId));
  }

  async addMember(input: AddMemberInput): Promise<WorkspaceMemberWithUser> {
    const id = input.id ? oid(input.id) : new Types.ObjectId(newDualId().oid);
    const doc = new WorkspaceMember({
      _id: id,
      workspaceId: oid(input.workspaceId),
      userId: input.userId,
      role: input.role,
      joinedAt: input.joinedAt ?? new Date(),
      ...(input.isDefaultMembership ? { isDefaultMembership: true } : {}),
    });
    await doc.save();
    const record = mongoMemberToRecord(
      doc.toObject() as unknown as MongoMemberLike,
    );
    const userMap = await loadUserEmailMap([record.userId]);
    return { ...record, user: userMap.get(record.userId) ?? null };
  }

  async addMemberIfNotExists(
    input: AddMemberInput,
  ): Promise<{ member: WorkspaceMemberRecord; inserted: boolean }> {
    const existing = await this.findMember(input.workspaceId, input.userId);
    if (existing) {
      return { member: existing, inserted: false };
    }
    try {
      const id = input.id ? oid(input.id) : new Types.ObjectId(newDualId().oid);
      const created = await WorkspaceMember.create({
        _id: id,
        workspaceId: oid(input.workspaceId),
        userId: input.userId,
        role: input.role,
        joinedAt: input.joinedAt ?? new Date(),
        ...(input.isDefaultMembership ? { isDefaultMembership: true } : {}),
      });
      return {
        member: mongoMemberToRecord(
          created.toObject() as unknown as MongoMemberLike,
        ),
        inserted: true,
      };
    } catch (error) {
      if (isMongoDupKey(error)) {
        const winner = await this.findMember(input.workspaceId, input.userId);
        if (winner) {
          return { member: winner, inserted: false };
        }
      }
      throw error;
    }
  }

  async updateMemberRole(
    workspaceId: string,
    userId: string,
    role: WorkspaceMemberRole,
  ): Promise<WorkspaceMemberWithUser | null> {
    if (!isEntityId(workspaceId)) {
      return null;
    }
    const doc = await WorkspaceMember.findOneAndUpdate(
      { workspaceId: oid(workspaceId), userId },
      { role },
      { returnDocument: "after" },
    ).lean<MongoMemberLike | null>();
    if (!doc) {
      return null;
    }
    const record = mongoMemberToRecord(doc);
    const userMap = await loadUserEmailMap([record.userId]);
    return { ...record, user: userMap.get(record.userId) ?? null };
  }

  async removeMember(workspaceId: string, userId: string): Promise<boolean> {
    if (!isEntityId(workspaceId)) {
      return false;
    }
    const res = await WorkspaceMember.deleteOne({
      workspaceId: oid(workspaceId),
      userId,
    });
    return (res.deletedCount ?? 0) > 0;
  }

  // ── 4. Workspace invites ─────────────────────────────────────────────

  async findPendingInviteByWorkspaceAndEmail(
    workspaceId: string,
    email: string,
  ): Promise<WorkspaceInviteRecord | null> {
    if (!isEntityId(workspaceId)) {
      return null;
    }
    const doc = await WorkspaceInvite.findOne({
      workspaceId: oid(workspaceId),
      email: normalizeEmail(email),
      acceptedAt: { $exists: false },
    }).lean<MongoInviteLike | null>();
    return doc ? mongoInviteToRecord(doc) : null;
  }

  async createInvite(input: CreateInviteInput): Promise<WorkspaceInviteRecord> {
    const id = input.id ? oid(input.id) : new Types.ObjectId(newDualId().oid);
    const doc = new WorkspaceInvite({
      _id: id,
      workspaceId: oid(input.workspaceId),
      email: normalizeEmail(input.email),
      token: input.token,
      role: input.role,
      invitedBy: input.invitedBy,
      expiresAt: input.expiresAt,
    });
    await doc.save();
    return mongoInviteToRecord(doc.toObject() as unknown as MongoInviteLike);
  }

  async refreshInvite(
    inviteId: string,
    patch: { expiresAt: Date; invitedBy: string },
  ): Promise<WorkspaceInviteRecord | null> {
    if (!isEntityId(inviteId)) {
      return null;
    }
    const doc = await WorkspaceInvite.findByIdAndUpdate(
      oid(inviteId),
      { $set: { expiresAt: patch.expiresAt, invitedBy: patch.invitedBy } },
      { returnDocument: "after" },
    ).lean<MongoInviteLike | null>();
    return doc ? mongoInviteToRecord(doc) : null;
  }

  async findPendingInviteByToken(
    token: string,
  ): Promise<WorkspaceInviteWithRefs | null> {
    const doc = await WorkspaceInvite.findOne({
      token,
      acceptedAt: { $exists: false },
    }).lean<MongoInviteLike | null>();
    if (!doc) {
      return null;
    }
    const record = mongoInviteToRecord(doc);
    const [wsMap, userMap] = await Promise.all([
      loadWorkspaceNameMap([record.workspaceId]),
      loadUserEmailMap([record.invitedBy]),
    ]);
    return {
      ...record,
      workspace: wsMap.get(record.workspaceId) ?? null,
      inviter: userMap.get(record.invitedBy) ?? null,
    };
  }

  async listPendingInvitesForWorkspace(
    workspaceId: string,
    now: Date = new Date(),
  ): Promise<WorkspaceInviteWithRefs[]> {
    if (!isEntityId(workspaceId)) {
      return [];
    }
    const docs = await WorkspaceInvite.find({
      workspaceId: oid(workspaceId),
      acceptedAt: { $exists: false },
      expiresAt: { $gt: now },
    })
      .sort({ _id: -1 })
      .lean<MongoInviteLike[]>();
    const records = docs.map(mongoInviteToRecord);
    const [wsMap, userMap] = await Promise.all([
      loadWorkspaceNameMap([workspaceId]),
      loadUserEmailMap(records.map(r => r.invitedBy)),
    ]);
    return records.map(r => ({
      ...r,
      workspace: wsMap.get(r.workspaceId) ?? null,
      inviter: userMap.get(r.invitedBy) ?? null,
    }));
  }

  async listPendingInvitesForEmail(
    email: string,
    now: Date = new Date(),
  ): Promise<WorkspaceInviteWithRefs[]> {
    const docs = await WorkspaceInvite.find({
      email: normalizeEmail(email),
      acceptedAt: { $exists: false },
      expiresAt: { $gt: now },
    })
      .sort({ _id: -1 })
      .lean<MongoInviteLike[]>();
    const records = docs.map(mongoInviteToRecord);
    const [wsMap, userMap] = await Promise.all([
      loadWorkspaceNameMap(records.map(r => r.workspaceId)),
      loadUserEmailMap(records.map(r => r.invitedBy)),
    ]);
    return records.map(r => ({
      ...r,
      workspace: wsMap.get(r.workspaceId) ?? null,
      inviter: userMap.get(r.invitedBy) ?? null,
    }));
  }

  async cancelInvite(inviteId: string): Promise<boolean> {
    if (!isEntityId(inviteId)) {
      return false;
    }
    const res = await WorkspaceInvite.deleteOne({ _id: oid(inviteId) });
    return (res.deletedCount ?? 0) > 0;
  }

  async acceptInviteTransaction(
    token: string,
    userId: string,
    now: Date = new Date(),
  ): Promise<{
    workspace: WorkspaceRecord;
    member: WorkspaceMemberRecord;
    invite: WorkspaceInviteRecord;
  }> {
    const inviteDoc = await WorkspaceInvite.findOne({
      token,
      acceptedAt: { $exists: false },
      expiresAt: { $gt: now },
    });
    if (!inviteDoc) {
      throw new Error("Invalid or expired invite");
    }

    const existingMember = await WorkspaceMember.findOne({
      workspaceId: inviteDoc.workspaceId,
      userId,
    }).lean<MongoMemberLike | null>();
    if (existingMember) {
      inviteDoc.acceptedAt = now;
      await inviteDoc.save();
      const ws = await Workspace.findById(
        inviteDoc.workspaceId,
      ).lean<MongoWorkspaceLike | null>();
      if (!ws) {
        throw new Error("Workspace not found");
      }
      return {
        workspace: mongoWorkspaceToRecord(ws),
        member: mongoMemberToRecord(existingMember),
        invite: mongoInviteToRecord(
          inviteDoc.toObject() as unknown as MongoInviteLike,
        ),
      };
    }

    return runInMongoTransaction(async session => {
      const opts = session ? { session } : undefined;
      inviteDoc.acceptedAt = now;
      await inviteDoc.save(opts);

      const memberDoc = new WorkspaceMember({
        _id: new Types.ObjectId(newDualId().oid),
        workspaceId: inviteDoc.workspaceId,
        userId,
        role: inviteDoc.role,
        joinedAt: now,
      });
      await memberDoc.save(opts);

      const wsQuery = Workspace.findById(inviteDoc.workspaceId);
      if (session) {
        wsQuery.session(session);
      }
      const ws = await wsQuery.lean<MongoWorkspaceLike | null>();
      if (!ws) {
        throw new Error("Workspace not found");
      }
      return {
        workspace: mongoWorkspaceToRecord(ws),
        member: mongoMemberToRecord(
          memberDoc.toObject() as unknown as MongoMemberLike,
        ),
        invite: mongoInviteToRecord(
          inviteDoc.toObject() as unknown as MongoInviteLike,
        ),
      };
    });
  }

  // ── 5. Workspace user handles ────────────────────────────────────────

  async listHandles(workspaceId: string): Promise<WorkspaceUserHandleRecord[]> {
    if (!isEntityId(workspaceId)) {
      return [];
    }
    const docs = await WorkspaceUserHandle.find({
      workspaceId: oid(workspaceId),
    }).lean<MongoHandleLike[]>();
    return docs.map(mongoHandleToRecord);
  }

  async insertHandlesBestEffort(
    workspaceId: string,
    rows: ReadonlyArray<{ userId: string; handle: string }>,
  ): Promise<{ inserted: WorkspaceUserHandleRecord[]; hadConflict: boolean }> {
    if (!isEntityId(workspaceId) || rows.length === 0) {
      return { inserted: [], hadConflict: false };
    }
    const wsOid = oid(workspaceId);
    const docsToInsert = rows.map(r => ({
      _id: new Types.ObjectId(newDualId().oid),
      workspaceId: wsOid,
      userId: r.userId,
      handle: r.handle,
    }));
    try {
      const inserted = await WorkspaceUserHandle.insertMany(docsToInsert, {
        ordered: false,
      });
      return {
        inserted: inserted.map(d =>
          mongoHandleToRecord(d.toObject() as unknown as MongoHandleLike),
        ),
        hadConflict: false,
      };
    } catch (error) {
      const bulkErr = error as {
        code?: number;
        insertedDocs?: Array<{ toObject?: () => unknown }>;
        writeErrors?: Array<{ code?: number }>;
      };
      const isDup =
        bulkErr.code === 11000 ||
        (Array.isArray(bulkErr.writeErrors) &&
          bulkErr.writeErrors.some(e => e.code === 11000));
      if (!isDup) {
        throw error;
      }
      const insertedDocs = (bulkErr.insertedDocs ?? []).map(d =>
        mongoHandleToRecord(
          (typeof d.toObject === "function"
            ? d.toObject()
            : d) as unknown as MongoHandleLike,
        ),
      );
      return { inserted: insertedDocs, hadConflict: true };
    }
  }

  // ── 6. MCP OAuth clients ─────────────────────────────────────────────

  async findMcpClient(clientId: string): Promise<McpOAuthClientRecord | null> {
    if (!clientId) {
      return null;
    }
    const doc = await McpOAuthClient.findOne({
      clientId,
    }).lean<MongoMcpClientLike | null>();
    return doc ? mongoMcpClientToRecord(doc) : null;
  }

  async createMcpClient(
    input: CreateMcpClientInput,
  ): Promise<McpOAuthClientRecord> {
    const id = input.id ? oid(input.id) : new Types.ObjectId(newDualId().oid);
    const created = await McpOAuthClient.create({
      _id: id,
      clientId: input.clientId,
      ...(input.clientName !== undefined
        ? { clientName: input.clientName }
        : {}),
      redirectUris: input.redirectUris,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    });
    return mongoMcpClientToRecord(
      created.toObject() as unknown as MongoMcpClientLike,
    );
  }

  async ensureMcpClient(
    input: CreateMcpClientInput,
  ): Promise<McpOAuthClientRecord> {
    const existing = await this.findMcpClient(input.clientId);
    if (existing) {
      return existing;
    }
    try {
      return await this.createMcpClient(input);
    } catch (error) {
      if (isMongoDupKey(error)) {
        const winner = await this.findMcpClient(input.clientId);
        if (winner) {
          return winner;
        }
      }
      throw error;
    }
  }

  // ── 7. MCP OAuth codes ───────────────────────────────────────────────

  async createMcpCode(input: CreateMcpCodeInput): Promise<McpOAuthCodeRecord> {
    const id = input.id ? oid(input.id) : new Types.ObjectId(newDualId().oid);
    const created = await McpOAuthCode.create({
      _id: id,
      codeHash: input.codeHash,
      clientId: input.clientId,
      userId: input.userId,
      workspaceId: toWireOrRaw(input.workspaceId),
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      scopes: input.scopes,
      expiresAt: input.expiresAt,
    });
    return mongoMcpCodeToRecord(
      created.toObject() as unknown as MongoMcpCodeLike,
    );
  }

  async redeemMcpCodeOnce(
    codeHash: string,
    now: Date = new Date(),
  ): Promise<McpOAuthCodeRecord | null> {
    const doc = await McpOAuthCode.findOneAndUpdate(
      {
        codeHash,
        usedAt: { $exists: false },
        expiresAt: { $gt: now },
      },
      { $set: { usedAt: now } },
      { returnDocument: "after" },
    ).lean<MongoMcpCodeLike | null>();
    return doc ? mongoMcpCodeToRecord(doc) : null;
  }

  // ── 8. MCP OAuth tokens ──────────────────────────────────────────────

  async createMcpToken(
    input: CreateMcpTokenInput,
  ): Promise<McpOAuthTokenRecord> {
    const id = input.id ? oid(input.id) : new Types.ObjectId(newDualId().oid);
    const created = await McpOAuthToken.create({
      _id: id,
      accessTokenHash: input.accessTokenHash,
      refreshTokenHash: input.refreshTokenHash,
      clientId: input.clientId,
      userId: input.userId,
      workspaceId: toWireOrRaw(input.workspaceId),
      ...(input.agentSessionId !== undefined
        ? { agentSessionId: input.agentSessionId }
        : {}),
      scopes: input.scopes,
      accessExpiresAt: input.accessExpiresAt,
      ...(input.refreshExpiresAt !== undefined
        ? { refreshExpiresAt: input.refreshExpiresAt }
        : {}),
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    });
    return mongoMcpTokenToRecord(
      created.toObject() as unknown as MongoMcpTokenLike,
    );
  }

  async findValidMcpTokenByAccessHash(
    accessTokenHash: string,
    now: Date = new Date(),
  ): Promise<McpOAuthTokenRecord | null> {
    const doc = await McpOAuthToken.findOne({
      accessTokenHash,
      accessExpiresAt: { $gt: now },
    }).lean<MongoMcpTokenLike | null>();
    return doc ? mongoMcpTokenToRecord(doc) : null;
  }

  async hasActiveMcpAgentSession(input: {
    workspaceId: string;
    userId: string;
    clientId: string;
    agentSessionId: string;
    now?: Date;
  }): Promise<boolean> {
    if (!input.workspaceId) {
      return false;
    }
    const exists = await McpOAuthToken.exists({
      workspaceId: toWireOrRaw(input.workspaceId),
      userId: input.userId,
      clientId: input.clientId,
      agentSessionId: input.agentSessionId,
      refreshExpiresAt: { $gt: input.now ?? new Date() },
    });
    return Boolean(exists);
  }

  async rotateMcpRefreshToken(
    input: RotateMcpRefreshTokenInput,
  ): Promise<McpOAuthTokenRecord | null> {
    const now = input.now ?? new Date();
    const doc = (await McpOAuthToken.findOneAndUpdate(
      {
        refreshTokenHash: input.currentRefreshTokenHash,
        clientId: input.clientId,
        $or: [
          { refreshExpiresAt: { $exists: false } },
          { refreshExpiresAt: { $gt: now } },
        ],
      },
      [
        {
          $set: {
            accessTokenHash: input.newAccessTokenHash,
            refreshTokenHash: input.newRefreshTokenHash,
            accessExpiresAt: input.newAccessExpiresAt,
            scopes: {
              $setDifference: [
                { $ifNull: ["$scopes", []] },
                { $literal: [...input.stripScopes] },
              ],
            },
          },
        },
        input.newRefreshExpiresAt === null
          ? { $unset: "refreshExpiresAt" }
          : { $set: { refreshExpiresAt: input.newRefreshExpiresAt } },
      ],
      { returnDocument: "after", updatePipeline: true, lean: true },
    )) as MongoMcpTokenLike | null;
    return doc ? mongoMcpTokenToRecord(doc) : null;
  }

  async touchMcpTokenLastUsed(
    tokenId: string,
    now: Date = new Date(),
    minIntervalMs: number = DEFAULT_LAST_USED_MIN_INTERVAL_MS,
  ): Promise<void> {
    if (!isEntityId(tokenId)) {
      return;
    }
    const cutoff = new Date(now.getTime() - minIntervalMs);
    await McpOAuthToken.updateOne(
      {
        _id: oid(tokenId),
        $or: [
          { lastUsedAt: { $exists: false } },
          { lastUsedAt: null },
          { lastUsedAt: { $lt: cutoff } },
        ],
      },
      { $set: { lastUsedAt: now } },
    );
  }

  async listMcpConnections(
    workspaceId: string,
    now: Date = new Date(),
  ): Promise<McpConnectionSummary[]> {
    if (!workspaceId) {
      return [];
    }
    const wsWire = toWireOrRaw(workspaceId);
    const grants = await McpOAuthToken.aggregate<{
      _id: { clientId: string; userId: string };
      connectedAt: Date;
      lastUsedAt?: Date | null;
      accessExpiresAt: Date;
    }>([
      {
        $match: {
          workspaceId: wsWire,
          $or: [
            { refreshExpiresAt: { $exists: false } },
            { refreshExpiresAt: { $gt: now } },
          ],
        },
      },
      {
        $group: {
          _id: { clientId: "$clientId", userId: "$userId" },
          connectedAt: { $min: "$createdAt" },
          lastUsedAt: { $max: "$lastUsedAt" },
          accessExpiresAt: { $max: "$accessExpiresAt" },
        },
      },
      { $sort: { lastUsedAt: -1, connectedAt: -1 } },
    ]);

    const clientIds = [...new Set(grants.map(g => g._id.clientId))];
    const clients =
      clientIds.length > 0
        ? await McpOAuthClient.find({ clientId: { $in: clientIds } })
            .select("clientId clientName")
            .lean<Array<{ clientId: string; clientName?: string }>>()
        : [];
    const nameByClientId = new Map(
      clients.map(c => [c.clientId, c.clientName] as const),
    );

    return grants.map(g => {
      const summary: McpConnectionSummary = {
        clientId: g._id.clientId,
        userId: g._id.userId,
        connectedAt: g.connectedAt,
        accessExpiresAt: g.accessExpiresAt,
      };
      const clientName = nameByClientId.get(g._id.clientId);
      if (clientName !== undefined) {
        summary.clientName = clientName;
      }
      if (g.lastUsedAt) {
        summary.lastUsedAt = g.lastUsedAt;
      }
      return summary;
    });
  }

  async revokeMcpGrantsForMember(input: {
    workspaceId: string;
    userId: string;
  }): Promise<number> {
    if (!input.workspaceId) {
      return 0;
    }
    const res = await McpOAuthToken.deleteMany({
      workspaceId: toWireOrRaw(input.workspaceId),
      userId: input.userId,
    });
    return res.deletedCount ?? 0;
  }

  async revokeMcpConnection(input: {
    workspaceId: string;
    clientId: string;
    userId: string;
  }): Promise<number> {
    if (!input.workspaceId) {
      return 0;
    }
    const res = await McpOAuthToken.deleteMany({
      workspaceId: toWireOrRaw(input.workspaceId),
      clientId: input.clientId,
      userId: input.userId,
    });
    return res.deletedCount ?? 0;
  }

  // ── 9. ACP plan grants ───────────────────────────────────────────────

  async upsertAcpGrant(
    input: UpsertAcpGrantInput,
  ): Promise<AcpPlanGrantRecord> {
    const id = input.id ? oid(input.id) : new Types.ObjectId(newDualId().oid);
    const doc = await AcpPlanGrant.findOneAndUpdate(
      { agentSessionId: input.agentSessionId },
      {
        $setOnInsert: { _id: id },
        $set: {
          workspaceId: toWireOrRaw(input.workspaceId),
          userId: input.userId,
          planDigest: input.planDigest,
          grants: input.grants,
          status: "approved",
          expiresAt: input.expiresAt,
        },
      },
      { upsert: true, returnDocument: "after" },
    ).lean<MongoAcpGrantLike>();
    return mongoAcpGrantToRecord(doc);
  }

  async revokeAcpGrant(input: {
    workspaceId: string;
    userId: string;
    agentSessionId: string;
    now?: Date;
  }): Promise<boolean> {
    if (!input.workspaceId) {
      return false;
    }
    const res = await AcpPlanGrant.updateOne(
      {
        workspaceId: toWireOrRaw(input.workspaceId),
        userId: input.userId,
        agentSessionId: input.agentSessionId,
      },
      { $set: { status: "revoked", expiresAt: input.now ?? new Date() } },
    );
    return res.matchedCount > 0;
  }

  async findActiveAcpGrant(input: {
    workspaceId: string;
    userId: string;
    agentSessionId: string;
    now?: Date;
  }): Promise<AcpPlanGrantRecord | null> {
    if (!input.workspaceId || !input.agentSessionId) {
      return null;
    }
    const doc = await AcpPlanGrant.findOne({
      workspaceId: toWireOrRaw(input.workspaceId),
      userId: input.userId,
      agentSessionId: input.agentSessionId,
      status: "approved",
      expiresAt: { $gt: input.now ?? new Date() },
    }).lean<MongoAcpGrantLike | null>();
    return doc ? mongoAcpGrantToRecord(doc) : null;
  }

  // ── 10. GitHub installations ─────────────────────────────────────────

  async listGitHubInstallations(
    workspaceId: string,
  ): Promise<GitHubInstallationRecord[]> {
    if (!isEntityId(workspaceId)) {
      return [];
    }
    const docs = await GitHubInstallation.find({
      workspaceId: oid(workspaceId),
    }).lean<MongoGitHubInstallationLike[]>();
    return docs.map(mongoGitHubInstallationToRecord);
  }

  async findGitHubInstallation(
    workspaceId: string,
    installationId: number,
  ): Promise<GitHubInstallationRecord | null> {
    if (!isEntityId(workspaceId)) {
      return null;
    }
    const doc = await GitHubInstallation.findOne({
      workspaceId: oid(workspaceId),
      installationId,
    }).lean<MongoGitHubInstallationLike | null>();
    return doc ? mongoGitHubInstallationToRecord(doc) : null;
  }

  async upsertGitHubInstallation(
    input: UpsertGitHubInstallationInput,
  ): Promise<GitHubInstallationRecord> {
    const id = input.id ? oid(input.id) : new Types.ObjectId(newDualId().oid);
    const doc = await GitHubInstallation.findOneAndUpdate(
      {
        workspaceId: oid(input.workspaceId),
        installationId: input.installationId,
      },
      {
        $set: {
          accountLogin: input.accountLogin.trim(),
          accountType: input.accountType,
          repositorySelection: input.repositorySelection,
        },
        $setOnInsert: {
          _id: id,
          createdBy: input.createdBy,
        },
      },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
    ).lean<MongoGitHubInstallationLike>();
    return mongoGitHubInstallationToRecord(doc);
  }

  async deleteGitHubInstallation(
    workspaceId: string,
    installationId: number,
  ): Promise<boolean> {
    if (!isEntityId(workspaceId)) {
      return false;
    }
    const res = await GitHubInstallation.deleteOne({
      workspaceId: oid(workspaceId),
      installationId,
    });
    return (res.deletedCount ?? 0) > 0;
  }

  async deleteGitHubInstallationsByInstallationIdReturningIds(
    installationId: number,
  ): Promise<string[]> {
    const docs = await GitHubInstallation.find({ installationId })
      .select("_id")
      .lean<Array<{ _id: Types.ObjectId }>>();
    if (docs.length === 0) {
      return [];
    }
    const ids = docs.map(d => toWire(d._id));
    await GitHubInstallation.deleteMany({ installationId });
    return ids;
  }

  async deleteGitHubInstallationsByInstallationId(
    installationId: number,
  ): Promise<number> {
    const ids =
      await this.deleteGitHubInstallationsByInstallationIdReturningIds(
        installationId,
      );
    return ids.length;
  }

  async pruneStaleGitHubInstallations(
    workspaceId: string,
    accountLogin: string,
    keepInstallationId: number,
  ): Promise<number> {
    if (!isEntityId(workspaceId)) {
      return 0;
    }
    const res = await GitHubInstallation.deleteMany({
      workspaceId: oid(workspaceId),
      accountLogin,
      installationId: { $ne: keepInstallationId },
    });
    return res.deletedCount ?? 0;
  }
}
