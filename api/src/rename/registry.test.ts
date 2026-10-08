/**
 * The rules every kind shares, enforced above the handlers: the no-op
 * answer, and the per-kind agent grants of `rename_object`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { RENAME_HANDLERS, renameObject } from "./registry";
import type { RenameHandler } from "./types";
import { missingInputConditionalGrant } from "../agent-lib/capabilities/runtime";

const ctx = { workspaceId: "66f000000000000000000001", userId: "u1" };

describe("renameObject", () => {
  const original = { ...RENAME_HANDLERS };
  afterEach(() => {
    Object.assign(RENAME_HANDLERS, original);
  });

  function stub(current: { title?: string; slug?: string; path?: string }) {
    const rename = vi.fn();
    RENAME_HANDLERS.dashboard = {
      kind: "dashboard",
      describe: "",
      resolve: async () => ({
        kind: "dashboard",
        id: "d1",
        via: "current",
        current,
      }),
      rename,
    } satisfies RenameHandler;
    return rename;
  }

  it("answers a rename to the current name as a no-op, without the handler", async () => {
    const rename = stub({ title: "Revenue", slug: "revenue" });
    const result = await renameObject(ctx, "dashboard", {
      ref: "d1",
      title: "Revenue",
    });
    expect(rename).not.toHaveBeenCalled();
    expect(result.id).toBe("d1");
    expect(result.aliasesAdded).toEqual([]);
    expect(result.warnings[0]).toMatch(/Nothing to change/);
  });

  it("matches a slug against the current path too", async () => {
    const rename = stub({ slug: "x", path: "apps/Sales/x" });
    await renameObject(ctx, "dashboard", { ref: "d1", slug: "apps/Sales/x" });
    expect(rename).not.toHaveBeenCalled();
  });

  it("hands a real change to the handler", async () => {
    const rename = stub({ title: "Revenue" });
    rename.mockResolvedValue({ id: "d1" });
    await renameObject(ctx, "dashboard", { ref: "d1", title: "Revenue v2" });
    expect(rename).toHaveBeenCalledOnce();
  });

  it("hands the handler the trimmed ref the resolve endpoint accepts", async () => {
    const rename = stub({ title: "Revenue" });
    rename.mockResolvedValue({ id: "d1" });
    await renameObject(ctx, "dashboard", { ref: "  d1 ", title: "Revenue v2" });
    expect(rename).toHaveBeenCalledWith(ctx, {
      ref: "d1",
      title: "Revenue v2",
    });
  });

  it("refuses a request with nothing to rename", async () => {
    await expect(renameObject(ctx, "dashboard", { ref: "d1" })).rejects.toThrow(
      /new title, a new slug/,
    );
  });
});

describe("rename_object agent grants", () => {
  const none = new Set<never>();

  it("keeps each kind's own gate: dbt jobs need warehouse-write", () => {
    expect(
      missingInputConditionalGrant("rename_object", { kind: "dbt_job" }, none),
    ).toMatchObject({ grant: "warehouse-write" });
  });

  it("skills and workspace connectors need git-write", () => {
    for (const kind of ["skill", "connector"]) {
      expect(
        missingInputConditionalGrant("rename_object", { kind }, none),
      ).toMatchObject({ grant: "git-write" });
    }
  });

  it("everything else needs no grant beyond the tool itself", () => {
    for (const kind of [
      "app",
      "console",
      "notebook",
      "dashboard",
      "flow",
      "dbt_file",
      "connection",
    ]) {
      expect(
        missingInputConditionalGrant("rename_object", { kind }, none),
      ).toBeNull();
    }
  });
});
