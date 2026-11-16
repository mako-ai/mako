/**
 * Who app search names as an app's owner (app-discovery.service ownerOf).
 * Real Mako ids are 15 characters (auth.service.ts generateId); the old
 * ObjectId check named nobody for them, so search and the Apps home showed
 * no owner for every app a real user owned.
 */
import { describe, expect, it } from "vitest";
import { ownerOf } from "./app-discovery.service";

const REAL = "a1b2c3d4e5f6a7b";
const LEGACY = "65f0c0ffee0000000000abcd";
const workspace = { scope: "workspace" as const };
const personal = { scope: "private" as const, ownerId: REAL };

describe("app search owner", () => {
  it("names a 15-character owner_id", () => {
    expect(ownerOf(workspace, { owner_id: REAL, createdBy: "" })).toBe(REAL);
  });

  it("still names a legacy 24-hex owner", () => {
    expect(ownerOf(workspace, { owner_id: LEGACY, createdBy: "" })).toBe(
      LEGACY,
    );
  });

  it("falls back to a 15-character createdBy", () => {
    expect(ownerOf(workspace, { createdBy: REAL })).toBe(REAL);
  });

  it.each(["system", "publish", "api-key", "scheduler", "app-chat", ""])(
    "names nobody for %j",
    sentinel => {
      expect(ownerOf(workspace, { owner_id: sentinel, createdBy: "" })).toBe(
        undefined,
      );
    },
  );

  it("uses the personal tree's owner when the row names no person", () => {
    expect(ownerOf(personal, { owner_id: "", createdBy: "system" })).toBe(REAL);
    expect(ownerOf(personal, undefined)).toBe(REAL);
    expect(ownerOf(workspace, undefined)).toBeUndefined();
  });
});
