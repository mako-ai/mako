/**
 * Notifications repository contract on PGlite (migration `0012`): dual-ID rules,
 * workspace scoping, flow soft-ref round trip, verbatim encrypted channel,
 * race-free delivery creation, atomic attempt counting, delivery ordering and
 * the 90-day `notification_deliveries` TTL rule.
 */
import type { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  resetPgTestDb,
  setPgTestDb,
  type MakoPgDb,
} from "../../database/pg/client";
import {
  generateObjectIdHex,
  generateUuidv7,
  isObjectIdHex,
  newDualId,
  objectIdToUuid,
} from "../../database/pg/id-codec";
import { runPgliteMigrations } from "../../database/pg/migrate";
import * as pgSchema from "../../database/pg/schema";
import { createTestPglite } from "../../database/pg/test-pglite";
import {
  DEFAULT_PG_TTL_RULES,
  reapExpiredRows,
} from "../../database/pg/ttl-reaper";
import { PgNotificationsRepository } from "./pg.repo";
import type {
  CreateNotificationDeliveryInput,
  CreateNotificationRuleInput,
} from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("PgNotificationsRepository contract", () => {
  let pg: PGlite;
  let db: MakoPgDb;
  let repo: PgNotificationsRepository;

  let userUuid: string;
  let wsId: string;
  let otherWsId: string;
  let flowId: string;

  beforeAll(async () => {
    pg = createTestPglite();
    await runPgliteMigrations(pg);
    db = drizzle(pg, { schema: pgSchema }) as unknown as MakoPgDb;
    repo = new PgNotificationsRepository({ getDb: () => db });
  });

  afterAll(async () => {
    await pg.close();
  });

  beforeEach(async () => {
    await pg.exec(
      "DELETE FROM notification_deliveries; DELETE FROM notification_rules; DELETE FROM workspaces; DELETE FROM users;",
    );
    userUuid = generateUuidv7();
    const ws = newDualId();
    const other = newDualId();
    wsId = ws.oid;
    otherWsId = other.oid;
    flowId = generateObjectIdHex();
    await db.insert(pgSchema.users).values({
      id: userUuid,
      email: `notif-${userUuid.slice(-6)}@example.com`,
    });
    await db.insert(pgSchema.workspaces).values([
      {
        id: ws.uuid,
        name: "Notif WS",
        slug: `notif-${ws.oid.slice(-6)}`,
        createdBy: userUuid,
      },
      {
        id: other.uuid,
        name: "Other WS",
        slug: `other-${other.oid.slice(-6)}`,
        createdBy: userUuid,
      },
    ]);
  });

  const webhookChannel = {
    type: "webhook" as const,
    urlEncrypted: "iv1:ciphertext-url",
    signingSecretEncrypted: "iv2:ciphertext-secret",
  };

  function ruleInput(
    overrides: Partial<CreateNotificationRuleInput> = {},
  ): CreateNotificationRuleInput {
    return {
      workspaceId: wsId,
      resourceType: "flow",
      resourceId: flowId,
      enabled: true,
      triggers: ["failure"],
      channel: webhookChannel,
      createdBy: userUuid,
      ...overrides,
    };
  }

  function deliveryInput(
    ruleId: string,
    overrides: Partial<CreateNotificationDeliveryInput> = {},
  ): CreateNotificationDeliveryInput {
    return {
      workspaceId: wsId,
      ruleId,
      resourceType: "flow",
      resourceId: flowId,
      runId: "run-1",
      trigger: "failure",
      channelType: "webhook",
      idempotencyKey: `key-${ruleId}-run-1`,
      ...overrides,
    };
  }

  it("mints a 24-hex dual ID and round-trips the rule", async () => {
    const created = await repo.createRule(ruleInput());
    expect(isObjectIdHex(created.id)).toBe(true);
    expect(created.workspaceId).toBe(wsId);
    expect(created.resourceId).toBe(flowId);
    expect(created.triggers).toEqual(["failure"]);

    const byId = await repo.findRuleInWorkspace(wsId, created.id);
    expect(byId).toEqual(created);
    // The canonical UUID form of the same ID resolves too.
    const byUuid = await repo.findRuleInWorkspace(
      wsId,
      objectIdToUuid(created.id),
    );
    expect(byUuid?.id).toBe(created.id);
  });

  it("stores a flow ObjectId as its UUIDv8 form and serves it back unchanged", async () => {
    const created = await repo.createRule(ruleInput());
    const rows = await db
      .select({ resourceId: pgSchema.notificationRules.resourceId })
      .from(pgSchema.notificationRules)
      .where(eq(pgSchema.notificationRules.id, objectIdToUuid(created.id)));
    expect(rows[0].resourceId).toBe(objectIdToUuid(flowId));
    expect(created.resourceId).toBe(flowId);
  });

  it("stores the encrypted channel verbatim", async () => {
    const slack = {
      type: "slack" as const,
      webhookUrlEncrypted: "iv3:ciphertext-slack",
      displayLabel: "#alerts",
    };
    const created = await repo.createRule(ruleInput({ channel: slack }));
    expect(created.channel).toEqual(slack);
    const raw = await pg.query<{ channel: Record<string, unknown> }>(
      "SELECT channel FROM notification_rules WHERE id = $1",
      [objectIdToUuid(created.id)],
    );
    expect(raw.rows[0].channel).toEqual(slack);
  });

  it("resolves created_by_user_id for a real user and leaves it NULL for a sentinel", async () => {
    const byUser = await repo.createRule(ruleInput());
    const bySentinel = await repo.createRule(
      ruleInput({ createdBy: "unknown" }),
    );
    const raw = await pg.query<{
      id: string;
      created_by_user_id: string | null;
      created_by: string;
    }>(
      "SELECT id::text, created_by_user_id::text, created_by FROM notification_rules",
    );
    const byId = new Map(raw.rows.map(r => [r.id, r]));
    expect(byId.get(objectIdToUuid(byUser.id))?.created_by_user_id).toBe(
      userUuid,
    );
    expect(byId.get(objectIdToUuid(bySentinel.id))?.created_by_user_id).toBe(
      null,
    );
    expect(byId.get(objectIdToUuid(bySentinel.id))?.created_by).toBe("unknown");
  });

  it("lists a resource's rules oldest first and filters enabled rules by trigger", async () => {
    const t0 = new Date("2026-01-01T00:00:00Z");
    const later = await repo.createRule(
      ruleInput({
        triggers: ["success", "failure"],
        createdAt: new Date(t0.getTime() + 2000),
      }),
    );
    const first = await repo.createRule(
      ruleInput({ triggers: ["failure"], createdAt: t0 }),
    );
    const disabled = await repo.createRule(
      ruleInput({
        enabled: false,
        triggers: ["success"],
        createdAt: new Date(t0.getTime() + 1000),
      }),
    );
    // Another resource's rule never shows.
    await repo.createRule(ruleInput({ resourceId: generateObjectIdHex() }));

    const all = await repo.listRulesForResource(wsId, "flow", flowId);
    expect(all.map(r => r.id)).toEqual([first.id, disabled.id, later.id]);

    const onSuccess = await repo.listEnabledRulesForTrigger(
      wsId,
      "flow",
      flowId,
      "success",
    );
    expect(onSuccess.map(r => r.id)).toEqual([later.id]);

    const onFailure = await repo.listEnabledRulesForTrigger(
      wsId,
      "flow",
      flowId,
      "failure",
    );
    expect(onFailure.map(r => r.id)).toEqual([first.id, later.id]);

    expect(
      await repo.listRulesForResource(wsId, "scheduled_query", flowId),
    ).toEqual([]);
  });

  it("scopes find, update and delete to the workspace", async () => {
    const created = await repo.createRule(ruleInput());
    expect(await repo.findRuleInWorkspace(otherWsId, created.id)).toBeNull();
    expect(
      await repo.updateRule(otherWsId, created.id, { enabled: false }),
    ).toBeNull();
    expect(await repo.deleteRule(otherWsId, created.id)).toBe(false);
    expect((await repo.findRuleInWorkspace(wsId, created.id))?.enabled).toBe(
      true,
    );
  });

  it("patches a rule and bumps updated_at", async () => {
    const created = await repo.createRule(
      ruleInput({ createdAt: new Date("2026-01-01T00:00:00Z") }),
    );
    const email = { type: "email" as const, recipients: ["ops@example.com"] };
    const updated = await repo.updateRule(wsId, created.id, {
      enabled: false,
      triggers: ["success"],
      channel: email,
    });
    expect(updated).not.toBeNull();
    expect(updated?.enabled).toBe(false);
    expect(updated?.triggers).toEqual(["success"]);
    expect(updated?.channel).toEqual(email);
    expect(updated?.createdAt.getTime()).toBe(created.createdAt.getTime());
    expect(updated?.updatedAt.getTime()).toBeGreaterThan(
      created.updatedAt.getTime(),
    );
  });

  it("returns empty results for malformed IDs without throwing", async () => {
    expect(await repo.findRuleInWorkspace(wsId, "not-an-id")).toBeNull();
    expect(await repo.findRuleInWorkspace("bad", "bad")).toBeNull();
    expect(await repo.updateRule("bad", "bad", { enabled: true })).toBeNull();
    expect(await repo.deleteRule("bad", "bad")).toBe(false);
    expect(await repo.listRulesForResource("bad", "flow", flowId)).toEqual([]);
    expect(
      await repo.listEnabledRulesForTrigger(wsId, "flow", "bad", "failure"),
    ).toEqual([]);
    expect(
      await repo.listDeliveriesForResource(wsId, "flow", "bad", 10),
    ).toEqual([]);
  });

  it("creates exactly one delivery when ten fan-outs race on one idempotency key", async () => {
    const rule = await repo.createRule(ruleInput());
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        repo.ensurePendingDelivery(deliveryInput(rule.id)),
      ),
    );
    const created = results.filter(r => r !== null);
    expect(created).toHaveLength(10);
    expect(new Set(created.map(row => row.id)).size).toBe(1);
    expect(created[0]?.status).toBe("pending");
    expect(created[0]?.attempts).toBe(0);
    expect(created[0]?.ruleId).toBe(rule.id);
    expect(created[0]?.resourceId).toBe(flowId);

    const count = await pg.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM notification_deliveries",
    );
    expect(count.rows[0].n).toBe(1);
  });

  it("replays an interrupted fan-out with the same Inngest event ID until completion", async () => {
    const { fanOutTerminalRunNotifications } =
      await import("../../services/flow-run-notification.service");
    const { inngest } = await import("../../inngest/client");
    const { consolesChartsRepo } = await import("../consoles-charts");
    setPgTestDb(db);
    try {
      vi.spyOn(consolesChartsRepo, "findConsoleByIdGlobal").mockResolvedValue(
        null,
      );
      const send = vi
        .spyOn(inngest, "send")
        .mockRejectedValueOnce(new Error("queue unavailable"))
        .mockResolvedValue({ ids: ["queued"] });
      await repo.createRule(ruleInput({ resourceType: "scheduled_query" }));
      const event = {
        workspaceId: wsId,
        resourceType: "scheduled_query" as const,
        resourceId: flowId,
        runId: "r1",
        status: "failed",
        success: false,
        completedAt: new Date().toISOString(),
      };
      await expect(fanOutTerminalRunNotifications(event)).rejects.toThrow(
        "queue unavailable",
      );
      expect(await fanOutTerminalRunNotifications(event)).toEqual({
        deliveriesQueued: 1,
      });
      const [pending] = await repo.listDeliveriesForResource(
        wsId,
        "scheduled_query",
        flowId,
        5,
      );
      for (const [message] of send.mock.calls) {
        expect(message).toMatchObject({ id: pending.idempotencyKey });
      }
      await repo.completeDelivery(pending.idempotencyKey, {
        status: "sent",
        completedAt: new Date(),
        countAttempt: true,
      });
      expect(await fanOutTerminalRunNotifications(event)).toEqual({
        deliveriesQueued: 0,
      });
      expect(send).toHaveBeenCalledTimes(2);
    } finally {
      vi.restoreAllMocks();
      resetPgTestDb();
    }
  });

  it("counts attempts atomically and leaves attempts alone on skip", async () => {
    const rule = await repo.createRule(ruleInput());
    const key = "key-attempts";
    await repo.ensurePendingDelivery(
      deliveryInput(rule.id, { idempotencyKey: key }),
    );

    const changed = await Promise.all(
      Array.from({ length: 7 }, () =>
        repo.completeDelivery(key, {
          status: "failed",
          lastError: "HTTP 500",
          completedAt: new Date(),
          countAttempt: true,
        }),
      ),
    );
    expect(changed.every(Boolean)).toBe(true);

    await repo.completeDelivery(key, {
      status: "skipped",
      lastError: "Rule disabled or deleted",
      completedAt: new Date(),
      countAttempt: false,
    });

    const [delivery] = await repo.listDeliveriesForResource(
      wsId,
      "flow",
      flowId,
      10,
    );
    expect(delivery.attempts).toBe(7);
    expect(delivery.status).toBe("skipped");
    expect(delivery.lastError).toBe("Rule disabled or deleted");
    expect(delivery.completedAt).toBeInstanceOf(Date);

    expect(
      await repo.completeDelivery("missing-key", {
        status: "sent",
        completedAt: new Date(),
        countAttempt: true,
      }),
    ).toBe(false);
  });

  it("preserves unrepresentable webhook errors and literal encoding prefixes in delivery history", async () => {
    const rule = await repo.createRule(ruleInput());
    const input = deliveryInput(rule.id);
    await repo.ensurePendingDelivery(input);
    for (const lastError of [
      "HTTP 500: a\0b😀",
      "surrogate \ud800",
      '\u001emako:delivery-error:"literal"',
    ]) {
      await repo.completeDelivery(input.idempotencyKey, {
        status: "failed",
        lastError,
        completedAt: new Date(),
        countAttempt: true,
      });
      const [row] = await repo.listDeliveriesForResource(
        wsId,
        "flow",
        flowId,
        10,
      );
      expect(row.lastError).toBe(lastError);
    }
  });

  it("orders deliveries by completed DESC NULLS LAST, then created DESC, and honors limit", async () => {
    const rule = await repo.createRule(ruleInput());
    for (const key of ["a", "b", "c", "d"]) {
      await repo.ensurePendingDelivery(
        deliveryInput(rule.id, { idempotencyKey: key, runId: key }),
      );
    }
    const base = Date.parse("2026-02-01T00:00:00Z");
    // a, b pending (completed NULL) with distinct created_at; c, d completed.
    await pg.query(
      `UPDATE notification_deliveries SET created_at = $2 WHERE idempotency_key = $1`,
      ["a", new Date(base).toISOString()],
    );
    await pg.query(
      `UPDATE notification_deliveries SET created_at = $2 WHERE idempotency_key = $1`,
      ["b", new Date(base + 1000).toISOString()],
    );
    await repo.completeDelivery("c", {
      status: "sent",
      sentAt: new Date(base + 5000),
      completedAt: new Date(base + 5000),
      countAttempt: true,
    });
    await repo.completeDelivery("d", {
      status: "sent",
      sentAt: new Date(base + 9000),
      completedAt: new Date(base + 9000),
      countAttempt: true,
    });

    const all = await repo.listDeliveriesForResource(wsId, "flow", flowId, 50);
    expect(all.map(d => d.idempotencyKey)).toEqual(["d", "c", "b", "a"]);
    expect(all[0].sentAt?.getTime()).toBe(base + 9000);

    const limited = await repo.listDeliveriesForResource(
      wsId,
      "flow",
      flowId,
      2,
    );
    expect(limited.map(d => d.idempotencyKey)).toEqual(["d", "c"]);
  });

  it("keeps history and finishes in-flight deliveries after rule deletion", async () => {
    const rule = await repo.createRule(ruleInput());
    const input = deliveryInput(rule.id);
    await repo.ensurePendingDelivery(input);
    expect(await repo.deleteRule(wsId, rule.id)).toBe(true);
    await repo.completeDelivery(input.idempotencyKey, {
      status: "skipped",
      completedAt: new Date(),
      lastError: "Rule disabled or deleted",
      countAttempt: false,
    });
    expect(await repo.ensurePendingDelivery(input)).toBeNull();
    const raced = await repo.ensurePendingDelivery({
      ...input,
      idempotencyKey: "fanout-racing-delete",
    });
    expect(raced?.ruleId).toBe(rule.id);
    const history = await repo.listDeliveriesForResource(
      wsId,
      "flow",
      flowId,
      10,
    );
    expect(history.map(d => [d.ruleId, d.status])).toEqual([
      [rule.id, "skipped"],
      [rule.id, "pending"],
    ]);
  });

  it("reaps deliveries older than 90 days and keeps fresh ones", async () => {
    const rule = await repo.createRule(ruleInput());
    await repo.ensurePendingDelivery(
      deliveryInput(rule.id, { idempotencyKey: "old" }),
    );
    await repo.ensurePendingDelivery(
      deliveryInput(rule.id, { idempotencyKey: "fresh" }),
    );
    const now = new Date();
    await db.execute(
      sql`UPDATE notification_deliveries SET created_at = ${new Date(now.getTime() - 91 * DAY_MS).toISOString()}::timestamptz WHERE idempotency_key = 'old'`,
    );
    await db.execute(
      sql`UPDATE notification_deliveries SET created_at = ${new Date(now.getTime() - 89 * DAY_MS).toISOString()}::timestamptz WHERE idempotency_key = 'fresh'`,
    );

    const ttlRule = DEFAULT_PG_TTL_RULES.find(
      r => r.tableName === "notification_deliveries",
    );
    expect(ttlRule).toMatchObject({
      timestampColumn: "created_at",
      olderThanMs: 90 * DAY_MS,
    });
    if (!ttlRule) throw new Error("Missing notification_deliveries TTL rule");
    const result = await reapExpiredRows(ttlRule, { db, now });
    expect(result.deleted).toBe(1);

    const left = await pg.query<{ idempotency_key: string }>(
      "SELECT idempotency_key FROM notification_deliveries",
    );
    expect(left.rows.map(r => r.idempotency_key)).toEqual(["fresh"]);
  });
});
