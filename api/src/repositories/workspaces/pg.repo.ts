/**
 * Postgres (Neon / Drizzle) implementation of `WorkspaceRepository` for all 10
 * tables of the Phase 1B `workspaces_core` + `github_installations` domain
 * (Decision #1 bijective UUIDv8 ObjectIds + Decision #3 UUIDv7 `users(id)` FKs).
 *
 * Key invariants:
 *   - Incoming `userId` values may be canonical UUIDv7s OR legacy 15-char Lucia
 *     IDs / UUIDv4s. Reads take a zero-extra-query fast path when `isUuidv7(userId)`
 *     and otherwise resolve via `users(id / legacy_id)`.
 *   - Nullable audit user columns (`created_by`, `invited_by`, `workspace_user_handles.user_id`)
 *     store `NULL` when the user does not exist in `users` (e.g. `"system"`, `"test"`, deleted).
 *   - Grant-bearing user columns (`workspace_members`, `mcp_oauth_codes`,
 *     `mcp_oauth_tokens`, `acp_plan_grants`) require a resolved `users.id` UUID.
 *   - All `.aggregate()` and `.populate()` queries from Mongo are native SQL
 *     `JOIN` / `GROUP BY` queries.
 *   - All 4 workspace lifecycle transactions run inside `db.transaction(...)`
 *     with `23505` constraint mapping matching Mongo's `11000` behavior.
 */
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
  ne,
  or,
  sql,
} from "drizzle-orm";
import { getPgDb, type MakoPgDb } from "../../database/pg/client";
import {
  isUuidString,
  isUuidv7,
  newDualId,
  objectIdUuidTimestamp,
  toWireId,
} from "../../database/pg/id-codec";
import { users } from "../../database/pg/schema/auth";
import {
  acpPlanGrants,
  githubInstallations,
  mcpOAuthClients,
  mcpOAuthCodes,
  mcpOAuthTokens,
  workspaceApiKeys,
  workspaceInvites,
  workspaceMembers,
  workspaceUserHandles,
  workspaces,
} from "../../database/pg/schema/workspaces";
import { normalizeEmail } from "../../utils/email.utils";
import {
  isEntityId,
  isSyntheticUserId,
  pgAcpGrantToRecord,
  pgApiKeyToRecord,
  pgGitHubInstallationToRecord,
  pgHandleToRecord,
  pgInviteToRecord,
  pgMcpClientToRecord,
  pgMcpCodeToRecord,
  pgMcpTokenToRecord,
  pgMemberToRecord,
  pgWorkspaceToRecord,
  repoToJson,
  toPgUuid,
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

interface PgErrorInfo {
  code?: string;
  constraint?: string;
  message: string;
}

/**
 * Extract Postgres `code` (e.g. `"23505"`) and `constraint` across `node-postgres`,
 * Neon serverless, PGlite, and Drizzle's `DrizzleQueryError` cause wrapper.
 */
function extractPgError(err: unknown): PgErrorInfo {
  let cur: unknown = err;
  for (let depth = 0; depth < 4 && cur && typeof cur === "object"; depth++) {
    const obj = cur as {
      code?: unknown;
      constraint?: unknown;
      constraint_name?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (typeof obj.code === "string") {
      return {
        code: obj.code,
        constraint:
          typeof obj.constraint === "string"
            ? obj.constraint
            : typeof obj.constraint_name === "string"
              ? obj.constraint_name
              : undefined,
        message: typeof obj.message === "string" ? obj.message : String(cur),
      };
    }
    cur = obj.cause;
  }
  return {
    message: err instanceof Error ? err.message : String(err),
  };
}

function isPgUniqueViolation(err: unknown, constraintName?: string): boolean {
  const info = extractPgError(err);
  if (info.code !== "23505") {
    return false;
  }
  if (!constraintName) {
    return true;
  }
  return (
    info.constraint === constraintName || info.message.includes(constraintName)
  );
}

function escapeLikePrefix(prefix: string): string {
  return prefix.replace(/[\\%_]/g, "\\$&");
}

type PgQueryable = Pick<MakoPgDb, "select" | "insert" | "update" | "delete">;

export class PgWorkspaceRepository implements WorkspaceRepository {
  private readonly getDb: () => MakoPgDb;

  constructor(options: { getDb?: () => MakoPgDb } = {}) {
    this.getDb = options.getDb ?? getPgDb;
  }

  // ── User ID resolution helpers (Decision #3) ─────────────────────────

  private async lookupPgUserUuid(
    userId: string,
    db: PgQueryable,
  ): Promise<string | null> {
    if (!userId) {
      return null;
    }
    const whereClause = isUuidString(userId)
      ? or(eq(users.id, userId.toLowerCase()), eq(users.legacyId, userId))
      : eq(users.legacyId, userId);
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(whereClause)
      .limit(1);
    return rows[0] ? rows[0].id.toLowerCase() : null;
  }

  /** Fast path for reads: UUIDv7 is always canonical `users.id` (zero extra query). */
  private async resolveReadUserUuid(
    userId: string,
    db: PgQueryable = this.getDb(),
  ): Promise<string | null> {
    if (!userId) {
      return null;
    }
    if (isUuidv7(userId)) {
      return userId.toLowerCase();
    }
    return this.lookupPgUserUuid(userId, db);
  }

  /** Safe lookup for nullable audit FKs (`ON DELETE SET NULL`): non-user sentinels -> NULL. */
  private async resolveNullableWriteUserUuid(
    userId: string | null | undefined,
    db: PgQueryable = this.getDb(),
  ): Promise<string | null> {
    if (!userId) {
      return null;
    }
    return this.lookupPgUserUuid(userId, db);
  }

  /**
   * Strict creator lookup for `workspace_api_keys.created_by`:
   * empty or synthetic sentinels (`"system"`, `"test"`) store NULL, whereas any
   * real user ID that cannot be resolved in `users` throws so callers/routers
   * fail loudly or enqueue a sync-retry instead of storing a broken NULL creator
   * (which causes 401s on auth and breaks `deleteApiKeysByCreator`).
   */
  private async resolveApiKeyCreatorWriteUserUuid(
    userId: string | null | undefined,
    db: PgQueryable = this.getDb(),
  ): Promise<string | null> {
    if (!userId || isSyntheticUserId(userId)) {
      return null;
    }
    const resolved = await this.lookupPgUserUuid(userId, db);
    if (!resolved) {
      throw new Error(
        `Cannot resolve API key creator ${JSON.stringify(userId)} in Postgres users table`,
      );
    }
    return resolved;
  }

  /** Strict lookup for `NOT NULL` grant-bearing FKs (`ON DELETE CASCADE`). */
  private async resolveRequiredWriteUserUuid(
    userId: string,
    db: PgQueryable = this.getDb(),
  ): Promise<string> {
    const resolved = await this.lookupPgUserUuid(userId, db);
    if (resolved) {
      return resolved;
    }
    if (isUuidString(userId)) {
      return userId.toLowerCase();
    }
    throw new Error(
      `Cannot resolve userId ${JSON.stringify(userId)} to a Postgres user UUID`,
    );
  }

  // ── 1. Workspaces ────────────────────────────────────────────────────

  async findById(workspaceId: string): Promise<WorkspaceRecord | null> {
    if (!isEntityId(workspaceId)) {
      return null;
    }
    const rows = await this.getDb()
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, toPgUuid(workspaceId)))
      .limit(1);
    return rows[0] ? pgWorkspaceToRecord(rows[0]) : null;
  }

  async findByIds(workspaceIds: readonly string[]): Promise<WorkspaceRecord[]> {
    const valid = [...new Set(workspaceIds.filter(isEntityId))];
    if (valid.length === 0) {
      return [];
    }
    const rows = await this.getDb()
      .select()
      .from(workspaces)
      .where(inArray(workspaces.id, valid.map(toPgUuid)));
    return rows.map(pgWorkspaceToRecord);
  }

  async findBySlug(slug: string): Promise<WorkspaceRecord | null> {
    const normalized = slug.trim().toLowerCase();
    if (!normalized) {
      return null;
    }
    const rows = await this.getDb()
      .select()
      .from(workspaces)
      .where(eq(workspaces.slug, normalized))
      .limit(1);
    return rows[0] ? pgWorkspaceToRecord(rows[0]) : null;
  }

  async findByStripeCustomerId(
    stripeCustomerId: string,
  ): Promise<WorkspaceRecord | null> {
    if (!stripeCustomerId) {
      return null;
    }
    const rows = await this.getDb()
      .select()
      .from(workspaces)
      .where(eq(workspaces.billingStripeCustomerId, stripeCustomerId))
      .limit(1);
    return rows[0] ? pgWorkspaceToRecord(rows[0]) : null;
  }

  async listPaidActiveBilling(): Promise<WorkspaceRecord[]> {
    const rows = await this.getDb()
      .select()
      .from(workspaces)
      .where(
        and(
          inArray(workspaces.billingPlan, ["pro", "enterprise"]),
          isNotNull(workspaces.billingStripeCustomerId),
          isNotNull(workspaces.billingStripeSubscriptionId),
          eq(workspaces.billingSubscriptionStatus, "active"),
        ),
      );
    return rows.map(pgWorkspaceToRecord);
  }

  async listIdsWithDeployedWorkflows(): Promise<string[]> {
    const rows = await this.getDb()
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(isNotNull(workspaces.workflowsLive));
    return rows.map(r => toWireId(r.id));
  }

  async listWithHatchetToken(workspaceId?: string): Promise<WorkspaceRecord[]> {
    if (workspaceId && !isEntityId(workspaceId)) {
      return [];
    }
    const whereClause = workspaceId
      ? and(
          eq(workspaces.id, toPgUuid(workspaceId)),
          isNotNull(workspaces.workflowsHatchetTokenEncrypted),
        )
      : isNotNull(workspaces.workflowsHatchetTokenEncrypted);
    const rows = await this.getDb()
      .select()
      .from(workspaces)
      .where(whereClause);
    return rows.map(pgWorkspaceToRecord);
  }

  async findOtherWorkspaceWithHatchetToken(
    excludeWorkspaceId: string,
  ): Promise<{ id: string; slug: string } | null> {
    const whereClause = isEntityId(excludeWorkspaceId)
      ? and(
          ne(workspaces.id, toPgUuid(excludeWorkspaceId)),
          isNotNull(workspaces.workflowsHatchetTokenEncrypted),
        )
      : isNotNull(workspaces.workflowsHatchetTokenEncrypted);
    const rows = await this.getDb()
      .select({ id: workspaces.id, slug: workspaces.slug })
      .from(workspaces)
      .where(whereClause)
      .limit(1);
    return rows[0] ? { id: toWireId(rows[0].id), slug: rows[0].slug } : null;
  }

  async findWorkspaceIdsByRepoBinding(
    owner: string,
    repo: string,
  ): Promise<string[]> {
    const needle = JSON.stringify([{ owner, repo }]);
    const rows = await this.getDb()
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(
        and(
          isNotNull(workspaces.workspaceRepos),
          sql`${workspaces.workspaceRepos} @> ${needle}::jsonb`,
        ),
      );
    return rows.map(r => toWireId(r.id));
  }

  async createWorkspaceWithOwner(
    input: CreateWorkspaceWithOwnerInput,
  ): Promise<{ workspace: WorkspaceRecord; member: WorkspaceMemberRecord }> {
    const db = this.getDb();
    const wsUuid = input.workspaceId
      ? toPgUuid(input.workspaceId)
      : newDualId().uuid;
    const memberUuid = input.memberId
      ? toPgUuid(input.memberId)
      : newDualId().uuid;
    const slug = input.slug.trim().toLowerCase();
    const now = new Date();

    try {
      return await db.transaction(async tx => {
        const pgUserUuid = await this.resolveRequiredWriteUserUuid(
          input.userId,
          tx,
        );
        const [wsRow] = await tx
          .insert(workspaces)
          .values({
            id: wsUuid,
            name: input.name.trim(),
            slug,
            createdBy: pgUserUuid,
            settingsMaxDatabases: input.settings?.maxDatabases ?? 5,
            settingsMaxMembers: input.settings?.maxMembers ?? 10,
            settingsBillingTier: input.settings?.billingTier ?? "free",
            settingsDisabledModelIds: input.settings?.disabledModelIds ?? [],
            settingsAutoJoin: input.settings?.autoJoin ?? null,
            settingsLinkPreviews: input.settings?.linkPreviews ?? null,
            createdAt: now,
            updatedAt: now,
          })
          .returning();

        const [memberRow] = await tx
          .insert(workspaceMembers)
          .values({
            id: memberUuid,
            workspaceId: wsUuid,
            userId: pgUserUuid,
            role: "owner",
            joinedAt: now,
            isDefaultMembership: input.isDefaultMembership ? true : null,
            updatedAt: now,
          })
          .returning();

        return {
          workspace: pgWorkspaceToRecord(wsRow),
          member: pgMemberToRecord(memberRow),
        };
      });
    } catch (error) {
      if (isPgUniqueViolation(error, "uq_workspaces_slug")) {
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
    const db = this.getDb();
    const pgUserUuid = await this.resolveRequiredWriteUserUuid(
      input.userId,
      db,
    );

    const existing = await db
      .select({ member: workspaceMembers, workspace: workspaces })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
      .where(eq(workspaceMembers.userId, pgUserUuid))
      .limit(1);
    if (existing[0]) {
      return {
        workspace: pgWorkspaceToRecord(existing[0].workspace),
        member: pgMemberToRecord(existing[0].member),
        created: false,
      };
    }

    try {
      const { workspace, member } = await this.createWorkspaceWithOwner({
        name: input.name,
        slug: input.slug,
        userId: pgUserUuid,
        isDefaultMembership: true,
      });
      return { workspace, member, created: true };
    } catch (error) {
      if (isPgUniqueViolation(error, "uq_workspace_members_default")) {
        const winner =
          (
            await db
              .select({ member: workspaceMembers, workspace: workspaces })
              .from(workspaceMembers)
              .innerJoin(
                workspaces,
                eq(workspaceMembers.workspaceId, workspaces.id),
              )
              .where(
                and(
                  eq(workspaceMembers.userId, pgUserUuid),
                  eq(workspaceMembers.isDefaultMembership, true),
                ),
              )
              .limit(1)
          )[0] ??
          (
            await db
              .select({ member: workspaceMembers, workspace: workspaces })
              .from(workspaceMembers)
              .innerJoin(
                workspaces,
                eq(workspaceMembers.workspaceId, workspaces.id),
              )
              .where(eq(workspaceMembers.userId, pgUserUuid))
              .limit(1)
          )[0];

        if (winner) {
          return {
            workspace: pgWorkspaceToRecord(winner.workspace),
            member: pgMemberToRecord(winner.member),
            created: false,
          };
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
    const deleted = await this.getDb()
      .delete(workspaces)
      .where(eq(workspaces.id, toPgUuid(workspaceId)))
      .returning({ id: workspaces.id });
    return deleted.length > 0;
  }

  async updateWorkspace(
    workspaceId: string,
    patch: UpdateWorkspacePatch,
  ): Promise<WorkspaceRecord | null> {
    if (!isEntityId(workspaceId)) {
      return null;
    }
    const values: Partial<typeof workspaces.$inferInsert> = {
      updatedAt: new Date(),
    };
    let hasChanges = false;
    if (patch.name !== undefined) {
      values.name = patch.name.trim();
      hasChanges = true;
    }
    if (patch.settings) {
      const s = patch.settings;
      if (s.maxDatabases !== undefined) {
        values.settingsMaxDatabases = s.maxDatabases;
        hasChanges = true;
      }
      if (s.maxMembers !== undefined) {
        values.settingsMaxMembers = s.maxMembers;
        hasChanges = true;
      }
      if (s.billingTier !== undefined) {
        values.settingsBillingTier = s.billingTier;
        hasChanges = true;
      }
      if (s.disabledModelIds !== undefined) {
        values.settingsDisabledModelIds = s.disabledModelIds;
        hasChanges = true;
      }
      if (s.autoJoin !== undefined) {
        values.settingsAutoJoin = s.autoJoin;
        hasChanges = true;
      }
      if (s.linkPreviews !== undefined) {
        values.settingsLinkPreviews = s.linkPreviews;
        hasChanges = true;
      }
    }
    if (!hasChanges) {
      return this.findById(workspaceId);
    }
    const rows = await this.getDb()
      .update(workspaces)
      .set(values)
      .where(eq(workspaces.id, toPgUuid(workspaceId)))
      .returning();
    return rows[0] ? pgWorkspaceToRecord(rows[0]) : null;
  }

  async setAutoJoin(
    workspaceId: string,
    autoJoin: WorkspaceAutoJoin | null,
  ): Promise<void> {
    if (!isEntityId(workspaceId)) {
      return;
    }
    await this.getDb()
      .update(workspaces)
      .set({ settingsAutoJoin: autoJoin, updatedAt: new Date() })
      .where(eq(workspaces.id, toPgUuid(workspaceId)));
  }

  async setLinkPreviews(workspaceId: string, enabled: boolean): Promise<void> {
    if (!isEntityId(workspaceId)) {
      return;
    }
    await this.getDb()
      .update(workspaces)
      .set({ settingsLinkPreviews: enabled, updatedAt: new Date() })
      .where(eq(workspaces.id, toPgUuid(workspaceId)));
  }

  async setDisabledModelIds(
    workspaceId: string,
    disabledModelIds: string[],
  ): Promise<WorkspaceRecord | null> {
    if (!isEntityId(workspaceId)) {
      return null;
    }
    const rows = await this.getDb()
      .update(workspaces)
      .set({
        settingsDisabledModelIds: disabledModelIds,
        updatedAt: new Date(),
      })
      .where(eq(workspaces.id, toPgUuid(workspaceId)))
      .returning();
    return rows[0] ? pgWorkspaceToRecord(rows[0]) : null;
  }

  async unsetLegacyCustomPrompt(): Promise<void> {
    // Legacy Mongo-only fields (`settings.customPrompt`, `selfDirective`) are not stored in Postgres.
  }

  // ── Billing ──────────────────────────────────────────────────────────

  async updateBilling(
    workspaceId: string,
    patch: UpdateBillingPatch,
  ): Promise<WorkspaceRecord | null> {
    if (!isEntityId(workspaceId)) {
      return null;
    }
    const values: Partial<typeof workspaces.$inferInsert> = {
      updatedAt: new Date(),
    };
    let hasChanges = false;
    if (patch.stripeCustomerId !== undefined) {
      values.billingStripeCustomerId = patch.stripeCustomerId;
      hasChanges = true;
    }
    if (patch.stripeSubscriptionId !== undefined) {
      values.billingStripeSubscriptionId = patch.stripeSubscriptionId;
      hasChanges = true;
    }
    if (patch.subscriptionStatus !== undefined) {
      values.billingSubscriptionStatus = patch.subscriptionStatus;
      hasChanges = true;
    }
    if (patch.currentPeriodStart !== undefined) {
      values.billingCurrentPeriodStart = patch.currentPeriodStart;
      hasChanges = true;
    }
    if (patch.currentPeriodEnd !== undefined) {
      values.billingCurrentPeriodEnd = patch.currentPeriodEnd;
      hasChanges = true;
    }
    if (patch.usageQuotaUsd !== undefined) {
      values.billingUsageQuotaUsd = patch.usageQuotaUsd;
      hasChanges = true;
    }
    if (patch.hardLimitUsd !== undefined) {
      values.billingHardLimitUsd = patch.hardLimitUsd;
      hasChanges = true;
    }
    if (patch.plan !== undefined) {
      values.billingPlan = patch.plan;
      hasChanges = true;
    }
    if (patch.lastReportedOverageCents !== undefined) {
      values.billingLastReportedOverageCents = patch.lastReportedOverageCents;
      hasChanges = true;
    }
    if (patch.pendingReportedOverageCents !== undefined) {
      values.billingPendingReportedOverageCents =
        patch.pendingReportedOverageCents;
      hasChanges = true;
    }
    if (patch.pendingMeterEventIdempotencyKey !== undefined) {
      values.billingPendingMeterEventIdempotencyKey =
        patch.pendingMeterEventIdempotencyKey;
      hasChanges = true;
    }
    if (patch.settingsBillingTier !== undefined) {
      values.settingsBillingTier = patch.settingsBillingTier;
      hasChanges = true;
    }
    if (!hasChanges) {
      return this.findById(workspaceId);
    }
    const rows = await this.getDb()
      .update(workspaces)
      .set(values)
      .where(eq(workspaces.id, toPgUuid(workspaceId)))
      .returning();
    return rows[0] ? pgWorkspaceToRecord(rows[0]) : null;
  }

  async claimStripeCustomerIdIfUnset(
    workspaceId: string,
    stripeCustomerId: string,
  ): Promise<boolean> {
    if (!isEntityId(workspaceId)) {
      return false;
    }
    const rows = await this.getDb()
      .update(workspaces)
      .set({
        billingStripeCustomerId: stripeCustomerId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(workspaces.id, toPgUuid(workspaceId)),
          isNull(workspaces.billingStripeCustomerId),
        ),
      )
      .returning({ id: workspaces.id });
    return rows.length === 1;
  }

  async markStripeCustomerPastDue(
    stripeCustomerId: string,
  ): Promise<string | null> {
    const rows = await this.getDb()
      .update(workspaces)
      .set({ billingSubscriptionStatus: "past_due", updatedAt: new Date() })
      .where(eq(workspaces.billingStripeCustomerId, stripeCustomerId))
      .returning({ id: workspaces.id });
    return rows[0] ? toWireId(rows[0].id) : null;
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
    const rows = await this.getDb()
      .update(workspaces)
      .set({
        billingPendingReportedOverageCents: targetCents,
        billingPendingMeterEventIdempotencyKey: idempotencyKey,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(workspaces.id, toPgUuid(workspaceId)),
          eq(workspaces.billingLastReportedOverageCents, expectedLastCents),
          isNull(workspaces.billingPendingReportedOverageCents),
        ),
      )
      .returning({ id: workspaces.id });
    return rows.length === 1;
  }

  async commitPendingOverage(
    workspaceId: string,
    targetCents: number,
    idempotencyKey: string,
  ): Promise<boolean> {
    if (!isEntityId(workspaceId)) {
      return false;
    }
    const rows = await this.getDb()
      .update(workspaces)
      .set({
        billingLastReportedOverageCents: targetCents,
        billingPendingReportedOverageCents: null,
        billingPendingMeterEventIdempotencyKey: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(workspaces.id, toPgUuid(workspaceId)),
          eq(workspaces.billingPendingReportedOverageCents, targetCents),
          eq(workspaces.billingPendingMeterEventIdempotencyKey, idempotencyKey),
        ),
      )
      .returning({ id: workspaces.id });
    return rows.length === 1;
  }

  // ── Workspace repos ──────────────────────────────────────────────────

  async setWorkspaceRepos(
    workspaceId: string,
    repos: WorkspaceRepoBinding[] | null,
  ): Promise<WorkspaceRecord | null> {
    if (!isEntityId(workspaceId)) {
      return null;
    }
    const rows = await this.getDb()
      .update(workspaces)
      .set({
        workspaceRepos: repos ? repos.map(repoToJson) : null,
        updatedAt: new Date(),
      })
      .where(eq(workspaces.id, toPgUuid(workspaceId)))
      .returning();
    return rows[0] ? pgWorkspaceToRecord(rows[0]) : null;
  }

  async upsertTestWorkspaceWithRepo(
    workspaceId: string,
    repo: WorkspaceRepoBinding,
  ): Promise<void> {
    const wsUuid = toPgUuid(workspaceId);
    const wire = toWireId(wsUuid);
    const reposJson = [repoToJson(repo)];
    const now = new Date();
    await this.getDb()
      .insert(workspaces)
      .values({
        id: wsUuid,
        name: "test-ws",
        slug: `test-${wire}`,
        createdBy: null,
        workspaceRepos: reposJson,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: workspaces.id,
        set: { workspaceRepos: reposJson, updatedAt: now },
      });
  }

  // ── Workflows ────────────────────────────────────────────────────────

  async setWorkflowHatchetToken(
    workspaceId: string,
    encryptedToken: string | null,
  ): Promise<void> {
    if (!isEntityId(workspaceId)) {
      return;
    }
    await this.getDb()
      .update(workspaces)
      .set({
        workflowsHatchetTokenEncrypted: encryptedToken,
        updatedAt: new Date(),
      })
      .where(eq(workspaces.id, toPgUuid(workspaceId)));
  }

  async setWorkflowLiveTarget(
    workspaceId: string,
    target: { sha: string; tree: string; names: string[] } | null,
  ): Promise<void> {
    if (!isEntityId(workspaceId)) {
      return;
    }
    const wsUuid = toPgUuid(workspaceId);
    const now = new Date();
    if (!target) {
      await this.getDb()
        .update(workspaces)
        .set({ workflowsLive: null, updatedAt: now })
        .where(eq(workspaces.id, wsUuid));
      return;
    }
    const patchJson = JSON.stringify({
      sha: target.sha,
      tree: target.tree,
      names: target.names,
    });
    await this.getDb()
      .update(workspaces)
      .set({
        workflowsLive: sql`COALESCE(${workspaces.workflowsLive}, '{}'::jsonb) || ${patchJson}::jsonb`,
        updatedAt: now,
      })
      .where(eq(workspaces.id, wsUuid));
  }

  async reportWorkflowLiveStatus(
    workspaceId: string,
    sha: string,
    error?: string,
  ): Promise<boolean> {
    if (!isEntityId(workspaceId)) {
      return false;
    }
    const wsUuid = toPgUuid(workspaceId);
    const now = new Date();
    const updateExpr =
      typeof error === "string"
        ? sql`${workspaces.workflowsLive} || ${JSON.stringify({ failed: { sha, error } })}::jsonb`
        : sql`(${workspaces.workflowsLive} || ${JSON.stringify({ running: { sha } })}::jsonb) - 'failed'`;
    const rows = await this.getDb()
      .update(workspaces)
      .set({ workflowsLive: updateExpr, updatedAt: now })
      .where(
        and(
          eq(workspaces.id, wsUuid),
          sql`${workspaces.workflowsLive}->>'sha' = ${sha}`,
        ),
      )
      .returning({ id: workspaces.id });
    return rows.length > 0;
  }

  async setWorkflowTrigger(
    workspaceId: string,
    name: string,
    change: { active?: boolean; encryptedWebhookSecret?: string | null },
  ): Promise<void> {
    if (!isEntityId(workspaceId)) {
      return;
    }
    const set: Record<string, unknown> = {};
    if (change.active === true) {
      set.workflowsActive = sql`CASE WHEN ${workspaces.workflowsActive} IS NULL THEN ARRAY[${name}]::text[] WHEN ${name} = ANY(${workspaces.workflowsActive}) THEN ${workspaces.workflowsActive} ELSE array_append(${workspaces.workflowsActive}, ${name}) END`;
    } else if (change.active === false) {
      set.workflowsActive = sql`CASE WHEN ${workspaces.workflowsActive} IS NULL THEN NULL ELSE array_remove(${workspaces.workflowsActive}, ${name}) END`;
    }
    if (typeof change.encryptedWebhookSecret === "string") {
      const entryJson = JSON.stringify({
        [name]: change.encryptedWebhookSecret,
      });
      set.workflowsWebhooksEncrypted = sql`COALESCE(${workspaces.workflowsWebhooksEncrypted}, '{}'::jsonb) || ${entryJson}::jsonb`;
    } else if (change.encryptedWebhookSecret === null) {
      set.workflowsWebhooksEncrypted = sql`CASE WHEN ${workspaces.workflowsWebhooksEncrypted} IS NULL THEN NULL ELSE ${workspaces.workflowsWebhooksEncrypted} - ${name} END`;
    }
    if (Object.keys(set).length === 0) {
      return;
    }
    set.updatedAt = new Date();
    await this.getDb()
      .update(workspaces)
      .set(set as Partial<typeof workspaces.$inferInsert>)
      .where(eq(workspaces.id, toPgUuid(workspaceId)));
  }

  async touchWorkflowLastNeededAt(
    workspaceId: string,
    at: Date = new Date(),
  ): Promise<void> {
    if (!isEntityId(workspaceId)) {
      return;
    }
    await this.getDb()
      .update(workspaces)
      .set({ workflowsLastNeededAt: at, updatedAt: new Date() })
      .where(eq(workspaces.id, toPgUuid(workspaceId)));
  }

  // ── 2. Workspace API keys ────────────────────────────────────────────

  async findApiKeyByHash(keyHash: string): Promise<{
    workspace: WorkspaceRecord;
    apiKey: WorkspaceApiKeyRecord;
  } | null> {
    if (!keyHash) {
      return null;
    }
    const rows = await this.getDb()
      .select({ key: workspaceApiKeys, workspace: workspaces })
      .from(workspaceApiKeys)
      .innerJoin(workspaces, eq(workspaceApiKeys.workspaceId, workspaces.id))
      .where(eq(workspaceApiKeys.keyHash, keyHash))
      .limit(1);
    if (!rows[0]) {
      return null;
    }
    return {
      workspace: pgWorkspaceToRecord(rows[0].workspace),
      apiKey: pgApiKeyToRecord(rows[0].key),
    };
  }

  async listApiKeys(workspaceId: string): Promise<WorkspaceApiKeyRecord[]> {
    if (!isEntityId(workspaceId)) {
      return [];
    }
    const rows = await this.getDb()
      .select()
      .from(workspaceApiKeys)
      .where(eq(workspaceApiKeys.workspaceId, toPgUuid(workspaceId)))
      .orderBy(asc(workspaceApiKeys.createdAt), asc(workspaceApiKeys.id));
    return rows.map(pgApiKeyToRecord);
  }

  async createApiKey(input: CreateApiKeyInput): Promise<WorkspaceApiKeyRecord> {
    const db = this.getDb();
    const id = input.id ? toPgUuid(input.id) : newDualId().uuid;
    const createdByUuid = await this.resolveApiKeyCreatorWriteUserUuid(
      input.createdBy,
      db,
    );
    const [row] = await db
      .insert(workspaceApiKeys)
      .values({
        id,
        workspaceId: toPgUuid(input.workspaceId),
        name: input.name.trim(),
        keyHash: input.keyHash,
        prefix: input.prefix,
        scopes: input.scopes ?? null,
        createdBy: createdByUuid,
        agentRun: input.agentRun ?? null,
        recordWrites: input.recordWrites ?? null,
        createdAt: input.createdAt ?? new Date(),
        lastUsedAt: null,
      })
      .returning();
    return pgApiKeyToRecord(row);
  }

  async replaceApiKeyByNameReturningReplacedIds(
    input: CreateApiKeyInput,
  ): Promise<{ apiKey: WorkspaceApiKeyRecord; replacedIds: string[] }> {
    const db = this.getDb();
    const wsUuid = toPgUuid(input.workspaceId);
    const id = input.id ? toPgUuid(input.id) : newDualId().uuid;
    const trimmedName = input.name.trim();
    return db.transaction(async tx => {
      const removed = await tx
        .delete(workspaceApiKeys)
        .where(
          and(
            eq(workspaceApiKeys.workspaceId, wsUuid),
            eq(workspaceApiKeys.name, trimmedName),
          ),
        )
        .returning({ id: workspaceApiKeys.id });
      const createdByUuid = await this.resolveApiKeyCreatorWriteUserUuid(
        input.createdBy,
        tx,
      );
      const [row] = await tx
        .insert(workspaceApiKeys)
        .values({
          id,
          workspaceId: wsUuid,
          name: trimmedName,
          keyHash: input.keyHash,
          prefix: input.prefix,
          scopes: input.scopes ?? null,
          createdBy: createdByUuid,
          agentRun: input.agentRun ?? null,
          recordWrites: input.recordWrites ?? null,
          createdAt: input.createdAt ?? new Date(),
          lastUsedAt: null,
        })
        .returning();
      return {
        apiKey: pgApiKeyToRecord(row),
        replacedIds: removed.map(r => toWireId(r.id)),
      };
    });
  }

  async replaceApiKeyByName(
    input: CreateApiKeyInput,
  ): Promise<WorkspaceApiKeyRecord> {
    const { apiKey } =
      await this.replaceApiKeyByNameReturningReplacedIds(input);
    return apiKey;
  }

  async updateApiKeyScopesByName(
    workspaceId: string,
    name: string,
    scopes: WorkspaceApiKeyScope[],
  ): Promise<boolean> {
    if (!isEntityId(workspaceId)) {
      return false;
    }
    const rows = await this.getDb()
      .update(workspaceApiKeys)
      .set({ scopes })
      .where(
        and(
          eq(workspaceApiKeys.workspaceId, toPgUuid(workspaceId)),
          eq(workspaceApiKeys.name, name),
        ),
      )
      .returning({ id: workspaceApiKeys.id });
    return rows.length > 0;
  }

  async deleteApiKey(workspaceId: string, keyId: string): Promise<boolean> {
    if (!isEntityId(workspaceId) || !isEntityId(keyId)) {
      return false;
    }
    const rows = await this.getDb()
      .delete(workspaceApiKeys)
      .where(
        and(
          eq(workspaceApiKeys.workspaceId, toPgUuid(workspaceId)),
          eq(workspaceApiKeys.id, toPgUuid(keyId)),
        ),
      )
      .returning({ id: workspaceApiKeys.id });
    return rows.length > 0;
  }

  async deleteApiKeysByNameReturningIds(
    workspaceId: string,
    name: string,
  ): Promise<string[]> {
    if (!isEntityId(workspaceId)) {
      return [];
    }
    const rows = await this.getDb()
      .delete(workspaceApiKeys)
      .where(
        and(
          eq(workspaceApiKeys.workspaceId, toPgUuid(workspaceId)),
          eq(workspaceApiKeys.name, name),
        ),
      )
      .returning({ id: workspaceApiKeys.id });
    return rows.map(r => toWireId(r.id));
  }

  async deleteApiKeysByName(
    workspaceId: string,
    name: string,
  ): Promise<number> {
    return (await this.deleteApiKeysByNameReturningIds(workspaceId, name))
      .length;
  }

  async deleteApiKeysByCreatorReturningIds(
    workspaceId: string,
    createdBy: string,
  ): Promise<string[]> {
    if (!isEntityId(workspaceId) || !createdBy) {
      return [];
    }
    const db = this.getDb();
    const creatorUuid = await this.resolveReadUserUuid(createdBy, db);
    if (!creatorUuid) {
      return [];
    }
    const rows = await db
      .delete(workspaceApiKeys)
      .where(
        and(
          eq(workspaceApiKeys.workspaceId, toPgUuid(workspaceId)),
          eq(workspaceApiKeys.createdBy, creatorUuid),
        ),
      )
      .returning({ id: workspaceApiKeys.id });
    return rows.map(r => toWireId(r.id));
  }

  async deleteApiKeysByCreator(
    workspaceId: string,
    createdBy: string,
  ): Promise<number> {
    return (
      await this.deleteApiKeysByCreatorReturningIds(workspaceId, createdBy)
    ).length;
  }

  async pruneExpiredApiKeysByNamePrefixReturningIds(
    workspaceId: string,
    namePrefix: string,
    createdBefore: Date,
  ): Promise<string[]> {
    if (!isEntityId(workspaceId)) {
      return [];
    }
    const pattern = `${escapeLikePrefix(namePrefix)}%`;
    const rows = await this.getDb()
      .delete(workspaceApiKeys)
      .where(
        and(
          eq(workspaceApiKeys.workspaceId, toPgUuid(workspaceId)),
          sql`${workspaceApiKeys.name} LIKE ${pattern} ESCAPE '\\'`,
          lt(workspaceApiKeys.createdAt, createdBefore),
        ),
      )
      .returning({ id: workspaceApiKeys.id });
    return rows.map(r => toWireId(r.id));
  }

  async pruneExpiredApiKeysByNamePrefix(
    workspaceId: string,
    namePrefix: string,
    createdBefore: Date,
  ): Promise<number> {
    return (
      await this.pruneExpiredApiKeysByNamePrefixReturningIds(
        workspaceId,
        namePrefix,
        createdBefore,
      )
    ).length;
  }

  async touchApiKeyLastUsedReturningChanged(
    workspaceId: string,
    keyId: string,
    now: Date = new Date(),
    minIntervalMs: number = DEFAULT_LAST_USED_MIN_INTERVAL_MS,
  ): Promise<boolean> {
    if (!isEntityId(workspaceId) || !isEntityId(keyId)) {
      return false;
    }
    const cutoff = new Date(now.getTime() - minIntervalMs);
    const rows = await this.getDb()
      .update(workspaceApiKeys)
      .set({ lastUsedAt: now })
      .where(
        and(
          eq(workspaceApiKeys.id, toPgUuid(keyId)),
          eq(workspaceApiKeys.workspaceId, toPgUuid(workspaceId)),
          or(
            isNull(workspaceApiKeys.lastUsedAt),
            lt(workspaceApiKeys.lastUsedAt, cutoff),
          ),
        ),
      )
      .returning({ id: workspaceApiKeys.id });
    return rows.length > 0;
  }

  async touchApiKeyLastUsed(
    workspaceId: string,
    keyId: string,
    now: Date = new Date(),
    minIntervalMs: number = DEFAULT_LAST_USED_MIN_INTERVAL_MS,
  ): Promise<void> {
    await this.touchApiKeyLastUsedReturningChanged(
      workspaceId,
      keyId,
      now,
      minIntervalMs,
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
    const db = this.getDb();
    const pgUserUuid = await this.resolveReadUserUuid(userId, db);
    if (!pgUserUuid) {
      return null;
    }
    const rows = await db
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, toPgUuid(workspaceId)),
          eq(workspaceMembers.userId, pgUserUuid),
        ),
      )
      .limit(1);
    return rows[0] ? pgMemberToRecord(rows[0]) : null;
  }

  async findWorkspacesForUser(
    userId: string,
  ): Promise<Array<{ workspace: WorkspaceRecord; role: WorkspaceMemberRole }>> {
    if (!userId) {
      return [];
    }
    const db = this.getDb();
    const pgUserUuid = await this.resolveReadUserUuid(userId, db);
    if (!pgUserUuid) {
      return [];
    }
    const rows = await db
      .select({ workspace: workspaces, role: workspaceMembers.role })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
      .where(eq(workspaceMembers.userId, pgUserUuid));
    return rows.map(r => ({
      workspace: pgWorkspaceToRecord(r.workspace),
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
    const whereClause =
      roles && roles.length > 0
        ? and(
            eq(workspaceMembers.workspaceId, toPgUuid(workspaceId)),
            inArray(workspaceMembers.role, [...roles]),
          )
        : eq(workspaceMembers.workspaceId, toPgUuid(workspaceId));
    const rows = await this.getDb()
      .select()
      .from(workspaceMembers)
      .where(whereClause)
      .orderBy(asc(workspaceMembers.joinedAt), asc(workspaceMembers.id));
    return rows.map(pgMemberToRecord);
  }

  async listMembersWithUsers(
    workspaceId: string,
  ): Promise<WorkspaceMemberWithUser[]> {
    if (!isEntityId(workspaceId)) {
      return [];
    }
    const rows = await this.getDb()
      .select({
        member: workspaceMembers,
        userId: users.id,
        userEmail: users.email,
      })
      .from(workspaceMembers)
      .leftJoin(users, eq(workspaceMembers.userId, users.id))
      .where(eq(workspaceMembers.workspaceId, toPgUuid(workspaceId)))
      .orderBy(asc(workspaceMembers.joinedAt), asc(workspaceMembers.id));
    return rows.map(r => ({
      ...pgMemberToRecord(r.member),
      user:
        r.userId !== null && r.userEmail !== null
          ? { id: r.userId.toLowerCase(), email: r.userEmail }
          : null,
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
    const db = this.getDb();
    const unique = [...new Set(userIds.filter(Boolean))];
    const uuidCandidates = unique
      .filter(isUuidString)
      .map(u => u.toLowerCase());
    const userWhere =
      uuidCandidates.length > 0
        ? or(inArray(users.id, uuidCandidates), inArray(users.legacyId, unique))
        : inArray(users.legacyId, unique);
    const userRows = await db
      .select({ id: users.id, legacyId: users.legacyId })
      .from(users)
      .where(userWhere);

    const inputByPgUuid = new Map<string, string[]>();
    const mapInput = (pgUuid: string, inputId: string) => {
      const list = inputByPgUuid.get(pgUuid);
      if (list) {
        if (!list.includes(inputId)) {
          list.push(inputId);
        }
      } else {
        inputByPgUuid.set(pgUuid, [inputId]);
      }
    };
    const uniqueSet = new Set(unique);
    const lowerMap = new Map(unique.map(u => [u.toLowerCase(), u]));
    for (const u of userRows) {
      const pgId = u.id.toLowerCase();
      const directInput = lowerMap.get(pgId);
      if (directInput) {
        mapInput(pgId, directInput);
      }
      if (u.legacyId && uniqueSet.has(u.legacyId)) {
        mapInput(pgId, u.legacyId);
      }
    }
    const pgUuids = [...inputByPgUuid.keys()];
    if (pgUuids.length === 0) {
      return [];
    }

    const memberWhere = role
      ? and(
          eq(workspaceMembers.workspaceId, toPgUuid(workspaceId)),
          inArray(workspaceMembers.userId, pgUuids),
          eq(workspaceMembers.role, role),
        )
      : and(
          eq(workspaceMembers.workspaceId, toPgUuid(workspaceId)),
          inArray(workspaceMembers.userId, pgUuids),
        );
    const memberRows = await db
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(memberWhere);

    const matched: string[] = [];
    for (const m of memberRows) {
      const originals = inputByPgUuid.get(m.userId.toLowerCase()) ?? [];
      for (const orig of originals) {
        matched.push(orig);
      }
    }
    return matched;
  }

  async addMember(input: AddMemberInput): Promise<WorkspaceMemberWithUser> {
    const db = this.getDb();
    const pgUserUuid = await this.resolveRequiredWriteUserUuid(
      input.userId,
      db,
    );
    const now = input.joinedAt ?? new Date();
    const id = input.id ? toPgUuid(input.id) : newDualId().uuid;
    const [row] = await db
      .insert(workspaceMembers)
      .values({
        id,
        workspaceId: toPgUuid(input.workspaceId),
        userId: pgUserUuid,
        role: input.role,
        joinedAt: now,
        isDefaultMembership: input.isDefaultMembership ? true : null,
        updatedAt: now,
      })
      .returning();
    const [u] = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.id, pgUserUuid))
      .limit(1);
    return {
      ...pgMemberToRecord(row),
      user: u ? { id: u.id.toLowerCase(), email: u.email } : null,
    };
  }

  async addMemberIfNotExists(
    input: AddMemberInput,
  ): Promise<{ member: WorkspaceMemberRecord; inserted: boolean }> {
    const db = this.getDb();
    const pgUserUuid = await this.resolveRequiredWriteUserUuid(
      input.userId,
      db,
    );
    const wsUuid = toPgUuid(input.workspaceId);
    const now = input.joinedAt ?? new Date();
    const id = input.id ? toPgUuid(input.id) : newDualId().uuid;
    const insertedRows = await db
      .insert(workspaceMembers)
      .values({
        id,
        workspaceId: wsUuid,
        userId: pgUserUuid,
        role: input.role,
        joinedAt: now,
        isDefaultMembership: input.isDefaultMembership ? true : null,
        updatedAt: now,
      })
      .onConflictDoNothing({
        target: [workspaceMembers.workspaceId, workspaceMembers.userId],
      })
      .returning();
    if (insertedRows[0]) {
      return { member: pgMemberToRecord(insertedRows[0]), inserted: true };
    }
    const existing = await db
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, wsUuid),
          eq(workspaceMembers.userId, pgUserUuid),
        ),
      )
      .limit(1);
    if (!existing[0]) {
      throw new Error("Workspace member conflict without existing row");
    }
    return { member: pgMemberToRecord(existing[0]), inserted: false };
  }

  async updateMemberRole(
    workspaceId: string,
    userId: string,
    role: WorkspaceMemberRole,
  ): Promise<WorkspaceMemberWithUser | null> {
    if (!isEntityId(workspaceId) || !userId) {
      return null;
    }
    const db = this.getDb();
    const pgUserUuid = await this.resolveReadUserUuid(userId, db);
    if (!pgUserUuid) {
      return null;
    }
    const rows = await db
      .update(workspaceMembers)
      .set({ role, updatedAt: new Date() })
      .where(
        and(
          eq(workspaceMembers.workspaceId, toPgUuid(workspaceId)),
          eq(workspaceMembers.userId, pgUserUuid),
        ),
      )
      .returning();
    if (!rows[0]) {
      return null;
    }
    const [u] = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.id, pgUserUuid))
      .limit(1);
    return {
      ...pgMemberToRecord(rows[0]),
      user: u ? { id: u.id.toLowerCase(), email: u.email } : null,
    };
  }

  async removeMemberReturningId(
    workspaceId: string,
    userId: string,
  ): Promise<string | null> {
    if (!isEntityId(workspaceId) || !userId) {
      return null;
    }
    const db = this.getDb();
    const pgUserUuid = await this.resolveReadUserUuid(userId, db);
    if (!pgUserUuid) {
      return null;
    }
    const rows = await db
      .delete(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, toPgUuid(workspaceId)),
          eq(workspaceMembers.userId, pgUserUuid),
        ),
      )
      .returning({ id: workspaceMembers.id });
    return rows[0] ? toWireId(rows[0].id) : null;
  }

  async removeMember(workspaceId: string, userId: string): Promise<boolean> {
    return (await this.removeMemberReturningId(workspaceId, userId)) !== null;
  }

  // ── 4. Workspace invites ─────────────────────────────────────────────

  async findPendingInviteByWorkspaceAndEmail(
    workspaceId: string,
    email: string,
  ): Promise<WorkspaceInviteRecord | null> {
    if (!isEntityId(workspaceId)) {
      return null;
    }
    const rows = await this.getDb()
      .select()
      .from(workspaceInvites)
      .where(
        and(
          eq(workspaceInvites.workspaceId, toPgUuid(workspaceId)),
          eq(workspaceInvites.email, normalizeEmail(email)),
          isNull(workspaceInvites.acceptedAt),
        ),
      )
      .limit(1);
    return rows[0] ? pgInviteToRecord(rows[0]) : null;
  }

  async createInvite(input: CreateInviteInput): Promise<WorkspaceInviteRecord> {
    const db = this.getDb();
    const now = new Date();
    const id = input.id ? toPgUuid(input.id) : newDualId(now.getTime()).uuid;
    // Match Mongo ObjectId second-precision timestamp so Stage 4 reverse-shadow
    // compare and offline parity verification agree to the exact millisecond.
    const createdAt =
      objectIdUuidTimestamp(id) ??
      new Date(Math.floor(now.getTime() / 1000) * 1000);
    const inviterUuid = await this.resolveNullableWriteUserUuid(
      input.invitedBy,
      db,
    );
    const [row] = await db
      .insert(workspaceInvites)
      .values({
        id,
        workspaceId: toPgUuid(input.workspaceId),
        email: normalizeEmail(input.email),
        token: input.token,
        role: input.role,
        invitedBy: inviterUuid,
        expiresAt: input.expiresAt,
        acceptedAt: null,
        createdAt,
        updatedAt: createdAt,
      })
      .returning();
    return pgInviteToRecord(row);
  }

  async refreshInvite(
    inviteId: string,
    patch: { expiresAt: Date; invitedBy: string },
  ): Promise<WorkspaceInviteRecord | null> {
    if (!isEntityId(inviteId)) {
      return null;
    }
    const db = this.getDb();
    const inviterUuid = await this.resolveNullableWriteUserUuid(
      patch.invitedBy,
      db,
    );
    const rows = await db
      .update(workspaceInvites)
      .set({
        expiresAt: patch.expiresAt,
        invitedBy: inviterUuid,
        updatedAt: new Date(),
      })
      .where(eq(workspaceInvites.id, toPgUuid(inviteId)))
      .returning();
    return rows[0] ? pgInviteToRecord(rows[0]) : null;
  }

  async findPendingInviteByToken(
    token: string,
  ): Promise<WorkspaceInviteWithRefs | null> {
    const rows = await this.getDb()
      .select({
        invite: workspaceInvites,
        wsId: workspaces.id,
        wsName: workspaces.name,
        inviterId: users.id,
        inviterEmail: users.email,
      })
      .from(workspaceInvites)
      .leftJoin(workspaces, eq(workspaceInvites.workspaceId, workspaces.id))
      .leftJoin(users, eq(workspaceInvites.invitedBy, users.id))
      .where(
        and(
          eq(workspaceInvites.token, token),
          isNull(workspaceInvites.acceptedAt),
        ),
      )
      .limit(1);
    const r = rows[0];
    if (!r) {
      return null;
    }
    return {
      ...pgInviteToRecord(r.invite),
      workspace:
        r.wsId !== null && r.wsName !== null
          ? { id: toWireId(r.wsId), name: r.wsName }
          : null,
      inviter:
        r.inviterId !== null && r.inviterEmail !== null
          ? { id: r.inviterId.toLowerCase(), email: r.inviterEmail }
          : null,
    };
  }

  async listPendingInvitesForWorkspace(
    workspaceId: string,
    now: Date = new Date(),
  ): Promise<WorkspaceInviteWithRefs[]> {
    if (!isEntityId(workspaceId)) {
      return [];
    }
    const rows = await this.getDb()
      .select({
        invite: workspaceInvites,
        wsId: workspaces.id,
        wsName: workspaces.name,
        inviterId: users.id,
        inviterEmail: users.email,
      })
      .from(workspaceInvites)
      .leftJoin(workspaces, eq(workspaceInvites.workspaceId, workspaces.id))
      .leftJoin(users, eq(workspaceInvites.invitedBy, users.id))
      .where(
        and(
          eq(workspaceInvites.workspaceId, toPgUuid(workspaceId)),
          isNull(workspaceInvites.acceptedAt),
          gt(workspaceInvites.expiresAt, now),
        ),
      )
      .orderBy(desc(workspaceInvites.createdAt), desc(workspaceInvites.id));
    return rows.map(r => ({
      ...pgInviteToRecord(r.invite),
      workspace:
        r.wsId !== null && r.wsName !== null
          ? { id: toWireId(r.wsId), name: r.wsName }
          : null,
      inviter:
        r.inviterId !== null && r.inviterEmail !== null
          ? { id: r.inviterId.toLowerCase(), email: r.inviterEmail }
          : null,
    }));
  }

  async listPendingInvitesForEmail(
    email: string,
    now: Date = new Date(),
  ): Promise<WorkspaceInviteWithRefs[]> {
    const rows = await this.getDb()
      .select({
        invite: workspaceInvites,
        wsId: workspaces.id,
        wsName: workspaces.name,
        inviterId: users.id,
        inviterEmail: users.email,
      })
      .from(workspaceInvites)
      .leftJoin(workspaces, eq(workspaceInvites.workspaceId, workspaces.id))
      .leftJoin(users, eq(workspaceInvites.invitedBy, users.id))
      .where(
        and(
          eq(workspaceInvites.email, normalizeEmail(email)),
          isNull(workspaceInvites.acceptedAt),
          gt(workspaceInvites.expiresAt, now),
        ),
      )
      .orderBy(desc(workspaceInvites.createdAt), desc(workspaceInvites.id));
    return rows.map(r => ({
      ...pgInviteToRecord(r.invite),
      workspace:
        r.wsId !== null && r.wsName !== null
          ? { id: toWireId(r.wsId), name: r.wsName }
          : null,
      inviter:
        r.inviterId !== null && r.inviterEmail !== null
          ? { id: r.inviterId.toLowerCase(), email: r.inviterEmail }
          : null,
    }));
  }

  async cancelInvite(workspaceId: string, inviteId: string): Promise<boolean> {
    if (!isEntityId(workspaceId) || !isEntityId(inviteId)) {
      return false;
    }
    const rows = await this.getDb()
      .delete(workspaceInvites)
      .where(
        and(
          eq(workspaceInvites.id, toPgUuid(inviteId)),
          eq(workspaceInvites.workspaceId, toPgUuid(workspaceId)),
        ),
      )
      .returning({ id: workspaceInvites.id });
    return rows.length > 0;
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
    return this.getDb().transaction(async tx => {
      const pgUserUuid = await this.resolveRequiredWriteUserUuid(userId, tx);
      const claimedRows = await tx
        .update(workspaceInvites)
        .set({ acceptedAt: now, updatedAt: now })
        .where(
          and(
            eq(workspaceInvites.token, token),
            isNull(workspaceInvites.acceptedAt),
            gt(workspaceInvites.expiresAt, now),
          ),
        )
        .returning();
      const claimed = claimedRows[0];
      if (!claimed) {
        throw new Error("Invalid or expired invite");
      }

      const existingMemberRows = await tx
        .select()
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, claimed.workspaceId),
            eq(workspaceMembers.userId, pgUserUuid),
          ),
        )
        .limit(1);

      let memberRow = existingMemberRows[0];
      if (!memberRow) {
        const [insertedMember] = await tx
          .insert(workspaceMembers)
          .values({
            id: newDualId(now.getTime()).uuid,
            workspaceId: claimed.workspaceId,
            userId: pgUserUuid,
            role: claimed.role,
            joinedAt: now,
            isDefaultMembership: null,
            updatedAt: now,
          })
          .onConflictDoNothing({
            target: [workspaceMembers.workspaceId, workspaceMembers.userId],
          })
          .returning();
        if (insertedMember) {
          memberRow = insertedMember;
        } else {
          const [refetched] = await tx
            .select()
            .from(workspaceMembers)
            .where(
              and(
                eq(workspaceMembers.workspaceId, claimed.workspaceId),
                eq(workspaceMembers.userId, pgUserUuid),
              ),
            )
            .limit(1);
          memberRow = refetched;
        }
      }

      const [wsRow] = await tx
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, claimed.workspaceId))
        .limit(1);
      if (!wsRow) {
        throw new Error("Workspace not found");
      }
      return {
        workspace: pgWorkspaceToRecord(wsRow),
        member: pgMemberToRecord(memberRow),
        invite: pgInviteToRecord(claimed),
      };
    });
  }

  // ── 5. Workspace user handles ────────────────────────────────────────

  async listHandles(workspaceId: string): Promise<WorkspaceUserHandleRecord[]> {
    if (!isEntityId(workspaceId)) {
      return [];
    }
    const rows = await this.getDb()
      .select()
      .from(workspaceUserHandles)
      .where(eq(workspaceUserHandles.workspaceId, toPgUuid(workspaceId)));
    return rows.map(pgHandleToRecord);
  }

  async insertHandlesBestEffort(
    workspaceId: string,
    rows: ReadonlyArray<{ userId: string; handle: string }>,
  ): Promise<{ inserted: WorkspaceUserHandleRecord[]; hadConflict: boolean }> {
    if (!isEntityId(workspaceId) || rows.length === 0) {
      return { inserted: [], hadConflict: false };
    }
    const db = this.getDb();
    const wsUuid = toPgUuid(workspaceId);
    const now = new Date();
    const inserted: WorkspaceUserHandleRecord[] = [];
    let hadConflict = false;

    for (const r of rows) {
      const userUuid = await this.resolveNullableWriteUserUuid(r.userId, db);
      const res = await db
        .insert(workspaceUserHandles)
        .values({
          id: newDualId(now.getTime()).uuid,
          workspaceId: wsUuid,
          userId: userUuid,
          handle: r.handle,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .returning();
      if (res[0]) {
        inserted.push(pgHandleToRecord(res[0]));
      } else {
        hadConflict = true;
      }
    }

    return { inserted, hadConflict };
  }

  // ── 6. MCP OAuth clients ─────────────────────────────────────────────

  async findMcpClient(clientId: string): Promise<McpOAuthClientRecord | null> {
    if (!clientId) {
      return null;
    }
    const rows = await this.getDb()
      .select()
      .from(mcpOAuthClients)
      .where(eq(mcpOAuthClients.clientId, clientId))
      .limit(1);
    return rows[0] ? pgMcpClientToRecord(rows[0]) : null;
  }

  async createMcpClient(
    input: CreateMcpClientInput,
  ): Promise<McpOAuthClientRecord> {
    const id = input.id ? toPgUuid(input.id) : newDualId().uuid;
    const [row] = await this.getDb()
      .insert(mcpOAuthClients)
      .values({
        id,
        clientId: input.clientId,
        clientName: input.clientName ?? null,
        redirectUris: input.redirectUris,
        createdAt: input.createdAt ?? new Date(),
      })
      .returning();
    return pgMcpClientToRecord(row);
  }

  async ensureMcpClient(
    input: CreateMcpClientInput,
  ): Promise<McpOAuthClientRecord> {
    const id = input.id ? toPgUuid(input.id) : newDualId().uuid;
    const inserted = await this.getDb()
      .insert(mcpOAuthClients)
      .values({
        id,
        clientId: input.clientId,
        clientName: input.clientName ?? null,
        redirectUris: input.redirectUris,
        createdAt: input.createdAt ?? new Date(),
      })
      .onConflictDoNothing({ target: mcpOAuthClients.clientId })
      .returning();
    if (inserted[0]) {
      return pgMcpClientToRecord(inserted[0]);
    }
    const existing = await this.findMcpClient(input.clientId);
    if (!existing) {
      throw new Error(
        `MCP OAuth client missing after conflict: ${input.clientId}`,
      );
    }
    return existing;
  }

  // ── 7. MCP OAuth codes ───────────────────────────────────────────────

  async createMcpCode(input: CreateMcpCodeInput): Promise<McpOAuthCodeRecord> {
    const db = this.getDb();
    const pgUserUuid = await this.resolveRequiredWriteUserUuid(
      input.userId,
      db,
    );
    const id = input.id ? toPgUuid(input.id) : newDualId().uuid;
    const [row] = await db
      .insert(mcpOAuthCodes)
      .values({
        id,
        codeHash: input.codeHash,
        clientId: input.clientId,
        userId: pgUserUuid,
        workspaceId: toPgUuid(input.workspaceId),
        redirectUri: input.redirectUri,
        codeChallenge: input.codeChallenge,
        scopes: input.scopes,
        expiresAt: input.expiresAt,
        usedAt: null,
      })
      .returning();
    return pgMcpCodeToRecord(row);
  }

  async redeemMcpCodeOnce(
    codeHash: string,
    now: Date = new Date(),
  ): Promise<McpOAuthCodeRecord | null> {
    const rows = await this.getDb()
      .update(mcpOAuthCodes)
      .set({ usedAt: now })
      .where(
        and(
          eq(mcpOAuthCodes.codeHash, codeHash),
          isNull(mcpOAuthCodes.usedAt),
          gt(mcpOAuthCodes.expiresAt, now),
        ),
      )
      .returning();
    return rows[0] ? pgMcpCodeToRecord(rows[0]) : null;
  }

  // ── 8. MCP OAuth tokens ──────────────────────────────────────────────

  async createMcpToken(
    input: CreateMcpTokenInput,
  ): Promise<McpOAuthTokenRecord> {
    const db = this.getDb();
    const pgUserUuid = await this.resolveRequiredWriteUserUuid(
      input.userId,
      db,
    );
    const now = input.createdAt ?? new Date();
    const id = input.id ? toPgUuid(input.id) : newDualId(now.getTime()).uuid;
    const [row] = await db
      .insert(mcpOAuthTokens)
      .values({
        id,
        accessTokenHash: input.accessTokenHash,
        refreshTokenHash: input.refreshTokenHash,
        clientId: input.clientId,
        userId: pgUserUuid,
        workspaceId: toPgUuid(input.workspaceId),
        agentSessionId: input.agentSessionId ?? null,
        scopes: input.scopes,
        accessExpiresAt: input.accessExpiresAt,
        refreshExpiresAt: input.refreshExpiresAt ?? null,
        createdAt: now,
        lastUsedAt: null,
        updatedAt: now,
      })
      .returning();
    return pgMcpTokenToRecord(row);
  }

  async findValidMcpTokenByAccessHash(
    accessTokenHash: string,
    now: Date = new Date(),
  ): Promise<McpOAuthTokenRecord | null> {
    const rows = await this.getDb()
      .select()
      .from(mcpOAuthTokens)
      .where(
        and(
          eq(mcpOAuthTokens.accessTokenHash, accessTokenHash),
          gt(mcpOAuthTokens.accessExpiresAt, now),
        ),
      )
      .limit(1);
    return rows[0] ? pgMcpTokenToRecord(rows[0]) : null;
  }

  async hasActiveMcpAgentSession(input: {
    workspaceId: string;
    userId: string;
    clientId: string;
    agentSessionId: string;
    now?: Date;
  }): Promise<boolean> {
    if (!isEntityId(input.workspaceId) || !input.userId) {
      return false;
    }
    const db = this.getDb();
    const pgUserUuid = await this.resolveReadUserUuid(input.userId, db);
    if (!pgUserUuid) {
      return false;
    }
    const rows = await db
      .select({ id: mcpOAuthTokens.id })
      .from(mcpOAuthTokens)
      .where(
        and(
          eq(mcpOAuthTokens.workspaceId, toPgUuid(input.workspaceId)),
          eq(mcpOAuthTokens.userId, pgUserUuid),
          eq(mcpOAuthTokens.clientId, input.clientId),
          eq(mcpOAuthTokens.agentSessionId, input.agentSessionId),
          gt(mcpOAuthTokens.refreshExpiresAt, input.now ?? new Date()),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async rotateMcpRefreshToken(
    input: RotateMcpRefreshTokenInput,
  ): Promise<McpOAuthTokenRecord | null> {
    const now = input.now ?? new Date();
    // Strip internal scopes atomically in SQL (`array_remove` chain keeps exact order and works in both PG & PGlite).
    let scopesExpr = sql`${mcpOAuthTokens.scopes}`;
    for (const s of input.stripScopes) {
      scopesExpr = sql`array_remove(${scopesExpr}, ${s})`;
    }
    const rows = await this.getDb()
      .update(mcpOAuthTokens)
      .set({
        accessTokenHash: input.newAccessTokenHash,
        refreshTokenHash: input.newRefreshTokenHash,
        accessExpiresAt: input.newAccessExpiresAt,
        refreshExpiresAt: input.newRefreshExpiresAt,
        scopes: scopesExpr as unknown as string[],
        updatedAt: now,
      })
      .where(
        and(
          eq(mcpOAuthTokens.refreshTokenHash, input.currentRefreshTokenHash),
          eq(mcpOAuthTokens.clientId, input.clientId),
          or(
            isNull(mcpOAuthTokens.refreshExpiresAt),
            gt(mcpOAuthTokens.refreshExpiresAt, now),
          ),
        ),
      )
      .returning();
    return rows[0] ? pgMcpTokenToRecord(rows[0]) : null;
  }

  async touchMcpTokenLastUsedReturningChanged(
    tokenId: string,
    now: Date = new Date(),
    minIntervalMs: number = DEFAULT_LAST_USED_MIN_INTERVAL_MS,
  ): Promise<boolean> {
    if (!isEntityId(tokenId)) {
      return false;
    }
    const cutoff = new Date(now.getTime() - minIntervalMs);
    const rows = await this.getDb()
      .update(mcpOAuthTokens)
      .set({ lastUsedAt: now, updatedAt: now })
      .where(
        and(
          eq(mcpOAuthTokens.id, toPgUuid(tokenId)),
          or(
            isNull(mcpOAuthTokens.lastUsedAt),
            lt(mcpOAuthTokens.lastUsedAt, cutoff),
          ),
        ),
      )
      .returning({ id: mcpOAuthTokens.id });
    return rows.length > 0;
  }

  async touchMcpTokenLastUsed(
    tokenId: string,
    now: Date = new Date(),
    minIntervalMs: number = DEFAULT_LAST_USED_MIN_INTERVAL_MS,
  ): Promise<void> {
    await this.touchMcpTokenLastUsedReturningChanged(
      tokenId,
      now,
      minIntervalMs,
    );
  }

  async listMcpConnections(
    workspaceId: string,
    now: Date = new Date(),
  ): Promise<McpConnectionSummary[]> {
    if (!isEntityId(workspaceId)) {
      return [];
    }
    const connectedAtExpr = sql<Date>`min(${mcpOAuthTokens.createdAt})`;
    const lastUsedAtExpr = sql<Date | null>`max(${mcpOAuthTokens.lastUsedAt})`;
    const accessExpiresAtExpr = sql<Date>`max(${mcpOAuthTokens.accessExpiresAt})`;

    const rows = await this.getDb()
      .select({
        clientId: mcpOAuthTokens.clientId,
        clientName: mcpOAuthClients.clientName,
        userId: mcpOAuthTokens.userId,
        connectedAt: connectedAtExpr,
        lastUsedAt: lastUsedAtExpr,
        accessExpiresAt: accessExpiresAtExpr,
      })
      .from(mcpOAuthTokens)
      .leftJoin(
        mcpOAuthClients,
        eq(mcpOAuthTokens.clientId, mcpOAuthClients.clientId),
      )
      .where(
        and(
          eq(mcpOAuthTokens.workspaceId, toPgUuid(workspaceId)),
          or(
            isNull(mcpOAuthTokens.refreshExpiresAt),
            gt(mcpOAuthTokens.refreshExpiresAt, now),
          ),
        ),
      )
      .groupBy(
        mcpOAuthTokens.clientId,
        mcpOAuthClients.clientName,
        mcpOAuthTokens.userId,
      )
      .orderBy(
        sql`max(${mcpOAuthTokens.lastUsedAt}) DESC NULLS LAST`,
        sql`min(${mcpOAuthTokens.createdAt}) DESC`,
      );

    return rows.map(r => {
      const summary: McpConnectionSummary = {
        clientId: r.clientId,
        userId: r.userId.toLowerCase(),
        connectedAt:
          r.connectedAt instanceof Date
            ? r.connectedAt
            : new Date(r.connectedAt),
        accessExpiresAt:
          r.accessExpiresAt instanceof Date
            ? r.accessExpiresAt
            : new Date(r.accessExpiresAt),
      };
      if (r.clientName !== null) {
        summary.clientName = r.clientName;
      }
      if (r.lastUsedAt !== null) {
        summary.lastUsedAt =
          r.lastUsedAt instanceof Date ? r.lastUsedAt : new Date(r.lastUsedAt);
      }
      return summary;
    });
  }

  async revokeMcpGrantsForMemberReturningIds(input: {
    workspaceId: string;
    userId: string;
  }): Promise<string[]> {
    if (!isEntityId(input.workspaceId) || !input.userId) {
      return [];
    }
    const db = this.getDb();
    const pgUserUuid = await this.resolveReadUserUuid(input.userId, db);
    if (!pgUserUuid) {
      return [];
    }
    const rows = await db
      .delete(mcpOAuthTokens)
      .where(
        and(
          eq(mcpOAuthTokens.workspaceId, toPgUuid(input.workspaceId)),
          eq(mcpOAuthTokens.userId, pgUserUuid),
        ),
      )
      .returning({ id: mcpOAuthTokens.id });
    return rows.map(r => toWireId(r.id));
  }

  async revokeMcpGrantsForMember(input: {
    workspaceId: string;
    userId: string;
  }): Promise<number> {
    return (await this.revokeMcpGrantsForMemberReturningIds(input)).length;
  }

  async revokeMcpConnectionReturningIds(input: {
    workspaceId: string;
    clientId: string;
    userId: string;
  }): Promise<string[]> {
    if (!isEntityId(input.workspaceId) || !input.userId) {
      return [];
    }
    const db = this.getDb();
    const pgUserUuid = await this.resolveReadUserUuid(input.userId, db);
    if (!pgUserUuid) {
      return [];
    }
    const rows = await db
      .delete(mcpOAuthTokens)
      .where(
        and(
          eq(mcpOAuthTokens.workspaceId, toPgUuid(input.workspaceId)),
          eq(mcpOAuthTokens.clientId, input.clientId),
          eq(mcpOAuthTokens.userId, pgUserUuid),
        ),
      )
      .returning({ id: mcpOAuthTokens.id });
    return rows.map(r => toWireId(r.id));
  }

  async revokeMcpConnection(input: {
    workspaceId: string;
    clientId: string;
    userId: string;
  }): Promise<number> {
    return (await this.revokeMcpConnectionReturningIds(input)).length;
  }

  // ── 9. ACP plan grants ───────────────────────────────────────────────

  async upsertAcpGrant(
    input: UpsertAcpGrantInput,
  ): Promise<AcpPlanGrantRecord> {
    const db = this.getDb();
    const pgUserUuid = await this.resolveRequiredWriteUserUuid(
      input.userId,
      db,
    );
    const now = new Date();
    const id = input.id ? toPgUuid(input.id) : newDualId(now.getTime()).uuid;
    const wsUuid = toPgUuid(input.workspaceId);
    const [row] = await db
      .insert(acpPlanGrants)
      .values({
        id,
        workspaceId: wsUuid,
        userId: pgUserUuid,
        agentSessionId: input.agentSessionId,
        planDigest: input.planDigest,
        grants: input.grants,
        status: "approved",
        expiresAt: input.expiresAt,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: acpPlanGrants.agentSessionId,
        set: {
          workspaceId: wsUuid,
          userId: pgUserUuid,
          planDigest: input.planDigest,
          grants: input.grants,
          status: "approved",
          expiresAt: input.expiresAt,
          updatedAt: now,
        },
      })
      .returning();
    return pgAcpGrantToRecord(row);
  }

  async revokeAcpGrantReturningId(input: {
    workspaceId: string;
    userId: string;
    agentSessionId: string;
    now?: Date;
  }): Promise<string | null> {
    if (!isEntityId(input.workspaceId) || !input.userId) {
      return null;
    }
    const db = this.getDb();
    const pgUserUuid = await this.resolveReadUserUuid(input.userId, db);
    if (!pgUserUuid) {
      return null;
    }
    const now = input.now ?? new Date();
    const rows = await db
      .update(acpPlanGrants)
      .set({ status: "revoked", expiresAt: now, updatedAt: now })
      .where(
        and(
          eq(acpPlanGrants.workspaceId, toPgUuid(input.workspaceId)),
          eq(acpPlanGrants.userId, pgUserUuid),
          eq(acpPlanGrants.agentSessionId, input.agentSessionId),
        ),
      )
      .returning({ id: acpPlanGrants.id });
    return rows[0] ? toWireId(rows[0].id) : null;
  }

  async revokeAcpGrant(input: {
    workspaceId: string;
    userId: string;
    agentSessionId: string;
    now?: Date;
  }): Promise<boolean> {
    return (await this.revokeAcpGrantReturningId(input)) !== null;
  }

  async findActiveAcpGrant(input: {
    workspaceId: string;
    userId: string;
    agentSessionId: string;
    now?: Date;
  }): Promise<AcpPlanGrantRecord | null> {
    if (
      !isEntityId(input.workspaceId) ||
      !input.userId ||
      !input.agentSessionId
    ) {
      return null;
    }
    const db = this.getDb();
    const pgUserUuid = await this.resolveReadUserUuid(input.userId, db);
    if (!pgUserUuid) {
      return null;
    }
    const rows = await db
      .select()
      .from(acpPlanGrants)
      .where(
        and(
          eq(acpPlanGrants.workspaceId, toPgUuid(input.workspaceId)),
          eq(acpPlanGrants.userId, pgUserUuid),
          eq(acpPlanGrants.agentSessionId, input.agentSessionId),
          eq(acpPlanGrants.status, "approved"),
          gt(acpPlanGrants.expiresAt, input.now ?? new Date()),
        ),
      )
      .limit(1);
    return rows[0] ? pgAcpGrantToRecord(rows[0]) : null;
  }

  // ── 10. GitHub installations ─────────────────────────────────────────

  async listGitHubInstallations(
    workspaceId: string,
  ): Promise<GitHubInstallationRecord[]> {
    if (!isEntityId(workspaceId)) {
      return [];
    }
    const rows = await this.getDb()
      .select()
      .from(githubInstallations)
      .where(eq(githubInstallations.workspaceId, toPgUuid(workspaceId)));
    return rows.map(pgGitHubInstallationToRecord);
  }

  async findGitHubInstallation(
    workspaceId: string,
    installationId: number,
  ): Promise<GitHubInstallationRecord | null> {
    if (!isEntityId(workspaceId)) {
      return null;
    }
    const rows = await this.getDb()
      .select()
      .from(githubInstallations)
      .where(
        and(
          eq(githubInstallations.workspaceId, toPgUuid(workspaceId)),
          eq(githubInstallations.installationId, installationId),
        ),
      )
      .limit(1);
    return rows[0] ? pgGitHubInstallationToRecord(rows[0]) : null;
  }

  async upsertGitHubInstallation(
    input: UpsertGitHubInstallationInput,
  ): Promise<GitHubInstallationRecord> {
    const db = this.getDb();
    const createdByUuid = await this.resolveNullableWriteUserUuid(
      input.createdBy,
      db,
    );
    const now = new Date();
    const id = input.id ? toPgUuid(input.id) : newDualId(now.getTime()).uuid;
    const [row] = await db
      .insert(githubInstallations)
      .values({
        id,
        workspaceId: toPgUuid(input.workspaceId),
        installationId: input.installationId,
        accountLogin: input.accountLogin.trim(),
        accountType: input.accountType,
        repositorySelection: input.repositorySelection,
        createdBy: createdByUuid,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          githubInstallations.workspaceId,
          githubInstallations.installationId,
        ],
        set: {
          accountLogin: input.accountLogin.trim(),
          accountType: input.accountType,
          repositorySelection: input.repositorySelection,
          updatedAt: now,
        },
      })
      .returning();
    return pgGitHubInstallationToRecord(row);
  }

  async deleteGitHubInstallationReturningId(
    workspaceId: string,
    installationId: number,
  ): Promise<string | null> {
    if (!isEntityId(workspaceId)) {
      return null;
    }
    const rows = await this.getDb()
      .delete(githubInstallations)
      .where(
        and(
          eq(githubInstallations.workspaceId, toPgUuid(workspaceId)),
          eq(githubInstallations.installationId, installationId),
        ),
      )
      .returning({ id: githubInstallations.id });
    return rows[0] ? toWireId(rows[0].id) : null;
  }

  async deleteGitHubInstallation(
    workspaceId: string,
    installationId: number,
  ): Promise<boolean> {
    return (
      (await this.deleteGitHubInstallationReturningId(
        workspaceId,
        installationId,
      )) !== null
    );
  }

  async deleteGitHubInstallationsByInstallationIdReturningIds(
    installationId: number,
  ): Promise<string[]> {
    const rows = await this.getDb()
      .delete(githubInstallations)
      .where(eq(githubInstallations.installationId, installationId))
      .returning({ id: githubInstallations.id });
    return rows.map(r => toWireId(r.id));
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

  async pruneStaleGitHubInstallationsReturningIds(
    workspaceId: string,
    accountLogin: string,
    keepInstallationId: number,
  ): Promise<string[]> {
    if (!isEntityId(workspaceId)) {
      return [];
    }
    const rows = await this.getDb()
      .delete(githubInstallations)
      .where(
        and(
          eq(githubInstallations.workspaceId, toPgUuid(workspaceId)),
          eq(githubInstallations.accountLogin, accountLogin),
          ne(githubInstallations.installationId, keepInstallationId),
        ),
      )
      .returning({ id: githubInstallations.id });
    return rows.map(r => toWireId(r.id));
  }

  async pruneStaleGitHubInstallations(
    workspaceId: string,
    accountLogin: string,
    keepInstallationId: number,
  ): Promise<number> {
    return (
      await this.pruneStaleGitHubInstallationsReturningIds(
        workspaceId,
        accountLogin,
        keepInstallationId,
      )
    ).length;
  }
}
