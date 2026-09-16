/**
 * The client folder-name rule must equal the server's `isSafeSegment`
 * (api/src/apps/app-paths.ts): Unicode letters and digits, no slashes, no
 * leading dot, no trailing dot or space, at most 100 characters.
 */
import { describe, expect, it } from "vitest";
import { isValidFolderName } from "./AppFolderDialogs";

describe("isValidFolderName", () => {
  it("accepts what git and a URL accept, Unicode included", () => {
    expect(isValidFolderName("Sales")).toBe(true);
    expect(isValidFolderName("Café")).toBe(true);
    expect(isValidFolderName("日本語 report")).toBe(true);
    expect(isValidFolderName("daily tracker v2")).toBe(true);
    expect(isValidFolderName("a.b-c_d")).toBe(true);
  });

  it("refuses names the server would refuse", () => {
    expect(isValidFolderName("")).toBe(false);
    expect(isValidFolderName("   ")).toBe(false);
    expect(isValidFolderName("a/b")).toBe(false);
    expect(isValidFolderName(".hidden")).toBe(false);
    expect(isValidFolderName(".")).toBe(false);
    expect(isValidFolderName("..")).toBe(false);
    expect(isValidFolderName("ends.")).toBe(false);
    expect(isValidFolderName("x".repeat(101))).toBe(false);
    expect(isValidFolderName("-leading-dash")).toBe(false);
  });
});
