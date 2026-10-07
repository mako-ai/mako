/**
 * App rename scenarios, part two: WHO may rename, WHAT a ref resolves to
 * for whom, and where a link stops. Real git and Mongo
 * (./app-scenario-harness.ts); the actor is a RenameContext as the REST
 * route, the agent tool and the MCP bridge build it (the route's own
 * session-only gate is in app-rename-routes.scenarios.test.ts).
 *
 *  - roles: owner, admin, member with write (an app's `workspaceRole`
 *    editor, or shared as editor), member read-only, viewer, a member who
 *    cannot see the app (someone else's private one), a workspace API key
 *    with nobody behind it;
 *  - resolve() never returns an app the caller cannot read — by id, by
 *    its current name, or by an old one;
 *  - links: an old URL, an old URL whose name another app took since, an
 *    old URL two apps claim, a link into ANOTHER workspace;
 *  - two workspaces with the same names never interfere.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { AppProject } from "../../database/workspace-schema";
import { renameObject, resolveObjectRef } from "../../rename/registry";
import type { RenameContext } from "../../rename/types";
import { ensureProjectRow, resolveProjectRef } from "../worktree.service";
import { loadAppsIndex } from "../app-index.service";
import {
  addMember,
  commitsSince,
  externalCommit,
  headOf,
  manifest,
  newId,
  resetWorkspace,
  startScenarioEnv,
  type ScenarioEnv,
} from "./app-scenario-harness";

let env: ScenarioEnv;
beforeAll(async () => {
  env = await startScenarioEnv("app-rename-access");
});
afterAll(async () => {
  await env.stop();
});

const WS = new Types.ObjectId().toString();
const WS2 = new Types.ObjectId().toString();
const OWNER = new Types.ObjectId().toString();
const ADMIN = new Types.ObjectId().toString();
const EDITOR = new Types.ObjectId().toString();
const MEMBER = new Types.ObjectId().toString();
const VIEWER = new Types.ObjectId().toString();
const STRANGER = new Types.ObjectId().toString();

const W_ID = newId(); // workspace app, members are editors (workspaceRole)
const R_ID = newId(); // workspace app, members read only
const P_ID = newId(); // OWNER's private app in the workspace tree, shared
const N_ID = newId(); // nested workspace app

const as = (userId: string | undefined, role?: string): RenameContext => ({
  workspaceId: WS,
  ...(userId ? { userId } : {}),
  ...(role ? { role } : {}),
});
const actors = {
  owner: as(OWNER, "owner"),
  admin: as(ADMIN, "admin"),
  editor: as(EDITOR, "member"),
  member: as(MEMBER, "member"),
  viewer: as(VIEWER, "viewer"),
  apiKey: as(undefined),
} as const;

beforeEach(async () => {
  await resetWorkspace(env, WS, {
    "apps/a/mako.json": manifest("A"),
    "apps/w/mako.json": manifest("W", W_ID),
    "apps/r/mako.json": manifest("R", R_ID),
    "apps/p/mako.json": manifest("P", P_ID),
    "apps/Team/n/mako.json": manifest("N", N_ID),
    [`users/${OWNER}/apps/mine/mako.json`]: manifest("Mine"),
  });
  await addMember(WS, OWNER, "owner");
  await addMember(WS, ADMIN, "admin");
  await addMember(WS, EDITOR, "member");
  await addMember(WS, MEMBER, "member");
  await addMember(WS, VIEWER, "viewer");
  const row = async (ref: string, set: Record<string, unknown>) => {
    const project = (await resolveProjectRef(WS, ref))!;
    await ensureProjectRow(project, OWNER);
    await AppProject.updateOne({ _id: project._id }, { $set: set });
  };
  await row("w", { access: "workspace", workspaceRole: "editor" });
  await row("r", { access: "workspace", workspaceRole: "viewer" });
  await row("p", {
    access: "private",
    sharedWith: [
      { userId: EDITOR, role: "editor" },
      { userId: VIEWER, role: "editor" },
      { userId: MEMBER, role: "viewer" },
    ],
  });
});

type Outcome = "ok" | 403 | 404;

async function attempt(
  ctx: RenameContext,
  ref: string,
  change: { title?: string; slug?: string },
): Promise<Outcome> {
  try {
    await renameObject(ctx, "app", { ref, ...change });
    return "ok";
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 403 || status === 404) return status;
    throw error;
  }
}

describe("who may rename an app", () => {
  // [actor, app ref, title outcome, slug outcome]
  const table: Array<[keyof typeof actors, string, Outcome, Outcome]> = [
    // A folder-only workspace app: admins and owners edit it, members and
    // viewers read it, an API key (no person) renames its title only — a
    // slug change moves the folder, which needs an editing role.
    ["owner", "a", "ok", "ok"],
    ["admin", "a", "ok", "ok"],
    ["member", "a", 403, 403],
    ["viewer", "a", 403, 403],
    ["apiKey", "a", "ok", 403],
    // workspaceRole editor: every member writes it; a viewer still reads.
    ["member", "w", "ok", "ok"],
    ["viewer", "w", 403, 403],
    // workspaceRole viewer: members read only.
    ["member", "r", 403, 403],
    ["admin", "r", "ok", "ok"],
    // Private, shared: the editor writes it; a viewer shared as EDITOR
    // renames its title, but its link is a folder move the workspace role
    // forbids; one shared as viewer reads; an admin it is not shared with
    // does not see it at all.
    ["editor", "p", "ok", "ok"],
    ["viewer", "p", "ok", 403],
    ["member", "p", 403, 403],
    ["admin", "p", 404, 404],
    // A personal tree: its owner only. Anyone else: not found.
    ["owner", `users/${OWNER}/apps/mine`, "ok", "ok"],
    ["admin", `users/${OWNER}/apps/mine`, 404, 404],
    ["editor", `users/${OWNER}/apps/mine`, 404, 404],
  ];

  it.each(table)(
    "%s renaming %s: title → %s, slug → %s; a refusal commits nothing",
    async (actor, ref, titleOutcome, slugOutcome) => {
      const ctx = actors[actor];
      const before = await headOf(WS);
      const id = (await resolveProjectRef(WS, ref))!._id.toString();
      expect(await attempt(ctx, ref, { title: "Renamed" })).toBe(titleOutcome);
      expect(await commitsSince(WS, before)).toBe(
        titleOutcome === "ok" ? 1 : 0,
      );
      const mid = await headOf(WS);
      expect(await attempt(ctx, id, { slug: "renamed-slug" })).toBe(
        slugOutcome,
      );
      expect(await commitsSince(WS, mid)).toBe(slugOutcome === "ok" ? 1 : 0);
      // Whatever happened, the id is the id.
      expect((await resolveProjectRef(WS, id))?._id.toString()).toBe(id);
    },
  );
});

describe("resolve() never returns what the caller cannot read", () => {
  it("a private app, renamed: hidden by id, current name AND old name from everyone it is not shared with", async () => {
    await renameObject(actors.owner, "app", { ref: "p", slug: "p2" });
    for (const ref of [P_ID, "p2", "apps/p2", "p", "apps/p"]) {
      for (const ctx of [actors.admin, as(STRANGER, undefined)]) {
        expect(await resolveObjectRef(ctx, "app", ref), ref).toBeNull();
      }
      for (const ctx of [actors.owner, actors.editor, actors.member]) {
        expect(
          (await resolveObjectRef(ctx, "app", ref))?.id,
          `${ref} for a sharee`,
        ).toBe(P_ID);
      }
    }
  });

  it("a personal app, renamed: its owner only", async () => {
    await renameObject(actors.owner, "app", {
      ref: `users/${OWNER}/apps/mine`,
      slug: "mine2",
    });
    const id = (await resolveObjectRef(actors.owner, "app", "mine2"))!.id;
    for (const ref of [
      id,
      "mine2",
      `users/${OWNER}/apps/mine2`,
      `users/${OWNER}/apps/mine`,
    ]) {
      expect((await resolveObjectRef(actors.owner, "app", ref))?.id).toBe(id);
      for (const ctx of [actors.admin, actors.editor, actors.viewer]) {
        expect(await resolveObjectRef(ctx, "app", ref), ref).toBeNull();
      }
    }
  });

  it("a hidden app's old name is not handed to a visible app that also claims it, nor revealed", async () => {
    // Both P (private) and W once used the name "shared": W from a laptop
    // rename, P from a rename by its owner. Two claims: nobody's.
    await renameObject(actors.owner, "app", { ref: "p", slug: "shared" });
    await renameObject(actors.owner, "app", { ref: "shared", slug: "p3" });
    await renameObject(actors.admin, "app", { ref: "w", slug: "shared" });
    // W now SITS at "shared": a current name beats an alias, for everyone.
    expect(await resolveObjectRef(actors.admin, "app", "shared")).toMatchObject(
      { id: W_ID, via: "current" },
    );
    await renameObject(actors.admin, "app", { ref: "shared", slug: "w2" });
    // W was the last to hold it: it follows W, for everyone who can see W.
    expect(await resolveObjectRef(actors.admin, "app", "shared")).toMatchObject(
      { id: W_ID, via: "alias" },
    );
    expect((await resolveObjectRef(actors.owner, "app", "shared"))?.id).toBe(
      W_ID,
    );
  });

  it("warnings never name an app the caller cannot see", async () => {
    await renameObject(actors.owner, "app", { ref: "p", slug: "old-p" });
    await renameObject(actors.owner, "app", { ref: "old-p", slug: "p-now" });
    const result = await renameObject(actors.admin, "app", {
      ref: "w",
      slug: "old-p",
    });
    expect(result.warnings).toEqual([
      '/apps/old-p used to open another app; it now opens "W".',
    ]);
    // W leaves the name: it keeps it as its own old name, and P's older
    // claim gives way — said without naming P to an admin who cannot see P.
    const leaving = await renameObject(actors.admin, "app", {
      ref: "old-p",
      slug: "old-p-2",
    });
    expect(leaving.warnings).toEqual([
      '/apps/old-p now opens "W"; it was also an old name of another app, which no longer answers to it.',
    ]);
    expect((await resolveObjectRef(actors.owner, "app", "old-p"))?.id).toBe(
      W_ID,
    );
  });
});

describe("links", () => {
  it("an old URL opens the app at its new address", async () => {
    await renameObject(actors.admin, "app", { ref: "w", slug: "w-new" });
    expect(await resolveObjectRef(actors.member, "app", "w")).toMatchObject({
      id: W_ID,
      via: "alias",
      current: { url: "/apps/w-new", path: "apps/w-new" },
    });
    // With and without `apps/`, leading and trailing slashes.
    for (const ref of ["apps/w", "/w", "w/", "/apps/w/"]) {
      expect((await resolveObjectRef(actors.member, "app", ref))?.id).toBe(
        W_ID,
      );
    }
  });

  it("an old URL whose name another app took since opens that app, never the old one", async () => {
    await renameObject(actors.admin, "app", { ref: "w", slug: "w-new" });
    await externalCommit(WS, { "apps/w/mako.json": manifest("Newcomer") });
    const NEW = (await loadAppsIndex(WS)).apps.find(a => a.path === "apps/w")!;
    expect(await resolveObjectRef(actors.admin, "app", "w")).toMatchObject({
      id: NEW.appId,
      via: "current",
    });
    // The newcomer leaves: the name follows it, its most recent holder.
    await renameObject(actors.admin, "app", { ref: "w", slug: "newcomer" });
    expect(await resolveObjectRef(actors.admin, "app", "w")).toMatchObject({
      id: NEW.appId,
      via: "alias",
    });
    expect((await resolveObjectRef(actors.admin, "app", "w-new"))?.id).toBe(
      W_ID,
    );
  });

  it("an old URL two apps claim opens neither", async () => {
    // Two laptop manifests that both list "gone" as an old name.
    await externalCommit(WS, {
      "apps/x1/mako.json": manifest("X1", newId(), { aliases: ["gone"] }),
      "apps/x2/mako.json": manifest("X2", newId(), { aliases: ["apps/gone"] }),
    });
    expect(await resolveObjectRef(actors.admin, "app", "gone")).toBeNull();
    expect(await resolveObjectRef(actors.admin, "app", "apps/gone")).toBeNull();
  });

  it("a link to an app in ANOTHER workspace does not resolve — by id, name or old name", async () => {
    const OTHER_ID = newId();
    await resetWorkspace(env, WS2, {
      "apps/elsewhere/mako.json": manifest("Elsewhere", OTHER_ID),
    });
    await addMember(WS2, ADMIN, "admin");
    const ws2 = { workspaceId: WS2, userId: ADMIN, role: "admin" };
    await renameObject(ws2, "app", { ref: "elsewhere", slug: "elsewhere-2" });
    for (const ref of [OTHER_ID, "elsewhere-2", "elsewhere"]) {
      expect(await resolveObjectRef(actors.admin, "app", ref), ref).toBeNull();
      expect(await resolveProjectRef(WS, ref), ref).toBeNull();
      await expect(
        renameObject(actors.admin, "app", { ref, title: "Hijack" }),
      ).rejects.toMatchObject({ status: 404 });
    }
    expect((await resolveObjectRef(ws2, "app", "elsewhere"))?.id).toBe(
      OTHER_ID,
    );
  });
});

describe("two workspaces with the same names", () => {
  it("never interfere: each renames, resolves and keeps its own ids", async () => {
    await resetWorkspace(env, WS2, {
      "apps/a/mako.json": manifest("A"),
      // A copy of WS's repo would carry WS's ids: WS2 must not get them.
      "apps/w/mako.json": manifest("W", W_ID),
    });
    await addMember(WS2, ADMIN, "admin");
    const ws2 = { workspaceId: WS2, userId: ADMIN, role: "admin" };
    const a1 = (await resolveObjectRef(actors.admin, "app", "a"))!.id;
    const a2 = (await resolveObjectRef(ws2, "app", "a"))!.id;
    expect(a1).not.toBe(a2);
    // W's id belongs to WS (it had state there first): WS2's copy gets its own.
    const w2 = (await resolveObjectRef(ws2, "app", "w"))!.id;
    expect(w2).not.toBe(W_ID);
    expect(await resolveObjectRef(ws2, "app", W_ID)).toBeNull();

    await renameObject(actors.admin, "app", { ref: "a", slug: "b" });
    expect(await resolveObjectRef(ws2, "app", "b")).toBeNull();
    expect(await resolveObjectRef(ws2, "app", "a")).toMatchObject({
      id: a2,
      via: "current",
    });
    await renameObject(ws2, "app", { ref: "a", slug: "c" });
    expect(await resolveObjectRef(actors.admin, "app", "a")).toMatchObject({
      id: a1,
      via: "alias",
      current: { path: "apps/b" },
    });
    expect(await resolveObjectRef(ws2, "app", "a")).toMatchObject({
      id: a2,
      via: "alias",
      current: { path: "apps/c" },
    });
    expect(await resolveObjectRef(actors.admin, "app", "c")).toBeNull();
  });
});
