/* eslint-disable no-console, no-process-exit */
/**
 * Unit tests for the deterministic ObjectId <-> uuid conversion.
 *
 * Run with: tsx src/db/ids.test.ts
 */
import assert from "node:assert/strict";

import {
  isObjectIdDerivedUuid,
  isObjectIdHex,
  isUuid,
  objectIdToUuid,
  toPgId,
  toPgIdOrNull,
  uuidToObjectId,
} from "./ids";

function testKnownVector() {
  const oid = "507f1f77bcf86cd799439011";
  const uuid = objectIdToUuid(oid);
  assert.equal(uuid, "507f1f77-bcf8-6cd7-9943-901100000000");
  assert.equal(uuidToObjectId(uuid), oid);
  assert.ok(isUuid(uuid), "produced value must be a canonical uuid");
}

function testRoundTrip() {
  // Deterministic pseudo-ObjectIds across the full hex range.
  for (let i = 0; i < 2000; i++) {
    const oid = i.toString(16).padStart(24, "0").slice(0, 24);
    const uuid = objectIdToUuid(oid);
    assert.equal(uuidToObjectId(uuid), oid, `round-trip failed for ${oid}`);
    assert.ok(isObjectIdDerivedUuid(uuid));
  }
}

function testDeterministic() {
  const oid = "65b8f1a2c3d4e5f600112233";
  assert.equal(objectIdToUuid(oid), objectIdToUuid(oid));
}

function testOrderingPreserved() {
  // ObjectIds with ascending timestamp prefixes must yield ascending uuids,
  // so created-at ordering survives the conversion.
  const a = objectIdToUuid("000000010000000000000000");
  const b = objectIdToUuid("000000020000000000000000");
  assert.ok(a < b, "uuid ordering must follow ObjectId ordering");
}

function testCaseInsensitiveAndUppercase() {
  const oid = "AABBCCDDEEFF001122334455";
  const uuid = objectIdToUuid(oid);
  assert.equal(uuid, "aabbccdd-eeff-0011-2233-445500000000");
  assert.equal(uuidToObjectId(uuid), oid.toLowerCase());
}

function testToPgIdPassthroughForUuid() {
  const userUuid = "11111111-2222-4333-8444-555566667777";
  assert.equal(toPgId(userUuid), userUuid);
  assert.ok(
    !isObjectIdDerivedUuid(userUuid),
    "real uuid is not ObjectId-derived",
  );
}

function testToPgIdConvertsObjectId() {
  const oid = "507f191e810c19729de860ea";
  assert.equal(toPgId(oid), objectIdToUuid(oid));
}

function testToPgIdHashesLegacyIds() {
  // Legacy nanoid / sentinel ids hash to a stable, valid uuid (UUIDv5).
  const nanoid = "165tpi4r5ozyuv9";
  const mapped = toPgId(nanoid);
  assert.ok(isUuid(mapped), "legacy id must map to a valid uuid");
  assert.equal(toPgId(nanoid), mapped, "hashing must be deterministic");
  // Distinct legacy ids map to distinct uuids; references resolve consistently.
  assert.notEqual(toPgId("system"), toPgId("agent"));
  assert.equal(toPgId("system"), toPgId("system"));
  // Hashed uuids are not ObjectId-derived (so they aren't reversed by mistake).
  assert.ok(!isObjectIdDerivedUuid(mapped));
}

function testToPgIdOrNull() {
  assert.equal(toPgIdOrNull(null), null);
  assert.equal(toPgIdOrNull(undefined), null);
  assert.equal(toPgIdOrNull(""), null);
  assert.equal(
    toPgIdOrNull("507f1f77bcf86cd799439011"),
    "507f1f77-bcf8-6cd7-9943-901100000000",
  );
}

function testRejections() {
  assert.throws(() => objectIdToUuid("xyz"), /valid ObjectId/);
  assert.throws(() => uuidToObjectId("not-a-uuid"), /valid uuid/);
  // A genuine v4 uuid is not ObjectId-derived (trailing bytes non-zero).
  assert.throws(
    () => uuidToObjectId("11111111-2222-4333-8444-555566667777"),
    /not derived from an ObjectId/,
  );
}

function testPredicates() {
  assert.ok(isObjectIdHex("507f1f77bcf86cd799439011"));
  assert.ok(!isObjectIdHex("507f1f77bcf86cd79943901")); // 23 chars
  assert.ok(isUuid("507f1f77-bcf8-6cd7-9943-901100000000"));
  assert.ok(!isUuid("507f1f77bcf86cd799439011"));
}

function main() {
  testKnownVector();
  testRoundTrip();
  testDeterministic();
  testOrderingPreserved();
  testCaseInsensitiveAndUppercase();
  testToPgIdPassthroughForUuid();
  testToPgIdConvertsObjectId();
  testToPgIdHashesLegacyIds();
  testToPgIdOrNull();
  testRejections();
  testPredicates();
  console.log(
    "ids.test: OK — ObjectId<->uuid conversion is reversible & deterministic",
  );
  process.exit(0);
}

main();
