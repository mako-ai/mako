/**
 * BoundedMap: the LRU size cap and the TTL that the module-level caches
 * (console definitions, author lookups, throttle stamps) rely on.
 *
 * Run: tsx src/utils/bounded-map.test.ts
 */
import assert from "node:assert/strict";
import { BoundedMap } from "./bounded-map";

// Size cap evicts the least recently USED entry, not the oldest inserted.
{
  const map = new BoundedMap<string, number>({ maxEntries: 2 });
  map.set("a", 1).set("b", 2);
  assert.equal(map.get("a"), 1); // touch a: b is now least recently used
  map.set("c", 3);
  assert.equal(map.size, 2);
  assert.equal(map.has("b"), false, "b was least recently used");
  assert.equal(map.get("a"), 1);
  assert.equal(map.get("c"), 3);
}

// Re-setting a key refreshes it and does not grow the map.
{
  const map = new BoundedMap<string, number>({ maxEntries: 2 });
  map.set("a", 1).set("b", 2).set("a", 10).set("c", 3);
  assert.equal(map.get("a"), 10);
  assert.equal(map.has("b"), false);
}

// TTL: an expired entry reads as absent and is dropped.
{
  let now = 1_000;
  const map = new BoundedMap<string, number>({
    maxEntries: 10,
    ttlMs: 100,
    now: () => now,
  });
  map.set("a", 1);
  now += 99;
  assert.equal(map.get("a"), 1);
  now += 1;
  assert.equal(map.has("a"), false);
  assert.equal(map.get("a"), undefined);
  assert.equal(map.size, 0);
}

// `undefined` is a cacheable value (negative lookups), told apart by has().
{
  const map = new BoundedMap<string, string | undefined>({ maxEntries: 2 });
  map.set("missing", undefined);
  assert.equal(map.has("missing"), true);
  assert.equal(map.get("missing"), undefined);
  assert.equal(map.delete("missing"), true);
  assert.equal(map.has("missing"), false);
}

assert.throws(() => new BoundedMap({ maxEntries: 0 }), /maxEntries/);

// eslint-disable-next-line no-console
console.log("bounded-map tests passed");
