import { describe, expect, it } from "vitest";
import {
  LOCAL_OVERLAY_MAX_FILE_BYTES,
  LocalOverlayError,
  applyLocalOverlay,
  normalizeLocalOverlay,
} from "./local-overlay";

const SHA = "a".repeat(40);

describe("normalizeLocalOverlay", () => {
  it("accepts a diff over a base commit", () => {
    expect(
      normalizeLocalOverlay({
        baseSha: SHA,
        files: { "models/a.sql": "select 1" },
        deletes: ["models/gone.sql", "models/gone.sql"],
      }),
    ).toEqual({
      baseSha: SHA,
      files: { "models/a.sql": "select 1" },
      deletes: ["models/gone.sql"],
    });
  });

  it("accepts a whole tree without a base, and only a whole tree", () => {
    expect(
      normalizeLocalOverlay({ files: { "dbt_project.yml": "name: x" } }),
    ).toEqual({ files: { "dbt_project.yml": "name: x" }, deletes: [] });
    expect(() =>
      normalizeLocalOverlay({ files: { "models/a.sql": "select 1" } }),
    ).toThrow(/whole dbt\/ tree/);
    expect(() =>
      normalizeLocalOverlay({
        files: { "dbt_project.yml": "name: x" },
        deletes: ["models/a.sql"],
      }),
    ).toThrow(/need a baseSha/);
  });

  it.each([
    "../escape.sql",
    "/etc/passwd",
    "models//a.sql",
    ".git/config",
    "models\\a.sql",
  ])("refuses the unsafe path %s", path => {
    expect(() =>
      normalizeLocalOverlay({ baseSha: SHA, files: { [path]: "x" } }),
    ).toThrow(LocalOverlayError);
  });

  it("refuses short or non-hex base shas (they would reach git argv)", () => {
    expect(() =>
      normalizeLocalOverlay({ baseSha: "abc123", files: {} }),
    ).toThrow(/40-character/);
    expect(() =>
      normalizeLocalOverlay({ baseSha: "--upload-pack=x", files: {} }),
    ).toThrow(/40-character/);
  });

  it("refuses non-text content and oversized files", () => {
    expect(() =>
      normalizeLocalOverlay({ baseSha: SHA, files: { "a.sql": 1 } }),
    ).toThrow(/must be text/);
    expect(() =>
      normalizeLocalOverlay({
        baseSha: SHA,
        files: { "a.csv": "x".repeat(LOCAL_OVERLAY_MAX_FILE_BYTES + 1) },
      }),
    ).toThrow(/per-file limit/);
  });
});

describe("applyLocalOverlay", () => {
  it("lays the checkout over the base: edits win, deletes go, new files join", () => {
    expect(
      applyLocalOverlay(
        [
          { path: "models/a.sql", content: "select 1" },
          { path: "models/b.sql", content: "select 2" },
          { path: "models/gone.sql", content: "select 3" },
        ],
        {
          files: { "models/a.sql": "select 10", "models/new.sql": "select 4" },
          deletes: ["models/gone.sql"],
        },
      ),
    ).toEqual([
      { path: "models/a.sql", content: "select 10" },
      { path: "models/b.sql", content: "select 2" },
      { path: "models/new.sql", content: "select 4" },
    ]);
  });
});
