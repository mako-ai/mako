/**
 * The app rename handler (api/src/rename/handlers/app.ts): one commit per
 * rename, the id untouched, the old slug kept as an alias, and `resolve`
 * saying whether a ref is a current name or an old one — against real bare
 * repos and in-memory Mongo, the apps index suite's harness.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  AppIndexEntry,
  AppIndexHead,
  AppProject,
} from "../../database/workspace-schema";
import {
  DEFAULT_BRANCH,
  commitBlobsOnBranch,
  initRepo,
  readBlob,
  repoDirFor,
  resolveCommit,
} from "../../apps/repository.service";
import {
  bindTestWorkspaceRepo,
  unbindTestWorkspaceRepo,
} from "../../apps/bind-test-workspace-repo";
import { invalidateAppsIndexCache } from "../../apps/app-index.service";
import { parseAppManifest } from "../../apps/app-paths";
import { runGit } from "../../apps/git";
import { renameObject, resolveObjectRef } from "../registry";
import { RenameError } from "../types";
import {
  ensureProjectRow,
  resolveProjectRef,
} from "../../apps/worktree.service";
import { appRenameHandler, appUrlFor } from "./app";

let mongo: MongoMemoryServer;
let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "app-rename-test-"));
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  process.env.APPS_SESSIONS_ROOT = path.join(tmpRoot, "sessions");
  process.env.APPS_SANDBOX_PROVIDER = "local";
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

const WS = new Types.ObjectId().toString();
const USER = new Types.ObjectId().toString();
const MAIN = `refs/heads/${DEFAULT_BRANCH}`;
const B_ID = new Types.ObjectId().toHexString();
// An admin is an editor of every workspace app; a plain member only of
// apps whose `workspaceRole` says so (resource-acl.ts), as on every route.
const editor = { workspaceId: WS, userId: USER, role: "admin" };

const manifest = (title: string, id?: string) =>
  JSON.stringify({ ...(id ? { id } : {}), schemaVersion: 1, title }, null, 2) +
  "\n";

beforeEach(async () => {
  await AppIndexEntry.deleteMany({});
  await AppIndexHead.deleteMany({});
  await AppProject.deleteMany({});
  await unbindTestWorkspaceRepo(WS);
  invalidateAppsIndexCache();
  await fs.rm(path.join(tmpRoot, "repos"), { recursive: true, force: true });
  await initRepo(repoDirFor(WS), {
    "apps/a/mako.json": manifest("A"),
    "apps/a/src/main.tsx": "export {}\n",
    "apps/Sales/CH/b/mako.json": manifest("B", B_ID),
    [`users/${USER}/apps/c/mako.json`]: manifest("C"),
  });
  await bindTestWorkspaceRepo(WS);
});

async function fileAt(rel: string): Promise<string | null> {
  try {
    return (await readBlob(repoDirFor(WS), MAIN, rel)).contents;
  } catch {
    return null;
  }
}

async function commitsSince(before: string): Promise<number> {
  const after = await resolveCommit(repoDirFor(WS), MAIN);
  const { stdout } = await runGit([
    "-C",
    repoDirFor(WS),
    "rev-list",
    "--count",
    `${before}..${after}`,
  ]);
  return Number(stdout.trim());
}

describe("appUrlFor", () => {
  it("is the slug for a top-level app, the id for anything else (the client's appUrlRef)", () => {
    expect(appUrlFor({ appId: B_ID, path: "apps/b", slug: "b" })).toBe(
      "/apps/b",
    );
    expect(appUrlFor({ appId: B_ID, path: "apps/Sales/CH/b", slug: "b" })).toBe(
      `/apps/${B_ID}`,
    );
    expect(appUrlFor({ appId: B_ID, path: "apps/café", slug: "café" })).toBe(
      "/apps/caf%C3%A9",
    );
  });
});

describe("resolve", () => {
  it("answers a current name with via=current and the in-app url", async () => {
    expect(await appRenameHandler.resolve(editor, "a")).toMatchObject({
      kind: "app",
      via: "current",
      current: { title: "A", slug: "a", path: "apps/a", url: "/apps/a" },
    });
    expect(await appRenameHandler.resolve(editor, "Sales/CH/b")).toMatchObject({
      id: B_ID,
      via: "current",
      current: { url: `/apps/${B_ID}` },
    });
    expect(await appRenameHandler.resolve(editor, "nope")).toBeNull();
  });

  it("hides a personal app from anyone but its owner", async () => {
    expect(
      await appRenameHandler.resolve(editor, `users/${USER}/apps/c`),
    ).not.toBeNull();
    expect(
      await appRenameHandler.resolve(
        { ...editor, userId: new Types.ObjectId().toString() },
        `users/${USER}/apps/c`,
      ),
    ).toBeNull();
  });
});

describe("rename", () => {
  it("changes the title in mako.json in one commit; the id, slug and link stay", async () => {
    const before = (await resolveCommit(repoDirFor(WS), MAIN))!;
    const result = await renameObject(editor, "app", {
      ref: "a",
      title: "Acquisition",
    });
    expect(await commitsSince(before)).toBe(1);
    expect(result.commit).toBe(await resolveCommit(repoDirFor(WS), MAIN));
    expect(parseAppManifest(await fileAt("apps/a/mako.json"), "a").title).toBe(
      "Acquisition",
    );
    expect(result).toMatchObject({
      kind: "app",
      before: { title: "A", slug: "a", url: "/apps/a" },
      after: { title: "Acquisition", slug: "a", url: "/apps/a" },
      aliasesAdded: [],
      warnings: [],
    });
    expect(result.id).toBe((await appRenameHandler.resolve(editor, "a"))?.id);
  });

  it("changes the slug as a move: one commit, the old slug an alias, the old link resolving", async () => {
    // A row (sharing, env, deploys) exists for this one: it must follow.
    await ensureProjectRow((await resolveProjectRef(WS, "a"))!, USER);
    const before = (await resolveCommit(repoDirFor(WS), MAIN))!;
    const was = (await appRenameHandler.resolve(editor, "a"))!;
    const result = await renameObject(editor, "app", {
      ref: "a",
      slug: "acquisition",
    });
    expect(await commitsSince(before)).toBe(1);
    expect(result.id).toBe(was.id);
    expect(result.aliasesAdded).toEqual(["a"]);
    expect(result.after).toMatchObject({
      slug: "acquisition",
      path: "apps/acquisition",
      url: "/apps/acquisition",
    });
    const written = parseAppManifest(
      await fileAt("apps/acquisition/mako.json"),
      "acquisition",
    );
    expect(written.id).toBe(was.id);
    expect(written.aliases).toEqual(["a"]);
    expect(await fileAt("apps/a/mako.json")).toBeNull();
    // The old link: via=alias, pointing at the new address.
    expect(await resolveObjectRef(editor, "app", "a")).toMatchObject({
      id: was.id,
      via: "alias",
      current: { url: "/apps/acquisition" },
    });
    // The project row (sharing, env, deploys) followed.
    expect((await AppProject.findById(was.id))?.slug).toBe("acquisition");
  });

  it("changes both in ONE commit", async () => {
    const before = (await resolveCommit(repoDirFor(WS), MAIN))!;
    const result = await renameObject(editor, "app", {
      ref: B_ID,
      title: "Billing",
      slug: "billing",
    });
    expect(await commitsSince(before)).toBe(1);
    const written = parseAppManifest(
      await fileAt("apps/Sales/CH/billing/mako.json"),
      "billing",
    );
    expect(written).toMatchObject({
      id: B_ID,
      title: "Billing",
      aliases: ["apps/Sales/CH/b"],
    });
    expect(result.after).toMatchObject({
      title: "Billing",
      path: "apps/Sales/CH/billing",
      url: `/apps/${B_ID}`,
    });
    // Folder-only app (no row): the index is the truth and carries it.
    expect(await AppProject.findById(B_ID)).toBeNull();
    expect(await appRenameHandler.resolve(editor, B_ID)).toMatchObject({
      via: "current",
      current: { title: "Billing", slug: "billing" },
    });
    expect(await appRenameHandler.resolve(editor, "Sales/CH/b")).toMatchObject({
      id: B_ID,
      via: "alias",
    });
  });

  it("warns when the old name it keeps was another app's old name too — that app loses it", async () => {
    await renameObject(editor, "app", { ref: "a", slug: "bar" });
    const C_ID = new Types.ObjectId().toHexString();
    await commitBlobsOnBranch(
      repoDirFor(WS),
      DEFAULT_BRANCH,
      { writes: { "apps/a/mako.json": manifest("A again", C_ID) } },
      { message: "new app at apps/a", author: { name: "L", email: "l@x" } },
    );
    invalidateAppsIndexCache(WS);
    const result = await renameObject(editor, "app", {
      ref: C_ID,
      slug: "a-v2",
    });
    expect(result.aliasesAdded).toEqual(["a"]);
    expect(result.warnings).toEqual([
      '/apps/a now opens "A again"; it was also an old name of "A" (apps/bar), which no longer answers to it.',
    ]);
    expect(await resolveObjectRef(editor, "app", "a")).toMatchObject({
      id: C_ID,
      via: "alias",
    });
    // A's manifest is not rewritten; the index supersedes its claim.
    expect(
      parseAppManifest(await fileAt("apps/bar/mako.json"), "bar").aliases,
    ).toEqual(["a"]);
    // A plain rename names nothing and warns about nothing.
    expect(
      (await renameObject(editor, "app", { ref: C_ID, slug: "a-v3" })).warnings,
    ).toEqual([]);
  });

  it("warns when the NEW link was another app's old link — it opens this app from now on", async () => {
    // A: a → bar → baz (old names "a" and "bar"). D, a new top-level app,
    // renamed onto "a".
    await renameObject(editor, "app", { ref: "a", slug: "bar" });
    await renameObject(editor, "app", { ref: "bar", slug: "baz" });
    const D_ID = new Types.ObjectId().toHexString();
    await commitBlobsOnBranch(
      repoDirFor(WS),
      DEFAULT_BRANCH,
      { writes: { "apps/d/mako.json": manifest("D", D_ID) } },
      { message: "new app d", author: { name: "L", email: "l@x" } },
    );
    invalidateAppsIndexCache(WS);
    const result = await renameObject(editor, "app", { ref: D_ID, slug: "a" });
    expect(result.warnings).toEqual([
      '/apps/a used to open "A" (apps/baz); it now opens this app.',
    ]);
    expect(await resolveObjectRef(editor, "app", "a")).toMatchObject({
      id: D_ID,
      via: "current",
    });
    // The app that loses a link is named only to someone who may see it:
    // A becomes someone else's private app. D moves on to "bar" — A's
    // other old name — keeping "a", which A also listed.
    const A = (await resolveProjectRef(WS, "baz"))!;
    await ensureProjectRow(A, USER);
    await AppProject.updateOne(
      { _id: A._id },
      {
        $set: { access: "private", owner_id: new Types.ObjectId().toString() },
      },
    );
    expect(
      (await renameObject(editor, "app", { ref: D_ID, slug: "bar" })).warnings,
    ).toEqual([
      "/apps/bar used to open another app; it now opens this app.",
      '/apps/a now opens "D"; it was also an old name of another app, which no longer answers to it.',
    ]);
  });

  it("refuses a link another app already uses, in the words of the link", async () => {
    await commitBlobsOnBranch(
      repoDirFor(WS),
      DEFAULT_BRANCH,
      {
        writes: {
          "apps/x/mako.json": manifest("X"),
          "apps/Sales/CH/y/mako.json": manifest("Y"),
        },
      },
      { message: "x and y", author: { name: "L", email: "l@x" } },
    );
    invalidateAppsIndexCache(WS);
    await expect(
      renameObject(editor, "app", { ref: "x", slug: "a" }),
    ).rejects.toMatchObject({
      status: 409,
      message: "An app already uses the link /apps/a.",
    });
    await expect(
      renameObject(editor, "app", { ref: B_ID, slug: "y" }),
    ).rejects.toMatchObject({
      status: 409,
      message: 'An app named "y" already exists in apps/Sales/CH.',
    });
  });

  it("answers read-only (403) to someone who can see the app but not write it, as POST /move does", async () => {
    // A member on a folder-only workspace app reads as viewer (no row,
    // no workspaceRole): the app is in their list, so never "not found".
    for (const role of ["member", "viewer"]) {
      await expect(
        renameObject({ ...editor, role }, "app", { ref: "a", title: "X" }),
      ).rejects.toMatchObject({
        status: 403,
        message: expect.stringMatching(/read-only access/),
      });
    }
    // A private app of someone else is invisible: 404, nothing revealed.
    await expect(
      renameObject(
        { ...editor, userId: new Types.ObjectId().toString(), role: "admin" },
        "app",
        { ref: `users/${USER}/apps/c`, title: "X" },
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("refuses a slug change from a viewer or a role-less API key, an empty title, and an unknown app", async () => {
    const viewer = { ...editor, role: "viewer" };
    await expect(
      renameObject(viewer, "app", { ref: "a", slug: "x" }),
    ).rejects.toMatchObject({ status: 403 });
    // A workspace API key with nobody behind it: no per-user ACL (as the
    // app tools), but a slug change is a move, and moving in the Workspace
    // tree needs an editing role — exactly app_move_app's refusal.
    await expect(
      renameObject({ workspaceId: WS }, "app", { ref: "a", slug: "x" }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      renameObject({ workspaceId: WS }, "app", { ref: "a", title: "Keyed" }),
    ).resolves.toMatchObject({ after: { title: "Keyed", slug: "a" } });
    await expect(
      renameObject(editor, "app", { ref: "a", title: "   " }),
    ).rejects.toBeInstanceOf(RenameError);
    await expect(
      renameObject(editor, "app", { ref: "ghost", title: "G" }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      renameObject(editor, "app", { ref: "a", slug: "../y" }),
    ).rejects.toThrow(/Invalid app folder name/);
  });
});
