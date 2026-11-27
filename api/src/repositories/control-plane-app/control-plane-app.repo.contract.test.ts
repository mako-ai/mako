/**
 * Small app control-plane repositories on PGlite (migration `0012`):
 *   - workflow recorded writes: the 200-per-run cap under concurrency, the full
 *     `keepRecordedWrite` / `recordedWritesOf` / `withRecordedWrites` path
 *     through the PG-first proxy, 64 KB body cut, paging, sandbox person
 *     filter, and the 7-day TTL rules;
 *   - model catalog snapshots: all 6 ids, CHECK on unknown ids, locked
 *     read-modify-write, `saveProbedThinkingMode`;
 *   - apps box policy: first-write-wins tracking start.
 */
import type { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  resetPgTestDb,
  setPgTestDb,
  type MakoPgDb,
} from "../../database/pg/client";
import {
  generateObjectIdHex,
  generateUuidv7,
  newDualId,
} from "../../database/pg/id-codec";
import { runPgliteMigrations } from "../../database/pg/migrate";
import * as pgSchema from "../../database/pg/schema";
import { MODEL_CATALOG_SNAPSHOT_IDS } from "../../database/pg/schema/control-plane-app";
import { createTestPglite } from "../../database/pg/test-pglite";
import {
  DEFAULT_PG_TTL_RULES,
  reapExpiredRows,
} from "../../database/pg/ttl-reaper";
import {
  MAX_RECORDED_PER_RUN,
  RECORDED_PAGE_SIZE,
  keepRecordedWrite,
  recordedWritesOf,
  withRecordedWrites,
} from "../../workflows/recorded-writes";
import {
  PgAppsBoxPolicyRepository,
  PgModelCatalogSnapshotsRepository,
  PgWorkflowRecordedWritesRepository,
} from "./pg.repo";

const DAY_MS = 24 * 60 * 60 * 1000;

const post = (text: string) => ({
  method: "POST",
  url: "https://slack.com/api/chat.postMessage",
  headers: { authorization: "Bearer [redacted]" },
  body: { channel: "C1", text },
});

