import { createHash, randomBytes } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate as drizzlePgliteMigrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  hasDirectPostgresConfig,
  hasPostgresConfig,
  isLocalPostgres,
  resetPgTestDb,
  resolvePgDriver,
} from "./client";
import {
  generateObjectIdHex,
  generateUuidv7,
  isObjectIdHex,
  isObjectIdUuid,
  isUuidv7,
  legacyUserIdToUuidv7,
  MAX_UUIDV7_TS_MS,
  newDualId,
  normalizeEntityId,
  objectIdToUuid,
  objectIdUuidTimestamp,
  optionalObjectIdToUuid,
  optionalToWireId,
  parseEntityId,
  toWireId,
  uuidToObjectId,
  uuidv7Timestamp,
} from "./id-codec";
import {
  checkMigrationsFolder,
  resolveMigrationsFolder,
  runPgliteMigrations,
} from "./migrate";
import { createTestPglite } from "./test-pglite";

const TEST_VECTORS = [
  {
    oid: "000000000000000000000000",
    uuid: "00000000-0000-86d0-a000-000000000000",
    iso: "1970-01-01T00:00:00.000Z",
  },
  {
    oid: "6745f6f4a1b2c3d4e5f60718",
    uuid: "0193694c-a920-86da-a1b2-c3d4e5f60718",
    iso: "2024-11-26T16:27:32.000Z",
  },
  {
    oid: "692741140000000000000000",
    uuid: "019ac156-3620-86d0-a000-000000000000",
    iso: "2025-11-26T18:04:04.000Z",
  },
  {
    oid: "69274114ffffffffffffffff",
    uuid: "019ac156-3620-86df-afff-ffffffffffff",
    iso: "2025-11-26T18:04:04.000Z",
  },
  {
    // Arbitrary SHA-1 prefix (simulates derivedAppId / derivedConsoleId with bit 31 = 1)
    oid: "deadbeefcafebabe01234567",
    uuid: "0365d6b1-d598-86dc-aafe-babe01234567",
    iso: "2088-05-20T21:55:59.000Z",
  },
  {
    oid: "ffffffffffffffffffffffff",
    uuid: "03e7ffff-fc18-86df-afff-ffffffffffff",
    iso: "2106-02-07T06:28:15.000Z",
  },
] as const;

