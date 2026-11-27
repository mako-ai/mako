/**
 * Phase 1B (`workspaces_core` + `github_installations`, 10 tables — Decision #3)
 * comprehensive contract, 5-stage dual-run, rollback, hot-read isolation,
 * secret-redaction, FK-ordered backfill, parity verifier (`--repair`),
 * sync-retry, and TTL reaper test suite.
 */
import { createHash, randomBytes } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type Stripe from "stripe";
import { loadPeopleDirectory } from "../../apps/app-owner.service";
import { OwnerDirectory } from "../../apps/user-handles";
import { syncSubscriptionToWorkspace } from "../../billing/billing.service";
import { AcpPlanGrant } from "../../database/acp-plan-grant-schema";
import {
  McpOAuthClient,
  McpOAuthCode,
  McpOAuthToken,
} from "../../database/mcp-oauth-schema";
import {
  resetPgTestDb,
  setPgTestDb,
  type MakoPgDb,
} from "../../database/pg/client";
import {
  generateUuidv7,
  legacyUserIdToUuidv7,
  newDualId,
  objectIdToUuid,
} from "../../database/pg/id-codec";
import { runPgliteMigrations } from "../../database/pg/migrate";
import * as pgSchema from "../../database/pg/schema";
import { createTestPglite } from "../../database/pg/test-pglite";
import { Session, User } from "../../database/schema";
import {
  GitHubInstallation,
  Workspace,
  WorkspaceInvite,
  WorkspaceMember,
  WorkspaceUserHandle,
} from "../../database/workspace-schema";
import {
  clearBackfillRegistryForTests,
  getBackfillDomain,
  listBackfillDomains,
  runBackfill,
} from "../../migration/backfill";
import { registerMigrationDomains } from "../../migration/domains";
import {
  MigrationRouter,
  recordMigrationTombstone,
} from "../../migration/router";
import {
  ShadowCompareRunner,
  type ShadowCompareEvent,
} from "../../migration/shadow-compare";
import {
  clearTtlRegistryForTests,
  listTtlRules,
  reapAllRegisteredTables,
} from "../../migration/ttl-reaper";
import type {
  SecondaryWriteFailureContext,
  SyncRetryEventData,
} from "../../migration/types";
import {
  clearVerifierRegistryForTests,
  listVerifierDomains,
  runParityVerification,
} from "../../migration/verifier";
import { workspaceService } from "../../services/workspace.service";
import { sandboxRunOfKey } from "../../workflows/sandbox";
import {
  DualAuthRepository,
  resetAuthRepoForTests,
  setAuthRepoForTests,
} from "../auth";
import { DualWorkspaceRepository } from "./dual.repo";
import { replayWorkspacesRetry } from "./dual-write";
import { resetWorkspaceRepoForTests, setWorkspaceRepoForTests } from "./index";
import {
  MongoWorkspaceRepository,
  isTransactionsUnsupportedError,
  runInMongoTransaction,
} from "./mongo.repo";
import { PgWorkspaceRepository } from "./pg.repo";
import { resyncToPg } from "./sync";
import {
  WORKSPACES_DOMAIN,
  WorkspaceSlugConflictError,
  type WorkspaceRepository,
} from "./types";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function makeHash(seed: string): string {
  return sha256(`${seed}:${randomBytes(8).toString("hex")}`);
}

