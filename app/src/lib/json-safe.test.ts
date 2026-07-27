import { describe, expect, it } from "vitest";
import { safeStringify } from "./json-safe";

describe("safeStringify", () => {
  it("serializes bigint values", () => {
    expect(safeStringify({ count: 9_007_199_254_740_993n })).toBe(
      '{"count":"9007199254740993"}',
    );
  });

  it("serializes circular objects and arrays without throwing", () => {
    const object: Record<string, unknown> = {};
    object.self = object;
    const array: unknown[] = [];
    array.push(array);
    const map = new Map<string, unknown>();
    map.set("self", map);
    const set = new Set<unknown>();
    set.add(set);

    expect(safeStringify({ object, array, map, set })).toBe(
      '{"object":{"self":"[Circular]"},"array":["[Circular]"],"map":{"self":"[Circular]"},"set":["[Circular]"]}',
    );
  });
});
