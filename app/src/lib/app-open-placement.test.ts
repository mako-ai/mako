import { describe, expect, it } from "vitest";
import {
  notePlacement,
  PLACEMENT_TTL_MS,
  takePlacement,
} from "./app-open-placement";

describe("app open placement", () => {
  const p = { surface: "home", shelf: "recommended", position: 7 } as const;

  it("hands a click's placement to the next open, once", () => {
    notePlacement("a", p, 1_000);
    expect(takePlacement("a", 2_000)).toEqual(p);
    expect(takePlacement("a", 2_000)).toBeUndefined();
  });

  it("never credits a stale click", () => {
    notePlacement("b", p, 0);
    expect(takePlacement("b", PLACEMENT_TTL_MS + 1)).toBeUndefined();
  });

  it("keeps apps apart", () => {
    notePlacement("c", p, 0);
    expect(takePlacement("d", 1)).toBeUndefined();
    expect(takePlacement("c", 1)).toEqual(p);
  });
});
