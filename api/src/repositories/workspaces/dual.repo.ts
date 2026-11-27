/**
 * 5-stage dual-run `WorkspaceRepository` for all 10 tables of Phase 1B
 * (`workspaces_core` + `github_installations`), powered by `MigrationRouter`.
 *
 * Hot-path invariant (zero eager PG lookups):
 *   - NEVER calls `getState()`, `resolveUserUuid()`, or any PG query BEFORE
 *     `dualRead` / `router.executeRead`.
 *   - In `mongo_only`, `dual_write_mongo_read`, and unsampled Stage 3 reads,
 *     ZERO Postgres queries execute.
 *   - In Stage 3/4 shadow reads, legacy user-ID canonicalization runs ONLY
 *     inside the asynchronously sampled secondary branch (off the critical path).
 *
 * Write invariant:
 *   - Primary runs its native operation (atomic CAS / transaction / single-use).
 *   - Secondary resyncs the affected rows from primary (`resyncToPg` / `resyncToMongo`)
 *     under bounded timeout, enqueueing ID-only `sync-retry` payloads on failure.
 */
import { getPgDb, type MakoPgDb } from "../../database/pg/client";
import { isUuidv7 } from "../../database/pg/id-codec";
import { migrationRouter, type MigrationRouter } from "../../migration/router";
import {
  dualRead,
  dualWrite,
  type DualContext,
  type ResyncTarget,
} from "./dual-write";
import { sortById } from "./mapper";
import { MongoWorkspaceRepository } from "./mongo.repo";
import { PgWorkspaceRepository } from "./pg.repo";
import { resolveMongoUserIdMap, resolvePgUserUuidMap } from "./sync";
import {
  WORKSPACES_DOMAIN,
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

export interface DualWorkspaceRepositoryDeps {
  mongo?: MongoWorkspaceRepository;
  pg?: PgWorkspaceRepository;
  router?: MigrationRouter;
  getDb?: () => MakoPgDb;
}

function normUserId(
  id: string,
  userMap: Map<string, string>,
  nullableAudit: boolean,
): string {
  if (!id) {
    return "";
  }
  const mapped = userMap.get(id) ?? userMap.get(id.toLowerCase());
  if (mapped) {
    return mapped;
  }
  if (nullableAudit && !isUuidv7(id)) {
    return "";
  }
  return id.toLowerCase();
}

export class DualWorkspaceRepository implements WorkspaceRepository {
  readonly mongo: MongoWorkspaceRepository;
  readonly pg: PgWorkspaceRepository;
  private readonly ctx: DualContext;
  private readonly getDb: () => MakoPgDb;

  constructor(deps: DualWorkspaceRepositoryDeps = {}) {
    this.mongo = deps.mongo ?? new MongoWorkspaceRepository();
    this.pg = deps.pg ?? new PgWorkspaceRepository({ getDb: deps.getDb });
    this.ctx = { router: deps.router, getDb: deps.getDb };
    this.getDb = deps.getDb ?? getPgDb;
  }

  /** Helper used ONLY inside sampled secondary shadow reads (never on the hot path). */
  private async populateUserUuidMap(
    userIds: readonly string[],
    target: Map<string, string>,
  ): Promise<void> {
    const legacyIds = [
      ...new Set(userIds.filter(id => Boolean(id) && !isUuidv7(id))),
    ];
    if (legacyIds.length === 0) {
      return;
    }
    const resolved = await resolvePgUserUuidMap(this.getDb(), legacyIds).catch(
      () => new Map<string, string>(),
    );
    for (const [k, v] of resolved) {
      target.set(k, v);
    }
  }

  /** Helper used ONLY inside sampled Stage 4 reverse-shadow reads. */
  private async resolveMongoLookupUserId(userId: string): Promise<string> {
    if (!userId) {
      return userId;
    }
    const map = await resolveMongoUserIdMap(this.getDb(), [userId]).catch(
      () => new Map<string, string>(),
    );
    return map.get(userId.toLowerCase()) ?? userId;
  }

  // ── 1. Workspaces ────────────────────────────────────────────────────

  findById(workspaceId: string): Promise<WorkspaceRecord | null> {
    const userMap = new Map<string, string>();
    let mongoRec: WorkspaceRecord | null | undefined;
    let pgRan = false;

    return dualRead(
      {
        operation: "findById",
        entityId: workspaceId,
        mongo: async () => {
          const rec = await this.mongo.findById(workspaceId);
          mongoRec = rec;
          if (pgRan && rec?.createdBy) {
            await this.populateUserUuidMap([rec.createdBy], userMap);
          }
          return rec;
        },
        pg: async () => {
          pgRan = true;
          const rec = await this.pg.findById(workspaceId);
          if (mongoRec?.createdBy) {
            await this.populateUserUuidMap([mongoRec.createdBy], userMap);
          }
          return rec;
        },
        canonicalize: r =>
          r
            ? { ...r, createdBy: normUserId(r.createdBy, userMap, true) }
            : null,
      },
      this.ctx,
    );
  }

  findByIds(workspaceIds: readonly string[]): Promise<WorkspaceRecord[]> {
    const userMap = new Map<string, string>();
    let mongoRecs: WorkspaceRecord[] | undefined;
    let pgRan = false;

    return dualRead(
      {
        operation: "findByIds",
        mongo: async () => {
          const recs = await this.mongo.findByIds(workspaceIds);
          mongoRecs = recs;
          if (pgRan && recs.length > 0) {
            await this.populateUserUuidMap(
              recs.map(r => r.createdBy),
              userMap,
            );
          }
          return recs;
        },
        pg: async () => {
          pgRan = true;
          const recs = await this.pg.findByIds(workspaceIds);
          if (mongoRecs && mongoRecs.length > 0) {
            await this.populateUserUuidMap(
              mongoRecs.map(r => r.createdBy),
              userMap,
            );
          }
          return recs;
        },
        canonicalize: list =>
          sortById(list).map(r => ({
            ...r,
            createdBy: normUserId(r.createdBy, userMap, true),
          })),
      },
      this.ctx,
    );
  }

  findBySlug(slug: string): Promise<WorkspaceRecord | null> {
    const userMap = new Map<string, string>();
    let mongoRec: WorkspaceRecord | null | undefined;
    let pgRan = false;

    return dualRead(
      {
        operation: "findBySlug",
        entityId: slug,
        mongo: async () => {
          const rec = await this.mongo.findBySlug(slug);
          mongoRec = rec;
          if (pgRan && rec?.createdBy) {
            await this.populateUserUuidMap([rec.createdBy], userMap);
          }
          return rec;
        },
        pg: async () => {
          pgRan = true;
          const rec = await this.pg.findBySlug(slug);
          if (mongoRec?.createdBy) {
            await this.populateUserUuidMap([mongoRec.createdBy], userMap);
          }
          return rec;
        },
        canonicalize: r =>
          r
            ? { ...r, createdBy: normUserId(r.createdBy, userMap, true) }
            : null,
      },
      this.ctx,
    );
  }

  findByStripeCustomerId(
    stripeCustomerId: string,
  ): Promise<WorkspaceRecord | null> {
    const userMap = new Map<string, string>();
    let mongoRec: WorkspaceRecord | null | undefined;
    let pgRan = false;

    return dualRead(
      {
        operation: "findByStripeCustomerId",
        mongo: async () => {
          const rec = await this.mongo.findByStripeCustomerId(stripeCustomerId);
          mongoRec = rec;
          if (pgRan && rec?.createdBy) {
            await this.populateUserUuidMap([rec.createdBy], userMap);
          }
          return rec;
        },
        pg: async () => {
          pgRan = true;
          const rec = await this.pg.findByStripeCustomerId(stripeCustomerId);
          if (mongoRec?.createdBy) {
            await this.populateUserUuidMap([mongoRec.createdBy], userMap);
          }
          return rec;
        },
        canonicalize: r =>
          r
            ? { ...r, createdBy: normUserId(r.createdBy, userMap, true) }
            : null,
      },
      this.ctx,
    );
  }

  listPaidActiveBilling(): Promise<WorkspaceRecord[]> {
    const userMap = new Map<string, string>();
    let mongoRecs: WorkspaceRecord[] | undefined;
    let pgRan = false;

    return dualRead(
      {
        operation: "listPaidActiveBilling",
        mongo: async () => {
          const recs = await this.mongo.listPaidActiveBilling();
          mongoRecs = recs;
          if (pgRan && recs.length > 0) {
            await this.populateUserUuidMap(
              recs.map(r => r.createdBy),
              userMap,
            );
          }
          return recs;
        },
        pg: async () => {
          pgRan = true;
          const recs = await this.pg.listPaidActiveBilling();
          if (mongoRecs && mongoRecs.length > 0) {
            await this.populateUserUuidMap(
              mongoRecs.map(r => r.createdBy),
              userMap,
            );
          }
          return recs;
        },
        canonicalize: list =>
          sortById(list).map(r => ({
            ...r,
            createdBy: normUserId(r.createdBy, userMap, true),
          })),
      },
      this.ctx,
    );
  }

  listIdsWithDeployedWorkflows(): Promise<string[]> {
    return dualRead(
      {
        operation: "listIdsWithDeployedWorkflows",
        mongo: () => this.mongo.listIdsWithDeployedWorkflows(),
        pg: () => this.pg.listIdsWithDeployedWorkflows(),
        canonicalize: ids => [...ids].sort(),
      },
      this.ctx,
    );
  }

  listWithHatchetToken(workspaceId?: string): Promise<WorkspaceRecord[]> {
    const userMap = new Map<string, string>();
    let mongoRecs: WorkspaceRecord[] | undefined;
    let pgRan = false;

    return dualRead(
      {
        operation: "listWithHatchetToken",
        entityId: workspaceId,
        mongo: async () => {
          const recs = await this.mongo.listWithHatchetToken(workspaceId);
          mongoRecs = recs;
          if (pgRan && recs.length > 0) {
            await this.populateUserUuidMap(
              recs.map(r => r.createdBy),
              userMap,
            );
          }
          return recs;
        },
        pg: async () => {
          pgRan = true;
          const recs = await this.pg.listWithHatchetToken(workspaceId);
          if (mongoRecs && mongoRecs.length > 0) {
            await this.populateUserUuidMap(
              mongoRecs.map(r => r.createdBy),
              userMap,
            );
          }
          return recs;
        },
        canonicalize: list =>
          sortById(list).map(r => ({
            ...r,
            createdBy: normUserId(r.createdBy, userMap, true),
          })),
      },
      this.ctx,
    );
  }

  findOtherWorkspaceWithHatchetToken(
    excludeWorkspaceId: string,
  ): Promise<{ id: string; slug: string } | null> {
    return dualRead(
      {
        operation: "findOtherWorkspaceWithHatchetToken",
        entityId: excludeWorkspaceId,
        mongo: () =>
          this.mongo.findOtherWorkspaceWithHatchetToken(excludeWorkspaceId),
        pg: () =>
          this.pg.findOtherWorkspaceWithHatchetToken(excludeWorkspaceId),
      },
      this.ctx,
    );
  }

  findWorkspaceIdsByRepoBinding(
    owner: string,
    repo: string,
  ): Promise<string[]> {
    return dualRead(
      {
        operation: "findWorkspaceIdsByRepoBinding",
        entityId: `${owner}/${repo}`,
        mongo: () => this.mongo.findWorkspaceIdsByRepoBinding(owner, repo),
        pg: () => this.pg.findWorkspaceIdsByRepoBinding(owner, repo),
        canonicalize: ids => [...ids].sort(),
      },
      this.ctx,
    );
  }

  createWorkspaceWithOwner(
    input: CreateWorkspaceWithOwnerInput,
  ): Promise<{ workspace: WorkspaceRecord; member: WorkspaceMemberRecord }> {
    return dualWrite(
      {
        operation: "createWorkspaceWithOwner",
        entityId: input.slug,
        mongo: () => this.mongo.createWorkspaceWithOwner(input),
        pg: () => this.pg.createWorkspaceWithOwner(input),
        targets: ({ workspace, member }) => [
          { table: "workspaces", scope: { entityIds: [workspace.id] } },
          { table: "workspace_members", scope: { entityIds: [member.id] } },
        ],
      },
      this.ctx,
    );
  }

  getOrCreateDefaultWorkspaceAttempt(input: {
    userId: string;
    name: string;
    slug: string;
  }): Promise<{
    workspace: WorkspaceRecord;
    member: WorkspaceMemberRecord;
    created: boolean;
  }> {
    return dualWrite(
      {
        operation: "getOrCreateDefaultWorkspaceAttempt",
        entityId: input.userId,
        mongo: () => this.mongo.getOrCreateDefaultWorkspaceAttempt(input),
        pg: () => this.pg.getOrCreateDefaultWorkspaceAttempt(input),
        targets: ({ workspace, member, created }) =>
          created
            ? [
                { table: "workspaces", scope: { entityIds: [workspace.id] } },
                {
                  table: "workspace_members",
                  scope: { entityIds: [member.id] },
                },
              ]
            : [],
      },
      this.ctx,
    );
  }

  deleteWorkspaceCascade(workspaceId: string): Promise<boolean> {
    const cascadeTargets: ResyncTarget[] = [
      { table: "workspace_api_keys", scope: { workspaceId } },
      { table: "workspace_members", scope: { workspaceId } },
      { table: "workspace_invites", scope: { workspaceId } },
      { table: "workspace_user_handles", scope: { workspaceId } },
      { table: "mcp_oauth_codes", scope: { workspaceId } },
      { table: "mcp_oauth_tokens", scope: { workspaceId } },
      { table: "acp_plan_grants", scope: { workspaceId } },
      { table: "github_installations", scope: { workspaceId } },
      { table: "workspaces", scope: { entityIds: [workspaceId] } },
    ];
    return dualWrite(
      {
        operation: "deleteWorkspaceCascade",
        entityId: workspaceId,
        mongo: () => this.mongo.deleteWorkspaceCascade(workspaceId),
        pg: () => this.pg.deleteWorkspaceCascade(workspaceId),
        targets: deleted => (deleted ? cascadeTargets : []),
      },
      this.ctx,
    );
  }

  updateWorkspace(
    workspaceId: string,
    patch: UpdateWorkspacePatch,
  ): Promise<WorkspaceRecord | null> {
    return dualWrite(
      {
        operation: "updateWorkspace",
        entityId: workspaceId,
        mongo: () => this.mongo.updateWorkspace(workspaceId, patch),
        pg: () => this.pg.updateWorkspace(workspaceId, patch),
        targets: [{ table: "workspaces", scope: { entityIds: [workspaceId] } }],
      },
      this.ctx,
    );
  }

  setAutoJoin(
    workspaceId: string,
    autoJoin: WorkspaceAutoJoin | null,
  ): Promise<void> {
    return dualWrite(
      {
        operation: "setAutoJoin",
        entityId: workspaceId,
        mongo: () => this.mongo.setAutoJoin(workspaceId, autoJoin),
        pg: () => this.pg.setAutoJoin(workspaceId, autoJoin),
        targets: [{ table: "workspaces", scope: { entityIds: [workspaceId] } }],
      },
      this.ctx,
    );
  }

  setLinkPreviews(workspaceId: string, enabled: boolean): Promise<void> {
    return dualWrite(
      {
        operation: "setLinkPreviews",
        entityId: workspaceId,
        mongo: () => this.mongo.setLinkPreviews(workspaceId, enabled),
        pg: () => this.pg.setLinkPreviews(workspaceId, enabled),
        targets: [{ table: "workspaces", scope: { entityIds: [workspaceId] } }],
      },
      this.ctx,
    );
  }

  setDisabledModelIds(
    workspaceId: string,
    disabledModelIds: string[],
  ): Promise<WorkspaceRecord | null> {
    return dualWrite(
      {
        operation: "setDisabledModelIds",
        entityId: workspaceId,
        mongo: () =>
          this.mongo.setDisabledModelIds(workspaceId, disabledModelIds),
        pg: () => this.pg.setDisabledModelIds(workspaceId, disabledModelIds),
        targets: [{ table: "workspaces", scope: { entityIds: [workspaceId] } }],
      },
      this.ctx,
    );
  }

  unsetLegacyCustomPrompt(
    workspaceId: string,
    options?: { includeSelfDirective?: boolean },
  ): Promise<void> {
    // Stage 4 must still unset legacy Mongo fields on the secondary store so an
    // emergency Stage 4 -> Stage 2 rollback never resurrects stale prompt text.
    const router = this.ctx.router ?? migrationRouter;
    return router.executeWrite(
      {
        domain: WORKSPACES_DOMAIN,
        operation: "unsetLegacyCustomPrompt",
        entityId: workspaceId,
        retryPayload: {
          targets: [],
          unsetLegacyCustomPrompt: {
            workspaceId,
            includeSelfDirective: Boolean(options?.includeSelfDirective),
          },
        },
      },
      {
        mongo: () => this.mongo.unsetLegacyCustomPrompt(workspaceId, options),
        pg: () => this.pg.unsetLegacyCustomPrompt(),
      },
    );
  }

  // ── Billing ──────────────────────────────────────────────────────────

  updateBilling(
    workspaceId: string,
    patch: UpdateBillingPatch,
  ): Promise<WorkspaceRecord | null> {
    return dualWrite(
      {
        operation: "updateBilling",
        entityId: workspaceId,
        mongo: () => this.mongo.updateBilling(workspaceId, patch),
        pg: () => this.pg.updateBilling(workspaceId, patch),
        targets: [{ table: "workspaces", scope: { entityIds: [workspaceId] } }],
      },
      this.ctx,
    );
  }

  claimStripeCustomerIdIfUnset(
    workspaceId: string,
    stripeCustomerId: string,
  ): Promise<boolean> {
    return dualWrite(
      {
        operation: "claimStripeCustomerIdIfUnset",
        entityId: workspaceId,
        mongo: () =>
          this.mongo.claimStripeCustomerIdIfUnset(
            workspaceId,
            stripeCustomerId,
          ),
        pg: () =>
          this.pg.claimStripeCustomerIdIfUnset(workspaceId, stripeCustomerId),
        targets: claimed =>
          claimed
            ? [{ table: "workspaces", scope: { entityIds: [workspaceId] } }]
            : [],
      },
      this.ctx,
    );
  }

  markStripeCustomerPastDue(stripeCustomerId: string): Promise<string | null> {
    return dualWrite(
      {
        operation: "markStripeCustomerPastDue",
        mongo: () => this.mongo.markStripeCustomerPastDue(stripeCustomerId),
        pg: () => this.pg.markStripeCustomerPastDue(stripeCustomerId),
        targets: wsId =>
          wsId ? [{ table: "workspaces", scope: { entityIds: [wsId] } }] : [],
      },
      this.ctx,
    );
  }

  claimPendingOverage(
    workspaceId: string,
    expectedLastCents: number,
    targetCents: number,
    idempotencyKey: string,
  ): Promise<boolean> {
    return dualWrite(
      {
        operation: "claimPendingOverage",
        entityId: workspaceId,
        mongo: () =>
          this.mongo.claimPendingOverage(
            workspaceId,
            expectedLastCents,
            targetCents,
            idempotencyKey,
          ),
        pg: () =>
          this.pg.claimPendingOverage(
            workspaceId,
            expectedLastCents,
            targetCents,
            idempotencyKey,
          ),
        targets: claimed =>
          claimed
            ? [{ table: "workspaces", scope: { entityIds: [workspaceId] } }]
            : [],
      },
      this.ctx,
    );
  }

  commitPendingOverage(
    workspaceId: string,
    targetCents: number,
    idempotencyKey: string,
  ): Promise<boolean> {
    return dualWrite(
      {
        operation: "commitPendingOverage",
        entityId: workspaceId,
        mongo: () =>
          this.mongo.commitPendingOverage(
            workspaceId,
            targetCents,
            idempotencyKey,
          ),
        pg: () =>
          this.pg.commitPendingOverage(
            workspaceId,
            targetCents,
            idempotencyKey,
          ),
        targets: committed =>
          committed
            ? [{ table: "workspaces", scope: { entityIds: [workspaceId] } }]
            : [],
      },
      this.ctx,
    );
  }

  // ── Workspace repos ──────────────────────────────────────────────────

  setWorkspaceRepos(
    workspaceId: string,
    repos: WorkspaceRepoBinding[] | null,
  ): Promise<WorkspaceRecord | null> {
    return dualWrite(
      {
        operation: "setWorkspaceRepos",
        entityId: workspaceId,
        mongo: () => this.mongo.setWorkspaceRepos(workspaceId, repos),
        pg: () => this.pg.setWorkspaceRepos(workspaceId, repos),
        targets: [{ table: "workspaces", scope: { entityIds: [workspaceId] } }],
      },
      this.ctx,
    );
  }

  upsertTestWorkspaceWithRepo(
    workspaceId: string,
    repo: WorkspaceRepoBinding,
  ): Promise<void> {
    return dualWrite(
      {
        operation: "upsertTestWorkspaceWithRepo",
        entityId: workspaceId,
        mongo: () => this.mongo.upsertTestWorkspaceWithRepo(workspaceId, repo),
        pg: () => this.pg.upsertTestWorkspaceWithRepo(workspaceId, repo),
        targets: [{ table: "workspaces", scope: { entityIds: [workspaceId] } }],
      },
      this.ctx,
    );
  }

  // ── Workflows ────────────────────────────────────────────────────────

  setWorkflowHatchetToken(
    workspaceId: string,
    encryptedToken: string | null,
  ): Promise<void> {
    return dualWrite(
      {
        operation: "setWorkflowHatchetToken",
        entityId: workspaceId,
        mongo: () =>
          this.mongo.setWorkflowHatchetToken(workspaceId, encryptedToken),
        pg: () => this.pg.setWorkflowHatchetToken(workspaceId, encryptedToken),
        targets: [{ table: "workspaces", scope: { entityIds: [workspaceId] } }],
      },
      this.ctx,
    );
  }

  setWorkflowLiveTarget(
    workspaceId: string,
    target: { sha: string; tree: string; names: string[] } | null,
  ): Promise<void> {
    return dualWrite(
      {
        operation: "setWorkflowLiveTarget",
        entityId: workspaceId,
        mongo: () => this.mongo.setWorkflowLiveTarget(workspaceId, target),
        pg: () => this.pg.setWorkflowLiveTarget(workspaceId, target),
        targets: [{ table: "workspaces", scope: { entityIds: [workspaceId] } }],
      },
      this.ctx,
    );
  }

  reportWorkflowLiveStatus(
    workspaceId: string,
    sha: string,
    error?: string,
  ): Promise<boolean> {
    return dualWrite(
      {
        operation: "reportWorkflowLiveStatus",
        entityId: workspaceId,
        mongo: () =>
          this.mongo.reportWorkflowLiveStatus(workspaceId, sha, error),
        pg: () => this.pg.reportWorkflowLiveStatus(workspaceId, sha, error),
        targets: matched =>
          matched
            ? [{ table: "workspaces", scope: { entityIds: [workspaceId] } }]
            : [],
      },
      this.ctx,
    );
  }

  setWorkflowTrigger(
    workspaceId: string,
    name: string,
    change: { active?: boolean; encryptedWebhookSecret?: string | null },
  ): Promise<void> {
    return dualWrite(
      {
        operation: "setWorkflowTrigger",
        entityId: workspaceId,
        mongo: () => this.mongo.setWorkflowTrigger(workspaceId, name, change),
        pg: () => this.pg.setWorkflowTrigger(workspaceId, name, change),
        targets: [{ table: "workspaces", scope: { entityIds: [workspaceId] } }],
      },
      this.ctx,
    );
  }

  touchWorkflowLastNeededAt(workspaceId: string, at?: Date): Promise<void> {
    return dualWrite(
      {
        operation: "touchWorkflowLastNeededAt",
        entityId: workspaceId,
        mongo: () => this.mongo.touchWorkflowLastNeededAt(workspaceId, at),
        pg: () => this.pg.touchWorkflowLastNeededAt(workspaceId, at),
        targets: [{ table: "workspaces", scope: { entityIds: [workspaceId] } }],
      },
      this.ctx,
    );
  }

  // ── 2. Workspace API keys ────────────────────────────────────────────

  findApiKeyByHash(keyHash: string): Promise<{
    workspace: WorkspaceRecord;
    apiKey: WorkspaceApiKeyRecord;
  } | null> {
    const userMap = new Map<string, string>();
    let mongoRes:
      | { workspace: WorkspaceRecord; apiKey: WorkspaceApiKeyRecord }
      | null
      | undefined;
    let pgRan = false;

    return dualRead(
      {
        operation: "findApiKeyByHash",
        mongo: async () => {
          const res = await this.mongo.findApiKeyByHash(keyHash);
          mongoRes = res;
          if (pgRan && res) {
            await this.populateUserUuidMap(
              [res.workspace.createdBy, res.apiKey.createdBy],
              userMap,
            );
          }
          return res;
        },
        pg: async () => {
          pgRan = true;
          const res = await this.pg.findApiKeyByHash(keyHash);
          if (mongoRes) {
            await this.populateUserUuidMap(
              [mongoRes.workspace.createdBy, mongoRes.apiKey.createdBy],
              userMap,
            );
          }
          return res;
        },
        canonicalize: r =>
          r
            ? {
                workspace: {
                  ...r.workspace,
                  createdBy: normUserId(r.workspace.createdBy, userMap, true),
                },
                apiKey: {
                  ...r.apiKey,
                  createdBy: normUserId(r.apiKey.createdBy, userMap, true),
                },
              }
            : null,
      },
      this.ctx,
    );
  }

  listApiKeys(workspaceId: string): Promise<WorkspaceApiKeyRecord[]> {
    const userMap = new Map<string, string>();
    let mongoRecs: WorkspaceApiKeyRecord[] | undefined;
    let pgRan = false;

    return dualRead(
      {
        operation: "listApiKeys",
        entityId: workspaceId,
        mongo: async () => {
          const recs = await this.mongo.listApiKeys(workspaceId);
          mongoRecs = recs;
          if (pgRan && recs.length > 0) {
            await this.populateUserUuidMap(
              recs.map(r => r.createdBy),
              userMap,
            );
          }
          return recs;
        },
        pg: async () => {
          pgRan = true;
          const recs = await this.pg.listApiKeys(workspaceId);
          if (mongoRecs && mongoRecs.length > 0) {
            await this.populateUserUuidMap(
              mongoRecs.map(r => r.createdBy),
              userMap,
            );
          }
          return recs;
        },
        canonicalize: list =>
          sortById(list).map(r => ({
            ...r,
            createdBy: normUserId(r.createdBy, userMap, true),
          })),
      },
      this.ctx,
    );
  }

  createApiKey(input: CreateApiKeyInput): Promise<WorkspaceApiKeyRecord> {
    return dualWrite(
      {
        operation: "createApiKey",
        entityId: input.workspaceId,
        mongo: () => this.mongo.createApiKey(input),
        pg: () => this.pg.createApiKey(input),
        targets: created => [
          { table: "workspace_api_keys", scope: { entityIds: [created.id] } },
        ],
      },
      this.ctx,
    );
  }

  async replaceApiKeyByName(
    input: CreateApiKeyInput,
  ): Promise<WorkspaceApiKeyRecord> {
    const { apiKey } = await dualWrite(
      {
        operation: "replaceApiKeyByName",
        entityId: input.workspaceId,
        mongo: () => this.mongo.replaceApiKeyByNameReturningReplacedIds(input),
        pg: () => this.pg.replaceApiKeyByNameReturningReplacedIds(input),
        targets: ({ apiKey: created, replacedIds }) => [
          {
            table: "workspace_api_keys",
            scope: { entityIds: [...replacedIds, created.id] },
          },
        ],
      },
      this.ctx,
    );
    return apiKey;
  }

  updateApiKeyScopesByName(
    workspaceId: string,
    name: string,
    scopes: WorkspaceApiKeyScope[],
  ): Promise<boolean> {
    return dualWrite(
      {
        operation: "updateApiKeyScopesByName",
        entityId: workspaceId,
        mongo: () =>
          this.mongo.updateApiKeyScopesByName(workspaceId, name, scopes),
        pg: () => this.pg.updateApiKeyScopesByName(workspaceId, name, scopes),
        targets: matched =>
          matched
            ? [{ table: "workspace_api_keys", scope: { workspaceId } }]
            : [],
      },
      this.ctx,
    );
  }

  deleteApiKey(workspaceId: string, keyId: string): Promise<boolean> {
    return dualWrite(
      {
        operation: "deleteApiKey",
        entityId: keyId,
        mongo: () => this.mongo.deleteApiKey(workspaceId, keyId),
        pg: () => this.pg.deleteApiKey(workspaceId, keyId),
        targets: deleted =>
          deleted
            ? [{ table: "workspace_api_keys", scope: { entityIds: [keyId] } }]
            : [],
      },
      this.ctx,
    );
  }

  async deleteApiKeysByName(
    workspaceId: string,
    name: string,
  ): Promise<number> {
    const deletedIds = await dualWrite(
      {
        operation: "deleteApiKeysByName",
        entityId: workspaceId,
        mongo: () =>
          this.mongo.deleteApiKeysByNameReturningIds(workspaceId, name),
        pg: () => this.pg.deleteApiKeysByNameReturningIds(workspaceId, name),
        targets: ids =>
          ids.length > 0
            ? [{ table: "workspace_api_keys", scope: { entityIds: ids } }]
            : [],
      },
      this.ctx,
    );
    return deletedIds.length;
  }

  async deleteApiKeysByCreator(
    workspaceId: string,
    createdBy: string,
  ): Promise<number> {
    const deletedIds = await dualWrite(
      {
        operation: "deleteApiKeysByCreator",
        entityId: workspaceId,
        mongo: () =>
          this.mongo.deleteApiKeysByCreatorReturningIds(workspaceId, createdBy),
        pg: () =>
          this.pg.deleteApiKeysByCreatorReturningIds(workspaceId, createdBy),
        targets: ids =>
          ids.length > 0
            ? [{ table: "workspace_api_keys", scope: { entityIds: ids } }]
            : [],
      },
      this.ctx,
    );
    return deletedIds.length;
  }

  async pruneExpiredApiKeysByNamePrefix(
    workspaceId: string,
    namePrefix: string,
    createdBefore: Date,
  ): Promise<number> {
    const deletedIds = await dualWrite(
      {
        operation: "pruneExpiredApiKeysByNamePrefix",
        entityId: workspaceId,
        mongo: () =>
          this.mongo.pruneExpiredApiKeysByNamePrefixReturningIds(
            workspaceId,
            namePrefix,
            createdBefore,
          ),
        pg: () =>
          this.pg.pruneExpiredApiKeysByNamePrefixReturningIds(
            workspaceId,
            namePrefix,
            createdBefore,
          ),
        targets: ids =>
          ids.length > 0
            ? [{ table: "workspace_api_keys", scope: { entityIds: ids } }]
            : [],
      },
      this.ctx,
    );
    return deletedIds.length;
  }

  async touchApiKeyLastUsed(
    workspaceId: string,
    keyId: string,
    now?: Date,
    minIntervalMs?: number,
  ): Promise<void> {
    await dualWrite(
      {
        operation: "touchApiKeyLastUsed",
        entityId: keyId,
        mongo: () =>
          this.mongo.touchApiKeyLastUsedReturningChanged(
            workspaceId,
            keyId,
            now,
            minIntervalMs,
          ),
        pg: () =>
          this.pg.touchApiKeyLastUsedReturningChanged(
            workspaceId,
            keyId,
            now,
            minIntervalMs,
          ),
        targets: changed =>
          changed
            ? [{ table: "workspace_api_keys", scope: { entityIds: [keyId] } }]
            : [],
      },
      this.ctx,
    );
  }

  // ── 3. Workspace members ─────────────────────────────────────────────

  findMember(
    workspaceId: string,
    userId: string,
  ): Promise<WorkspaceMemberRecord | null> {
    let pgRan = false;
    return dualRead(
      {
        operation: "findMember",
        entityId: `${workspaceId}:${userId}`,
        mongo: async () => {
          const lookupUserId = pgRan
            ? await this.resolveMongoLookupUserId(userId)
            : userId;
          return this.mongo.findMember(workspaceId, lookupUserId);
        },
        pg: () => {
          pgRan = true;
          return this.pg.findMember(workspaceId, userId);
        },
        canonicalize: r => (r ? { ...r, userId: "<matched-user>" } : null),
      },
      this.ctx,
    );
  }

  findWorkspacesForUser(
    userId: string,
  ): Promise<Array<{ workspace: WorkspaceRecord; role: WorkspaceMemberRole }>> {
    const userMap = new Map<string, string>();
    let mongoRes:
      | Array<{ workspace: WorkspaceRecord; role: WorkspaceMemberRole }>
      | undefined;
    let pgRan = false;

    return dualRead(
      {
        operation: "findWorkspacesForUser",
        entityId: userId,
        mongo: async () => {
          const lookupUserId = pgRan
            ? await this.resolveMongoLookupUserId(userId)
            : userId;
          const res = await this.mongo.findWorkspacesForUser(lookupUserId);
          mongoRes = res;
          if (pgRan && res.length > 0) {
            await this.populateUserUuidMap(
              res.map(item => item.workspace.createdBy),
              userMap,
            );
          }
          return res;
        },
        pg: async () => {
          pgRan = true;
          const res = await this.pg.findWorkspacesForUser(userId);
          if (mongoRes && mongoRes.length > 0) {
            await this.populateUserUuidMap(
              mongoRes.map(item => item.workspace.createdBy),
              userMap,
            );
          }
          return res;
        },
        canonicalize: items =>
          [...items]
            .sort((a, b) => a.workspace.id.localeCompare(b.workspace.id))
            .map(item => ({
              role: item.role,
              workspace: {
                ...item.workspace,
                createdBy: normUserId(item.workspace.createdBy, userMap, true),
              },
            })),
      },
      this.ctx,
    );
  }

  listMembers(
    workspaceId: string,
    roles?: readonly WorkspaceMemberRole[],
  ): Promise<WorkspaceMemberRecord[]> {
    const userMap = new Map<string, string>();
    let mongoRecs: WorkspaceMemberRecord[] | undefined;
    let pgRan = false;

    return dualRead(
      {
        operation: "listMembers",
        entityId: workspaceId,
        mongo: async () => {
          const recs = await this.mongo.listMembers(workspaceId, roles);
          mongoRecs = recs;
          if (pgRan && recs.length > 0) {
            await this.populateUserUuidMap(
              recs.map(r => r.userId),
              userMap,
            );
          }
          return recs;
        },
        pg: async () => {
          pgRan = true;
          const recs = await this.pg.listMembers(workspaceId, roles);
          if (mongoRecs && mongoRecs.length > 0) {
            await this.populateUserUuidMap(
              mongoRecs.map(r => r.userId),
              userMap,
            );
          }
          return recs;
        },
        canonicalize: list =>
          sortById(list).map(r => ({
            ...r,
            userId: normUserId(r.userId, userMap, false),
          })),
      },
      this.ctx,
    );
  }

  listMembersWithUsers(
    workspaceId: string,
  ): Promise<WorkspaceMemberWithUser[]> {
    const userMap = new Map<string, string>();
    let mongoRecs: WorkspaceMemberWithUser[] | undefined;
    let pgRan = false;

    return dualRead(
      {
        operation: "listMembersWithUsers",
        entityId: workspaceId,
        mongo: async () => {
          const recs = await this.mongo.listMembersWithUsers(workspaceId);
          mongoRecs = recs;
          if (pgRan && recs.length > 0) {
            await this.populateUserUuidMap(
              recs.flatMap(r => (r.user ? [r.userId, r.user.id] : [r.userId])),
              userMap,
            );
          }
          return recs;
        },
        pg: async () => {
          pgRan = true;
          const recs = await this.pg.listMembersWithUsers(workspaceId);
          if (mongoRecs && mongoRecs.length > 0) {
            await this.populateUserUuidMap(
              mongoRecs.flatMap(r =>
                r.user ? [r.userId, r.user.id] : [r.userId],
              ),
              userMap,
            );
          }
          return recs;
        },
        canonicalize: list =>
          sortById(list).map(r => ({
            ...r,
            userId: normUserId(r.userId, userMap, false),
            user: r.user
              ? {
                  id: normUserId(r.user.id, userMap, false),
                  email: r.user.email,
                }
              : null,
          })),
      },
      this.ctx,
    );
  }

  findMatchingMemberUserIds(
    workspaceId: string,
    userIds: readonly string[],
    role?: WorkspaceMemberRole,
  ): Promise<string[]> {
    let pgRan = false;
    return dualRead(
      {
        operation: "findMatchingMemberUserIds",
        entityId: workspaceId,
        mongo: async () => {
          if (!pgRan) {
            return this.mongo.findMatchingMemberUserIds(
              workspaceId,
              userIds,
              role,
            );
          }
          const map = await resolveMongoUserIdMap(this.getDb(), userIds).catch(
            () => new Map<string, string>(),
          );
          const mongoIds = userIds.map(id => map.get(id.toLowerCase()) ?? id);
          const matchedMongo = new Set(
            await this.mongo.findMatchingMemberUserIds(
              workspaceId,
              mongoIds,
              role,
            ),
          );
          return userIds.filter(id =>
            matchedMongo.has(map.get(id.toLowerCase()) ?? id),
          );
        },
        pg: () => {
          pgRan = true;
          return this.pg.findMatchingMemberUserIds(workspaceId, userIds, role);
        },
        canonicalize: ids => [...ids].sort(),
      },
      this.ctx,
    );
  }

  addMember(input: AddMemberInput): Promise<WorkspaceMemberWithUser> {
    return dualWrite(
      {
        operation: "addMember",
        entityId: `${input.workspaceId}:${input.userId}`,
        mongo: () => this.mongo.addMember(input),
        pg: () => this.pg.addMember(input),
        targets: created => [
          { table: "workspace_members", scope: { entityIds: [created.id] } },
        ],
      },
      this.ctx,
    );
  }

  addMemberIfNotExists(
    input: AddMemberInput,
  ): Promise<{ member: WorkspaceMemberRecord; inserted: boolean }> {
    return dualWrite(
      {
        operation: "addMemberIfNotExists",
        entityId: `${input.workspaceId}:${input.userId}`,
        mongo: () => this.mongo.addMemberIfNotExists(input),
        pg: () => this.pg.addMemberIfNotExists(input),
        targets: ({ member, inserted }) =>
          inserted
            ? [
                {
                  table: "workspace_members",
                  scope: { entityIds: [member.id] },
                },
              ]
            : [],
      },
      this.ctx,
    );
  }

  updateMemberRole(
    workspaceId: string,
    userId: string,
    role: WorkspaceMemberRole,
  ): Promise<WorkspaceMemberWithUser | null> {
    return dualWrite(
      {
        operation: "updateMemberRole",
        entityId: `${workspaceId}:${userId}`,
        mongo: () => this.mongo.updateMemberRole(workspaceId, userId, role),
        pg: () => this.pg.updateMemberRole(workspaceId, userId, role),
        targets: updated =>
          updated
            ? [
                {
                  table: "workspace_members",
                  scope: { entityIds: [updated.id] },
                },
              ]
            : [],
      },
      this.ctx,
    );
  }

  async removeMember(workspaceId: string, userId: string): Promise<boolean> {
    const deletedId = await dualWrite(
      {
        operation: "removeMember",
        entityId: `${workspaceId}:${userId}`,
        mongo: () => this.mongo.removeMemberReturningId(workspaceId, userId),
        pg: () => this.pg.removeMemberReturningId(workspaceId, userId),
        targets: id =>
          id
            ? [{ table: "workspace_members", scope: { entityIds: [id] } }]
            : [],
      },
      this.ctx,
    );
    return deletedId !== null;
  }

  // ── 4. Workspace invites ─────────────────────────────────────────────

  findPendingInviteByWorkspaceAndEmail(
    workspaceId: string,
    email: string,
  ): Promise<WorkspaceInviteRecord | null> {
    const userMap = new Map<string, string>();
    let mongoRec: WorkspaceInviteRecord | null | undefined;
    let pgRan = false;

    return dualRead(
      {
        operation: "findPendingInviteByWorkspaceAndEmail",
        entityId: workspaceId,
        mongo: async () => {
          const rec = await this.mongo.findPendingInviteByWorkspaceAndEmail(
            workspaceId,
            email,
          );
          mongoRec = rec;
          if (pgRan && rec?.invitedBy) {
            await this.populateUserUuidMap([rec.invitedBy], userMap);
          }
          return rec;
        },
        pg: async () => {
          pgRan = true;
          const rec = await this.pg.findPendingInviteByWorkspaceAndEmail(
            workspaceId,
            email,
          );
          if (mongoRec?.invitedBy) {
            await this.populateUserUuidMap([mongoRec.invitedBy], userMap);
          }
          return rec;
        },
        canonicalize: r =>
          r
            ? { ...r, invitedBy: normUserId(r.invitedBy, userMap, true) }
            : null,
      },
      this.ctx,
    );
  }

  createInvite(input: CreateInviteInput): Promise<WorkspaceInviteRecord> {
    return dualWrite(
      {
        operation: "createInvite",
        entityId: input.workspaceId,
        mongo: () => this.mongo.createInvite(input),
        pg: () => this.pg.createInvite(input),
        targets: created => [
          { table: "workspace_invites", scope: { entityIds: [created.id] } },
        ],
      },
      this.ctx,
    );
  }

  refreshInvite(
    inviteId: string,
    patch: { expiresAt: Date; invitedBy: string },
  ): Promise<WorkspaceInviteRecord | null> {
    return dualWrite(
      {
        operation: "refreshInvite",
        entityId: inviteId,
        mongo: () => this.mongo.refreshInvite(inviteId, patch),
        pg: () => this.pg.refreshInvite(inviteId, patch),
        targets: updated =>
          updated
            ? [{ table: "workspace_invites", scope: { entityIds: [inviteId] } }]
            : [],
      },
      this.ctx,
    );
  }

  findPendingInviteByToken(
    token: string,
  ): Promise<WorkspaceInviteWithRefs | null> {
    const userMap = new Map<string, string>();
    let mongoRec: WorkspaceInviteWithRefs | null | undefined;
    let pgRan = false;

    return dualRead(
      {
        operation: "findPendingInviteByToken",
        mongo: async () => {
          const rec = await this.mongo.findPendingInviteByToken(token);
          mongoRec = rec;
          if (pgRan && rec) {
            await this.populateUserUuidMap(
              rec.inviter ? [rec.invitedBy, rec.inviter.id] : [rec.invitedBy],
              userMap,
            );
          }
          return rec;
        },
        pg: async () => {
          pgRan = true;
          const rec = await this.pg.findPendingInviteByToken(token);
          if (mongoRec) {
            await this.populateUserUuidMap(
              mongoRec.inviter
                ? [mongoRec.invitedBy, mongoRec.inviter.id]
                : [mongoRec.invitedBy],
              userMap,
            );
          }
          return rec;
        },
        canonicalize: r =>
          r
            ? {
                ...r,
                invitedBy: normUserId(r.invitedBy, userMap, true),
                inviter: r.inviter
                  ? {
                      id: normUserId(r.inviter.id, userMap, false),
                      email: r.inviter.email,
                    }
                  : null,
              }
            : null,
      },
      this.ctx,
    );
  }

  listPendingInvitesForWorkspace(
    workspaceId: string,
    now?: Date,
  ): Promise<WorkspaceInviteWithRefs[]> {
    const userMap = new Map<string, string>();
    let mongoRecs: WorkspaceInviteWithRefs[] | undefined;
    let pgRan = false;

    return dualRead(
      {
        operation: "listPendingInvitesForWorkspace",
        entityId: workspaceId,
        mongo: async () => {
          const recs = await this.mongo.listPendingInvitesForWorkspace(
            workspaceId,
            now,
          );
          mongoRecs = recs;
          if (pgRan && recs.length > 0) {
            await this.populateUserUuidMap(
              recs.flatMap(r =>
                r.inviter ? [r.invitedBy, r.inviter.id] : [r.invitedBy],
              ),
              userMap,
            );
          }
          return recs;
        },
        pg: async () => {
          pgRan = true;
          const recs = await this.pg.listPendingInvitesForWorkspace(
            workspaceId,
            now,
          );
          if (mongoRecs && mongoRecs.length > 0) {
            await this.populateUserUuidMap(
              mongoRecs.flatMap(r =>
                r.inviter ? [r.invitedBy, r.inviter.id] : [r.invitedBy],
              ),
              userMap,
            );
          }
          return recs;
        },
        canonicalize: list =>
          sortById(list).map(r => ({
            ...r,
            invitedBy: normUserId(r.invitedBy, userMap, true),
            inviter: r.inviter
              ? {
                  id: normUserId(r.inviter.id, userMap, false),
                  email: r.inviter.email,
                }
              : null,
          })),
      },
      this.ctx,
    );
  }

  listPendingInvitesForEmail(
    email: string,
    now?: Date,
  ): Promise<WorkspaceInviteWithRefs[]> {
    const userMap = new Map<string, string>();
    let mongoRecs: WorkspaceInviteWithRefs[] | undefined;
    let pgRan = false;

    return dualRead(
      {
        operation: "listPendingInvitesForEmail",
        mongo: async () => {
          const recs = await this.mongo.listPendingInvitesForEmail(email, now);
          mongoRecs = recs;
          if (pgRan && recs.length > 0) {
            await this.populateUserUuidMap(
              recs.flatMap(r =>
                r.inviter ? [r.invitedBy, r.inviter.id] : [r.invitedBy],
              ),
              userMap,
            );
          }
          return recs;
        },
        pg: async () => {
          pgRan = true;
          const recs = await this.pg.listPendingInvitesForEmail(email, now);
          if (mongoRecs && mongoRecs.length > 0) {
            await this.populateUserUuidMap(
              mongoRecs.flatMap(r =>
                r.inviter ? [r.invitedBy, r.inviter.id] : [r.invitedBy],
              ),
              userMap,
            );
          }
          return recs;
        },
        canonicalize: list =>
          sortById(list).map(r => ({
            ...r,
            invitedBy: normUserId(r.invitedBy, userMap, true),
            inviter: r.inviter
              ? {
                  id: normUserId(r.inviter.id, userMap, false),
                  email: r.inviter.email,
                }
              : null,
          })),
      },
      this.ctx,
    );
  }

  cancelInvite(inviteId: string): Promise<boolean> {
    return dualWrite(
      {
        operation: "cancelInvite",
        entityId: inviteId,
        mongo: () => this.mongo.cancelInvite(inviteId),
        pg: () => this.pg.cancelInvite(inviteId),
        targets: deleted =>
          deleted
            ? [{ table: "workspace_invites", scope: { entityIds: [inviteId] } }]
            : [],
      },
      this.ctx,
    );
  }

  acceptInviteTransaction(
    token: string,
    userId: string,
    now?: Date,
  ): Promise<{
    workspace: WorkspaceRecord;
    member: WorkspaceMemberRecord;
    invite: WorkspaceInviteRecord;
  }> {
    return dualWrite(
      {
        operation: "acceptInviteTransaction",
        entityId: userId,
        mongo: () => this.mongo.acceptInviteTransaction(token, userId, now),
        pg: () => this.pg.acceptInviteTransaction(token, userId, now),
        targets: ({ invite, member }) => [
          { table: "workspace_invites", scope: { entityIds: [invite.id] } },
          { table: "workspace_members", scope: { entityIds: [member.id] } },
        ],
      },
      this.ctx,
    );
  }

  // ── 5. Workspace user handles ────────────────────────────────────────

  listHandles(workspaceId: string): Promise<WorkspaceUserHandleRecord[]> {
    const userMap = new Map<string, string>();
    let mongoRecs: WorkspaceUserHandleRecord[] | undefined;
    let pgRan = false;

    return dualRead(
      {
        operation: "listHandles",
        entityId: workspaceId,
        mongo: async () => {
          const recs = await this.mongo.listHandles(workspaceId);
          mongoRecs = recs;
          if (pgRan && recs.length > 0) {
            await this.populateUserUuidMap(
              recs.map(r => r.userId),
              userMap,
            );
          }
          return recs;
        },
        pg: async () => {
          pgRan = true;
          const recs = await this.pg.listHandles(workspaceId);
          if (mongoRecs && mongoRecs.length > 0) {
            await this.populateUserUuidMap(
              mongoRecs.map(r => r.userId),
              userMap,
            );
          }
          return recs;
        },
        canonicalize: list =>
          sortById(list).map(r => ({
            ...r,
            userId: normUserId(r.userId, userMap, true),
          })),
      },
      this.ctx,
    );
  }

  insertHandlesBestEffort(
    workspaceId: string,
    rows: ReadonlyArray<{ userId: string; handle: string }>,
  ): Promise<{ inserted: WorkspaceUserHandleRecord[]; hadConflict: boolean }> {
    return dualWrite(
      {
        operation: "insertHandlesBestEffort",
        entityId: workspaceId,
        mongo: () => this.mongo.insertHandlesBestEffort(workspaceId, rows),
        pg: () => this.pg.insertHandlesBestEffort(workspaceId, rows),
        targets: ({ inserted }) =>
          inserted.length > 0
            ? [
                {
                  table: "workspace_user_handles",
                  scope: { entityIds: inserted.map(r => r.id) },
                },
              ]
            : [],
      },
      this.ctx,
    );
  }

  // ── 6. MCP OAuth clients ─────────────────────────────────────────────

  findMcpClient(clientId: string): Promise<McpOAuthClientRecord | null> {
    return dualRead(
      {
        operation: "findMcpClient",
        entityId: clientId,
        mongo: () => this.mongo.findMcpClient(clientId),
        pg: () => this.pg.findMcpClient(clientId),
      },
      this.ctx,
    );
  }

  createMcpClient(input: CreateMcpClientInput): Promise<McpOAuthClientRecord> {
    return dualWrite(
      {
        operation: "createMcpClient",
        entityId: input.clientId,
        mongo: () => this.mongo.createMcpClient(input),
        pg: () => this.pg.createMcpClient(input),
        targets: [
          {
            table: "mcp_oauth_clients",
            scope: { entityIds: [input.clientId] },
          },
        ],
      },
      this.ctx,
    );
  }

  ensureMcpClient(input: CreateMcpClientInput): Promise<McpOAuthClientRecord> {
    return dualWrite(
      {
        operation: "ensureMcpClient",
        entityId: input.clientId,
        mongo: () => this.mongo.ensureMcpClient(input),
        pg: () => this.pg.ensureMcpClient(input),
        targets: [
          {
            table: "mcp_oauth_clients",
            scope: { entityIds: [input.clientId] },
          },
        ],
      },
      this.ctx,
    );
  }

  // ── 7. MCP OAuth codes ───────────────────────────────────────────────

  createMcpCode(input: CreateMcpCodeInput): Promise<McpOAuthCodeRecord> {
    return dualWrite(
      {
        operation: "createMcpCode",
        entityId: input.workspaceId,
        mongo: () => this.mongo.createMcpCode(input),
        pg: () => this.pg.createMcpCode(input),
        targets: created => [
          { table: "mcp_oauth_codes", scope: { entityIds: [created.id] } },
        ],
      },
      this.ctx,
    );
  }

  redeemMcpCodeOnce(
    codeHash: string,
    now?: Date,
  ): Promise<McpOAuthCodeRecord | null> {
    return dualWrite(
      {
        operation: "redeemMcpCodeOnce",
        mongo: () => this.mongo.redeemMcpCodeOnce(codeHash, now),
        pg: () => this.pg.redeemMcpCodeOnce(codeHash, now),
        targets: redeemed =>
          redeemed
            ? [
                {
                  table: "mcp_oauth_codes",
                  scope: { entityIds: [redeemed.id] },
                },
              ]
            : [],
      },
      this.ctx,
    );
  }

  // ── 8. MCP OAuth tokens ──────────────────────────────────────────────

  createMcpToken(input: CreateMcpTokenInput): Promise<McpOAuthTokenRecord> {
    return dualWrite(
      {
        operation: "createMcpToken",
        entityId: input.workspaceId,
        mongo: () => this.mongo.createMcpToken(input),
        pg: () => this.pg.createMcpToken(input),
        targets: created => [
          { table: "mcp_oauth_tokens", scope: { entityIds: [created.id] } },
        ],
      },
      this.ctx,
    );
  }

  findValidMcpTokenByAccessHash(
    accessTokenHash: string,
    now?: Date,
  ): Promise<McpOAuthTokenRecord | null> {
    const userMap = new Map<string, string>();
    let mongoRec: McpOAuthTokenRecord | null | undefined;
    let pgRan = false;

    return dualRead(
      {
        operation: "findValidMcpTokenByAccessHash",
        mongo: async () => {
          const rec = await this.mongo.findValidMcpTokenByAccessHash(
            accessTokenHash,
            now,
          );
          mongoRec = rec;
          if (pgRan && rec) {
            await this.populateUserUuidMap([rec.userId], userMap);
          }
          return rec;
        },
        pg: async () => {
          pgRan = true;
          const rec = await this.pg.findValidMcpTokenByAccessHash(
            accessTokenHash,
            now,
          );
          if (mongoRec) {
            await this.populateUserUuidMap([mongoRec.userId], userMap);
          }
          return rec;
        },
        canonicalize: r =>
          r ? { ...r, userId: normUserId(r.userId, userMap, false) } : null,
      },
      this.ctx,
    );
  }

  hasActiveMcpAgentSession(input: {
    workspaceId: string;
    userId: string;
    clientId: string;
    agentSessionId: string;
    now?: Date;
  }): Promise<boolean> {
    let pgRan = false;
    return dualRead(
      {
        operation: "hasActiveMcpAgentSession",
        entityId: input.agentSessionId,
        mongo: async () => {
          const lookupUserId = pgRan
            ? await this.resolveMongoLookupUserId(input.userId)
            : input.userId;
          return this.mongo.hasActiveMcpAgentSession({
            ...input,
            userId: lookupUserId,
          });
        },
        pg: () => {
          pgRan = true;
          return this.pg.hasActiveMcpAgentSession(input);
        },
      },
      this.ctx,
    );
  }

  rotateMcpRefreshToken(
    input: RotateMcpRefreshTokenInput,
  ): Promise<McpOAuthTokenRecord | null> {
    return dualWrite(
      {
        operation: "rotateMcpRefreshToken",
        entityId: input.clientId,
        mongo: () => this.mongo.rotateMcpRefreshToken(input),
        pg: () => this.pg.rotateMcpRefreshToken(input),
        targets: rotated =>
          rotated
            ? [
                {
                  table: "mcp_oauth_tokens",
                  scope: { entityIds: [rotated.id] },
                },
              ]
            : [],
      },
      this.ctx,
    );
  }

  async touchMcpTokenLastUsed(
    tokenId: string,
    now?: Date,
    minIntervalMs?: number,
  ): Promise<void> {
    await dualWrite(
      {
        operation: "touchMcpTokenLastUsed",
        entityId: tokenId,
        mongo: () =>
          this.mongo.touchMcpTokenLastUsedReturningChanged(
            tokenId,
            now,
            minIntervalMs,
          ),
        pg: () =>
          this.pg.touchMcpTokenLastUsedReturningChanged(
            tokenId,
            now,
            minIntervalMs,
          ),
        targets: changed =>
          changed
            ? [{ table: "mcp_oauth_tokens", scope: { entityIds: [tokenId] } }]
            : [],
      },
      this.ctx,
    );
  }

  listMcpConnections(
    workspaceId: string,
    now?: Date,
  ): Promise<McpConnectionSummary[]> {
    const userMap = new Map<string, string>();
    let mongoRecs: McpConnectionSummary[] | undefined;
    let pgRan = false;

    return dualRead(
      {
        operation: "listMcpConnections",
        entityId: workspaceId,
        mongo: async () => {
          const recs = await this.mongo.listMcpConnections(workspaceId, now);
          mongoRecs = recs;
          if (pgRan && recs.length > 0) {
            await this.populateUserUuidMap(
              recs.map(r => r.userId),
              userMap,
            );
          }
          return recs;
        },
        pg: async () => {
          pgRan = true;
          const recs = await this.pg.listMcpConnections(workspaceId, now);
          if (mongoRecs && mongoRecs.length > 0) {
            await this.populateUserUuidMap(
              mongoRecs.map(r => r.userId),
              userMap,
            );
          }
          return recs;
        },
        canonicalize: list =>
          [...list]
            .map(r => ({ ...r, userId: normUserId(r.userId, userMap, false) }))
            .sort((a, b) =>
              `${a.clientId}:${a.userId}`.localeCompare(
                `${b.clientId}:${b.userId}`,
              ),
            ),
      },
      this.ctx,
    );
  }

  async revokeMcpGrantsForMember(input: {
    workspaceId: string;
    userId: string;
  }): Promise<number> {
    const deletedIds = await dualWrite(
      {
        operation: "revokeMcpGrantsForMember",
        entityId: `${input.workspaceId}:${input.userId}`,
        mongo: () => this.mongo.revokeMcpGrantsForMemberReturningIds(input),
        pg: () => this.pg.revokeMcpGrantsForMemberReturningIds(input),
        targets: ids =>
          ids.length > 0
            ? [{ table: "mcp_oauth_tokens", scope: { entityIds: ids } }]
            : [],
      },
      this.ctx,
    );
    return deletedIds.length;
  }

  async revokeMcpConnection(input: {
    workspaceId: string;
    clientId: string;
    userId: string;
  }): Promise<number> {
    const deletedIds = await dualWrite(
      {
        operation: "revokeMcpConnection",
        entityId: `${input.workspaceId}:${input.clientId}:${input.userId}`,
        mongo: () => this.mongo.revokeMcpConnectionReturningIds(input),
        pg: () => this.pg.revokeMcpConnectionReturningIds(input),
        targets: ids =>
          ids.length > 0
            ? [{ table: "mcp_oauth_tokens", scope: { entityIds: ids } }]
            : [],
      },
      this.ctx,
    );
    return deletedIds.length;
  }

  // ── 9. ACP plan grants ───────────────────────────────────────────────

  upsertAcpGrant(input: UpsertAcpGrantInput): Promise<AcpPlanGrantRecord> {
    return dualWrite(
      {
        operation: "upsertAcpGrant",
        entityId: input.agentSessionId,
        mongo: () => this.mongo.upsertAcpGrant(input),
        pg: () => this.pg.upsertAcpGrant(input),
        targets: upserted => [
          { table: "acp_plan_grants", scope: { entityIds: [upserted.id] } },
        ],
      },
      this.ctx,
    );
  }

  revokeAcpGrant(input: {
    workspaceId: string;
    userId: string;
    agentSessionId: string;
    now?: Date;
  }): Promise<boolean> {
    return dualWrite(
      {
        operation: "revokeAcpGrant",
        entityId: input.agentSessionId,
        mongo: () => this.mongo.revokeAcpGrant(input),
        pg: () => this.pg.revokeAcpGrant(input),
        targets: revoked =>
          revoked
            ? [
                {
                  table: "acp_plan_grants",
                  scope: { workspaceId: input.workspaceId },
                },
              ]
            : [],
      },
      this.ctx,
    );
  }

  findActiveAcpGrant(input: {
    workspaceId: string;
    userId: string;
    agentSessionId: string;
    now?: Date;
  }): Promise<AcpPlanGrantRecord | null> {
    let pgRan = false;
    return dualRead(
      {
        operation: "findActiveAcpGrant",
        entityId: input.agentSessionId,
        mongo: async () => {
          const lookupUserId = pgRan
            ? await this.resolveMongoLookupUserId(input.userId)
            : input.userId;
          return this.mongo.findActiveAcpGrant({
            ...input,
            userId: lookupUserId,
          });
        },
        pg: () => {
          pgRan = true;
          return this.pg.findActiveAcpGrant(input);
        },
        canonicalize: r => (r ? { ...r, userId: "<matched-user>" } : null),
      },
      this.ctx,
    );
  }

  // ── 10. GitHub installations ─────────────────────────────────────────

  listGitHubInstallations(
    workspaceId: string,
  ): Promise<GitHubInstallationRecord[]> {
    const userMap = new Map<string, string>();
    let mongoRecs: GitHubInstallationRecord[] | undefined;
    let pgRan = false;

    return dualRead(
      {
        operation: "listGitHubInstallations",
        entityId: workspaceId,
        mongo: async () => {
          const recs = await this.mongo.listGitHubInstallations(workspaceId);
          mongoRecs = recs;
          if (pgRan && recs.length > 0) {
            await this.populateUserUuidMap(
              recs.map(r => r.createdBy),
              userMap,
            );
          }
          return recs;
        },
        pg: async () => {
          pgRan = true;
          const recs = await this.pg.listGitHubInstallations(workspaceId);
          if (mongoRecs && mongoRecs.length > 0) {
            await this.populateUserUuidMap(
              mongoRecs.map(r => r.createdBy),
              userMap,
            );
          }
          return recs;
        },
        canonicalize: list =>
          sortById(list).map(r => ({
            ...r,
            createdBy: normUserId(r.createdBy, userMap, true),
          })),
      },
      this.ctx,
    );
  }

  findGitHubInstallation(
    workspaceId: string,
    installationId: number,
  ): Promise<GitHubInstallationRecord | null> {
    const userMap = new Map<string, string>();
    let mongoRec: GitHubInstallationRecord | null | undefined;
    let pgRan = false;

    return dualRead(
      {
        operation: "findGitHubInstallation",
        entityId: `${workspaceId}:${installationId}`,
        mongo: async () => {
          const rec = await this.mongo.findGitHubInstallation(
            workspaceId,
            installationId,
          );
          mongoRec = rec;
          if (pgRan && rec?.createdBy) {
            await this.populateUserUuidMap([rec.createdBy], userMap);
          }
          return rec;
        },
        pg: async () => {
          pgRan = true;
          const rec = await this.pg.findGitHubInstallation(
            workspaceId,
            installationId,
          );
          if (mongoRec?.createdBy) {
            await this.populateUserUuidMap([mongoRec.createdBy], userMap);
          }
          return rec;
        },
        canonicalize: r =>
          r
            ? { ...r, createdBy: normUserId(r.createdBy, userMap, true) }
            : null,
      },
      this.ctx,
    );
  }

  upsertGitHubInstallation(
    input: UpsertGitHubInstallationInput,
  ): Promise<GitHubInstallationRecord> {
    return dualWrite(
      {
        operation: "upsertGitHubInstallation",
        entityId: `${input.workspaceId}:${input.installationId}`,
        mongo: () => this.mongo.upsertGitHubInstallation(input),
        pg: () => this.pg.upsertGitHubInstallation(input),
        targets: upserted => [
          {
            table: "github_installations",
            scope: { entityIds: [upserted.id] },
          },
        ],
      },
      this.ctx,
    );
  }

  async deleteGitHubInstallation(
    workspaceId: string,
    installationId: number,
  ): Promise<boolean> {
    const deletedId = await dualWrite(
      {
        operation: "deleteGitHubInstallation",
        entityId: `${workspaceId}:${installationId}`,
        mongo: () =>
          this.mongo.deleteGitHubInstallationReturningId(
            workspaceId,
            installationId,
          ),
        pg: () =>
          this.pg.deleteGitHubInstallationReturningId(
            workspaceId,
            installationId,
          ),
        targets: id =>
          id
            ? [{ table: "github_installations", scope: { entityIds: [id] } }]
            : [],
      },
      this.ctx,
    );
    return deletedId !== null;
  }

  async deleteGitHubInstallationsByInstallationId(
    installationId: number,
  ): Promise<number> {
    const deletedIds = await dualWrite(
      {
        operation: "deleteGitHubInstallationsByInstallationId",
        entityId: String(installationId),
        mongo: () =>
          this.mongo.deleteGitHubInstallationsByInstallationIdReturningIds(
            installationId,
          ),
        pg: () =>
          this.pg.deleteGitHubInstallationsByInstallationIdReturningIds(
            installationId,
          ),
        targets: ids =>
          ids.length > 0
            ? [{ table: "github_installations", scope: { entityIds: ids } }]
            : [],
      },
      this.ctx,
    );
    return deletedIds.length;
  }

  async pruneStaleGitHubInstallations(
    workspaceId: string,
    accountLogin: string,
    keepInstallationId: number,
  ): Promise<number> {
    const deletedIds = await dualWrite(
      {
        operation: "pruneStaleGitHubInstallations",
        entityId: `${workspaceId}:${accountLogin}`,
        mongo: () =>
          this.mongo.pruneStaleGitHubInstallationsReturningIds(
            workspaceId,
            accountLogin,
            keepInstallationId,
          ),
        pg: () =>
          this.pg.pruneStaleGitHubInstallationsReturningIds(
            workspaceId,
            accountLogin,
            keepInstallationId,
          ),
        targets: ids =>
          ids.length > 0
            ? [{ table: "github_installations", scope: { entityIds: ids } }]
            : [],
      },
      this.ctx,
    );
    return deletedIds.length;
  }
}
