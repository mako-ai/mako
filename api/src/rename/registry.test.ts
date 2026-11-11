/**
 * The rules every kind shares, enforced above the handlers: a kind with no
 * handler answers "not supported yet", a rename to the current name is a
 * no-op, and the ref is trimmed the way the resolve endpoint trims it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RENAME_HANDLERS,
  isRenameKind,
  renameObject,
  resolveObjectRef,
  supportedRenameKinds,
} from "./registry";
import { RENAME_KINDS, type RenameHandler } from "./types";

const ctx = { workspaceId: "66f000000000000000000001", userId: "u1" };

const original = { ...RENAME_HANDLERS };
afterEach(() => {
  for (const kind of RENAME_KINDS) delete RENAME_HANDLERS[kind];
  Object.assign(RENAME_HANDLERS, original);
});

/** A stand-in handler for `flow`, resolving every ref to `current`. */
function stub(current: { title?: string; slug?: string; path?: string }) {
  const rename = vi.fn();
  RENAME_HANDLERS.flow = {
    kind: "flow",
    describe: "",
    resolve: async () => ({ kind: "flow", id: "f1", via: "current", current }),
    rename,
  } satisfies RenameHandler;
  return rename;
}

describe("the handler map", () => {
  it("lists each handler under its own kind", () => {
    for (const kind of supportedRenameKinds()) {
      expect(RENAME_HANDLERS[kind]?.kind).toBe(kind);
    }
    expect(supportedRenameKinds()).toContain("connection");
  });

  it("answers a kind with no handler yet as not supported, for rename and resolve", async () => {
    const missing = RENAME_KINDS.filter(kind => !RENAME_HANDLERS[kind]);
    for (const kind of missing) {
      await expect(
        renameObject(ctx, kind, { ref: "x", title: "New" }),
      ).rejects.toMatchObject({
        name: "RenameError",
        status: 501,
        message: expect.stringMatching(/not supported yet/),
      });
      await expect(resolveObjectRef(ctx, kind, "x")).rejects.toMatchObject({
        status: 501,
      });
    }
  });

  it("becomes supported with one line: a handler under its kind", async () => {
    delete RENAME_HANDLERS.flow;
    expect(supportedRenameKinds()).not.toContain("flow");
    const rename = stub({ title: "Revenue" });
    rename.mockResolvedValue({ id: "f1" });
    expect(supportedRenameKinds()).toContain("flow");
    await renameObject(ctx, "flow", { ref: "f1", title: "Revenue v2" });
    expect(rename).toHaveBeenCalledOnce();
    expect((await resolveObjectRef(ctx, "flow", "f1"))?.id).toBe("f1");
  });

  it("knows a kind from any other string", () => {
    expect(isRenameKind("connection")).toBe(true);
    expect(isRenameKind("dashboard")).toBe(false);
    expect(isRenameKind("")).toBe(false);
  });
});

describe("renameObject", () => {
  it("answers a rename to the current name as a no-op, without the handler", async () => {
    const rename = stub({ title: "Revenue", slug: "revenue" });
    const result = await renameObject(ctx, "flow", {
      ref: "f1",
      title: "Revenue",
    });
    expect(rename).not.toHaveBeenCalled();
    expect(result).toMatchObject({ kind: "flow", id: "f1", aliasesAdded: [] });
    expect(result.before).toEqual(result.after);
    expect(result.warnings[0]).toMatch(/Nothing to change/);
  });

  it("reads a name typed in another Unicode form, or padded, as the same name", async () => {
    const rename = stub({ title: "Caf\u{E9}" });
    await renameObject(ctx, "flow", { ref: "f1", title: "  Cafe\u{301} " });
    expect(rename).not.toHaveBeenCalled();
  });

  it("matches a slug against the current path too", async () => {
    const rename = stub({ slug: "x", path: "apps/Sales/x" });
    await renameObject(ctx, "flow", { ref: "f1", slug: "apps/Sales/x" });
    expect(rename).not.toHaveBeenCalled();
  });

  it("hands a real change to the handler", async () => {
    const rename = stub({ title: "Revenue", slug: "revenue" });
    rename.mockResolvedValue({ id: "f1" });
    await renameObject(ctx, "flow", { ref: "f1", title: "Revenue v2" });
    await renameObject(ctx, "flow", {
      ref: "f1",
      title: "Revenue",
      slug: "revenue-2",
    });
    expect(rename).toHaveBeenCalledTimes(2);
  });

  it("hands the handler the trimmed ref the resolve endpoint accepts", async () => {
    const rename = stub({ title: "Revenue" });
    rename.mockResolvedValue({ id: "f1" });
    await renameObject(ctx, "flow", { ref: "  f1 ", title: "Revenue v2" });
    expect(rename).toHaveBeenCalledWith(ctx, {
      ref: "f1",
      title: "Revenue v2",
    });
  });

  it("refuses a request with nothing to rename", async () => {
    stub({ title: "Revenue" });
    await expect(renameObject(ctx, "flow", { ref: "f1" })).rejects.toThrow(
      /new title, a new slug/,
    );
  });
});

describe("resolveObjectRef", () => {
  it("answers a blank ref with nothing, without asking the handler", async () => {
    const resolve = vi.fn();
    RENAME_HANDLERS.flow = {
      kind: "flow",
      describe: "",
      resolve,
      rename: vi.fn(),
    };
    expect(await resolveObjectRef(ctx, "flow", "   ")).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });
});