describe("id-codec (RFC 9562 UUIDv8 bijection)", () => {
  let pg: PGlite;

  beforeAll(async () => {
    pg = createTestPglite();
    await runPgliteMigrations(pg);
  });

  afterAll(async () => {
    await pg.close();
  });

  it("matches golden boundary vectors and passes Zod v4 uuid validation", () => {
    for (const v of TEST_VECTORS) {
      const encoded = objectIdToUuid(v.oid);
      expect(encoded).toBe(v.uuid);
      expect(isObjectIdUuid(encoded)).toBe(true);
      expect(uuidToObjectId(encoded)).toBe(v.oid);
      expect(objectIdUuidTimestamp(encoded)?.toISOString()).toBe(v.iso);
      expect(toWireId(encoded)).toBe(v.oid);

      // Uppercase input normalization
      expect(objectIdToUuid(v.oid.toUpperCase())).toBe(v.uuid);
      expect(uuidToObjectId(v.uuid.toUpperCase())).toBe(v.oid);

      // Zod v4 strict RFC 9562 UUID acceptance
      expect(z.uuid().safeParse(encoded).success).toBe(true);
      expect(z.string().uuid().safeParse(encoded).success).toBe(true);
    }
  });

  it("handles SHA-1 derivedAppId / derivedConsoleId arbitrary 96-bit patterns", () => {
    for (let i = 0; i < 200; i++) {
      const sha1Prefix = createHash("sha1")
        .update(`apps:6745f6f4a1b2c3d4e5f60718:folder-${i}`)
        .digest("hex")
        .slice(0, 24);
      const u = objectIdToUuid(sha1Prefix);
      expect(isObjectIdUuid(u)).toBe(true);
      expect(uuidToObjectId(u)).toBe(sha1Prefix);
      expect(z.uuid().safeParse(u).success).toBe(true);
    }
  });

  it("preserves strict lexicographic order across 5,000 random & same-second pairs", () => {
    const oids: string[] = [];
    for (let i = 0; i < 4_000; i++) {
      oids.push(randomBytes(12).toString("hex"));
    }
    // Same-second ties exercising P0..P15 ordering across group 3/4/5 boundaries
    for (let i = 0; i < 1_000; i++) {
      oids.push("69274114" + randomBytes(8).toString("hex"));
    }

    const sortedByOid = [...oids].sort();
    const sortedByUuid = [...oids].sort((a, b) =>
      objectIdToUuid(a).localeCompare(objectIdToUuid(b)),
    );

    expect(sortedByUuid).toEqual(sortedByOid);
    for (const oid of sortedByOid) {
      expect(uuidToObjectId(objectIdToUuid(oid))).toBe(oid);
    }
  });

  it("interleaves chronologically with native UUIDv7 and rejects non-subspace UUIDs with 0% false positives", () => {
    const nativeV4 = "550e8400-e29b-41d4-a716-446655440000";
    // Same timestamp (ts_ms % 1000 == 0), same 6d + a nibbles, but version = 7!
    const nativeV7 = "019ac156-3620-76d0-a123-456789abcdef";
    const nativeV7NextMs = "019ac156-3621-7000-8000-000000000000";
    const badMod1000 = "019ac156-3621-86d0-a123-456789abcdef";
    const badMagicHi = "019ac156-3620-86e0-a123-456789abcdef";
    const badMagicLo = "019ac156-3620-86d0-8123-456789abcdef";
    const overflow = "03e80000-0000-86d0-a123-456789abcdef"; // > 0xffffffff * 1000

    for (const bad of [
      nativeV4,
      nativeV7,
      nativeV7NextMs,
      badMod1000,
      badMagicHi,
      badMagicLo,
      overflow,
      "not-a-uuid",
    ]) {
      expect(isObjectIdUuid(bad)).toBe(false);
      expect(() => uuidToObjectId(bad)).toThrow();
      expect(objectIdUuidTimestamp(bad)).toBeNull();
    }

    // ObjectId at second 0x69274114 (ts_ms = 0x019ac1563620) sorts strictly before UUIDv7 at ts_ms + 1ms
    const mappedEndOfSec = objectIdToUuid("69274114ffffffffffffffff");
    expect(mappedEndOfSec < nativeV7NextMs).toBe(true);

    // toWireId preserves native UUIDv7/v4 verbatim
    expect(toWireId(nativeV7.toUpperCase())).toBe(nativeV7);
    expect(toWireId(nativeV4)).toBe(nativeV4);
  });

  it("rejects Mongoose 12-char ASCII footgun and parses both ObjectId and UUID inputs cleanly", () => {
    expect(isObjectIdHex("hello world!")).toBe(false);
    expect(isObjectIdHex("6745f6f4a1b2c3d4e5f6071")).toBe(false);
    expect(isObjectIdHex("6745f6f4a1b2c3d4e5f6071g")).toBe(false);
    expect(() => objectIdToUuid("hello world!")).toThrow();

    const v = TEST_VECTORS[1];
    expect(parseEntityId(v.oid.toUpperCase())).toEqual({
      oid: v.oid,
      uuid: v.uuid,
    });
    expect(parseEntityId(v.uuid.toUpperCase())).toEqual({
      oid: v.oid,
      uuid: v.uuid,
    });
    expect(parseEntityId("019ac156-3620-76d0-a123-456789abcdef")).toEqual({
      oid: null,
      uuid: "019ac156-3620-76d0-a123-456789abcdef",
    });
    expect(parseEntityId("hello world!")).toBeNull();
    expect(parseEntityId(null)).toBeNull();

    expect(optionalObjectIdToUuid(null)).toBeNull();
    expect(optionalObjectIdToUuid(undefined)).toBeNull();
    expect(optionalObjectIdToUuid(v.oid)).toBe(v.uuid);
    expect(optionalToWireId(null)).toBeNull();
    expect(optionalToWireId(v.uuid)).toBe(v.oid);
  });

  it("mints monotonic, unique dual IDs inside the ObjectId subspace", () => {
    const fixedNow = Date.UTC(2026, 10, 26, 18, 0, 0);
    const seen = new Set<string>();
    let prevUuid = "";
    for (let i = 0; i < 100; i++) {
      const dual = newDualId(fixedNow);
      expect(isObjectIdHex(dual.oid)).toBe(true);
      expect(isObjectIdUuid(dual.uuid)).toBe(true);
      expect(uuidToObjectId(dual.uuid)).toBe(dual.oid);
      expect(seen.has(dual.oid)).toBe(false);
      seen.add(dual.oid);
      if (prevUuid) {
        expect(dual.uuid > prevUuid).toBe(true);
      }
      prevUuid = dual.uuid;
    }

    const standalone = generateObjectIdHex(fixedNow);
    expect(isObjectIdHex(standalone)).toBe(true);
  });

  it("achieves 100% parity with Postgres SQL codec functions in PGlite", async () => {
    for (const v of TEST_VECTORS) {
      const res = await pg.query<{
        u: string;
        is_oid: boolean;
        back: string;
        ts_epoch: number;
      }>(
        `SELECT
          objectid_to_uuid($1)::text AS u,
          is_objectid_uuid(objectid_to_uuid($1)) AS is_oid,
          uuid_to_objectid(objectid_to_uuid($1)) AS back,
          extract(epoch FROM objectid_uuid_timestamp(objectid_to_uuid($1)))::double precision AS ts_epoch`,
        [v.oid],
      );
      const row = res.rows[0];
      expect(row.u).toBe(v.uuid);
      expect(row.is_oid).toBe(true);
      expect(row.back).toBe(v.oid);
      expect(row.ts_epoch * 1000).toBe(new Date(v.iso).getTime());
    }

    // Verify Postgres B-tree ordering matches ObjectId order
    const ordered = await pg.query<{ oid: string }>(
      `SELECT oid FROM (VALUES ${TEST_VECTORS.map(v => `('${v.oid}')`).join(",")}) AS t(oid)
       ORDER BY objectid_to_uuid(oid) ASC`,
    );
    expect(ordered.rows.map(r => r.oid)).toEqual(TEST_VECTORS.map(v => v.oid));

    // Verify SQL rejection of native UUIDv4 / UUIDv7 / overflow / non-mod-1000
    const neg = await pg.query<{
      v4: boolean;
      v7: boolean;
      bad_mod: boolean;
      overflow: boolean;
      gen_ok: boolean;
      gen_oid: string;
    }>(`
      SELECT
        is_objectid_uuid('550e8400-e29b-41d4-a716-446655440000'::uuid) AS v4,
        is_objectid_uuid('019ac156-3620-76d0-a123-456789abcdef'::uuid) AS v7,
        is_objectid_uuid('019ac156-3621-86d0-a123-456789abcdef'::uuid) AS bad_mod,
        is_objectid_uuid('03e80000-0000-86d0-a123-456789abcdef'::uuid) AS overflow,
        is_objectid_uuid(generate_objectid_uuid()) AS gen_ok,
        uuid_to_objectid(generate_objectid_uuid()) AS gen_oid
    `);
    expect(neg.rows[0].v4).toBe(false);
    expect(neg.rows[0].v7).toBe(false);
    expect(neg.rows[0].bad_mod).toBe(false);
    expect(neg.rows[0].overflow).toBe(false);
    expect(neg.rows[0].gen_ok).toBe(true);
    expect(isObjectIdHex(neg.rows[0].gen_oid)).toBe(true);

    // Invalid input raises 22P02
    await expect(
      pg.query(`SELECT objectid_to_uuid('hello world!')`),
    ).rejects.toThrow(/Invalid MongoDB ObjectId/);
    await expect(
      pg.query(
        `SELECT uuid_to_objectid('550e8400-e29b-41d4-a716-446655440000'::uuid)`,
      ),
    ).rejects.toThrow(/UUID is not in ObjectId subspace/);
  });

  it("validates driver resolution, IPv6 localhost, config guards, normalizeEntityId, and real Drizzle migrator idempotency", async () => {
    expect(isLocalPostgres("postgresql://mako:mako@localhost:5433/mako")).toBe(
      true,
    );
    expect(isLocalPostgres("postgresql://mako:mako@[::1]:5433/mako")).toBe(
      true,
    );
    expect(isLocalPostgres("postgresql://mako:mako@127.0.0.1:5433/mako")).toBe(
      true,
    );
    expect(
      isLocalPostgres("postgresql://u:p@ep-cool-pooler.neon.tech/db"),
    ).toBe(false);
    expect(
      resolvePgDriver("postgresql://mako:mako@[::1]:5433/mako", "neon-ws"),
    ).toBe("postgres");
    expect(
      resolvePgDriver(
        "postgresql://u:p@ep-cool-pooler.neon.tech/db",
        "neon-ws",
      ),
    ).toBe("neon-ws");
    expect(
      resolvePgDriver(
        "postgresql://u:p@ep-cool-pooler.neon.tech/db",
        undefined,
      ),
    ).toBe("postgres");

    // normalizeEntityId lowercases UUID/ObjectId hex but preserves case-sensitive base64url text PKs
    expect(normalizeEntityId("6745F6F4A1B2C3D4E5F60718")).toBe(
      "6745f6f4a1b2c3d4e5f60718",
    );
    expect(normalizeEntityId("0193694C-A920-86DA-A1B2-C3D4E5F60718")).toBe(
      "0193694c-a920-86da-a1b2-c3d4e5f60718",
    );
    const b64url = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AaBbC";
    expect(normalizeEntityId(b64url)).toBe(b64url);

    // hasPostgresConfig() must NOT return true when only POSTGRES_DIRECT_URL is set
    const prevUrl = process.env.POSTGRES_URL;
    const prevDirect = process.env.POSTGRES_DIRECT_URL;
    resetPgTestDb();
    try {
      delete process.env.POSTGRES_URL;
      process.env.POSTGRES_DIRECT_URL =
        "postgresql://mako:mako@localhost:5433/mako";
      expect(hasPostgresConfig()).toBe(false);
      expect(hasDirectPostgresConfig()).toBe(true);

      process.env.POSTGRES_URL = "postgresql://mako:mako@localhost:5433/mako";
      expect(hasPostgresConfig()).toBe(true);
    } finally {
      if (prevUrl === undefined) delete process.env.POSTGRES_URL;
      else process.env.POSTGRES_URL = prevUrl;
      if (prevDirect === undefined) delete process.env.POSTGRES_DIRECT_URL;
      else process.env.POSTGRES_DIRECT_URL = prevDirect;
    }

    const info = checkMigrationsFolder();
    expect(info.count).toBeGreaterThanOrEqual(2);
    expect(info.tags).toContain("0000_objectid_uuid_codec");
    expect(info.tags).toContain("0001_migration_control_plane");

    // Verify real Drizzle migrator applies _journal.json cleanly and idempotently
    const freshPg = createTestPglite();
    try {
      const freshDb = drizzle(freshPg);
      const migrationsFolder = resolveMigrationsFolder();
      await drizzlePgliteMigrate(freshDb, { migrationsFolder });
      // Second run must be a clean idempotent no-op
      await drizzlePgliteMigrate(freshDb, { migrationsFolder });

      const check = await freshPg.query<{ ok: boolean }>(
        `SELECT uuid_to_objectid(objectid_to_uuid('6745f6f4a1b2c3d4e5f60718')) = '6745f6f4a1b2c3d4e5f60718' AS ok`,
      );
      expect(check.rows[0].ok).toBe(true);

      // Verify createTestPglite() preloads pgvector and pg_trgm extensions
      await freshPg.exec(`
        CREATE EXTENSION IF NOT EXISTS vector;
        CREATE EXTENSION IF NOT EXISTS pg_trgm;
      `);
      const extCheck = await freshPg.query<{ sim: number; vec: string }>(
        `SELECT similarity('mako', 'mako') AS sim, '[1,2,3]'::vector::text AS vec`,
      );
      expect(extCheck.rows[0].sim).toBe(1);
      expect(extCheck.rows[0].vec).toBe("[1,2,3]");
    } finally {
      await freshPg.close();
    }
  });

  it("generates monotonic RFC 9562 UUIDv7s disjoint from ObjectId UUIDv8s", async () => {
    const fixedMs = Date.UTC(2026, 10, 26, 22, 15, 30, 456);
    const seen = new Set<string>();
    let prev = "";
    for (let i = 0; i < 200; i++) {
      const id = generateUuidv7(fixedMs);
      expect(isUuidv7(id)).toBe(true);
      expect(isObjectIdUuid(id)).toBe(false);
      expect(z.uuid().safeParse(id).success).toBe(true);
      expect(uuidv7Timestamp(id)?.getTime()).toBe(fixedMs);
      expect(seen.has(id)).toBe(false);
      seen.add(id);
      if (prev) {
        expect(id > prev).toBe(true);
      }
      prev = id;
    }

    // Explicit future/epoch-0 timestamps must NOT poison or reset default wall-clock calls
    const futureMs = Date.UTC(2035, 0, 1);
    const futureId = generateUuidv7(futureMs);
    expect(uuidv7Timestamp(futureId)?.getTime()).toBe(futureMs);

    const beforeClock = Date.now();
    const now1 = generateUuidv7();
    const now2 = generateUuidv7();
    const afterClock = Date.now();
    expect(isUuidv7(now1)).toBe(true);
    expect(isUuidv7(now2)).toBe(true);
    expect(now2 > now1).toBe(true);
    const now1Ms = uuidv7Timestamp(now1)?.getTime() ?? -1;
    expect(now1Ms).toBeGreaterThanOrEqual(beforeClock);
    expect(now1Ms).toBeLessThanOrEqual(afterClock + 1);

    // Explicit epoch-0 call between wall-clock calls must not break wall-clock monotonicity
    const epochId = generateUuidv7(0);
    expect(isUuidv7(epochId)).toBe(true);
    expect(epochId.startsWith("00000000-0000-7")).toBe(true);
    expect(uuidv7Timestamp(epochId)?.getTime()).toBe(0);
    const now3 = generateUuidv7();
    expect(now3 > now2).toBe(true);

    const pgCheck = await pg.query<{ u: string; is_oid: boolean }>(
      `SELECT $1::uuid::text AS u, is_objectid_uuid($1::uuid) AS is_oid`,
      [now1],
    );
    expect(pgCheck.rows[0]).toEqual({ u: now1, is_oid: false });

    // Rejects invalid timestamps and non-v7 UUIDs
    expect(() => generateUuidv7(-1)).toThrow(RangeError);
    expect(() => generateUuidv7(Number.NaN)).toThrow(RangeError);
    expect(() => generateUuidv7(MAX_UUIDV7_TS_MS + 1)).toThrow(RangeError);

    expect(isUuidv7("550e8400-e29b-41d4-a716-446655440000")).toBe(false); // v4
    expect(isUuidv7("0193694c-a920-86da-a1b2-c3d4e5f60718")).toBe(false); // ObjectId v8
    expect(isUuidv7("0193694c-a920-76da-01b2-c3d4e5f60718")).toBe(false); // bad variant nibble 0
    expect(isUuidv7("not-a-uuid")).toBe(false);
    expect(isUuidv7(null)).toBe(false);
    expect(uuidv7Timestamp("550e8400-e29b-41d4-a716-446655440000")).toBeNull();
  });

  it("deterministically maps legacy user IDs (Lucia 15-char & UUIDv4) to RFC 9562 UUIDv7", async () => {
    const createdAt = new Date("2025-03-14T09:26:53.589Z");
    const luciaId = "a1b2c3d4e5f6g7h";
    const legacyV4 = "550e8400-e29b-41d4-a716-446655440000";

    const uLucia1 = legacyUserIdToUuidv7(luciaId, createdAt);
    const uLucia2 = legacyUserIdToUuidv7(luciaId, createdAt.getTime());
    expect(uLucia1).toBe(uLucia2);
    expect(isUuidv7(uLucia1)).toBe(true);
    expect(isObjectIdUuid(uLucia1)).toBe(false);
    expect(z.uuid().safeParse(uLucia1).success).toBe(true);
    expect(uuidv7Timestamp(uLucia1)?.toISOString()).toBe(
      createdAt.toISOString(),
    );

    // Exact bit-level verification against SHA-256(legacyId)
    const digest = createHash("sha256").update(luciaId, "utf8").digest();
    const expectedHex = Buffer.allocUnsafe(16);
    expectedHex.writeUIntBE(createdAt.getTime(), 0, 6);
    expectedHex[6] = 0x70 | (digest[0] & 0x0f);
    expectedHex[7] = digest[1];
    expectedHex[8] = 0x80 | (digest[2] & 0x3f);
    digest.copy(expectedHex, 9, 3, 10);
    const h = expectedHex.toString("hex");
    expect(uLucia1).toBe(
      `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`,
    );

    // Missing or invalid createdAt falls back to epoch 0 deterministically
    const noDate = legacyUserIdToUuidv7(luciaId);
    expect(isUuidv7(noDate)).toBe(true);
    expect(noDate.startsWith("00000000-0000-7")).toBe(true);
    expect(legacyUserIdToUuidv7(luciaId, null)).toBe(noDate);
    expect(legacyUserIdToUuidv7(luciaId, new Date("invalid"))).toBe(noDate);
    expect(legacyUserIdToUuidv7(luciaId, -5000)).toBe(noDate);

    // Case-sensitive legacy IDs stay distinct
    expect(legacyUserIdToUuidv7("AbCdEfGhIjKlMnO", createdAt)).not.toBe(
      legacyUserIdToUuidv7("abcdefghijklmno", createdAt),
    );

    // Legacy UUIDv4 gets a valid UUIDv7 distinct from itself and from ObjectId UUIDv8
    const uV4 = legacyUserIdToUuidv7(legacyV4, createdAt);
    expect(isUuidv7(uV4)).toBe(true);
    expect(uV4).not.toBe(legacyV4);

    // Earlier createdAt sorts strictly before later createdAt in Postgres B-tree order
    const uEarlier = legacyUserIdToUuidv7(
      "user-earlier",
      new Date("2024-01-01T00:00:00.000Z"),
    );
    const uLater = legacyUserIdToUuidv7(
      "user-later",
      new Date("2025-01-01T00:00:00.000Z"),
    );
    const pgOrd = await pg.query<{ lt: boolean; is_oid: boolean }>(
      `SELECT ($1::uuid < $2::uuid) AS lt, is_objectid_uuid($1::uuid) AS is_oid`,
      [uEarlier, uLater],
    );
    expect(pgOrd.rows[0]).toEqual({ lt: true, is_oid: false });

    // Reject empty string
    expect(() => legacyUserIdToUuidv7("")).toThrow();
  });
});