describe("Phase 1B WorkspaceRepository contract & migration lifecycle (10 tables, Decision #3)", () => {
  let mongo: MongoMemoryServer;
  let pg: PGlite;
  let db: MakoPgDb;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    await Promise.all([
      User.syncIndexes(),
      Session.syncIndexes(),
      Workspace.syncIndexes(),
      WorkspaceMember.syncIndexes(),
      WorkspaceInvite.syncIndexes(),
      WorkspaceUserHandle.syncIndexes(),
      McpOAuthClient.syncIndexes(),
      McpOAuthCode.syncIndexes(),
      McpOAuthToken.syncIndexes(),
      AcpPlanGrant.syncIndexes(),
      GitHubInstallation.syncIndexes(),
    ]);

    pg = createTestPglite();
    await runPgliteMigrations(pg);
    db = drizzle(pg, { schema: pgSchema }) as unknown as MakoPgDb;
  });

  async function cleanAllStores(): Promise<void> {
    await Promise.all([
      User.deleteMany({}),
      Session.deleteMany({}),
      Workspace.deleteMany({}),
      WorkspaceMember.deleteMany({}),
      WorkspaceInvite.deleteMany({}),
      WorkspaceUserHandle.deleteMany({}),
      McpOAuthClient.deleteMany({}),
      McpOAuthCode.deleteMany({}),
      McpOAuthToken.deleteMany({}),
      AcpPlanGrant.deleteMany({}),
      GitHubInstallation.deleteMany({}),
    ]);
    await pg.exec(`
      DELETE FROM github_installations;
      DELETE FROM acp_plan_grants;
      DELETE FROM mcp_oauth_tokens;
      DELETE FROM mcp_oauth_codes;
      DELETE FROM mcp_oauth_clients;
      DELETE FROM workspace_user_handles;
      DELETE FROM workspace_invites;
      DELETE FROM workspace_members;
      DELETE FROM workspace_api_keys;
      DELETE FROM workspaces;
      DELETE FROM sessions;
      DELETE FROM users;
      DELETE FROM migration_domain_state;
      DELETE FROM migration_backfill_jobs;
      DELETE FROM migration_tombstones;
      DELETE FROM migration_quarantine;
    `);
  }

  /** Seed a user into BOTH Mongo and PG (supporting legacy 15-char Lucia IDs and UUIDv7). */
  async function seedUser(opts: {
    mongoId: string;
    email: string;
    pgUuid?: string;
  }): Promise<{ mongoId: string; pgUuid: string; email: string }> {
    const createdAt = new Date("2026-06-01T00:00:00.000Z");
    const pgUuid =
      opts.pgUuid ??
      (/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        opts.mongoId,
      )
        ? opts.mongoId.toLowerCase()
        : legacyUserIdToUuidv7(opts.mongoId, createdAt));
    await User.create({
      _id: opts.mongoId,
      email: opts.email.toLowerCase(),
      emailVerified: true,
      createdAt,
      updatedAt: createdAt,
    });
    await db.insert(pgSchema.users).values({
      id: pgUuid,
      legacyId: opts.mongoId,
      email: opts.email.toLowerCase(),
      emailVerified: true,
      createdAt,
      updatedAt: createdAt,
    });
    return { mongoId: opts.mongoId, pgUuid, email: opts.email.toLowerCase() };
  }

  beforeEach(async () => {
    setPgTestDb(db);
    resetWorkspaceRepoForTests();
    resetAuthRepoForTests();
    await cleanAllStores();
    clearBackfillRegistryForTests();
    clearVerifierRegistryForTests();
    clearTtlRegistryForTests();
    registerMigrationDomains({ force: true });
  });

  afterEach(() => {
    resetWorkspaceRepoForTests();
    resetAuthRepoForTests();
    resetPgTestDb();
  });

  afterAll(async () => {
    resetPgTestDb();
    await mongoose.disconnect();
    await mongo.stop();
    await pg.close();
  });

  // ── 1. Shared parity contract tests (Mongo vs Postgres) ────────────────

  const backends: Array<{
    name: string;
    createRepo: () => WorkspaceRepository;
    idForUser: (u: { mongoId: string; pgUuid: string }) => string;
  }> = [
    {
      name: "MongoWorkspaceRepository",
      createRepo: () => new MongoWorkspaceRepository(),
      idForUser: u => u.mongoId,
    },
    {
      name: "PgWorkspaceRepository",
      createRepo: () => new PgWorkspaceRepository({ getDb: () => db }),
      idForUser: u => u.pgUuid,
    },
  ];

  for (const backend of backends) {
    describe(`${backend.name} contract parity`, () => {
      it("creates workspace with owner, enforces unique slug, handles default-workspace race, updates settings, and cascades delete", async () => {
        const repo = backend.createRepo();
        const alice = await seedUser({
          mongoId: "alice15charuser",
          email: "alice@example.com",
        });
        const bob = await seedUser({
          mongoId: generateUuidv7(),
          email: "bob@example.com",
        });
        const aliceId = backend.idForUser(alice);
        const bobId = backend.idForUser(bob);

        // createWorkspaceWithOwner + findById / findByIds / findBySlug
        const { workspace, member } = await repo.createWorkspaceWithOwner({
          name: "Acme Data",
          slug: "acme-data",
          userId: aliceId,
        });
        expect(workspace.id).toMatch(/^[0-9a-f]{24}$/);
        expect(workspace._id).toBe(workspace.id);
        expect(member.role).toBe("owner");
        expect(member.workspaceId).toBe(workspace.id);

        expect((await repo.findById(workspace.id))?.slug).toBe("acme-data");
        expect((await repo.findBySlug("ACME-DATA"))?.id).toBe(workspace.id);
        expect((await repo.findByIds([workspace.id, "invalid"])).length).toBe(
          1,
        );

        // Duplicate slug raises WorkspaceSlugConflictError on both stores
        await expect(
          repo.createWorkspaceWithOwner({
            name: "Acme Clone",
            slug: "acme-data",
            userId: bobId,
          }),
        ).rejects.toBeInstanceOf(WorkspaceSlugConflictError);

        // Settings updates: autoJoin, linkPreviews, disabledModelIds, general update
        await repo.setAutoJoin(workspace.id, {
          domains: ["acme.io"],
          role: "viewer",
        });
        await repo.setLinkPreviews(workspace.id, false);
        await repo.setDisabledModelIds(workspace.id, ["openai/gpt-4o"]);
        const updated = await repo.updateWorkspace(workspace.id, {
          name: "Acme Analytics",
          settings: { maxDatabases: 12 },
        });
        expect(updated?.name).toBe("Acme Analytics");
        expect(updated?.settings.maxDatabases).toBe(12);
        expect(updated?.settings.autoJoin).toEqual({
          domains: ["acme.io"],
          role: "viewer",
        });
        expect(updated?.settings.linkPreviews).toBe(false);
        expect(updated?.settings.disabledModelIds).toEqual(["openai/gpt-4o"]);

        // Clearing autoJoin -> absent
        await repo.setAutoJoin(workspace.id, null);
        const afterClear = await repo.findById(workspace.id);
        expect(afterClear?.settings.autoJoin).toBeUndefined();

        // Concurrent getOrCreateDefaultWorkspaceAttempt race converges on ONE workspace
        const [r1, r2] = await Promise.all([
          repo.getOrCreateDefaultWorkspaceAttempt({
            userId: bobId,
            name: "Bob Workspace",
            slug: "bob-ws-a",
          }),
          repo.getOrCreateDefaultWorkspaceAttempt({
            userId: bobId,
            name: "Bob Workspace",
            slug: "bob-ws-b",
          }),
        ]);
        expect(r1.workspace.id).toBe(r2.workspace.id);
        expect([r1.created, r2.created].filter(Boolean).length).toBe(1);

        // Cascade delete removes workspace + members + invites
        await repo.createInvite({
          workspaceId: workspace.id,
          email: "carol@example.com",
          token: "tok-cascade-1",
          role: "member",
          invitedBy: aliceId,
          expiresAt: new Date(Date.now() + 3600_000),
        });
        expect(await repo.deleteWorkspaceCascade(workspace.id)).toBe(true);
        expect(await repo.findById(workspace.id)).toBeNull();
        expect(await repo.listMembers(workspace.id)).toEqual([]);
        expect(await repo.findPendingInviteByToken("tok-cascade-1")).toBeNull();
      });

      it("handles Stripe billing, unlimited null hardLimitUsd, and 2-phase overage CAS", async () => {
        const repo = backend.createRepo();
        const owner = await seedUser({
          mongoId: generateUuidv7(),
          email: "bill@example.com",
        });
        const { workspace } = await repo.createWorkspaceWithOwner({
          name: "BillCo",
          slug: "billco",
          userId: backend.idForUser(owner),
        });

        // Claim customer ID once (idempotent CAS)
        expect(
          await repo.claimStripeCustomerIdIfUnset(workspace.id, "cus_123"),
        ).toBe(true);
        expect(
          await repo.claimStripeCustomerIdIfUnset(workspace.id, "cus_999"),
        ).toBe(false);
        expect((await repo.findByStripeCustomerId("cus_123"))?.id).toBe(
          workspace.id,
        );

        // Upgrade to Pro with null (unlimited) hardLimitUsd
        const periodStart = new Date("2026-11-01T00:00:00.000Z");
        const proWs = await repo.updateBilling(workspace.id, {
          stripeSubscriptionId: "sub_abc",
          subscriptionStatus: "active",
          plan: "pro",
          usageQuotaUsd: 25,
          hardLimitUsd: null,
          currentPeriodStart: periodStart,
          settingsBillingTier: "pro",
        });
        expect(proWs?.billing.hardLimitUsd).toBeNull();
        expect(proWs?.billing.usageQuotaUsd).toBe(25);
        expect(proWs?.settings.billingTier).toBe("pro");
        expect((await repo.listPaidActiveBilling()).map(w => w.id)).toContain(
          workspace.id,
        );

        // 2-phase overage CAS claim & commit
        const idemKey = "billing-overage:1:0:450";
        expect(
          await repo.claimPendingOverage(workspace.id, 0, 450, idemKey),
        ).toBe(true);
        // Second claim while pending fails
        expect(
          await repo.claimPendingOverage(workspace.id, 0, 500, "other-key"),
        ).toBe(false);
        // Wrong idempotency key fails commit
        expect(
          await repo.commitPendingOverage(workspace.id, 450, "wrong-key"),
        ).toBe(false);
        // Matching commit advances cursor and clears pending fields
        expect(
          await repo.commitPendingOverage(workspace.id, 450, idemKey),
        ).toBe(true);

        const afterCommit = await repo.findById(workspace.id);
        expect(afterCommit?.billing.lastReportedOverageCents).toBe(450);
        expect(afterCommit?.billing.pendingReportedOverageCents).toBeNull();
        expect(afterCommit?.billing.pendingMeterEventIdempotencyKey).toBeNull();

        // Mark past_due via Stripe customer ID
        expect(await repo.markStripeCustomerPastDue("cus_123")).toBe(
          workspace.id,
        );
        expect(
          (await repo.findById(workspace.id))?.billing.subscriptionStatus,
        ).toBe("past_due");
        expect(await repo.listPaidActiveBilling()).toEqual([]);
      });

      it("preserves opaque workflow secrets, atomic triggers, live status transitions, and JSONB repo lookup", async () => {
        const repo = backend.createRepo();
        const owner = await seedUser({
          mongoId: generateUuidv7(),
          email: "wf@example.com",
        });
        const { workspace: ws1 } = await repo.createWorkspaceWithOwner({
          name: "WF 1",
          slug: "wf-1",
          userId: backend.idForUser(owner),
        });
        const { workspace: ws2 } = await repo.createWorkspaceWithOwner({
          name: "WF 2",
          slug: "wf-2",
          userId: backend.idForUser(owner),
        });

        // Repo bindings + lookup by owner/repo
        const linkedAt = new Date("2026-11-10T12:00:00.000Z");
        await repo.setWorkspaceRepos(ws1.id, [
          {
            provider: "github",
            installationId: 4242,
            owner: "acme",
            repo: "analytics",
            defaultBranch: "main",
            subdirectory: "",
            linkedBy: backend.idForUser(owner),
            linkedAt,
          },
        ]);
        expect(
          await repo.findWorkspaceIdsByRepoBinding("acme", "analytics"),
        ).toEqual([ws1.id]);

        // Opaque encrypted Hatchet token (copied verbatim, never decrypted)
        const opaqueToken = "iv0123456789abcdef:ciphertext99887766";
        await repo.setWorkflowHatchetToken(ws1.id, opaqueToken);
        expect((await repo.findById(ws1.id))?.workflows?.hatchetToken).toBe(
          opaqueToken,
        );
        expect(await repo.findOtherWorkspaceWithHatchetToken(ws2.id)).toEqual({
          id: ws1.id,
          slug: "wf-1",
        });
        expect(
          await repo.findOtherWorkspaceWithHatchetToken(ws1.id),
        ).toBeNull();
        expect((await repo.listWithHatchetToken()).map(w => w.id)).toEqual([
          ws1.id,
        ]);

        // Live target + status reporting + preserving running across target bump
        await repo.setWorkflowLiveTarget(ws1.id, {
          sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          tree: "1111111111111111111111111111111111111111",
          names: ["daily-sync", "alerts"],
        });
        expect(await repo.listIdsWithDeployedWorkflows()).toEqual([ws1.id]);

        // Mismatched sha does nothing
        expect(
          await repo.reportWorkflowLiveStatus(
            ws1.id,
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "boom",
          ),
        ).toBe(false);
        // Matching sha sets failed, then clears failed on success
        expect(
          await repo.reportWorkflowLiveStatus(
            ws1.id,
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "build failed",
          ),
        ).toBe(true);
        expect((await repo.findById(ws1.id))?.workflows?.live?.failed).toEqual({
          sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          error: "build failed",
        });
        expect(
          await repo.reportWorkflowLiveStatus(
            ws1.id,
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          ),
        ).toBe(true);
        const runningSlot = (await repo.findById(ws1.id))?.workflows?.live;
        expect(runningSlot?.running).toEqual({
          sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        });
        expect(runningSlot?.failed).toBeUndefined();

        // Updating live target preserves `running`
        await repo.setWorkflowLiveTarget(ws1.id, {
          sha: "cccccccccccccccccccccccccccccccccccccccc",
          tree: "2222222222222222222222222222222222222222",
          names: ["daily-sync"],
        });
        const bumpedSlot = (await repo.findById(ws1.id))?.workflows?.live;
        expect(bumpedSlot?.sha).toBe(
          "cccccccccccccccccccccccccccccccccccccccc",
        );
        expect(bumpedSlot?.running).toEqual({
          sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        });

        // Atomic active toggles + per-webhook opaque secret set/delete
        await repo.setWorkflowTrigger(ws1.id, "daily-sync", {
          active: true,
          encryptedWebhookSecret: "iv1:sec1",
        });
        await repo.setWorkflowTrigger(ws1.id, "alerts", {
          active: true,
          encryptedWebhookSecret: "iv2:sec2",
        });
        // Idempotent active add + delete only one webhook
        await repo.setWorkflowTrigger(ws1.id, "daily-sync", {
          active: true,
          encryptedWebhookSecret: null,
        });
        await repo.setWorkflowTrigger(ws1.id, "alerts", { active: false });
        const wfAfter = (await repo.findById(ws1.id))?.workflows;
        expect(wfAfter?.active).toEqual(["daily-sync"]);
        expect(wfAfter?.webhooks).toEqual({ alerts: "iv2:sec2" });

        // Clear live target
        await repo.setWorkflowLiveTarget(ws1.id, null);
        expect(await repo.listIdsWithDeployedWorkflows()).toEqual([]);
      });

      it("preserves API key _id, scopes NULL vs [], and throttles last_used_at writes to 60s", async () => {
        const repo = backend.createRepo();
        const owner = await seedUser({
          mongoId: generateUuidv7(),
          email: "keys@example.com",
        });
        const ownerId = backend.idForUser(owner);
        const { workspace } = await repo.createWorkspaceWithOwner({
          name: "KeyCo",
          slug: "keyco",
          userId: ownerId,
        });

        const legacyHash = makeHash("legacy");
        const emptyHash = makeHash("empty");
        const scopedHash = makeHash("scoped");

        const legacyKey = await repo.createApiKey({
          workspaceId: workspace.id,
          name: "Legacy Unrestricted",
          keyHash: legacyHash,
          prefix: "revops_legacy0",
          // scopes intentionally omitted -> NULL in PG, undefined in DTO
          createdBy: ownerId,
        });
        const emptyScopedKey = await repo.createApiKey({
          workspaceId: workspace.id,
          name: "Empty Scoped",
          keyHash: emptyHash,
          prefix: "revops_empty00",
          scopes: [],
          createdBy: ownerId,
          agentRun: true,
          recordWrites: true,
        });
        const workerKey = await repo.replaceApiKeyByName({
          workspaceId: workspace.id,
          name: "workflows-worker",
          keyHash: scopedHash,
          prefix: "revops_worker0",
          scopes: ["workflows:runtime"],
          createdBy: ownerId,
        });

        expect(legacyKey.scopes).toBeUndefined();
        expect(emptyScopedKey.scopes).toEqual([]);
        expect(emptyScopedKey.agentRun).toBe(true);
        expect(emptyScopedKey.recordWrites).toBe(true);

        const foundLegacy = await repo.findApiKeyByHash(legacyHash);
        expect(foundLegacy?.apiKey.id).toBe(legacyKey.id);
        expect(foundLegacy?.apiKey.scopes).toBeUndefined();

        const foundEmpty = await repo.findApiKeyByHash(emptyHash);
        expect(foundEmpty?.apiKey.scopes).toEqual([]);

        // 60s lastUsedAt throttle
        const t0 = new Date("2026-11-26T10:00:00.000Z");
        const t5s = new Date("2026-11-26T10:00:05.000Z");
        const t61s = new Date("2026-11-26T10:01:01.000Z");
        await repo.touchApiKeyLastUsed(workspace.id, legacyKey.id, t0, 60_000);
        expect(
          (
            await repo.findApiKeyByHash(legacyHash)
          )?.apiKey.lastUsedAt?.getTime(),
        ).toBe(t0.getTime());
        await repo.touchApiKeyLastUsed(workspace.id, legacyKey.id, t5s, 60_000);
        expect(
          (
            await repo.findApiKeyByHash(legacyHash)
          )?.apiKey.lastUsedAt?.getTime(),
        ).toBe(t0.getTime());
        await repo.touchApiKeyLastUsed(
          workspace.id,
          legacyKey.id,
          t61s,
          60_000,
        );
        expect(
          (
            await repo.findApiKeyByHash(legacyHash)
          )?.apiKey.lastUsedAt?.getTime(),
        ).toBe(t61s.getTime());

        // Scopes update by name + sandbox prefix prune + delete
        expect(
          await repo.updateApiKeyScopesByName(
            workspace.id,
            "workflows-worker",
            ["workflows:runtime", "query:read"],
          ),
        ).toBe(true);
        expect(
          (await repo.findApiKeyByHash(scopedHash))?.apiKey.scopes,
        ).toEqual(["workflows:runtime", "query:read"]);

        await repo.createApiKey({
          workspaceId: workspace.id,
          name: "sandbox-u1 sandbox-old",
          keyHash: makeHash("sb-old"),
          prefix: "revops_sbold00",
          scopes: ["workflows:runtime"],
          createdBy: ownerId,
          createdAt: new Date("2026-11-01T00:00:00.000Z"),
        });
        await repo.createApiKey({
          workspaceId: workspace.id,
          name: "sandbox-u1 sandbox-new",
          keyHash: makeHash("sb-new"),
          prefix: "revops_sbnew00",
          scopes: ["workflows:runtime"],
          createdBy: ownerId,
          createdAt: new Date("2026-11-26T00:00:00.000Z"),
        });
        expect(
          await repo.pruneExpiredApiKeysByNamePrefix(
            workspace.id,
            "sandbox-u1 sandbox-",
            new Date("2026-11-20T00:00:00.000Z"),
          ),
        ).toBeGreaterThan(0);
        const remainingNames = (await repo.listApiKeys(workspace.id)).map(
          k => k.name,
        );
        expect(remainingNames).not.toContain("sandbox-u1 sandbox-old");
        expect(remainingNames).toContain("sandbox-u1 sandbox-new");
        expect(await repo.deleteApiKey(workspace.id, workerKey.id)).toBe(true);
      });

      it("handles members, invites, handles, MCP OAuth, ACP grants, and GitHub installations", async () => {
        const repo = backend.createRepo();
        const owner = await seedUser({
          mongoId: "owner15charid01",
          email: "owner@co.io",
        });
        const memberUser = await seedUser({
          mongoId: generateUuidv7(),
          email: "dev@co.io",
        });
        const ownerId = backend.idForUser(owner);
        const memberId = backend.idForUser(memberUser);

        const { workspace } = await repo.createWorkspaceWithOwner({
          name: "FullCo",
          slug: "fullco",
          userId: ownerId,
        });

        // Workspaces for user + members with users
        const userWorkspaces = await repo.findWorkspacesForUser(ownerId);
        expect(userWorkspaces.map(w => w.workspace.id)).toEqual([workspace.id]);
        expect(userWorkspaces[0]?.role).toBe("owner");

        // Invite -> lookup with refs -> acceptInviteTransaction
        const invite = await repo.createInvite({
          workspaceId: workspace.id,
          email: "DEV@co.io",
          token: "tok-dev-123",
          role: "member",
          invitedBy: ownerId,
          expiresAt: new Date(Date.now() + 86_400_000),
        });
        const inviteWithRefs =
          await repo.findPendingInviteByToken("tok-dev-123");
        expect(inviteWithRefs?.workspace?.name).toBe("FullCo");
        expect(inviteWithRefs?.inviter?.email).toBe("owner@co.io");
        expect(
          (await repo.listPendingInvitesForEmail("dev@co.io")).length,
        ).toBe(1);

        const accepted = await repo.acceptInviteTransaction(
          invite.token,
          memberId,
        );
        expect(accepted.workspace.id).toBe(workspace.id);
        expect(accepted.member.role).toBe("member");
        expect(accepted.invite.acceptedAt).toBeInstanceOf(Date);
        // Re-accepting fails
        await expect(
          repo.acceptInviteTransaction(invite.token, memberId),
        ).rejects.toThrow("Invalid or expired invite");

        const membersWithUsers = await repo.listMembersWithUsers(workspace.id);
        expect(membersWithUsers.map(m => m.user?.email).sort()).toEqual([
          "dev@co.io",
          "owner@co.io",
        ]);

        // Update role to viewer + matching user IDs
        const updatedMember = await repo.updateMemberRole(
          workspace.id,
          memberId,
          "viewer",
        );
        expect(updatedMember?.role).toBe("viewer");
        expect(
          await repo.findMatchingMemberUserIds(
            workspace.id,
            [ownerId, memberId, "nonexistent"],
            "viewer",
          ),
        ).toEqual([memberId]);

        // Handles + conflict handling
        const h1 = await repo.insertHandlesBestEffort(workspace.id, [
          { userId: ownerId, handle: "owner" },
          { userId: memberId, handle: "dev" },
        ]);
        expect(h1.hadConflict).toBe(false);
        expect(h1.inserted.length).toBe(2);
        const h2 = await repo.insertHandlesBestEffort(workspace.id, [
          { userId: ownerId, handle: "owner" },
        ]);
        expect(h2.hadConflict).toBe(true);
        expect((await repo.listHandles(workspace.id)).length).toBe(2);

        // MCP OAuth clients + single-use codes + rotating tokens + grouped connections
        const client = await repo.ensureMcpClient({
          clientId: "mcpc_test_client",
          clientName: "Claude Desktop",
          redirectUris: ["http://localhost:9999/cb"],
        });
        expect(client.clientId).toBe("mcpc_test_client");

        const codeHash = makeHash("code1");
        await repo.createMcpCode({
          codeHash,
          clientId: client.clientId,
          userId: ownerId,
          workspaceId: workspace.id,
          redirectUri: "http://localhost:9999/cb",
          codeChallenge: "chal_1",
          scopes: ["mcp", "query:read"],
          expiresAt: new Date(Date.now() + 600_000),
        });
        expect((await repo.redeemMcpCodeOnce(codeHash))?.codeHash).toBe(
          codeHash,
        );
        expect(await repo.redeemMcpCodeOnce(codeHash)).toBeNull();

        const access1 = makeHash("at1");
        const refresh1 = makeHash("rt1");
        const token = await repo.createMcpToken({
          accessTokenHash: access1,
          refreshTokenHash: refresh1,
          clientId: client.clientId,
          userId: ownerId,
          workspaceId: workspace.id,
          agentSessionId: "acp-sess-1",
          scopes: ["mcp", "workflows:runtime", "query:read"],
          accessExpiresAt: new Date(Date.now() + 3600_000),
          refreshExpiresAt: new Date(Date.now() + 86_400_000),
        });
        expect((await repo.findValidMcpTokenByAccessHash(access1))?.id).toBe(
          token.id,
        );
        expect(
          await repo.hasActiveMcpAgentSession({
            workspaceId: workspace.id,
            userId: ownerId,
            clientId: client.clientId,
            agentSessionId: "acp-sess-1",
          }),
        ).toBe(true);

        // Rotate refresh token: strips internal scope `workflows:runtime`
        const access2 = makeHash("at2");
        const refresh2 = makeHash("rt2");
        const rotated = await repo.rotateMcpRefreshToken({
          currentRefreshTokenHash: refresh1,
          clientId: client.clientId,
          newAccessTokenHash: access2,
          newRefreshTokenHash: refresh2,
          newAccessExpiresAt: new Date(Date.now() + 7200_000),
          newRefreshExpiresAt: null, // idle TTL disabled -> clears refreshExpiresAt
          stripScopes: ["workflows:runtime"],
        });
        expect(rotated?.scopes).toEqual(["mcp", "query:read"]);
        expect(rotated?.refreshExpiresAt).toBeUndefined();
        // Old refresh hash can no longer rotate
        expect(
          await repo.rotateMcpRefreshToken({
            currentRefreshTokenHash: refresh1,
            clientId: client.clientId,
            newAccessTokenHash: makeHash("at3"),
            newRefreshTokenHash: makeHash("rt3"),
            newAccessExpiresAt: new Date(Date.now() + 7200_000),
            newRefreshExpiresAt: null,
            stripScopes: [],
          }),
        ).toBeNull();

        const connections = await repo.listMcpConnections(workspace.id);
        expect(connections.length).toBe(1);
        expect(connections[0]?.clientName).toBe("Claude Desktop");

        // ACP plan grants
        await repo.upsertAcpGrant({
          workspaceId: workspace.id,
          userId: ownerId,
          agentSessionId: "acp-sess-1",
          planDigest: sha256("plan v1"),
          grants: ["git-write", "artifact-write"],
          expiresAt: new Date(Date.now() + 3600_000),
        });
        const activeGrant = await repo.findActiveAcpGrant({
          workspaceId: workspace.id,
          userId: ownerId,
          agentSessionId: "acp-sess-1",
        });
        expect(activeGrant?.grants).toEqual(["git-write", "artifact-write"]);
        expect(
          await repo.revokeAcpGrant({
            workspaceId: workspace.id,
            userId: ownerId,
            agentSessionId: "acp-sess-1",
          }),
        ).toBe(true);
        expect(
          await repo.findActiveAcpGrant({
            workspaceId: workspace.id,
            userId: ownerId,
            agentSessionId: "acp-sess-1",
          }),
        ).toBeNull();

        // GitHub installations (including >int32 bigint installationId)
        const bigInstallId = 5_000_000_123;
        const staleInstallId = 5_000_000_100;
        await repo.upsertGitHubInstallation({
          workspaceId: workspace.id,
          installationId: staleInstallId,
          accountLogin: "acme-org",
          accountType: "Organization",
          repositorySelection: "selected",
          createdBy: ownerId,
        });
        const inst = await repo.upsertGitHubInstallation({
          workspaceId: workspace.id,
          installationId: bigInstallId,
          accountLogin: "acme-org",
          accountType: "Organization",
          repositorySelection: "all",
          createdBy: ownerId,
        });
        expect(inst.installationId).toBe(bigInstallId);
        expect(
          await repo.pruneStaleGitHubInstallations(
            workspace.id,
            "acme-org",
            bigInstallId,
          ),
        ).toBe(1);
        expect(
          (await repo.listGitHubInstallations(workspace.id)).map(
            i => i.installationId,
          ),
        ).toEqual([bigInstallId]);
        expect(
          await repo.deleteGitHubInstallationsByInstallationId(bigInstallId),
        ).toBe(1);
        expect(
          await repo.findGitHubInstallation(workspace.id, bigInstallId),
        ).toBeNull();
      });
    });
  }

  // ── 2. 5-Stage Dual-Run + Rollback + Hot-Read Isolation + Sync-Retry ───

  describe("DualWorkspaceRepository 5-stage lifecycle, rollback, hot-read isolation & sync-retry", () => {
    it("walks all 5 stages + Stage 4->2 rollback with zero hot-read leaks and zero secrets in retry payloads", async () => {
      const shadowEvents: ShadowCompareEvent[] = [];
      const failures: SecondaryWriteFailureContext[] = [];
      const shadowRunner = new ShadowCompareRunner({
        onEvent: evt => {
          shadowEvents.push(evt);
        },
      });
      const router = new MigrationRouter({
        getDb: () => db,
        hasPg: () => true,
        enablePubSub: false,
        shadowRunner,
        onSecondaryFailure: async ctx => {
          failures.push(ctx);
        },
        cacheTtlMs: 0,
        secondaryTimeoutMs: 5_000,
      });

      const mongoRepo = new MongoWorkspaceRepository();
      const pgRepo = new PgWorkspaceRepository({ getDb: () => db });
      const dualRepo = new DualWorkspaceRepository({
        mongo: mongoRepo,
        pg: pgRepo,
        router,
        getDb: () => db,
      });

      const legacyUser = await seedUser({
        mongoId: "lucia15charid99",
        email: "legacy@mako.ai",
      });
      const v7User = await seedUser({
        mongoId: generateUuidv7(),
        email: "modern@mako.ai",
      });

      // Stage 1: mongo_only -> zero PG calls
      await router.setDomainState({
        domain: WORKSPACES_DOMAIN,
        mode: "mongo_only",
      });
      const pgFindSpy = vi.spyOn(pgRepo, "findById");
      const pgMemberSpy = vi.spyOn(pgRepo, "findMember");

      const stage1Created = await dualRepo.createWorkspaceWithOwner({
        name: "Stage 1 WS",
        slug: "stage-1-ws",
        userId: legacyUser.mongoId,
      });
      expect(
        await dualRepo.findById(stage1Created.workspace.id),
      ).not.toBeNull();
      expect(pgFindSpy).not.toHaveBeenCalled();
      expect(await pgRepo.findById(stage1Created.workspace.id)).toBeNull();

      // Stage 2: dual_write_mongo_read -> writes land in Mongo primary AND resync to PG (mapping legacyUser -> pgUuid!)
      await router.setDomainState({
        domain: WORKSPACES_DOMAIN,
        mode: "dual_write_mongo_read",
      });
      const { workspace: ws } = await dualRepo.createWorkspaceWithOwner({
        name: "Dual WS",
        slug: "dual-ws",
        userId: legacyUser.mongoId,
      });
      const pgWs = await pgRepo.findById(ws.id);
      expect(pgWs?.name).toBe("Dual WS");
      expect(pgWs?.createdBy).toBe(legacyUser.pgUuid);

      const apiKeyHash = makeHash("stage2-key");
      const createdKey = await dualRepo.createApiKey({
        workspaceId: ws.id,
        name: "Dual Key",
        keyHash: apiKeyHash,
        prefix: "revops_dualkey",
        scopes: ["mcp"],
        createdBy: legacyUser.mongoId,
      });
      const pgKey = await pgRepo.findApiKeyByHash(apiKeyHash);
      expect(pgKey?.apiKey.id).toBe(createdKey.id);
      expect(pgKey?.apiKey.createdBy).toBe(legacyUser.pgUuid);

      await dualRepo.upsertGitHubInstallation({
        workspaceId: ws.id,
        installationId: 777001,
        accountLogin: "dual-org",
        accountType: "Organization",
        repositorySelection: "all",
        createdBy: legacyUser.mongoId,
      });
      expect(await pgRepo.findGitHubInstallation(ws.id, 777001)).not.toBeNull();

      // Stage 3: dual_write_shadow_compare with sampleRate=0 -> ZERO PG hot-path reads!
      await router.setDomainState({
        domain: WORKSPACES_DOMAIN,
        mode: "dual_write_shadow_compare",
        shadowSampleRate: 0,
      });
      pgFindSpy.mockClear();
      pgMemberSpy.mockClear();
      await dualRepo.findById(ws.id);
      await dualRepo.findMember(ws.id, legacyUser.mongoId);
      expect(pgFindSpy).not.toHaveBeenCalled();
      expect(pgMemberSpy).not.toHaveBeenCalled();

      // Stage 3 with sampleRate=1 -> shadow-compare runs and reports 0 diffs!
      await router.setDomainState({
        domain: WORKSPACES_DOMAIN,
        mode: "dual_write_shadow_compare",
        shadowSampleRate: 1,
      });
      shadowEvents.length = 0;
      await dualRepo.findById(ws.id);
      await dualRepo.findApiKeyByHash(apiKeyHash);
      await dualRepo.findMember(ws.id, legacyUser.mongoId);
      await dualRepo.listMembersWithUsers(ws.id);
      await dualRepo.listGitHubInstallations(ws.id);
      await shadowRunner.flush();
      expect(shadowEvents.length).toBeGreaterThanOrEqual(5);
      for (const evt of shadowEvents) {
        expect(
          evt.result,
          `shadow diff on ${evt.operation}: ${JSON.stringify(evt.diffs)}`,
        ).toBe("match");
      }

      // Stage 4: dual_write_pg_read -> PG primary, Mongo secondary reverse-sync!
      await router.setDomainState({
        domain: WORKSPACES_DOMAIN,
        mode: "dual_write_pg_read",
        shadowSampleRate: 0,
      });
      const mongoFindSpy = vi.spyOn(mongoRepo, "findById");
      await dualRepo.findById(ws.id);
      // Unsampled Stage 4 hot read makes ZERO Mongo calls!
      expect(mongoFindSpy).not.toHaveBeenCalled();

      // Write in Stage 4 with PG UUID -> reverse-syncs legacyUser.mongoId back into Mongo & preserves existing apiKeys[]!
      await dualRepo.updateWorkspace(ws.id, { name: "Stage 4 Renamed" });
      await dualRepo.addMember({
        workspaceId: ws.id,
        userId: v7User.pgUuid,
        role: "admin",
      });
      const stage4KeyHash = makeHash("stage4-key");
      const stage4Key = await dualRepo.createApiKey({
        workspaceId: ws.id,
        name: "Stage 4 Key",
        keyHash: stage4KeyHash,
        prefix: "revops_stage4k",
        scopes: ["query:read"],
        createdBy: legacyUser.pgUuid,
      });
      await dualRepo.upsertGitHubInstallation({
        workspaceId: ws.id,
        installationId: 777002,
        accountLogin: "stage4-org",
        accountType: "User",
        repositorySelection: "selected",
        createdBy: legacyUser.pgUuid,
      });

      // Stage 4 -> Stage 2 emergency rollback: Mongo MUST see every Stage 4 write + preserved Stage 2 key + legacy userId!
      await router.setDomainState({
        domain: WORKSPACES_DOMAIN,
        mode: "dual_write_mongo_read",
      });
      const rolledBackWs = await dualRepo.findById(ws.id);
      expect(rolledBackWs?.name).toBe("Stage 4 Renamed");
      expect(rolledBackWs?.createdBy).toBe(legacyUser.mongoId);
      const rolledBackKeys = await dualRepo.listApiKeys(ws.id);
      expect(rolledBackKeys.map(k => k.id).sort()).toEqual(
        [createdKey.id, stage4Key.id].sort(),
      );
      expect(rolledBackKeys.find(k => k.id === stage4Key.id)?.createdBy).toBe(
        legacyUser.mongoId,
      );
      const rolledBackGh = await dualRepo.findGitHubInstallation(ws.id, 777002);
      expect(rolledBackGh?.accountLogin).toBe("stage4-org");
      expect(rolledBackGh?.createdBy).toBe(legacyUser.mongoId);

      // Stage 5: pg_only -> writes PG only
      await router.setDomainState({
        domain: WORKSPACES_DOMAIN,
        mode: "pg_only",
      });
      await dualRepo.updateWorkspace(ws.id, { name: "PG Only Name" });
      expect((await pgRepo.findById(ws.id))?.name).toBe("PG Only Name");
      expect((await mongoRepo.findById(ws.id))?.name).toBe("Stage 4 Renamed");

      // Secondary failure isolation + ID-only payload (zero secrets!) + replayWorkspacesRetry
      await router.setDomainState({
        domain: WORKSPACES_DOMAIN,
        mode: "dual_write_mongo_read",
      });
      failures.length = 0;
      const secretInviteToken = "super-secret-invite-token-xyz";
      const secretEmail = "secret-invitee@example.com";
      const brokenDual = new DualWorkspaceRepository({
        mongo: mongoRepo,
        pg: pgRepo,
        router,
        getDb: () => {
          throw new Error("Simulated PG outage");
        },
      });
      const inv = await brokenDual.createInvite({
        workspaceId: ws.id,
        email: secretEmail,
        token: secretInviteToken,
        role: "member",
        invitedBy: legacyUser.mongoId,
        expiresAt: new Date(Date.now() + 86_400_000),
      });
      expect(inv.token).toBe(secretInviteToken);
      expect(failures.length).toBe(1);
      const retryJson = JSON.stringify(failures[0]?.payload ?? {});
      expect(retryJson).not.toContain(secretInviteToken);
      expect(retryJson).not.toContain(secretEmail);
      expect(retryJson).toContain(inv.id);

      // Replay heals PG cleanly
      const retryEvent: SyncRetryEventData = {
        domain: WORKSPACES_DOMAIN,
        operation: failures[0].operation,
        target: "pg",
        entityId: failures[0].entityId ?? inv.id,
        payload: failures[0].payload,
        failedAt: new Date().toISOString(),
        errorMessage: "Simulated PG outage",
      };
      await replayWorkspacesRetry(retryEvent, { getDb: () => db });
      expect(
        (await pgRepo.findPendingInviteByToken(secretInviteToken))?.id,
      ).toBe(inv.id);
    });
  });

  // ── 3. Backfill, Quarantine, Tombstones, Verifier (--repair) & TTL ─────

  describe("FK-ordered backfill, quarantine, tombstones, parity verifier & TTL reaper", () => {
    it("backfills all 10 tables with pagination, quarantines orphans, respects tombstones, verifies/repairs with POSTGRES_URL unset, and reaps TTL tables", async () => {
      expect(listBackfillDomains()).toContain(WORKSPACES_DOMAIN);
      expect(listBackfillDomains()).toContain(
        `${WORKSPACES_DOMAIN}:github_installations`,
      );
      expect(listVerifierDomains()).toContain(WORKSPACES_DOMAIN);

      const u1 = await seedUser({
        mongoId: "legacy_u1_15chr",
        email: "u1@example.com",
      });
      const u2 = await seedUser({
        mongoId: generateUuidv7(),
        email: "u2@example.com",
      });

      const ws1Id = new Types.ObjectId(newDualId().oid);
      const wsTombstonedId = new Types.ObjectId(newDualId().oid);
      const key1Id = new Types.ObjectId(newDualId().oid);
      const key2Id = new Types.ObjectId(newDualId().oid);
      const key3Id = new Types.ObjectId(newDualId().oid);

      // Seed workspaces in Mongo: ws1 has legacy appsRepo, opaque workflow secret, 3 API keys (testing pagination with batchSize=2)
      await Workspace.collection.insertOne({
        _id: ws1Id,
        name: "Backfill WS",
        slug: "backfill-ws",
        createdBy: "system", // synthetic creator -> maps to NULL in PG!
        settings: {
          maxDatabases: 5,
          maxMembers: 10,
          billingTier: "free",
          disabledModelIds: [],
          linkPreviews: false,
        },
        billing: {
          stripeCustomerId: null,
          stripeSubscriptionId: null,
          subscriptionStatus: null,
          currentPeriodStart: null,
          currentPeriodEnd: null,
          usageQuotaUsd: 5,
          hardLimitUsd: null,
          plan: "free",
          lastReportedOverageCents: 0,
          pendingReportedOverageCents: null,
          pendingMeterEventIdempotencyKey: null,
        },
        appsRepo: {
          provider: "github",
          owner: "legacy-org",
          repo: "legacy-repo",
          defaultBranch: "main",
          subdirectory: "",
        },
        workflows: {
          hatchetToken: "iv_bf:cipher_bf",
          active: ["sync"],
          webhooks: { sync: "iv_wh:cipher_wh" },
        },
        apiKeys: [
          {
            _id: key1Id,
            name: "Key 1",
            keyHash: makeHash("bf-k1"),
            prefix: "revops_bfk1000",
            createdBy: u1.mongoId,
            createdAt: new Date("2026-11-01T00:00:00.000Z"),
            // scopes omitted -> NULL
          },
          {
            _id: key2Id,
            name: "Key 2",
            keyHash: makeHash("bf-k2"),
            prefix: "revops_bfk2000",
            scopes: [],
            createdBy: "system",
            createdAt: new Date("2026-11-02T00:00:00.000Z"),
          },
          {
            _id: key3Id,
            name: "Key 3",
            keyHash: makeHash("bf-k3"),
            prefix: "revops_bfk3000",
            scopes: ["mcp"],
            createdBy: u2.mongoId,
            createdAt: new Date("2026-11-03T00:00:00.000Z"),
          },
        ],
        createdAt: new Date("2026-11-01T00:00:00.000Z"),
        updatedAt: new Date("2026-11-05T00:00:00.000Z"),
      });

      // Tombstoned workspace (should NOT be resurrected into PG!)
      await Workspace.collection.insertOne({
        _id: wsTombstonedId,
        name: "Deleted WS",
        slug: "deleted-ws",
        createdBy: u1.mongoId,
        settings: { maxDatabases: 5, maxMembers: 10, billingTier: "free" },
        billing: { usageQuotaUsd: 5, hardLimitUsd: 5, plan: "free" },
        createdAt: new Date("2026-11-01T00:00:00.000Z"),
        updatedAt: new Date("2026-11-01T00:00:00.000Z"),
      });
      await recordMigrationTombstone(
        "workspaces",
        objectIdToUuid(wsTombstonedId.toHexString()),
        db,
      );

      // Members: 1 valid + 1 orphaned user (quarantined)
      await WorkspaceMember.create({
        workspaceId: ws1Id,
        userId: u1.mongoId,
        role: "owner",
        isDefaultMembership: true,
      });
      await WorkspaceMember.create({
        workspaceId: ws1Id,
        userId: "ghost_user_missing",
        role: "member",
      });

      // Invites: 1 active + 1 expired (for TTL reaper)
      await WorkspaceInvite.create({
        workspaceId: ws1Id,
        email: "active-invite@example.com",
        token: "tok-active-bf",
        role: "member",
        invitedBy: u1.mongoId,
        expiresAt: new Date(Date.now() + 86_400_000),
      });
      await WorkspaceInvite.create({
        workspaceId: ws1Id,
        email: "expired-invite@example.com",
        token: "tok-expired-bf",
        role: "viewer",
        invitedBy: "system",
        expiresAt: new Date(Date.now() - 86_400_000),
      });

      // Handles (including a deleted/unknown user whose handle stays reserved with NULL user_id)
      await WorkspaceUserHandle.create({
        workspaceId: ws1Id,
        userId: u1.mongoId,
        handle: "alice",
      });
      await WorkspaceUserHandle.create({
        workspaceId: ws1Id,
        userId: "departed_deleted_user",
        handle: "departed",
      });

      // GitHub installation
      const ghDoc = await GitHubInstallation.create({
        workspaceId: ws1Id,
        installationId: 888999,
        accountLogin: "bf-org",
        accountType: "Organization",
        repositorySelection: "all",
        createdBy: u1.mongoId,
      });

      // MCP OAuth client, codes (1 active + 1 expired), tokens (1 non-expiring + 1 expired + 1 orphan workspace)
      await McpOAuthClient.create({
        clientId: "mcpc_bf_1",
        clientName: "BF Client",
        redirectUris: ["https://client.example/cb"],
      });
      await McpOAuthCode.create({
        codeHash: makeHash("code-active"),
        clientId: "mcpc_bf_1",
        userId: u1.mongoId,
        workspaceId: ws1Id.toHexString(),
        redirectUri: "https://client.example/cb",
        codeChallenge: "chal_active",
        scopes: ["mcp"],
        expiresAt: new Date(Date.now() + 600_000),
      });
      await McpOAuthCode.create({
        codeHash: makeHash("code-expired"),
        clientId: "mcpc_bf_1",
        userId: u1.mongoId,
        workspaceId: ws1Id.toHexString(),
        redirectUri: "https://client.example/cb",
        codeChallenge: "chal_expired",
        scopes: ["mcp"],
        expiresAt: new Date(Date.now() - 600_000),
      });
      await McpOAuthToken.create({
        accessTokenHash: makeHash("at-nonexp"),
        refreshTokenHash: makeHash("rt-nonexp"),
        clientId: "mcpc_bf_1",
        userId: u1.mongoId,
        workspaceId: ws1Id.toHexString(),
        scopes: ["mcp"],
        accessExpiresAt: new Date(Date.now() + 3600_000),
        // refreshExpiresAt omitted -> NULL (must NOT be reaped!)
      });
      await McpOAuthToken.create({
        accessTokenHash: makeHash("at-exp"),
        refreshTokenHash: makeHash("rt-exp"),
        clientId: "mcpc_bf_1",
        userId: u2.mongoId,
        workspaceId: ws1Id.toHexString(),
        scopes: ["mcp"],
        accessExpiresAt: new Date(Date.now() - 3600_000),
        refreshExpiresAt: new Date(Date.now() - 1000),
      });
      await McpOAuthToken.create({
        accessTokenHash: makeHash("at-orphan"),
        refreshTokenHash: makeHash("rt-orphan"),
        clientId: "mcpc_bf_1",
        userId: u1.mongoId,
        workspaceId: "not-a-valid-oid",
        scopes: ["mcp"],
        accessExpiresAt: new Date(Date.now() + 3600_000),
      });

      // ACP plan grants (1 active + 1 expired)
      await AcpPlanGrant.create({
        workspaceId: ws1Id.toHexString(),
        userId: u1.mongoId,
        agentSessionId: "acp-active-bf",
        planDigest: sha256("p1"),
        grants: ["git-write"],
        status: "approved",
        expiresAt: new Date(Date.now() + 3600_000),
      });
      await AcpPlanGrant.create({
        workspaceId: ws1Id.toHexString(),
        userId: u2.mongoId,
        agentSessionId: "acp-expired-bf",
        planDigest: sha256("p2"),
        grants: ["git-write"],
        status: "revoked",
        expiresAt: new Date(Date.now() - 3600_000),
      });

      // Run FK-ordered backfill with small batchSize=2 to exercise resumable multi-table + multi-key pagination
      const bfSummary = await runBackfill({
        domain: WORKSPACES_DOMAIN,
        db,
        batchSize: 2,
      });
      expect(bfSummary.status).toBe("completed");
      expect(bfSummary.rowsSkippedTombstone).toBe(1);
      expect(bfSummary.rowsQuarantined).toBe(2); // ghost user member + invalid-workspaceId token

      const pgRepo = new PgWorkspaceRepository({ getDb: () => db });
      expect(await pgRepo.findById(wsTombstonedId.toHexString())).toBeNull();
      const bfWs = await pgRepo.findById(ws1Id.toHexString());
      expect(bfWs?.createdBy).toBe("");
      expect(bfWs?.workspaceRepos?.[0]?.owner).toBe("legacy-org");
      expect((await pgRepo.listApiKeys(ws1Id.toHexString())).length).toBe(3);
      expect(
        await pgRepo.findGitHubInstallation(ws1Id.toHexString(), 888999),
      ).not.toBeNull();

      // Remove the 2 quarantined bad docs from Mongo so parity verifier checks clean valid corpus
      await WorkspaceMember.deleteMany({ userId: "ghost_user_missing" });
      await McpOAuthToken.deleteMany({ workspaceId: "not-a-valid-oid" });
      await Workspace.deleteOne({ _id: wsTombstonedId });

      // Verify parity with POSTGRES_URL UNSET & pgTestDb cleared (proving fetchMongoBatch uses injected `db`!)
      resetPgTestDb();
      const prevPgUrl = process.env.POSTGRES_URL;
      delete process.env.POSTGRES_URL;
      try {
        const cleanVerify = await runParityVerification({
          domain: WORKSPACES_DOMAIN,
          db,
          batchSize: 2,
        });
        expect(cleanVerify.missingInPg).toBe(0);
        expect(cleanVerify.extraInPg).toBe(0);
        expect(cleanVerify.mismatched).toBe(0);

        // Introduce drift across 3 tables in PG and heal with --repair
        await db
          .update(pgSchema.workspaces)
          .set({ name: "Drifted Name" })
          .where(
            eq(pgSchema.workspaces.id, objectIdToUuid(ws1Id.toHexString())),
          );
        await db
          .delete(pgSchema.workspaceApiKeys)
          .where(
            eq(
              pgSchema.workspaceApiKeys.id,
              objectIdToUuid(key2Id.toHexString()),
            ),
          );
        await db
          .update(pgSchema.githubInstallations)
          .set({ accountLogin: "drifted-org" })
          .where(
            eq(
              pgSchema.githubInstallations.id,
              objectIdToUuid(ghDoc._id.toHexString()),
            ),
          );

        const repairedReport = await runParityVerification({
          domain: WORKSPACES_DOMAIN,
          db,
          batchSize: 2,
          repair: true,
        });
        expect(repairedReport.mismatched).toBe(2);
        expect(repairedReport.missingInPg).toBe(1);
        expect(repairedReport.repaired).toBe(3);

        const afterRepair = await runParityVerification({
          domain: WORKSPACES_DOMAIN,
          db,
          batchSize: 2,
        });
        expect(afterRepair.missingInPg).toBe(0);
        expect(afterRepair.extraInPg).toBe(0);
        expect(afterRepair.mismatched).toBe(0);
      } finally {
        if (prevPgUrl !== undefined) {
          process.env.POSTGRES_URL = prevPgUrl;
        }
        setPgTestDb(db);
      }

      // TTL reaper rules registered & reap only expired rows (preserving NULL refresh_expires_at!)
      const ruleTables = listTtlRules().map(r => r.tableName);
      expect(ruleTables).toEqual(
        expect.arrayContaining([
          "workspace_invites",
          "mcp_oauth_codes",
          "mcp_oauth_tokens",
          "acp_plan_grants",
        ]),
      );
      const reapResults = await reapAllRegisteredTables({ db });
      expect(reapResults.errors).toEqual({});
      const deletedByTable = new Map(
        reapResults.results.map(r => [r.tableName, r.deleted]),
      );
      expect(deletedByTable.get("workspace_invites")).toBe(1);
      expect(deletedByTable.get("mcp_oauth_codes")).toBe(1);
      expect(deletedByTable.get("mcp_oauth_tokens")).toBe(1);
      expect(deletedByTable.get("acp_plan_grants")).toBe(1);

      // Non-expiring MCP token (refresh_expires_at IS NULL) survived!
      const survivingTokens = await db.select().from(pgSchema.mcpOAuthTokens);
      expect(survivingTokens.length).toBe(1);
      expect(survivingTokens[0]?.refreshExpiresAt).toBeNull();
    });
  });

  // ── 4. WorkspaceService end-to-end with PG primary ─────────────────────

  describe("WorkspaceService integration on PgWorkspaceRepository + authRepo", () => {
    it("updates active session via authRepo, filters existing-member invites, and revokes credentials on member removal", async () => {
      const router = new MigrationRouter({
        getDb: () => db,
        hasPg: () => true,
        enablePubSub: false,
        cacheTtlMs: 0,
      });
      await router.setDomainState({ domain: "auth", mode: "pg_only" });
      await router.setDomainState({
        domain: WORKSPACES_DOMAIN,
        mode: "pg_only",
      });

      const authPg = new DualAuthRepository({ router, getDb: () => db });
      const wsPg = new DualWorkspaceRepository({ router, getDb: () => db });
      setAuthRepoForTests(authPg);
      setWorkspaceRepoForTests(wsPg);

      const owner = await seedUser({
        mongoId: generateUuidv7(),
        email: "svc-owner@example.com",
      });
      const dev = await seedUser({
        mongoId: generateUuidv7(),
        email: "svc-dev@example.com",
      });

      // Create PG session for owner
      const sessionToken = "raw-session-token-1234567890";
      await authPg.createSession({
        id: sessionToken,
        userId: owner.pgUuid,
        expiresAt: new Date(Date.now() + 86_400_000),
      });

      const ws = await workspaceService.createWorkspace(
        owner.pgUuid,
        "Service Test WS",
      );
      const updatedSession = await authPg.findSessionById(sessionToken);
      expect(updatedSession?.activeWorkspaceId).toBe(ws.id);

      // Add dev + create an API key and MCP token for dev
      await workspaceService.addMember(ws.id, dev.pgUuid, "member");
      const devKeyHash = makeHash("dev-key");
      await wsPg.createApiKey({
        workspaceId: ws.id,
        name: "Dev Key",
        keyHash: devKeyHash,
        prefix: "revops_devkey0",
        scopes: ["mcp"],
        createdBy: dev.pgUuid,
      });
      await wsPg.ensureMcpClient({
        clientId: "mcpc_svc",
        redirectUris: ["https://svc.example/cb"],
      });
      const devMcpHash = makeHash("dev-mcp");
      await wsPg.createMcpToken({
        accessTokenHash: devMcpHash,
        refreshTokenHash: makeHash("dev-mcp-rt"),
        clientId: "mcpc_svc",
        userId: dev.pgUuid,
        workspaceId: ws.id,
        scopes: ["mcp"],
        accessExpiresAt: new Date(Date.now() + 3600_000),
      });

      // Removing member revokes BOTH their workspace API key AND their MCP OAuth token
      expect(await workspaceService.removeMember(ws.id, dev.pgUuid)).toBe(true);
      expect(await wsPg.findApiKeyByHash(devKeyHash)).toBeNull();
      expect(await wsPg.findValidMcpTokenByAccessHash(devMcpHash)).toBeNull();
    });
  });

  // ── 5. Audit Regressions (#61: stale backfill, throttle, cascade, tombstones, parity) ─

  describe("Audit regressions: stale backfill, throttle, cascade, tombstones, parity & mixed-mode", () => {
    it("1. protects live redeemed codes, accepted invites, revoked grants, rotated tokens, touched keys, and updated child rows from stale backfill overwrites", async () => {
      const router = new MigrationRouter({
        getDb: () => db,
        hasPg: () => true,
        enablePubSub: false,
        cacheTtlMs: 0,
      });
      await router.setDomainState({
        domain: WORKSPACES_DOMAIN,
        mode: "dual_write_mongo_read",
      });
      const dualRepo = new DualWorkspaceRepository({
        router,
        getDb: () => db,
      });
      const pgRepo = new PgWorkspaceRepository({ getDb: () => db });

      const owner = await seedUser({
        mongoId: "stale_owner_001",
        email: "stale-owner@example.com",
      });
      const member = await seedUser({
        mongoId: "stale_member_01",
        email: "stale-member@example.com",
      });
      const invitee = await seedUser({
        mongoId: "stale_inv_00001",
        email: "stale-invitee@example.com",
      });

      const { workspace: ws } = await dualRepo.createWorkspaceWithOwner({
        name: "Stale Guard WS",
        slug: "stale-guard-ws",
        userId: owner.mongoId,
      });
      await dualRepo.addMember({
        workspaceId: ws.id,
        userId: member.mongoId,
        role: "viewer",
      });
      const apiKey = await dualRepo.createApiKey({
        workspaceId: ws.id,
        name: "Stale Key",
        keyHash: makeHash("stale-k"),
        prefix: "revops_stalek0",
        scopes: ["mcp"],
        createdBy: owner.mongoId,
      });
      const invite = await dualRepo.createInvite({
        workspaceId: ws.id,
        email: invitee.email,
        token: "stale-invite-tok",
        role: "member",
        invitedBy: owner.mongoId,
        expiresAt: new Date(Date.now() + 86_400_000),
      });
      await dualRepo.ensureMcpClient({
        clientId: "mcpc_stale",
        redirectUris: ["https://stale.example/cb"],
      });
      const codeHash = makeHash("stale-code");
      const code = await dualRepo.createMcpCode({
        codeHash,
        clientId: "mcpc_stale",
        userId: owner.mongoId,
        workspaceId: ws.id,
        redirectUri: "https://stale.example/cb",
        codeChallenge: "chal_stale",
        scopes: ["mcp"],
        expiresAt: new Date(Date.now() + 600_000),
      });
      const origRefreshHash = makeHash("stale-rt-1");
      const token = await dualRepo.createMcpToken({
        accessTokenHash: makeHash("stale-at-1"),
        refreshTokenHash: origRefreshHash,
        clientId: "mcpc_stale",
        userId: owner.mongoId,
        workspaceId: ws.id,
        scopes: ["mcp", "workflow:internal"],
        accessExpiresAt: new Date(Date.now() + 3600_000),
        refreshExpiresAt: new Date(Date.now() + 86_400_000),
      });
      const grant = await dualRepo.upsertAcpGrant({
        workspaceId: ws.id,
        userId: owner.mongoId,
        agentSessionId: "acp-stale-1",
        planDigest: sha256("stale-plan"),
        grants: ["git-write"],
        expiresAt: new Date(Date.now() + 3600_000),
      });
      const gh = await dualRepo.upsertGitHubInstallation({
        workspaceId: ws.id,
        installationId: 555001,
        accountLogin: "stale-org",
        accountType: "Organization",
        repositorySelection: "all",
        createdBy: owner.mongoId,
      });

      // Capture a STALE backfill snapshot BEFORE live Stage 2 mutations happen
      const handler = getBackfillDomain(WORKSPACES_DOMAIN);
      if (!handler) {
        throw new Error("Expected workspaces_core backfill handler");
      }
      const staleSnapshot = await handler.fetchBatch({
        afterCursor: null,
        limit: 500,
        workspaceId: null,
      });
      expect(staleSnapshot.length).toBeGreaterThanOrEqual(8);
      // Validate each item against current PG state (same as backfill engine)
      for (const item of staleSnapshot) {
        if (handler.validate) {
          const v = await handler.validate(item, db);
          expect(v.ok).toBe(true);
        }
      }

      // Live Stage 2 mutations advance PG past the stale snapshot
      const futureTouch = new Date(Date.now() + 120_000);
      await dualRepo.redeemMcpCodeOnce(codeHash, futureTouch);
      await dualRepo.acceptInviteTransaction(
        invite.token,
        invitee.mongoId,
        futureTouch,
      );
      await dualRepo.revokeAcpGrant({
        workspaceId: ws.id,
        userId: owner.mongoId,
        agentSessionId: "acp-stale-1",
        now: futureTouch,
      });
      const rotatedAccessHash = makeHash("stale-at-2");
      await dualRepo.rotateMcpRefreshToken({
        currentRefreshTokenHash: origRefreshHash,
        clientId: "mcpc_stale",
        newAccessTokenHash: rotatedAccessHash,
        newRefreshTokenHash: makeHash("stale-rt-2"),
        newAccessExpiresAt: new Date(Date.now() + 7200_000),
        newRefreshExpiresAt: new Date(Date.now() + 172_800_000),
        stripScopes: ["workflow:internal"],
        now: futureTouch,
      });
      await dualRepo.touchApiKeyLastUsed(ws.id, apiKey.id, futureTouch);
      await new Promise(resolve => setTimeout(resolve, 15));
      await dualRepo.updateMemberRole(ws.id, member.mongoId, "admin");
      await dualRepo.upsertGitHubInstallation({
        workspaceId: ws.id,
        installationId: 555001,
        accountLogin: "stale-org",
        accountType: "Organization",
        repositorySelection: "selected",
        createdBy: owner.mongoId,
      });

      // Replay the STALE backfill batch into PG — MUST NOT regress ANY live state!
      await handler.upsertBatch(staleSnapshot, db);

      const [pgCode] = await db
        .select()
        .from(pgSchema.mcpOAuthCodes)
        .where(eq(pgSchema.mcpOAuthCodes.id, objectIdToUuid(code.id)));
      expect(pgCode?.usedAt).not.toBeNull();
      expect(await pgRepo.redeemMcpCodeOnce(codeHash)).toBeNull();

      const [pgInv] = await db
        .select()
        .from(pgSchema.workspaceInvites)
        .where(eq(pgSchema.workspaceInvites.id, objectIdToUuid(invite.id)));
      expect(pgInv?.acceptedAt).not.toBeNull();

      const [pgGrant] = await db
        .select()
        .from(pgSchema.acpPlanGrants)
        .where(eq(pgSchema.acpPlanGrants.id, objectIdToUuid(grant.id)));
      expect(pgGrant?.status).toBe("revoked");

      const [pgTok] = await db
        .select()
        .from(pgSchema.mcpOAuthTokens)
        .where(eq(pgSchema.mcpOAuthTokens.id, objectIdToUuid(token.id)));
      expect(pgTok?.accessTokenHash).toBe(rotatedAccessHash);
      expect(pgTok?.scopes).toEqual(["mcp"]);

      const [pgKey] = await db
        .select()
        .from(pgSchema.workspaceApiKeys)
        .where(eq(pgSchema.workspaceApiKeys.id, objectIdToUuid(apiKey.id)));
      expect(pgKey?.lastUsedAt?.getTime()).toBe(futureTouch.getTime());

      expect((await pgRepo.findMember(ws.id, member.mongoId))?.role).toBe(
        "admin",
      );
      expect(
        (await pgRepo.findGitHubInstallation(ws.id, gh.installationId))
          ?.repositorySelection,
      ).toBe("selected");
    });

    it("2. enforces 60s last_used_at throttle on secondary store in both Stage 2 and Stage 4 (0 secondary writes)", async () => {
      const failures: SecondaryWriteFailureContext[] = [];
      const router = new MigrationRouter({
        getDb: () => db,
        hasPg: () => true,
        enablePubSub: false,
        cacheTtlMs: 0,
        onSecondaryFailure: async ctx => {
          failures.push(ctx);
        },
      });
      await router.setDomainState({
        domain: WORKSPACES_DOMAIN,
        mode: "dual_write_mongo_read",
      });
      const mongoRepo = new MongoWorkspaceRepository();
      const pgRepo = new PgWorkspaceRepository({ getDb: () => db });
      let failSecondaryPg = false;
      const dualRepo = new DualWorkspaceRepository({
        mongo: mongoRepo,
        pg: pgRepo,
        router,
        getDb: () => {
          if (failSecondaryPg) {
            throw new Error("Secondary PG must not be called when throttled");
          }
          return db;
        },
      });

      const owner = await seedUser({
        mongoId: "thr_owner_00001",
        email: "throttle@example.com",
      });
      const { workspace: ws } = await dualRepo.createWorkspaceWithOwner({
        name: "Throttle WS",
        slug: "throttle-ws",
        userId: owner.mongoId,
      });
      const apiKey = await dualRepo.createApiKey({
        workspaceId: ws.id,
        name: "Throttle Key",
        keyHash: makeHash("thr-k"),
        prefix: "revops_thrk000",
        scopes: ["mcp"],
        createdBy: owner.mongoId,
      });
      await dualRepo.ensureMcpClient({
        clientId: "mcpc_thr",
        redirectUris: ["https://thr.example/cb"],
      });
      const tok = await dualRepo.createMcpToken({
        accessTokenHash: makeHash("thr-at"),
        refreshTokenHash: makeHash("thr-rt"),
        clientId: "mcpc_thr",
        userId: owner.mongoId,
        workspaceId: ws.id,
        scopes: ["mcp"],
        accessExpiresAt: new Date(Date.now() + 3600_000),
      });

      // Stage 2: first touch writes both Mongo + PG
      const t0 = new Date("2026-11-26T12:00:00.000Z");
      await dualRepo.touchApiKeyLastUsed(ws.id, apiKey.id, t0);
      await dualRepo.touchMcpTokenLastUsed(tok.id, t0);
      expect((await pgRepo.listApiKeys(ws.id))[0]?.lastUsedAt?.getTime()).toBe(
        t0.getTime(),
      );

      // Second touch 5s later is throttled by Mongo -> ZERO secondary PG calls!
      failSecondaryPg = true;
      await dualRepo.touchApiKeyLastUsed(
        ws.id,
        apiKey.id,
        new Date(t0.getTime() + 5_000),
      );
      await dualRepo.touchMcpTokenLastUsed(
        tok.id,
        new Date(t0.getTime() + 5_000),
      );
      expect(failures).toEqual([]);
      failSecondaryPg = false;

      // Stage 4: touch 10s later is throttled by PG -> ZERO secondary Mongo writes!
      await router.setDomainState({
        domain: WORKSPACES_DOMAIN,
        mode: "dual_write_pg_read",
      });
      const wsUpdateSpy = vi.spyOn(Workspace.collection, "updateOne");
      const tokReplaceSpy = vi.spyOn(McpOAuthToken.collection, "replaceOne");
      failSecondaryPg = true;
      await dualRepo.touchApiKeyLastUsed(
        ws.id,
        apiKey.id,
        new Date(t0.getTime() + 10_000),
      );
      await dualRepo.touchMcpTokenLastUsed(
        tok.id,
        new Date(t0.getTime() + 10_000),
      );
      failSecondaryPg = false;
      expect(wsUpdateSpy).not.toHaveBeenCalled();
      expect(tokReplaceSpy).not.toHaveBeenCalled();
      expect(failures).toEqual([]);
      wsUpdateSpy.mockRestore();
      tokReplaceSpy.mockRestore();
    });

    it("3. cascades deleteWorkspaceCascade across all 8 Mongo collections, tombstones workspace_api_keys, passes parity verification, and skips no-op deletes", async () => {
      const router = new MigrationRouter({
        getDb: () => db,
        hasPg: () => true,
        enablePubSub: false,
        cacheTtlMs: 0,
      });
      await router.setDomainState({
        domain: WORKSPACES_DOMAIN,
        mode: "dual_write_mongo_read",
      });
      const dualRepo = new DualWorkspaceRepository({
        router,
        getDb: () => db,
      });

      const owner = await seedUser({
        mongoId: "casc_owner_0001",
        email: "cascade@example.com",
      });
      const { workspace: ws } = await dualRepo.createWorkspaceWithOwner({
        name: "Cascade WS",
        slug: "cascade-ws",
        userId: owner.mongoId,
      });
      const key = await dualRepo.createApiKey({
        workspaceId: ws.id,
        name: "Cascade Key",
        keyHash: makeHash("casc-k"),
        prefix: "revops_casck00",
        scopes: ["mcp"],
        createdBy: owner.mongoId,
      });
      await dualRepo.createInvite({
        workspaceId: ws.id,
        email: "casc-inv@example.com",
        token: "casc-inv-tok",
        role: "member",
        invitedBy: owner.mongoId,
        expiresAt: new Date(Date.now() + 86_400_000),
      });
      await dualRepo.insertHandlesBestEffort(ws.id, [
        {
          userId: owner.mongoId,
          handle: "cascalice",
        },
      ]);
      await dualRepo.ensureMcpClient({
        clientId: "mcpc_casc",
        redirectUris: ["https://casc.example/cb"],
      });
      await dualRepo.createMcpCode({
        codeHash: makeHash("casc-code"),
        clientId: "mcpc_casc",
        userId: owner.mongoId,
        workspaceId: ws.id,
        redirectUri: "https://casc.example/cb",
        codeChallenge: "chal_casc",
        scopes: ["mcp"],
        expiresAt: new Date(Date.now() + 600_000),
      });
      await dualRepo.createMcpToken({
        accessTokenHash: makeHash("casc-at"),
        refreshTokenHash: makeHash("casc-rt"),
        clientId: "mcpc_casc",
        userId: owner.mongoId,
        workspaceId: ws.id,
        scopes: ["mcp"],
        accessExpiresAt: new Date(Date.now() + 3600_000),
      });
      await dualRepo.upsertAcpGrant({
        workspaceId: ws.id,
        userId: owner.mongoId,
        agentSessionId: "acp-casc-1",
        planDigest: sha256("casc-plan"),
        grants: ["git-write"],
        expiresAt: new Date(Date.now() + 3600_000),
      });
      await dualRepo.upsertGitHubInstallation({
        workspaceId: ws.id,
        installationId: 666001,
        accountLogin: "casc-org",
        accountType: "Organization",
        repositorySelection: "all",
        createdBy: owner.mongoId,
      });

      // No-op delete on nonexistent workspace writes 0 tombstones
      const ghostWsId = newDualId().oid;
      expect(await dualRepo.deleteWorkspaceCascade(ghostWsId)).toBe(false);
      expect(await db.select().from(pgSchema.migrationTombstones)).toHaveLength(
        0,
      );

      // Real cascade delete removes ALL 8 child collections in Mongo & tombstones all child rows + workspace_api_keys in PG
      expect(await dualRepo.deleteWorkspaceCascade(ws.id)).toBe(true);
      const wsOid = new Types.ObjectId(ws.id);
      expect(await Workspace.countDocuments({ _id: wsOid })).toBe(0);
      expect(await WorkspaceMember.countDocuments({ workspaceId: wsOid })).toBe(
        0,
      );
      expect(await WorkspaceInvite.countDocuments({ workspaceId: wsOid })).toBe(
        0,
      );
      expect(
        await WorkspaceUserHandle.countDocuments({ workspaceId: wsOid }),
      ).toBe(0);
      expect(
        await GitHubInstallation.countDocuments({ workspaceId: wsOid }),
      ).toBe(0);
      expect(await McpOAuthCode.countDocuments({ workspaceId: ws.id })).toBe(0);
      expect(await McpOAuthToken.countDocuments({ workspaceId: ws.id })).toBe(
        0,
      );
      expect(await AcpPlanGrant.countDocuments({ workspaceId: ws.id })).toBe(0);

      const tombstones = await db.select().from(pgSchema.migrationTombstones);
      expect(
        tombstones.some(
          t =>
            t.tableName === "workspace_api_keys" &&
            t.entityId === objectIdToUuid(key.id),
        ),
      ).toBe(true);
      expect(
        tombstones.some(
          t =>
            t.tableName === "workspaces" &&
            t.entityId === objectIdToUuid(ws.id),
        ),
      ).toBe(true);

      const parity = await runParityVerification({
        domain: WORKSPACES_DOMAIN,
        db,
      });
      expect(parity.missingInPg).toBe(0);
      expect(parity.extraInPg).toBe(0);
      expect(parity.mismatched).toBe(0);
    });

    it("4. tombstones deleted not-yet-backfilled Stage 2 child rows (preventing backfill resurrection) and writes 0 tombstones on wrong-workspace no-op deletes", async () => {
      const router = new MigrationRouter({
        getDb: () => db,
        hasPg: () => true,
        enablePubSub: false,
        cacheTtlMs: 0,
      });
      const dualRepo = new DualWorkspaceRepository({
        router,
        getDb: () => db,
      });
      const pgRepo = new PgWorkspaceRepository({ getDb: () => db });

      const owner = await seedUser({
        mongoId: "tomb_owner_0001",
        email: "tomb-owner@example.com",
      });
      const guest = await seedUser({
        mongoId: "tomb_guest_0001",
        email: "tomb-guest@example.com",
      });

      // Stage 1 (mongo_only): seed parent + child rows ONLY in Mongo (not yet backfilled into PG!)
      await router.setDomainState({
        domain: WORKSPACES_DOMAIN,
        mode: "mongo_only",
      });
      const { workspace: ws } = await dualRepo.createWorkspaceWithOwner({
        name: "Tombstone WS",
        slug: "tombstone-ws",
        userId: owner.mongoId,
      });
      const { workspace: otherWs } = await dualRepo.createWorkspaceWithOwner({
        name: "Other WS",
        slug: "other-ws",
        userId: owner.mongoId,
      });
      const guestMember = await dualRepo.addMember({
        workspaceId: ws.id,
        userId: guest.mongoId,
        role: "member",
      });
      const keyById = await dualRepo.createApiKey({
        workspaceId: ws.id,
        name: "Key By Id",
        keyHash: makeHash("tomb-k1"),
        prefix: "revops_tombk10",
        scopes: ["mcp"],
        createdBy: owner.mongoId,
      });
      const keyByName = await dualRepo.createApiKey({
        workspaceId: ws.id,
        name: "Key By Name",
        keyHash: makeHash("tomb-k2"),
        prefix: "revops_tombk20",
        scopes: ["mcp"],
        createdBy: owner.mongoId,
      });
      const keyByCreator = await dualRepo.createApiKey({
        workspaceId: ws.id,
        name: "Key By Creator",
        keyHash: makeHash("tomb-k3"),
        prefix: "revops_tombk30",
        scopes: ["mcp"],
        createdBy: guest.mongoId,
      });
      const invite = await dualRepo.createInvite({
        workspaceId: ws.id,
        email: "tomb-inv@example.com",
        token: "tomb-inv-tok",
        role: "viewer",
        invitedBy: owner.mongoId,
        expiresAt: new Date(Date.now() + 86_400_000),
      });
      await dualRepo.ensureMcpClient({
        clientId: "mcpc_tomb",
        redirectUris: ["https://tomb.example/cb"],
      });
      const tokMember = await dualRepo.createMcpToken({
        accessTokenHash: makeHash("tomb-at1"),
        refreshTokenHash: makeHash("tomb-rt1"),
        clientId: "mcpc_tomb",
        userId: guest.mongoId,
        workspaceId: ws.id,
        scopes: ["mcp"],
        accessExpiresAt: new Date(Date.now() + 3600_000),
      });
      const tokConn = await dualRepo.createMcpToken({
        accessTokenHash: makeHash("tomb-at2"),
        refreshTokenHash: makeHash("tomb-rt2"),
        clientId: "mcpc_tomb",
        userId: owner.mongoId,
        workspaceId: ws.id,
        scopes: ["mcp"],
        accessExpiresAt: new Date(Date.now() + 3600_000),
      });
      const gh = await dualRepo.upsertGitHubInstallation({
        workspaceId: ws.id,
        installationId: 777999,
        accountLogin: "tomb-org",
        accountType: "Organization",
        repositorySelection: "all",
        createdBy: owner.mongoId,
      });

      // Capture an in-flight backfill batch BEFORE the Stage 2 deletes happen
      const handler = getBackfillDomain(WORKSPACES_DOMAIN);
      if (!handler) {
        throw new Error("Expected workspaces_core backfill handler");
      }
      const inflightItems = await handler.fetchBatch({
        afterCursor: null,
        limit: 500,
        workspaceId: null,
      });

      // Switch to Stage 2: PG still has ZERO of these child rows!
      await router.setDomainState({
        domain: WORKSPACES_DOMAIN,
        mode: "dual_write_mongo_read",
      });

      // Wrong-workspace / nonexistent no-op deletes MUST write 0 tombstones!
      expect(await dualRepo.deleteApiKey(otherWs.id, keyById.id)).toBe(false);
      expect(await dualRepo.cancelInvite(ws.id, newDualId().oid)).toBe(false);
      expect(await dualRepo.cancelInvite(otherWs.id, invite.id)).toBe(false);
      expect(await dualRepo.removeMember(otherWs.id, guest.mongoId)).toBe(
        false,
      );
      expect(await dualRepo.deleteGitHubInstallation(otherWs.id, 777999)).toBe(
        false,
      );
      expect(await db.select().from(pgSchema.migrationTombstones)).toHaveLength(
        0,
      );

      // Now delete all not-yet-backfilled child rows in Stage 2
      expect(await dualRepo.deleteApiKey(ws.id, keyById.id)).toBe(true);
      expect(await dualRepo.deleteApiKeysByName(ws.id, "Key By Name")).toBe(1);
      expect(await dualRepo.deleteApiKeysByCreator(ws.id, guest.mongoId)).toBe(
        1,
      );
      expect(await dualRepo.removeMember(ws.id, guest.mongoId)).toBe(true);
      expect(await dualRepo.cancelInvite(ws.id, invite.id)).toBe(true);
      expect(
        await dualRepo.revokeMcpGrantsForMember({
          workspaceId: ws.id,
          userId: guest.mongoId,
        }),
      ).toBe(1);
      expect(
        await dualRepo.revokeMcpConnection({
          workspaceId: ws.id,
          clientId: "mcpc_tomb",
          userId: owner.mongoId,
        }),
      ).toBe(1);
      expect(await dualRepo.deleteGitHubInstallation(ws.id, 777999)).toBe(true);

      // Verify EVERY deleted row's PG UUID is tombstoned despite never existing in PG
      const tombstones = await db.select().from(pgSchema.migrationTombstones);
      const hasTomb = (table: string, wireId: string) =>
        tombstones.some(
          t => t.tableName === table && t.entityId === objectIdToUuid(wireId),
        );
      expect(hasTomb("workspace_api_keys", keyById.id)).toBe(true);
      expect(hasTomb("workspace_api_keys", keyByName.id)).toBe(true);
      expect(hasTomb("workspace_api_keys", keyByCreator.id)).toBe(true);
      expect(hasTomb("workspace_members", guestMember.id)).toBe(true);
      expect(hasTomb("workspace_invites", invite.id)).toBe(true);
      expect(hasTomb("mcp_oauth_tokens", tokMember.id)).toBe(true);
      expect(hasTomb("mcp_oauth_tokens", tokConn.id)).toBe(true);
      expect(hasTomb("github_installations", gh.id)).toBe(true);

      // Simulate an in-flight backfill running from the pre-delete snapshot:
      // backfill MUST skip every tombstoned child and NEVER resurrect them in PG!
      const summary = await runBackfill({
        domain: WORKSPACES_DOMAIN,
        db,
        handler: {
          ...handler,
          fetchBatch: async ({ afterCursor }) =>
            afterCursor ? [] : inflightItems,
        },
      });
      expect(summary.rowsSkippedTombstone).toBe(8);
      expect(await pgRepo.listApiKeys(ws.id)).toEqual([]);
      expect(await pgRepo.findMember(ws.id, guest.mongoId)).toBeNull();
      expect(await pgRepo.findPendingInviteByToken("tomb-inv-tok")).toBeNull();
      expect(await pgRepo.listMcpConnections(ws.id)).toEqual([]);
      expect(await pgRepo.findGitHubInstallation(ws.id, 777999)).toBeNull();
    });

    it("5. matches Stage 4 reverse-shadow on createInvite/findPendingInviteByToken and Stage 3 shadow on empty workflows:{}", async () => {
      const shadowEvents: ShadowCompareEvent[] = [];
      const shadowRunner = new ShadowCompareRunner({
        onEvent: evt => {
          shadowEvents.push(evt);
        },
      });
      const router = new MigrationRouter({
        getDb: () => db,
        hasPg: () => true,
        enablePubSub: false,
        shadowRunner,
        cacheTtlMs: 0,
      });
      const dualRepo = new DualWorkspaceRepository({
        router,
        getDb: () => db,
      });

      const owner = await seedUser({
        mongoId: "par_owner_00001",
        email: "parity-owner@example.com",
      });

      // Stage 3: set hatchetToken then clear -> Mongo leaves `workflows: {}`, PG has 5 NULLs -> MUST match!
      await router.setDomainState({
        domain: WORKSPACES_DOMAIN,
        mode: "dual_write_shadow_compare",
        shadowSampleRate: 1,
      });
      const { workspace: ws } = await dualRepo.createWorkspaceWithOwner({
        name: "Parity WS",
        slug: "parity-ws",
        userId: owner.mongoId,
      });
      await dualRepo.setWorkflowHatchetToken(ws.id, "iv_x:cipher_x");
      await dualRepo.setWorkflowHatchetToken(ws.id, null);
      shadowEvents.length = 0;
      const wsRead = await dualRepo.findById(ws.id);
      expect(wsRead?.workflows).toBeUndefined();
      await shadowRunner.flush();
      expect(shadowEvents.length).toBeGreaterThanOrEqual(1);
      for (const evt of shadowEvents) {
        expect(
          evt.result,
          `empty workflows diff: ${JSON.stringify(evt.diffs)}`,
        ).toBe("match");
      }

      // Stage 4 with reverse shadowSampleRate=1: createInvite + findPendingInviteByToken -> 0 ms drift!
      await router.setDomainState({
        domain: WORKSPACES_DOMAIN,
        mode: "dual_write_pg_read",
        shadowSampleRate: 1,
      });
      const inv = await dualRepo.createInvite({
        workspaceId: ws.id,
        email: "rev-shadow@example.com",
        token: "rev-shadow-tok",
        role: "member",
        invitedBy: owner.pgUuid,
        expiresAt: new Date(Date.now() + 86_400_000),
      });
      expect(inv.createdAt.getUTCMilliseconds()).toBe(0);
      shadowEvents.length = 0;
      const found = await dualRepo.findPendingInviteByToken("rev-shadow-tok");
      expect(found?.id).toBe(inv.id);
      await shadowRunner.flush();
      expect(shadowEvents.length).toBeGreaterThanOrEqual(1);
      for (const evt of shadowEvents) {
        expect(
          evt.result,
          `invite createdAt diff: ${JSON.stringify(evt.diffs)}`,
        ).toBe("match");
      }
    });

    it("6. unsets legacy Mongo customPrompt in Stage 4, trims replaceApiKeyByName consistently, and preserves legacy member email domains in mixed-mode app-owner", async () => {
      const router = new MigrationRouter({
        getDb: () => db,
        hasPg: () => true,
        enablePubSub: false,
        cacheTtlMs: 0,
      });
      const authDual = new DualAuthRepository({ router, getDb: () => db });
      const wsDual = new DualWorkspaceRepository({ router, getDb: () => db });
      setAuthRepoForTests(authDual);
      setWorkspaceRepoForTests(wsDual);

      await router.setDomainState({
        domain: WORKSPACES_DOMAIN,
        mode: "dual_write_mongo_read",
      });
      const owner = await seedUser({
        mongoId: "mix_legacy_0001",
        email: "alice@acme-corp.io",
      });
      const { workspace: ws } = await wsDual.createWorkspaceWithOwner({
        name: "Minor Gaps WS",
        slug: "minor-gaps-ws",
        userId: owner.mongoId,
      });

      // (a) Stage 4 unsetLegacyCustomPrompt still clears Mongo legacy fields
      await Workspace.collection.updateOne(
        { _id: new Types.ObjectId(ws.id) },
        {
          $set: {
            "settings.customPrompt": "old prompt",
            selfDirective: "old directive",
          },
        },
      );
      await router.setDomainState({
        domain: WORKSPACES_DOMAIN,
        mode: "dual_write_pg_read",
      });
      await wsDual.unsetLegacyCustomPrompt(ws.id, {
        includeSelfDirective: true,
      });
      const rawMongoWs = await Workspace.collection.findOne({
        _id: new Types.ObjectId(ws.id),
      });
      expect(
        (rawMongoWs?.settings as Record<string, unknown> | undefined)
          ?.customPrompt,
      ).toBeUndefined();
      expect(rawMongoWs?.selfDirective).toBeUndefined();

      // (b) replaceApiKeyByName trims name consistently on delete & insert in both stores
      const sp2Hash = makeHash("sp-2");
      await wsDual.replaceApiKeyByName({
        workspaceId: ws.id,
        name: "  spaced-key  ",
        keyHash: makeHash("sp-1"),
        prefix: "revops_sp10000",
        scopes: ["mcp"],
        createdBy: owner.pgUuid,
      });
      await wsDual.replaceApiKeyByName({
        workspaceId: ws.id,
        name: "spaced-key",
        keyHash: sp2Hash,
        prefix: "revops_sp20000",
        scopes: ["mcp"],
        createdBy: owner.pgUuid,
      });
      const keysAfter = await wsDual.listApiKeys(ws.id);
      expect(keysAfter).toHaveLength(1);
      expect(keysAfter[0]?.name).toBe("spaced-key");
      expect(keysAfter[0]?.keyHash).toBe(sp2Hash);

      // (c) Mixed-mode app-owner: auth=pg_only (returns UUIDv7 + legacyId) + workspaces=mongo_only (member holds legacyId)
      await router.setDomainState({ domain: "auth", mode: "pg_only" });
      await router.setDomainState({
        domain: WORKSPACES_DOMAIN,
        mode: "mongo_only",
      });
      const peopleDir = await loadPeopleDirectory(
        ws.id,
        new OwnerDirectory([]),
      );
      expect(peopleDir.domains.has("acme-corp.io")).toBe(true);
      expect(peopleDir.resolveEmail("alice@acme-corp.io")?.userId).toBe(
        owner.pgUuid,
      );
      // Local-part fallback on a non-public external domain resolves via workspaceEmailDomains
      expect(peopleDir.resolveEmail("alice@private-laptop.dev")?.userId).toBe(
        owner.pgUuid,
      );
    });
  });

  // ── 6. PR #1554 Deep Review Regressions (12 findings) ──────────────────

  describe("PR #1554 deep-review regressions", () => {
    it("[4717269351] syncSubscriptionToWorkspace persists unpaid, paused, and incomplete_expired identically in Mongo and PG and downgrades plan to free", async () => {
      const router = new MigrationRouter({
        getDb: () => db,
        hasPg: () => true,
        enablePubSub: false,
        cacheTtlMs: 0,
      });
      const dualRepo = new DualWorkspaceRepository({
        router,
        getDb: () => db,
      });
      const mongoRepo = new MongoWorkspaceRepository();
      const pgRepo = new PgWorkspaceRepository({ getDb: () => db });
      setWorkspaceRepoForTests(dualRepo);

      await router.setDomainState({
        domain: WORKSPACES_DOMAIN,
        mode: "dual_write_mongo_read",
      });
      const owner = await seedUser({
        mongoId: "stripe_owner_01",
        email: "stripe@example.com",
      });
      const { workspace: ws } = await dualRepo.createWorkspaceWithOwner({
        name: "Stripe Status WS",
        slug: "stripe-status-ws",
        userId: owner.mongoId,
      });

      const makeSub = (
        status: Stripe.Subscription.Status,
      ): Stripe.Subscription =>
        ({
          id: "sub_test_123",
          customer: "cus_test_123",
          status,
          metadata: { workspaceId: ws.id },
          current_period_start: Math.floor(Date.now() / 1000),
          current_period_end: Math.floor(Date.now() / 1000) + 86_400 * 30,
          items: { data: [] },
        }) as unknown as Stripe.Subscription;

      // Upgrade to pro first, then test all 3 previously-failing Stripe statuses under Stage 2 & Stage 5.
      await syncSubscriptionToWorkspace(makeSub("active"), ws.id);
      expect((await pgRepo.findById(ws.id))?.billing.plan).toBe("pro");

      for (const status of [
        "paused",
        "unpaid",
        "incomplete_expired",
      ] as const) {
        await syncSubscriptionToWorkspace(makeSub(status), ws.id);
        const mWs = await mongoRepo.findById(ws.id);
        const pWs = await pgRepo.findById(ws.id);
        expect(mWs?.billing.subscriptionStatus).toBe(status);
        expect(pWs?.billing.subscriptionStatus).toBe(status);
        expect(pWs?.billing.plan).toBe("free");
        expect(pWs?.settings.billingTier).toBe("free");
      }

      // Now switch to PG-primary (`pg_only`) and verify downgrade succeeds without PG 23514.
      await router.setDomainState({
        domain: WORKSPACES_DOMAIN,
        mode: "pg_only",
      });
      await syncSubscriptionToWorkspace(makeSub("trialing"), ws.id);
      expect((await pgRepo.findById(ws.id))?.billing.plan).toBe("pro");
      await syncSubscriptionToWorkspace(makeSub("paused"), ws.id);
      const pgAfter = await pgRepo.findById(ws.id);
      expect(pgAfter?.billing.subscriptionStatus).toBe("paused");
      expect(pgAfter?.billing.plan).toBe("free");
    });

    it("[4717269792] workspace_api_keys backfill is insert-only so stale snapshots never overwrite live scopes, names, or flags", async () => {
      const router = new MigrationRouter({
        getDb: () => db,
        hasPg: () => true,
        enablePubSub: false,
        cacheTtlMs: 0,
      });
      await router.setDomainState({
        domain: WORKSPACES_DOMAIN,
        mode: "dual_write_mongo_read",
      });
      const dualRepo = new DualWorkspaceRepository({
        router,
        getDb: () => db,
      });
      const pgRepo = new PgWorkspaceRepository({ getDb: () => db });

      const owner = await seedUser({
        mongoId: "key_stale_own01",
        email: "key-stale@example.com",
      });
      const { workspace: ws } = await dualRepo.createWorkspaceWithOwner({
        name: "Key Stale WS",
        slug: "key-stale-ws",
        userId: owner.mongoId,
      });
      const workerKey = await dualRepo.createApiKey({
        workspaceId: ws.id,
        name: "Workflows worker",
        keyHash: makeHash("worker-stale"),
        prefix: "revops_wrk0000",
        scopes: ["workflows:runtime"],
        createdBy: owner.mongoId,
        agentRun: false,
        recordWrites: false,
      });

      // Capture stale backfill snapshot BEFORE live mutations (last_used_at is NULL in both!)
      const handler = getBackfillDomain(WORKSPACES_DOMAIN);
      if (!handler?.validate) {
        throw new Error("Expected workspaces_core backfill handler");
      }
      const staleBatch = await handler.fetchBatch({
        afterCursor: null,
        limit: 500,
        workspaceId: null,
      });
      for (const item of staleBatch) {
        expect((await handler.validate(item, db)).ok).toBe(true);
      }

      // Live dual-write upgrades scopes (does NOT touch lastUsedAt) and updates live PG metadata
      await dualRepo.updateApiKeyScopesByName(ws.id, "Workflows worker", [
        "mcp",
        "query:write",
        "workflows:runtime",
      ]);
      await db
        .update(pgSchema.workspaceApiKeys)
        .set({ name: "Renamed Live Key", agentRun: true, recordWrites: true })
        .where(eq(pgSchema.workspaceApiKeys.id, objectIdToUuid(workerKey.id)));

      // Also insert a Stage-1-only key (not yet in PG) to verify backfill still inserts missing keys.
      await router.setDomainState({
        domain: WORKSPACES_DOMAIN,
        mode: "mongo_only",
      });
      const missingKey = await dualRepo.createApiKey({
        workspaceId: ws.id,
        name: "Missing From PG Key",
        keyHash: makeHash("worker-missing"),
        prefix: "revops_mis0000",
        scopes: ["mcp"],
        createdBy: owner.mongoId,
      });
      const missingBatch = (
        await handler.fetchBatch({
          afterCursor: null,
          limit: 500,
          workspaceId: null,
        })
      ).filter(
        i =>
          i.targetTable === "workspace_api_keys" &&
          i.entityId === objectIdToUuid(missingKey.id),
      );
      for (const item of missingBatch) {
        expect((await handler.validate(item, db)).ok).toBe(true);
      }

      // Replay the stale snapshot + the new key: existing live key MUST stay untouched, missing key MUST insert!
      await handler.upsertBatch([...staleBatch, ...missingBatch], db);

      const keys = await pgRepo.listApiKeys(ws.id);
      const liveKey = keys.find(k => k.id === workerKey.id);
      expect(liveKey?.scopes).toEqual([
        "mcp",
        "query:write",
        "workflows:runtime",
      ]);
      expect(liveKey?.name).toBe("Renamed Live Key");
      expect(liveKey?.agentRun).toBe(true);
      expect(liveKey?.recordWrites).toBe(true);
      expect(keys.find(k => k.id === missingKey.id)?.name).toBe(
        "Missing From PG Key",
      );
    });

    it("[4717270238] backfill upserts enforce tombstones atomically inside the PG transaction so mid-batch live deletes are never resurrected", async () => {
      const router = new MigrationRouter({
        getDb: () => db,
        hasPg: () => true,
        enablePubSub: false,
        cacheTtlMs: 0,
      });
      const dualRepo = new DualWorkspaceRepository({
        router,
        getDb: () => db,
      });
      const pgRepo = new PgWorkspaceRepository({ getDb: () => db });

      const owner = await seedUser({
        mongoId: "mid_tomb_own001",
        email: "mid-tomb@example.com",
      });
      const member = await seedUser({
        mongoId: "mid_tomb_mem001",
        email: "mid-tomb-mem@example.com",
      });

      // Stage 1: seed entities in Mongo only (not in PG yet).
      await router.setDomainState({
        domain: WORKSPACES_DOMAIN,
        mode: "mongo_only",
      });
      const { workspace: ws } = await dualRepo.createWorkspaceWithOwner({
        name: "Mid-Batch Tombstone WS",
        slug: "mid-batch-tombstone-ws",
        userId: owner.mongoId,
      });
      const { workspace: deletedWs } = await dualRepo.createWorkspaceWithOwner({
        name: "Mid-Batch Deleted WS",
        slug: "mid-batch-deleted-ws",
        userId: owner.mongoId,
      });
      await dualRepo.addMember({
        workspaceId: ws.id,
        userId: member.mongoId,
        role: "member",
      });
      const apiKey = await dualRepo.createApiKey({
        workspaceId: ws.id,
        name: "Mid-Batch Revoked Key",
        keyHash: makeHash("mid-tomb-k"),
        prefix: "revops_midt000",
        scopes: ["mcp"],
        createdBy: owner.mongoId,
      });
      await dualRepo.ensureMcpClient({
        clientId: "mcpc_midtomb",
        redirectUris: ["https://midtomb.example/cb"],
      });
      await dualRepo.createMcpToken({
        accessTokenHash: makeHash("mid-tomb-at"),
        refreshTokenHash: makeHash("mid-tomb-rt"),
        clientId: "mcpc_midtomb",
        userId: owner.mongoId,
        workspaceId: ws.id,
        scopes: ["mcp"],
        accessExpiresAt: new Date(Date.now() + 3600_000),
      });
      await dualRepo.upsertGitHubInstallation({
        workspaceId: ws.id,
        installationId: 912345,
        accountLogin: "mid-tomb-org",
        accountType: "Organization",
        repositorySelection: "all",
        createdBy: owner.mongoId,
      });

      // Capture pre-delete batch and run `validate` BEFORE tombstones exist
      // (simulating the exact race window after `runBackfill`'s initial batch tombstone check!).
      const handler = getBackfillDomain(WORKSPACES_DOMAIN);
      if (!handler?.validate) {
        throw new Error("Expected workspaces_core backfill handler");
      }
      const preDeleteItems = await handler.fetchBatch({
        afterCursor: null,
        limit: 500,
        workspaceId: null,
      });
      // Seed parent workspace & client in PG so validate() passes on child rows.
      await resyncToPg(
        "workspaces",
        { entityIds: [ws.id, deletedWs.id] },
        { getDb: () => db },
      );
      await resyncToPg(
        "mcp_oauth_clients",
        { entityIds: ["mcpc_midtomb"] },
        { getDb: () => db },
      );
      for (const item of preDeleteItems) {
        expect((await handler.validate(item, db)).ok).toBe(true);
      }

      // Now live Stage 2 deletes happen AFTER validate() and BEFORE upsertBatch()!
      await router.setDomainState({
        domain: WORKSPACES_DOMAIN,
        mode: "dual_write_mongo_read",
      });
      expect(await dualRepo.deleteApiKey(ws.id, apiKey.id)).toBe(true);
      expect(await dualRepo.removeMember(ws.id, member.mongoId)).toBe(true);
      expect(
        await dualRepo.revokeMcpConnection({
          workspaceId: ws.id,
          clientId: "mcpc_midtomb",
          userId: owner.mongoId,
        }),
      ).toBe(1);
      expect(await dualRepo.deleteGitHubInstallation(ws.id, 912345)).toBe(true);
      expect(await dualRepo.deleteWorkspaceCascade(deletedWs.id)).toBe(true);

      // Now the delayed backfill `upsertBatch` executes with pre-delete items -> MUST resurrect ZERO deleted rows!
      await handler.upsertBatch(preDeleteItems, db);

      expect(await pgRepo.findById(deletedWs.id)).toBeNull();
      expect(await pgRepo.listApiKeys(ws.id)).toEqual([]);
      expect(await pgRepo.findMember(ws.id, member.mongoId)).toBeNull();
      expect(await pgRepo.listMcpConnections(ws.id)).toEqual([]);
      expect(await pgRepo.findGitHubInstallation(ws.id, 912345)).toBeNull();
    });

    it("[4717270787] resyncToPg guards against tombstones and stale overwrites so delayed touch/resync calls never resurrect revoked credentials or clobber live updates", async () => {
      const router = new MigrationRouter({
        getDb: () => db,
        hasPg: () => true,
        enablePubSub: false,
        cacheTtlMs: 0,
      });
      await router.setDomainState({
        domain: WORKSPACES_DOMAIN,
        mode: "dual_write_mongo_read",
      });
      const dualRepo = new DualWorkspaceRepository({
        router,
        getDb: () => db,
      });
      const pgRepo = new PgWorkspaceRepository({ getDb: () => db });

      const owner = await seedUser({
        mongoId: "resync_own_0001",
        email: "resync@example.com",
      });
      const { workspace: ws } = await dualRepo.createWorkspaceWithOwner({
        name: "Resync Guard WS",
        slug: "resync-guard-ws",
        userId: owner.mongoId,
      });
      const key = await dualRepo.createApiKey({
        workspaceId: ws.id,
        name: "Revoked Key",
        keyHash: makeHash("rs-k1"),
        prefix: "revops_rsk1000",
        scopes: ["mcp"],
        createdBy: owner.mongoId,
      });
      const liveKey = await dualRepo.createApiKey({
        workspaceId: ws.id,
        name: "Scoped Key",
        keyHash: makeHash("rs-k2"),
        prefix: "revops_rsk2000",
        scopes: ["mcp"],
        createdBy: owner.mongoId,
      });
      await dualRepo.ensureMcpClient({
        clientId: "mcpc_rs",
        redirectUris: ["https://rs.example/cb"],
      });
      const tok = await dualRepo.createMcpToken({
        accessTokenHash: makeHash("rs-at1"),
        refreshTokenHash: makeHash("rs-rt1"),
        clientId: "mcpc_rs",
        userId: owner.mongoId,
        workspaceId: ws.id,
        scopes: ["mcp"],
        accessExpiresAt: new Date(Date.now() + 3600_000),
      });
      const liveTok = await dualRepo.createMcpToken({
        accessTokenHash: makeHash("rs-at2"),
        refreshTokenHash: makeHash("rs-rt2"),
        clientId: "mcpc_rs",
        userId: owner.mongoId,
        workspaceId: ws.id,
        scopes: ["mcp"],
        accessExpiresAt: new Date(Date.now() + 3600_000),
      });
      const code = await dualRepo.createMcpCode({
        codeHash: makeHash("rs-code"),
        clientId: "mcpc_rs",
        userId: owner.mongoId,
        workspaceId: ws.id,
        redirectUri: "https://rs.example/cb",
        codeChallenge: "chal_rs",
        scopes: ["mcp"],
        expiresAt: new Date(Date.now() + 600_000),
      });

      // (a) Simulate a tombstone already written by a live revoke, while a stale Mongo read
      //     still sees the key/token — `resyncToPg` MUST skip tombstoned IDs and NEVER resurrect!
      await recordMigrationTombstone(
        "workspace_api_keys",
        objectIdToUuid(key.id),
        db,
      );
      await db
        .delete(pgSchema.workspaceApiKeys)
        .where(eq(pgSchema.workspaceApiKeys.id, objectIdToUuid(key.id)));
      await resyncToPg(
        "workspace_api_keys",
        { entityIds: [key.id], touchOnly: true },
        { getDb: () => db },
      );
      expect(await pgRepo.findApiKeyByHash(key.keyHash)).toBeNull();

      await recordMigrationTombstone(
        "mcp_oauth_tokens",
        objectIdToUuid(tok.id),
        db,
      );
      await db
        .delete(pgSchema.mcpOAuthTokens)
        .where(eq(pgSchema.mcpOAuthTokens.id, objectIdToUuid(tok.id)));
      await resyncToPg(
        "mcp_oauth_tokens",
        { entityIds: [tok.id], touchOnly: true },
        { getDb: () => db },
      );
      expect(
        await pgRepo.findValidMcpTokenByAccessHash(tok.accessTokenHash),
      ).toBeNull();

      // (b) `touchOnly` resync NEVER overwrites newer PG scopes or rotated token hashes!
      const newerAccessHash = makeHash("rs-at2-rotated");
      const touchTime = new Date(Date.now() + 60_000);
      await db
        .update(pgSchema.workspaceApiKeys)
        .set({ scopes: ["mcp", "query:write", "workflows:runtime"] })
        .where(eq(pgSchema.workspaceApiKeys.id, objectIdToUuid(liveKey.id)));
      await Workspace.updateOne(
        {
          _id: new Types.ObjectId(ws.id),
          "apiKeys._id": new Types.ObjectId(liveKey.id),
        },
        { $set: { "apiKeys.$.lastUsedAt": touchTime } },
        { timestamps: false },
      );
      await resyncToPg(
        "workspace_api_keys",
        { entityIds: [liveKey.id], touchOnly: true },
        { getDb: () => db },
      );
      const pgLiveKey = (await pgRepo.listApiKeys(ws.id)).find(
        k => k.id === liveKey.id,
      );
      expect(pgLiveKey?.scopes).toEqual([
        "mcp",
        "query:write",
        "workflows:runtime",
      ]);
      expect(pgLiveKey?.lastUsedAt?.getTime()).toBe(touchTime.getTime());

      await db
        .update(pgSchema.mcpOAuthTokens)
        .set({
          accessTokenHash: newerAccessHash,
          accessExpiresAt: new Date(Date.now() + 7200_000),
        })
        .where(eq(pgSchema.mcpOAuthTokens.id, objectIdToUuid(liveTok.id)));
      await McpOAuthToken.updateOne(
        { _id: new Types.ObjectId(liveTok.id) },
        { $set: { lastUsedAt: touchTime } },
      );
      await resyncToPg(
        "mcp_oauth_tokens",
        { entityIds: [liveTok.id], touchOnly: true },
        { getDb: () => db },
      );
      const [pgLiveTok] = await db
        .select()
        .from(pgSchema.mcpOAuthTokens)
        .where(eq(pgSchema.mcpOAuthTokens.id, objectIdToUuid(liveTok.id)));
      expect(pgLiveTok?.accessTokenHash).toBe(newerAccessHash);
      expect(pgLiveTok?.lastUsedAt?.getTime()).toBe(touchTime.getTime());

      // (c) Redeemed MCP code in PG cannot be un-redeemed by a stale pre-redeem resync.
      await db
        .update(pgSchema.mcpOAuthCodes)
        .set({ usedAt: touchTime })
        .where(eq(pgSchema.mcpOAuthCodes.id, objectIdToUuid(code.id)));
      await resyncToPg(
        "mcp_oauth_codes",
        { entityIds: [code.id] },
        { getDb: () => db },
      );
      const [pgCode] = await db
        .select()
        .from(pgSchema.mcpOAuthCodes)
        .where(eq(pgSchema.mcpOAuthCodes.id, objectIdToUuid(code.id)));
      expect(pgCode?.usedAt).not.toBeNull();
    });

    it("[4717271507] Mongo find-then-delete methods delete ONLY the captured IDs so concurrently inserted rows are never dropped silently", async () => {
      const mongoRepo = new MongoWorkspaceRepository();
      const owner = await seedUser({
        mongoId: "race_del_own001",
        email: "race-del@example.com",
      });
      const { workspace: ws } = await mongoRepo.createWorkspaceWithOwner({
        name: "Race Delete WS",
        slug: "race-delete-ws",
        userId: owner.mongoId,
      });

      // Seed initial token, API keys, and GitHub installation
      await mongoRepo.ensureMcpClient({
        clientId: "mcpc_race",
        redirectUris: ["https://race.example/cb"],
      });
      const tok1 = await mongoRepo.createMcpToken({
        accessTokenHash: makeHash("race-at1"),
        refreshTokenHash: makeHash("race-rt1"),
        clientId: "mcpc_race",
        userId: owner.mongoId,
        workspaceId: ws.id,
        scopes: ["mcp"],
        accessExpiresAt: new Date(Date.now() + 3600_000),
      });

      // Intercept McpOAuthToken.deleteMany to insert tok2 AFTER find() and BEFORE deleteMany() executes.
      let tok2Id = "";
      const origTokDeleteMany = McpOAuthToken.deleteMany.bind(McpOAuthToken);
      const tokSpy = vi
        .spyOn(McpOAuthToken, "deleteMany")
        .mockImplementationOnce((async (filter: Record<string, unknown>) => {
          const tok2 = await mongoRepo.createMcpToken({
            accessTokenHash: makeHash("race-at2"),
            refreshTokenHash: makeHash("race-rt2"),
            clientId: "mcpc_race",
            userId: owner.mongoId,
            workspaceId: ws.id,
            scopes: ["mcp"],
            accessExpiresAt: new Date(Date.now() + 3600_000),
          });
          tok2Id = tok2.id;
          return origTokDeleteMany(filter);
        }) as unknown as typeof McpOAuthToken.deleteMany);

      const deletedTokIds =
        await mongoRepo.revokeMcpGrantsForMemberReturningIds({
          workspaceId: ws.id,
          userId: owner.mongoId,
        });
      tokSpy.mockRestore();
      expect(deletedTokIds).toEqual([tok1.id]);
      // Concurrently inserted tok2 MUST still exist in Mongo because it was NOT in the returned ID list!
      expect(
        await McpOAuthToken.findById(new Types.ObjectId(tok2Id)).lean(),
      ).not.toBeNull();

      // Same race check for revokeMcpConnectionReturningIds
      let tok3Id = "";
      const tokConnSpy = vi
        .spyOn(McpOAuthToken, "deleteMany")
        .mockImplementationOnce((async (filter: Record<string, unknown>) => {
          const tok3 = await mongoRepo.createMcpToken({
            accessTokenHash: makeHash("race-at3"),
            refreshTokenHash: makeHash("race-rt3"),
            clientId: "mcpc_race",
            userId: owner.mongoId,
            workspaceId: ws.id,
            scopes: ["mcp"],
            accessExpiresAt: new Date(Date.now() + 3600_000),
          });
          tok3Id = tok3.id;
          return origTokDeleteMany(filter);
        }) as unknown as typeof McpOAuthToken.deleteMany);

      const deletedConnIds = await mongoRepo.revokeMcpConnectionReturningIds({
        workspaceId: ws.id,
        clientId: "mcpc_race",
        userId: owner.mongoId,
      });
      tokConnSpy.mockRestore();
      expect(deletedConnIds).toEqual([tok2Id]);
      expect(
        await McpOAuthToken.findById(new Types.ObjectId(tok3Id)).lean(),
      ).not.toBeNull();

      // Same race check for deleteApiKeysByCreatorReturningIds ($pull by exact _id list)
      const k1 = await mongoRepo.createApiKey({
        workspaceId: ws.id,
        name: "Race Key 1",
        keyHash: makeHash("race-k1"),
        prefix: "revops_rck1000",
        scopes: ["mcp"],
        createdBy: owner.mongoId,
      });
      let k2Id = "";
      const origWsUpdateOne = Workspace.updateOne.bind(Workspace);
      const wsSpy = vi
        .spyOn(Workspace, "updateOne")
        .mockImplementationOnce((async (
          filter: Record<string, unknown>,
          update: Record<string, unknown>,
          options?: Record<string, unknown>,
        ) => {
          const k2 = await mongoRepo.createApiKey({
            workspaceId: ws.id,
            name: "Race Key 2",
            keyHash: makeHash("race-k2"),
            prefix: "revops_rck2000",
            scopes: ["mcp"],
            createdBy: owner.mongoId,
          });
          k2Id = k2.id;
          return origWsUpdateOne(filter, update, options);
        }) as unknown as typeof Workspace.updateOne);

      const deletedKeyIds = await mongoRepo.deleteApiKeysByCreatorReturningIds(
        ws.id,
        owner.mongoId,
      );
      wsSpy.mockRestore();
      expect(deletedKeyIds).toEqual([k1.id]);
      const remainingKeys = await mongoRepo.listApiKeys(ws.id);
      expect(remainingKeys.map(k => k.id)).toEqual([k2Id]);

      // Same race check for deleteGitHubInstallationsByInstallationIdReturningIds
      const gh1 = await mongoRepo.upsertGitHubInstallation({
        workspaceId: ws.id,
        installationId: 444555,
        accountLogin: "race-gh",
        accountType: "Organization",
        repositorySelection: "all",
        createdBy: owner.mongoId,
      });
      const { workspace: ws2 } = await mongoRepo.createWorkspaceWithOwner({
        name: "Race Delete WS 2",
        slug: "race-delete-ws-2",
        userId: owner.mongoId,
      });
      let gh2Id = "";
      const origGhDeleteMany =
        GitHubInstallation.deleteMany.bind(GitHubInstallation);
      const ghSpy = vi
        .spyOn(GitHubInstallation, "deleteMany")
        .mockImplementationOnce((async (filter: Record<string, unknown>) => {
          const gh2 = await mongoRepo.upsertGitHubInstallation({
            workspaceId: ws2.id,
            installationId: 444555,
            accountLogin: "race-gh",
            accountType: "Organization",
            repositorySelection: "all",
            createdBy: owner.mongoId,
          });
          gh2Id = gh2.id;
          return origGhDeleteMany(filter);
        }) as unknown as typeof GitHubInstallation.deleteMany);

      const deletedGhIds =
        await mongoRepo.deleteGitHubInstallationsByInstallationIdReturningIds(
          444555,
        );
      ghSpy.mockRestore();
      expect(deletedGhIds).toEqual([gh1.id]);
      expect(
        await GitHubInstallation.findById(new Types.ObjectId(gh2Id)).lean(),
      ).not.toBeNull();
    });

    it("[4717272005] isTransactionsUnsupportedError rethrows Atlas code 251 (NoSuchTransaction) and generic code 20 (IllegalOperation) without non-transactional fallback", async () => {
      const noSuchTx = Object.assign(
        new Error("Transaction 42 has been aborted."),
        { code: 251 },
      );
      const genericIllegalOp = Object.assign(
        new Error(
          "Cannot create namespace inside a multi-document transaction",
        ),
        { code: 20 },
      );
      const standaloneReplicaErr = Object.assign(
        new Error(
          "Transaction numbers are only allowed on a replica set member or mongos",
        ),
        { code: 20 },
      );
      const standaloneDriverErr = new Error(
        "Standalone servers do not support transactions",
      );

      expect(isTransactionsUnsupportedError(noSuchTx)).toBe(false);
      expect(isTransactionsUnsupportedError(genericIllegalOp)).toBe(false);
      expect(isTransactionsUnsupportedError(standaloneReplicaErr)).toBe(true);
      expect(isTransactionsUnsupportedError(standaloneDriverErr)).toBe(true);

      // Verify runInMongoTransaction does NOT fall back on code 251 when topology is replica-set.
      const fakeSession = {
        startTransaction: vi.fn(),
        commitTransaction: vi.fn(),
        abortTransaction: vi.fn().mockResolvedValue(undefined),
        endSession: vi.fn().mockResolvedValue(undefined),
      };
      const fakeClient = {
        topology: { description: { type: "ReplicaSetWithPrimary" } },
      };
      const getClientSpy = vi
        .spyOn(Workspace.db, "getClient")
        .mockReturnValue(fakeClient as never);
      const startSessionSpy = vi
        .spyOn(Workspace.db, "startSession")
        .mockResolvedValue(fakeSession as never);

      try {
        let calls = 0;
        await expect(
          runInMongoTransaction(async () => {
            calls += 1;
            throw noSuchTx;
          }),
        ).rejects.toThrow(/Transaction 42 has been aborted/);
        expect(calls).toBe(1);

        // Genuine standalone error DOES fall back once without session.
        let fallbackCalls = 0;
        const result = await runInMongoTransaction(async session => {
          fallbackCalls += 1;
          if (session) {
            throw standaloneReplicaErr;
          }
          return "ok-fallback";
        });
        expect(result).toBe("ok-fallback");
        expect(fallbackCalls).toBe(2);
      } finally {
        getClientSpy.mockRestore();
        startSessionSpy.mockRestore();
      }
    });

    it("[4717272990] replayWorkspacesRetry checks the current stage and drops stale retries directed at the new primary or a retired secondary", async () => {
      const router = new MigrationRouter({
        getDb: () => db,
        hasPg: () => true,
        enablePubSub: false,
        cacheTtlMs: 0,
      });
      const dualRepo = new DualWorkspaceRepository({
        router,
        getDb: () => db,
      });
      const mongoRepo = new MongoWorkspaceRepository();
      const pgRepo = new PgWorkspaceRepository({ getDb: () => db });

      await router.setDomainState({
        domain: WORKSPACES_DOMAIN,
        mode: "dual_write_mongo_read",
      });
      const owner = await seedUser({
        mongoId: "stage_rtry_own1",
        email: "stage-retry@example.com",
      });
      const { workspace: ws } = await dualRepo.createWorkspaceWithOwner({
        name: "Before Cutover",
        slug: "stage-retry-ws",
        userId: owner.mongoId,
      });
      await dualRepo.ensureMcpClient({
        clientId: "mcpc_stage",
        redirectUris: ["https://stage.example/cb"],
      });
      const origRefresh = makeHash("stage-rt-old");
      const tok = await dualRepo.createMcpToken({
        accessTokenHash: makeHash("stage-at-old"),
        refreshTokenHash: origRefresh,
        clientId: "mcpc_stage",
        userId: owner.mongoId,
        workspaceId: ws.id,
        scopes: ["mcp"],
        accessExpiresAt: new Date(Date.now() + 3600_000),
      });

      // Now flip to Stage 4 (PG primary) and rotate token + rename workspace in PG,
      // while Mongo still has the old token hash (e.g., if secondary failed).
      await router.setDomainState({
        domain: WORKSPACES_DOMAIN,
        mode: "dual_write_pg_read",
      });
      const rotatedAccess = makeHash("stage-at-new");
      await pgRepo.rotateMcpRefreshToken({
        currentRefreshTokenHash: origRefresh,
        clientId: "mcpc_stage",
        newAccessTokenHash: rotatedAccess,
        newRefreshTokenHash: makeHash("stage-rt-new"),
        newAccessExpiresAt: new Date(Date.now() + 7200_000),
        newRefreshExpiresAt: null,
        stripScopes: [],
      });
      await pgRepo.updateWorkspace(ws.id, { name: "Authoritative PG Name" });

      // A stale `pg-sync-retry` queued during Stage 2 arrives NOW -> MUST be dropped!
      const stalePgRetry: SyncRetryEventData = {
        domain: WORKSPACES_DOMAIN,
        operation: "createMcpToken",
        target: "pg",
        entityId: tok.id,
        payload: {
          targets: [
            { table: "workspaces", entityIds: [ws.id] },
            { table: "mcp_oauth_tokens", entityIds: [tok.id] },
          ],
        },
        failedAt: new Date().toISOString(),
        errorMessage: "old stage-2 timeout",
      };
      await replayWorkspacesRetry(stalePgRetry, { getDb: () => db });

      expect((await pgRepo.findById(ws.id))?.name).toBe(
        "Authoritative PG Name",
      );
      expect(
        (await pgRepo.findValidMcpTokenByAccessHash(rotatedAccess))?.id,
      ).toBe(tok.id);

      // Flip to Stage 5 (`pg_only`): BOTH `pg` and `mongo` retries MUST be dropped!
      await router.setDomainState({
        domain: WORKSPACES_DOMAIN,
        mode: "pg_only",
      });
      await replayWorkspacesRetry(
        { ...stalePgRetry, target: "mongo" },
        { getDb: () => db },
      );
      expect((await mongoRepo.findById(ws.id))?.name).toBe("Before Cutover");

      // Roll back to Stage 2 (`dual_write_mongo_read`): stale `mongo` retry MUST be dropped!
      await router.setDomainState({
        domain: WORKSPACES_DOMAIN,
        mode: "dual_write_mongo_read",
      });
      await replayWorkspacesRetry(
        { ...stalePgRetry, target: "mongo" },
        { getDb: () => db },
      );
      expect((await mongoRepo.findById(ws.id))?.name).toBe("Before Cutover");
    });

    it("[4717273406] revokeAcpGrant resyncs only the revoked grant so another grant with an unresolvable user never blocks revocation", async () => {
      const failures: SecondaryWriteFailureContext[] = [];
      const router = new MigrationRouter({
        getDb: () => db,
        hasPg: () => true,
        enablePubSub: false,
        cacheTtlMs: 0,
        onSecondaryFailure: async ctx => {
          failures.push(ctx);
        },
      });
      await router.setDomainState({
        domain: WORKSPACES_DOMAIN,
        mode: "dual_write_mongo_read",
      });
      const dualRepo = new DualWorkspaceRepository({
        router,
        getDb: () => db,
      });
      const pgRepo = new PgWorkspaceRepository({ getDb: () => db });

      const validUser = await seedUser({
        mongoId: "acp_valid_usr01",
        email: "acp-valid@example.com",
      });
      const { workspace: ws } = await dualRepo.createWorkspaceWithOwner({
        name: "ACP Scoped WS",
        slug: "acp-scoped-ws",
        userId: validUser.mongoId,
      });
      await dualRepo.upsertAcpGrant({
        workspaceId: ws.id,
        userId: validUser.mongoId,
        agentSessionId: "acp-good-session",
        planDigest: sha256("plan-good"),
        grants: ["git-write"],
        expiresAt: new Date(Date.now() + 3600_000),
      });

      // Plant an unrelated Mongo ACP grant for a deleted/missing PG user in the SAME workspace.
      await AcpPlanGrant.create({
        workspaceId: ws.id,
        userId: "deleted_user_not_in_pg",
        agentSessionId: "acp-orphan-session",
        planDigest: sha256("plan-orphan"),
        grants: ["git-write"],
        status: "approved",
        expiresAt: new Date(Date.now() + 3600_000),
      });

      failures.length = 0;
      expect(
        await dualRepo.revokeAcpGrant({
          workspaceId: ws.id,
          userId: validUser.mongoId,
          agentSessionId: "acp-good-session",
        }),
      ).toBe(true);
      expect(failures).toEqual([]);
      expect(
        await pgRepo.findActiveAcpGrant({
          workspaceId: ws.id,
          userId: validUser.mongoId,
          agentSessionId: "acp-good-session",
        }),
      ).toBeNull();
    });

    it("[4717273987] unresolved API key creator throws in PG & Stage 2 resync (queuing retry) and is quarantined in backfill instead of silently storing NULL", async () => {
      const failures: SecondaryWriteFailureContext[] = [];
      const router = new MigrationRouter({
        getDb: () => db,
        hasPg: () => true,
        enablePubSub: false,
        cacheTtlMs: 0,
        onSecondaryFailure: async ctx => {
          failures.push(ctx);
        },
      });
      await router.setDomainState({
        domain: WORKSPACES_DOMAIN,
        mode: "dual_write_mongo_read",
      });
      const dualRepo = new DualWorkspaceRepository({
        router,
        getDb: () => db,
      });
      const pgRepo = new PgWorkspaceRepository({ getDb: () => db });

      const owner = await seedUser({
        mongoId: "api_cr_owner_01",
        email: "api-cr-owner@example.com",
      });
      const { workspace: ws } = await dualRepo.createWorkspaceWithOwner({
        name: "Creator Check WS",
        slug: "creator-check-ws",
        userId: owner.mongoId,
      });

      // 1. Direct PG write throws when non-sentinel creator does not exist in PG `users`.
      await expect(
        pgRepo.createApiKey({
          workspaceId: ws.id,
          name: "Broken Creator Key",
          keyHash: makeHash("missing-creator-pg"),
          prefix: "revops_mis0001",
          scopes: ["mcp"],
          createdBy: "lagging_user_not_in_pg",
        }),
      ).rejects.toThrow(/Cannot resolve API key creator/);

      await expect(
        pgRepo.replaceApiKeyByName({
          workspaceId: ws.id,
          name: "Broken Replace Key",
          keyHash: makeHash("missing-creator-rep"),
          prefix: "revops_mis0002",
          scopes: ["mcp"],
          createdBy: "lagging_user_not_in_pg",
        }),
      ).rejects.toThrow(/Cannot resolve API key creator/);

      // Synthetic sentinel `"system"` still maps cleanly to NULL.
      const sysKey = await pgRepo.createApiKey({
        workspaceId: ws.id,
        name: "System Sentinel Key",
        keyHash: makeHash("sys-sentinel"),
        prefix: "revops_sys0001",
        scopes: ["mcp"],
        createdBy: "system",
      });
      expect(sysKey.createdBy).toBe("");

      // 2. Stage 2 dual-write queues a pg-sync-retry when creator is lagging (does NOT write NULL to PG).
      failures.length = 0;
      const laggingKey = await dualRepo.createApiKey({
        workspaceId: ws.id,
        name: "Lagging Auth Key",
        keyHash: makeHash("lagging-auth-k"),
        prefix: "revops_lag0001",
        scopes: ["mcp"],
        createdBy: "lagging_user_retry1",
      });
      expect(failures).toHaveLength(1);
      expect(await pgRepo.findApiKeyByHash(laggingKey.keyHash)).toBeNull();

      // Once auth catches up and user arrives in PG, replaying the retry succeeds with non-null creator UUID!
      const laggedUser = await seedUser({
        mongoId: "lagging_user_retry1",
        email: "lagged@example.com",
      });
      await replayWorkspacesRetry(
        {
          domain: WORKSPACES_DOMAIN,
          operation: failures[0].operation,
          target: "pg",
          entityId: failures[0].entityId ?? laggingKey.id,
          payload: failures[0].payload,
          failedAt: new Date().toISOString(),
          errorMessage: "lagging auth",
        },
        { getDb: () => db },
      );
      const syncedKey = await pgRepo.findApiKeyByHash(laggingKey.keyHash);
      expect(syncedKey?.apiKey.createdBy).toBe(laggedUser.pgUuid);

      // 3. Backfill quarantines API keys whose non-sentinel creator is missing in PG (never writes NULL silently).
      const orphanKeyId = new Types.ObjectId(newDualId().oid);
      await Workspace.updateOne(
        { _id: new Types.ObjectId(ws.id) },
        {
          $push: {
            apiKeys: {
              _id: orphanKeyId,
              name: "Orphan Creator Key",
              keyHash: makeHash("orphan-cr-bf"),
              prefix: "revops_orp0001",
              scopes: ["mcp"],
              createdBy: "ghost_creator_never_synced",
              createdAt: new Date(),
            },
          },
        },
        { timestamps: false },
      );
      const bf = await runBackfill({
        domain: `${WORKSPACES_DOMAIN}:workspace_api_keys`,
        db,
        resetCursor: true,
      });
      expect(bf.rowsQuarantined).toBe(1);
      const quarantined = await db.select().from(pgSchema.migrationQuarantine);
      expect(
        quarantined.some(q => q.reason === "orphaned_api_key_creator_missing"),
      ).toBe(true);
      expect(
        (await pgRepo.listApiKeys(ws.id)).some(
          k => k.id === orphanKeyId.toHexString(),
        ),
      ).toBe(false);
    });

    it("[4717274345] cancelInvite is scoped by (workspaceId, inviteId) across Mongo, PG, and Dual repos", async () => {
      const router = new MigrationRouter({
        getDb: () => db,
        hasPg: () => true,
        enablePubSub: false,
        cacheTtlMs: 0,
      });
      await router.setDomainState({
        domain: WORKSPACES_DOMAIN,
        mode: "dual_write_mongo_read",
      });
      const dualRepo = new DualWorkspaceRepository({
        router,
        getDb: () => db,
      });
      const mongoRepo = new MongoWorkspaceRepository();
      const pgRepo = new PgWorkspaceRepository({ getDb: () => db });

      const owner = await seedUser({
        mongoId: "inv_scope_own01",
        email: "inv-scope@example.com",
      });
      const { workspace: wsA } = await dualRepo.createWorkspaceWithOwner({
        name: "Workspace A",
        slug: "invite-scope-a",
        userId: owner.mongoId,
      });
      const { workspace: wsB } = await dualRepo.createWorkspaceWithOwner({
        name: "Workspace B",
        slug: "invite-scope-b",
        userId: owner.mongoId,
      });
      const invB = await dualRepo.createInvite({
        workspaceId: wsB.id,
        email: "victim@example.com",
        token: "tok-ws-b-scoped",
        role: "member",
        invitedBy: owner.mongoId,
        expiresAt: new Date(Date.now() + 86_400_000),
      });

      // Workspace A MUST NOT cancel Workspace B's invite in Mongo, PG, or Dual!
      expect(await mongoRepo.cancelInvite(wsA.id, invB.id)).toBe(false);
      expect(await pgRepo.cancelInvite(wsA.id, invB.id)).toBe(false);
      expect(await dualRepo.cancelInvite(wsA.id, invB.id)).toBe(false);
      expect(
        await pgRepo.findPendingInviteByToken("tok-ws-b-scoped"),
      ).not.toBeNull();
      expect(
        await mongoRepo.findPendingInviteByToken("tok-ws-b-scoped"),
      ).not.toBeNull();
      expect(await db.select().from(pgSchema.migrationTombstones)).toHaveLength(
        0,
      );

      // Workspace B CAN cancel its own invite.
      expect(await dualRepo.cancelInvite(wsB.id, invB.id)).toBe(true);
      expect(
        await pgRepo.findPendingInviteByToken("tok-ws-b-scoped"),
      ).toBeNull();
      expect(
        await mongoRepo.findPendingInviteByToken("tok-ws-b-scoped"),
      ).toBeNull();
    });

    it("[4717276184] sandboxRunOfKey matches PG API keys whose createdBy is UUIDv7 against legacy user IDs in sandbox key names", async () => {
      const pgRepo = new PgWorkspaceRepository({ getDb: () => db });
      const legacyUser = await seedUser({
        mongoId: "sb_legacy_usr01",
        email: "sandbox-user@example.com",
      });
      const { workspace: ws } = await pgRepo.createWorkspaceWithOwner({
        name: "Sandbox Key WS",
        slug: "sandbox-key-ws",
        userId: legacyUser.mongoId,
      });
      const runId = "sandbox-11111111-2222-4333-8444-555555555555";
      const pgKey = await pgRepo.createApiKey({
        workspaceId: ws.id,
        name: `Workflows sandbox ${legacyUser.mongoId} ${runId}`,
        keyHash: makeHash("sandbox-pg-key"),
        prefix: "revops_sbx0001",
        scopes: ["mcp", "query:write", "workflows:runtime"],
        createdBy: legacyUser.mongoId,
        recordWrites: true,
      });

      // PG returns UUIDv7 createdBy while key name holds legacy user ID -> MUST match!
      expect(pgKey.createdBy).toBe(legacyUser.pgUuid);
      expect(sandboxRunOfKey(pgKey)).toBe(runId);

      // Spoofed name with a different user's legacy ID MUST still return null!
      expect(
        sandboxRunOfKey({
          name: `Workflows sandbox other_legacy_99 ${runId}`,
          createdBy: pgKey.createdBy,
        }),
      ).toBeNull();
    });
  });
});
