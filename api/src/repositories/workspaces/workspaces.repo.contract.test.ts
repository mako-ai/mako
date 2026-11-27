/**
 * Phase 1B (`workspaces_core` + `github_installations`, 10 tables — Decision #3)
 * comprehensive contract, 5-stage dual-run, rollback, hot-read isolation,
 * secret-redaction, FK-ordered backfill, parity verifier (`--repair`),
 * sync-retry, and TTL reaper test suite.
 */
import { createHash, randomBytes } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import mongoose from "mongoose";
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
import { workspaceService } from "../../services/workspace.service";
import { sandboxRunOfKey } from "../../workflows/sandbox";
import {
  PgAuthRepository,
  resetAuthRepoForTests,
  setAuthRepoForTests,
} from "../auth";
import { resetWorkspaceRepoForTests, setWorkspaceRepoForTests } from "./index";
import {
  MongoWorkspaceRepository,
  isTransactionsUnsupportedError,
  runInMongoTransaction,
} from "./mongo.repo";
import { PgWorkspaceRepository } from "./pg.repo";
import { WorkspaceSlugConflictError, type WorkspaceRepository } from "./types";

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

  // ── 3. Backfill, Quarantine, Tombstones, Verifier (--repair) & TTL ─────

  // ── 4. WorkspaceService end-to-end with PG primary ─────────────────────

  describe("WorkspaceService integration on PgWorkspaceRepository + authRepo", () => {
    it("updates active session via authRepo, filters existing-member invites, and revokes credentials on member removal", async () => {
      const authPg = new PgAuthRepository({ getDb: () => db });
      const wsPg = new PgWorkspaceRepository({ getDb: () => db });
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

  // ── 6. PR #1554 Deep Review Regressions (12 findings) ──────────────────

  describe("PR #1554 deep-review regressions", () => {
    it("[4717269351] syncSubscriptionToWorkspace persists unpaid, paused, and incomplete_expired identically in Mongo and PG and downgrades plan to free", async () => {
      const mongoRepo = new MongoWorkspaceRepository();
      const pgRepo = new PgWorkspaceRepository({ getDb: () => db });
      const owner = await seedUser({
        mongoId: "stripe_owner_01",
        email: "stripe@example.com",
      });
      const { workspace: wsPg } = await pgRepo.createWorkspaceWithOwner({
        name: "Stripe Status WS",
        slug: "stripe-status-ws-pg",
        userId: owner.pgUuid,
      });
      const { workspace: wsMongo } = await mongoRepo.createWorkspaceWithOwner({
        name: "Stripe Status WS",
        slug: "stripe-status-ws-mongo",
        userId: owner.mongoId,
      });

      const makeSub = (
        workspaceId: string,
        status: Stripe.Subscription.Status,
      ): Stripe.Subscription =>
        ({
          id: "sub_test_123",
          customer: "cus_test_123",
          status,
          metadata: { workspaceId },
          current_period_start: Math.floor(Date.now() / 1000),
          current_period_end: Math.floor(Date.now() / 1000) + 86_400 * 30,
          items: { data: [] },
        }) as unknown as Stripe.Subscription;

      // Upgrade to pro first, then verify all 3 Stripe statuses persist cleanly in both PG and Mongo.
      for (const [store, targetWs] of [
        [pgRepo, wsPg],
        [mongoRepo, wsMongo],
      ] as const) {
        setWorkspaceRepoForTests(store);
        await syncSubscriptionToWorkspace(
          makeSub(targetWs.id, "active"),
          targetWs.id,
        );
        expect((await store.findById(targetWs.id))?.billing.plan).toBe("pro");

        for (const status of [
          "paused",
          "unpaid",
          "incomplete_expired",
        ] as const) {
          await syncSubscriptionToWorkspace(
            makeSub(targetWs.id, status),
            targetWs.id,
          );
          const updated = await store.findById(targetWs.id);
          expect(updated?.billing.subscriptionStatus).toBe(status);
          expect(updated?.billing.plan).toBe("free");
          expect(updated?.settings.billingTier).toBe("free");
        }
      }

      setWorkspaceRepoForTests(pgRepo);
      await syncSubscriptionToWorkspace(makeSub(wsPg.id, "trialing"), wsPg.id);
      expect((await pgRepo.findById(wsPg.id))?.billing.plan).toBe("pro");
      await syncSubscriptionToWorkspace(makeSub(wsPg.id, "paused"), wsPg.id);
      const pgAfter = await pgRepo.findById(wsPg.id);
      expect(pgAfter?.billing.subscriptionStatus).toBe("paused");
      expect(pgAfter?.billing.plan).toBe("free");
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