describe("small app control-plane repositories (PGlite)", () => {
  let pg: PGlite;
  let db: MakoPgDb;
  let wsId: string;
  let userUuid: string;

  beforeAll(async () => {
    pg = createTestPglite();
    await runPgliteMigrations(pg);
    db = drizzle(pg, { schema: pgSchema }) as unknown as MakoPgDb;
  });

  afterAll(async () => {
    await pg.close();
  });

  beforeEach(async () => {
    await pg.exec(`
      DELETE FROM workflow_recorded_writes;
      DELETE FROM workflow_recorded_runs;
      DELETE FROM model_catalog_snapshots;
      DELETE FROM apps_box_policy;
      DELETE FROM workspaces;
      DELETE FROM users;
    `);
    userUuid = generateUuidv7();
    const ws = newDualId();
    wsId = ws.oid;
    await db.insert(pgSchema.users).values({
      id: userUuid,
      email: `cp-${userUuid.slice(-6)}@example.com`,
    });
    await db.insert(pgSchema.workspaces).values({
      id: ws.uuid,
      name: "Control Plane WS",
      slug: `cp-${ws.oid.slice(-6)}`,
      createdBy: userUuid,
    });
  });

  describe("workflow recorded writes", () => {
    let repo: PgWorkflowRecordedWritesRepository;
    const slack = { _id: generateObjectIdHex(), name: "slack" };

    beforeAll(() => {
      repo = new PgWorkflowRecordedWritesRepository({ getDb: () => db });
    });

    afterEach(() => {
      resetPgTestDb();
    });

    it("keeps the slot available when the write insert fails", async () => {
      const input = {
        workspaceId: wsId,
        runId: "run-retry",
        connectionId: slack._id,
        connection: slack.name,
        request: post("retry"),
      };
      expect(await repo.appendWrite(input, 2)).toBe(0);
      // Force a unique violation on the next write, after its slot is reserved.
      await pg.exec("UPDATE workflow_recorded_writes SET seq = 1");
      await expect(repo.appendWrite(input, 2)).rejects.toThrow();
      await pg.exec("UPDATE workflow_recorded_writes SET seq = 0");
      expect(await repo.appendWrite(input, 2)).toBe(1);
      expect(await repo.appendWrite(input, 2)).toBeNull();
    });

    it("keeps the cap through keepRecordedWrite on the PG-first proxy", async () => {
      setPgTestDb(db);
      const outcomes = await Promise.all(
        Array.from({ length: MAX_RECORDED_PER_RUN + 15 }, (_, i) =>
          keepRecordedWrite(
            wsId,
            { runId: "run-proxy", step: i % 2 ? "send" : "notify" },
            slack,
            post(`m${i}`),
          ),
        ),
      );
      expect(outcomes.filter(o => o === "kept")).toHaveLength(
        MAX_RECORDED_PER_RUN,
      );
      expect(outcomes.filter(o => o === "full")).toHaveLength(15);
      const seqs = await pg.query<{ seq: number }>(
        "SELECT seq FROM workflow_recorded_writes WHERE run_id = 'run-proxy' ORDER BY seq",
      );
      expect(seqs.rows.map(r => r.seq)).toEqual(
        Array.from({ length: MAX_RECORDED_PER_RUN }, (_, i) => i),
      );
    });

    it("cuts a body past 64 000 characters and marks it", async () => {
      setPgTestDb(db);
      const long = "x".repeat(70_000);
      expect(
        await keepRecordedWrite(
          wsId,
          { runId: "run-long", step: "send" },
          slack,
          { ...post("t"), body: long },
          { wouldSend: false },
        ),
      ).toBe("kept");
      const raw = await pg.query<{
        request: { body: string };
        body_cut: boolean;
        would_send: boolean;
      }>(
        "SELECT request, body_cut, would_send FROM workflow_recorded_writes WHERE run_id = 'run-long'",
      );
      expect(raw.rows[0].body_cut).toBe(true);
      expect(raw.rows[0].would_send).toBe(false);
      expect(raw.rows[0].request.body).toHaveLength(64_001);
      expect(raw.rows[0].request.body.endsWith("…")).toBe(true);

      const page = await recordedWritesOf(wsId, "run-long", { full: true });
      expect(page.total).toBe(1);
      expect(page.writes[0].bodyCut).toBe(true);
      expect(page.writes[0].wouldSend).toBe(false);
      expect(page.writes[0].body).toBe(raw.rows[0].request.body);

      const summary = await recordedWritesOf(wsId, "run-long");
      expect(String(summary.writes[0].body)).toContain(
        "(64001 chars; full: true for all)",
      );
    });

    it("keeps nested unsafe strings and truncates before a split emoji", async () => {
      setPgTestDb(db);
      const stem = "a".repeat(63_999);
      for (const body of [
        stem + "😀tail",
        { nested: ["a\u0000b", "\ud800", "😀"] },
      ]) {
        expect(
          await keepRecordedWrite(wsId, { runId: "unicode" }, slack, {
            ...post(""),
            headers: { "x-sample": "a\u0000b" },
            body,
          }),
        ).toBe("kept");
      }
      const { writes } = await recordedWritesOf(wsId, "unicode", {
        full: true,
      });
      expect(writes[0]).toMatchObject({
        headers: { "x-sample": "ab" },
        body: stem + "…",
        bodyCut: true,
      });
      expect(writes[1].body).toEqual({ nested: ["ab", "�", "😀"] });
    });

    it("pages writes in seq order and says where the next page starts", async () => {
      setPgTestDb(db);
      const total = RECORDED_PAGE_SIZE * 2 + 5;
      for (let i = 0; i < total; i++) {
        await keepRecordedWrite(
          wsId,
          { runId: "run-page", step: "send" },
          slack,
          post(`m${i}`),
        );
      }
      const first = await recordedWritesOf(wsId, "run-page");
      expect(first.total).toBe(total);
      expect(first.writes).toHaveLength(RECORDED_PAGE_SIZE);
      expect(first.next).toBe(RECORDED_PAGE_SIZE);
      expect(first.writes[0].body).toEqual(post("m0").body);

      const second = await recordedWritesOf(wsId, "run-page", {
        from: first.next,
      });
      expect(second.writes).toHaveLength(RECORDED_PAGE_SIZE);
      expect(second.next).toBe(RECORDED_PAGE_SIZE * 2);
      expect(second.writes[0].body).toEqual(
        post(`m${RECORDED_PAGE_SIZE}`).body,
      );

      const last = await recordedWritesOf(wsId, "run-page", {
        from: second.next,
      });
      expect(last.writes).toHaveLength(5);
      expect(last.next).toBeUndefined();
    });

    it("shows a sandbox run's writes only to its person", async () => {
      setPgTestDb(db);
      const run = "sandbox-run-1";
      await keepRecordedWrite(
        wsId,
        { runId: run, userId: "vera", step: "send" },
        slack,
        post("vera"),
      );
      await keepRecordedWrite(
        wsId,
        { runId: run, userId: "deployer", step: "send" },
        slack,
        post("deployer"),
      );
      const vera = await recordedWritesOf(wsId, run, { userId: "vera" });
      expect(vera.total).toBe(1);
      expect(vera.writes[0].body).toEqual(post("vera").body);
      expect((await recordedWritesOf(wsId, run)).total).toBe(2);
      expect(
        (await recordedWritesOf(wsId, run, { userId: "nobody" })).total,
      ).toBe(0);
    });

    it("adds the count, one page and a log line per step to a run's answer", async () => {
      setPgTestDb(db);
      const plain = {
        status: "COMPLETED",
        steps: [{ step: "send", logs: [] as string[] }],
      };
      expect(await withRecordedWrites(wsId, "run-none", plain)).toBe(plain);

      for (const [step, text] of [
        ["send", "a"],
        ["send", "b"],
        ["notify", "c"],
      ]) {
        await keepRecordedWrite(wsId, { runId: "run-steps", step }, slack, {
          ...post(text),
        });
      }
      const answered = await withRecordedWrites(wsId, "run-steps", {
        status: "COMPLETED",
        steps: [
          { step: "send", logs: [] as string[] },
          { step: "notify", logs: [] as string[] },
          { step: "other", logs: [] as string[] },
        ],
      });
      expect(answered.recordedWriteCount).toBe(3);
      expect(answered.recordedWrites).toHaveLength(3);
      expect(answered.recordedWritesNext).toBeUndefined();
      expect(answered.steps?.[0].logs).toEqual([
        "warn: 2 connection writes recorded, not sent (a dry run): see recordedWrites",
      ]);
      expect(answered.steps?.[1].logs).toEqual([
        "warn: 1 connection write recorded, not sent (a dry run): see recordedWrites",
      ]);
      expect(answered.steps?.[2].logs).toEqual([]);
    });

    it("answers a malformed workspace ID with nothing", async () => {
      setPgTestDb(db);
      expect(await recordedWritesOf("not-a-workspace", "run")).toEqual({
        total: 0,
        writes: [],
      });
      expect(
        await keepRecordedWrite(
          "not-a-workspace",
          { runId: "r" },
          slack,
          post("x"),
        ),
      ).toBe("failed");
    });

    it("reaps writes and run counters older than 7 days", async () => {
      const now = new Date();
      for (const [runId, age] of [
        ["run-old", 8],
        ["run-fresh", 6],
      ] as const) {
        await repo.appendWrite(
          {
            workspaceId: wsId,
            runId,
            connectionId: slack._id,
            connection: slack.name,
            request: post(runId),
          },
          MAX_RECORDED_PER_RUN,
        );
        const at = new Date(now.getTime() - age * DAY_MS).toISOString();
        await db.execute(
          sql`UPDATE workflow_recorded_runs SET at = ${at}::timestamptz WHERE run_id = ${runId}`,
        );
        await db.execute(
          sql`UPDATE workflow_recorded_writes SET at = ${at}::timestamptz WHERE run_id = ${runId}`,
        );
      }

      for (const table of [
        "workflow_recorded_writes",
        "workflow_recorded_runs",
      ]) {
        const rule = DEFAULT_PG_TTL_RULES.find(r => r.tableName === table);
        expect(rule).toMatchObject({
          timestampColumn: "at",
          olderThanMs: 7 * DAY_MS,
        });
        if (!rule) throw new Error(`Missing TTL rule for ${table}`);
        const result = await reapExpiredRows(rule, { db, now });
        expect(result.deleted).toBe(1);
        const left = await pg.query<{ run_id: string }>(
          `SELECT run_id FROM ${table}`,
        );
        expect(left.rows.map(r => r.run_id)).toEqual(["run-fresh"]);
      }
    });
  });

  describe("model catalog snapshots", () => {
    let repo: PgModelCatalogSnapshotsRepository;

    beforeAll(() => {
      repo = new PgModelCatalogSnapshotsRepository({ getDb: () => db });
    });

    afterEach(() => {
      resetPgTestDb();
    });

    it("upserts and reads all six snapshot ids", async () => {
      const at = new Date("2026-03-01T00:00:00Z");
      for (const id of MODEL_CATALOG_SNAPSHOT_IDS) {
        await repo.upsertSnapshot(id, {
          data: [{ id: `${id}-1` }],
          fetchedAt: at,
          itemCount: 1,
        });
      }
      const later = new Date("2026-03-02T00:00:00Z");
      await repo.upsertSnapshot("gateway-raw", {
        data: [{ id: "raw-1" }, { id: "raw-2" }],
        fetchedAt: later,
        itemCount: 2,
      });
      await repo.upsertSnapshot("capabilities", {
        data: { thinkingModes: { "anthropic/claude-x": "adaptive" } },
        fetchedAt: later,
        itemCount: 1,
      });

      const raw = await repo.findSnapshot("gateway-raw");
      expect(raw).toEqual({
        id: "gateway-raw",
        data: [{ id: "raw-1" }, { id: "raw-2" }],
        fetchedAt: later,
        itemCount: 2,
      });
      expect((await repo.findSnapshot("capabilities"))?.data).toEqual({
        thinkingModes: { "anthropic/claude-x": "adaptive" },
      });

      const many = await repo.findSnapshots(["gateway", "pricing", "curation"]);
      expect(many.map(s => s.id).sort()).toEqual([
        "curation",
        "gateway",
        "pricing",
      ]);
      expect(await repo.findSnapshots([])).toEqual([]);

      const count = await pg.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM model_catalog_snapshots",
      );
      expect(count.rows[0].n).toBe(6);
    });

    it("returns null for a missing snapshot and rejects an unknown id", async () => {
      expect(await repo.findSnapshot("arena")).toBeNull();
      await expect(
        pg.query(
          `INSERT INTO model_catalog_snapshots (id, data, fetched_at, item_count)
           VALUES ('bogus', '[]'::jsonb, now(), 0)`,
        ),
      ).rejects.toThrow(/model_catalog_snapshots_id_check/);
    });

    it("leaves the row alone when mutate returns null", async () => {
      expect(await repo.mutateSnapshot("capabilities", () => null)).toBe(false);
      expect(await repo.findSnapshot("capabilities")).toBeNull();
    });

    it("lands every concurrent locked read-modify-write", async () => {
      const keys = Array.from({ length: 8 }, (_, i) => `model-${i}`);
      const wrote = await Promise.all(
        keys.map(key =>
          repo.mutateSnapshot("capabilities", current => {
            const modes = {
              ...((current?.data as { thinkingModes?: Record<string, string> })
                ?.thinkingModes ?? {}),
              [key]: "manual",
            };
            return {
              data: { thinkingModes: modes },
              fetchedAt: new Date(),
              itemCount: Object.keys(modes).length,
            };
          }),
        ),
      );
      expect(wrote.every(Boolean)).toBe(true);
      const snap = await repo.findSnapshot("capabilities");
      const modes = (snap?.data as { thinkingModes: Record<string, string> })
        .thinkingModes;
      expect(Object.keys(modes).sort()).toEqual([...keys].sort());
      expect(snap?.itemCount).toBe(keys.length);
    });

    it("saveProbedThinkingMode merges into capabilities and skips a no-op", async () => {
      setPgTestDb(db);
      const { saveProbedThinkingMode } =
        await import("../../services/model-catalog.service");
      await repo.upsertSnapshot("capabilities", {
        data: { thinkingModes: { "anthropic/a": "adaptive", bad: "nope" } },
        fetchedAt: new Date("2026-01-01T00:00:00Z"),
        itemCount: 2,
      });
      await saveProbedThinkingMode("anthropic/b", "manual");
      const after = await repo.findSnapshot("capabilities");
      expect(after?.data).toEqual({
        thinkingModes: { "anthropic/a": "adaptive", "anthropic/b": "manual" },
      });
      expect(after?.itemCount).toBe(2);

      await saveProbedThinkingMode("anthropic/b", "manual");
      const again = await repo.findSnapshot("capabilities");
      expect(again?.fetchedAt.getTime()).toBe(after?.fetchedAt.getTime());
    });
  });

  describe("apps box policy", () => {
    let repo: PgAppsBoxPolicyRepository;

    beforeAll(() => {
      repo = new PgAppsBoxPolicyRepository({ getDb: () => db });
    });

    it("records the first start and keeps it", async () => {
      expect(await repo.readSince("activity-tracking")).toBeNull();
      const first = new Date("2026-04-01T00:00:00Z");
      expect(
        (await repo.ensureSince("activity-tracking", first)).getTime(),
      ).toBe(first.getTime());
      const second = new Date("2026-05-01T00:00:00Z");
      expect(
        (await repo.ensureSince("activity-tracking", second)).getTime(),
      ).toBe(first.getTime());
      expect((await repo.readSince("activity-tracking"))?.getTime()).toBe(
        first.getTime(),
      );
    });

    it("settles concurrent first calls on one start", async () => {
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          repo.ensureSince("race", new Date(Date.UTC(2026, 0, 1 + i))),
        ),
      );
      const distinct = new Set(results.map(d => d.getTime()));
      expect(distinct.size).toBe(1);
      const count = await pg.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM apps_box_policy WHERE id = 'race'",
      );
      expect(count.rows[0].n).toBe(1);
    });
  });
});
