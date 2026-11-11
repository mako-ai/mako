/**
 * The app rename handler, through the registry, the REST routes and the
 * `rename_object` tool: real git, real Mongo (mongodb-memory-server).
 *
 * WHO: the name is an edit of the app (whoever may write it); the link is
 * the folder's name (an editing role in the workspace tree, the owner in a
 * personal folder). Read-only is a 403 that says so; an app the caller
 * cannot see is "not found", by id, by name and by old name alike.
 *
 * WHAT RESOLVES: only this workspace's apps, only the ones the caller may
 * read, a current name before an old one.
 *
 * RESERVED LINKS: the list in @mako/schemas is derived from the apps router
 * here, so a new literal route cannot be shadowed by an app's link.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { Hono } from "hono";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { RESERVED_APP_LINKS } from "@mako/schemas";
import {
  AppIndexEntry,
  AppIndexHead,
  AppProject,
  WorkspaceMember,
  WorkspaceUserHandle,
} from "../../database/workspace-schema";
import {
  DEFAULT_BRANCH,
  initRepo,
  readBlob,
  repoDirFor,
} from "../../apps/repository.service";
import { bindTestWorkspaceRepo } from "../../apps/bind-test-workspace-repo";
import { invalidateAppsIndexCache } from "../../apps/app-index.service";
import { invalidateOwnerDirectory } from "../../apps/user-handles.service";
import { renameObject, resolveObjectRef } from "../registry";
import { RenameError } from "../types";
import { appUrlFor } from "./app";

const session = vi.hoisted(() => ({ userId: "" }));
vi.mock("../../auth/unified-auth.middleware", () => ({
  unifiedAuthMiddleware: async (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set("authType", "session");
    c.set("user", { id: session.userId });
    await next();
  },
  isSessionAuth: () => true,
}));

import { createRenameTools } from "../../agent-lib/tools/rename-tools";
import { appsRoutes } from "../../routes/apps";
import { objectRoutes } from "../../routes/objects";

let mongo: MongoMemoryServer;
let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "app-rename-handler-"));
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  process.env.APPS_SESSIONS_ROOT = path.join(tmpRoot, "sessions");
  process.env.APPS_SANDBOX_PROVIDER = "local";
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

const WS = new Types.ObjectId().toString();
const ELSEWHERE = new Types.ObjectId().toString();
const [OWNER, ADMIN, ANA, BEN, VIEWER] = Array.from({ length: 5 }, () =>
  new Types.ObjectId().toString(),
);
const ROLES: Record<string, "owner" | "admin" | "member" | "viewer"> = {
  [OWNER]: "owner",
  [ADMIN]: "admin",
  [ANA]: "member",
  [BEN]: "member",
  [VIEWER]: "viewer",
};
const REPORT = new Types.ObjectId().toHexString();
const SECRET = new Types.ObjectId().toHexString();
const DRAFT = new Types.ObjectId().toHexString();
const FOREIGN = new Types.ObjectId().toHexString();

const manifest = (id: string, title: string, aliases?: string[]) =>
  `${JSON.stringify({ id, title, ...(aliases ? { aliases } : {}) }, null, 2)}\n`;

beforeEach(async () => {
  await Promise.all([
    AppIndexEntry.deleteMany({}),
    AppIndexHead.deleteMany({}),
    AppProject.deleteMany({}),
    WorkspaceMember.deleteMany({}),
    WorkspaceUserHandle.deleteMany({}),
  ]);
  for (const [userId, role] of Object.entries(ROLES)) {
    await WorkspaceMember.create({
      workspaceId: new Types.ObjectId(WS),
      userId,
      role,
      joinedAt: new Date(),
    });
  }
  await WorkspaceMember.create({
    workspaceId: new Types.ObjectId(ELSEWHERE),
    userId: BEN,
    role: "owner",
    joinedAt: new Date(),
  });
  await WorkspaceUserHandle.create({
    workspaceId: new Types.ObjectId(WS),
    userId: ANA,
    handle: "ana",
  });
  invalidateOwnerDirectory();
  invalidateAppsIndexCache();
  await fs.rm(path.join(tmpRoot, "repos"), { recursive: true, force: true });
  await initRepo(repoDirFor(WS), {
    "apps/report/mako.json": manifest(REPORT, "Report", ["weekly"]),
    "apps/report/src/main.tsx": "export {}\n",
    "apps/Team/secret/mako.json": manifest(SECRET, "Secret", ["hush"]),
    "users/ana/apps/draft/mako.json": manifest(DRAFT, "Draft", ["sketch"]),
  });
  await initRepo(repoDirFor(ELSEWHERE), {
    "apps/report/mako.json": manifest(FOREIGN, "Their report", ["weekly"]),
  });
  await bindTestWorkspaceRepo(WS);
  await bindTestWorkspaceRepo(ELSEWHERE);
  // A workspace app members may edit, Ana's restricted app, and her
  // personal app shared with Ben as an editor.
  await AppProject.create({
    _id: new Types.ObjectId(REPORT),
    workspaceId: new Types.ObjectId(WS),
    title: "Report",
    slug: "report",
    path: "apps/report",
    access: "workspace",
    workspaceRole: "editor",
    owner_id: ANA,
    createdBy: ANA,
  });
  await AppProject.create({
    _id: new Types.ObjectId(SECRET),
    workspaceId: new Types.ObjectId(WS),
    title: "Secret",
    slug: "secret",
    path: "apps/Team/secret",
    access: "private",
    owner_id: ANA,
    createdBy: ANA,
  });
  await AppProject.create({
    _id: new Types.ObjectId(DRAFT),
    workspaceId: new Types.ObjectId(WS),
    title: "Draft",
    slug: "draft",
    path: "users/ana/apps/draft",
    access: "private",
    owner_id: ANA,
    createdBy: ANA,
    sharedWith: [{ userId: BEN, role: "editor" }],
  });
});

const as = (userId?: string, workspaceId = WS) => ({
  workspaceId,
  userId,
  role: userId ? ROLES[userId] : undefined,
});
const resolve = (userId: string | undefined, ref: string, ws = WS) =>
  resolveObjectRef(as(userId, ws), "app", ref);
const rename = (
  userId: string | undefined,
  ref: string,
  change: { title?: string; slug?: string },
) => renameObject(as(userId), "app", { ref, ...change });
const refused = (promise: Promise<unknown>) =>
  promise.then(
    () => "renamed",
    (error: unknown) =>
      error instanceof RenameError
        ? `${error.status} ${error.message}`
        : String(error),
  );
const titleAt = async (dir: string) =>
  (
    JSON.parse(
      (await readBlob(repoDirFor(WS), DEFAULT_BRANCH, `${dir}/mako.json`))
        .contents,
    ) as { title: string }
  ).title;

describe("resolving an app", () => {
  it("answers a current name, an old link and the id, with the link the client builds", async () => {
    expect(await resolve(BEN, "report")).toEqual({
      kind: "app",
      id: REPORT,
      via: "current",
      current: {
        title: "Report",
        slug: "report",
        path: "apps/report",
        url: "/apps/report",
      },
    });
    expect(await resolve(BEN, "weekly")).toMatchObject({
      id: REPORT,
      via: "alias",
      current: { url: "/apps/report" },
    });
    expect((await resolve(VIEWER, REPORT))?.via).toBe("current");
    expect(await resolve(BEN, "nope")).toBeNull();
    // A nested, a personal or an id-lookalike folder is addressed by its id.
    const at = (p: string) =>
      appUrlFor({ appId: REPORT, path: p, slug: p.split("/").pop() ?? p });
    expect(at("apps/report")).toBe("/apps/report");
    expect(at("apps/café x")).toBe("/apps/caf%C3%A9%20x");
    expect(at("apps/Team/report")).toBe(`/apps/${REPORT}`);
    expect(at("users/ana/apps/report")).toBe(`/apps/${REPORT}`);
    expect(at(`apps/${SECRET}`)).toBe(`/apps/${REPORT}`);
  });

  it("never returns an app the caller cannot read — by id, name or old link", async () => {
    for (const ref of [SECRET, "secret", "apps/Team/secret", "hush"]) {
      expect([ref, await resolve(BEN, ref)]).toEqual([ref, null]);
      expect([ref, await resolve(ADMIN, ref)]).toEqual([ref, null]);
      expect([ref, (await resolve(ANA, ref))?.id]).toEqual([ref, SECRET]);
    }
    // A personal app: its owner and whoever it is shared with, nobody else.
    for (const ref of [DRAFT, "users/ana/apps/draft", "sketch"]) {
      expect([ref, (await resolve(ANA, ref))?.id]).toEqual([ref, DRAFT]);
      expect([ref, (await resolve(BEN, ref))?.id]).toEqual([ref, DRAFT]);
      expect([ref, await resolve(OWNER, ref)]).toEqual([ref, null]);
    }
    // A personal app with no row yet is its folder owner's alone.
    await AppProject.deleteOne({ _id: new Types.ObjectId(DRAFT) });
    expect((await resolve(ANA, "sketch"))?.id).toBe(DRAFT);
    expect(await resolve(BEN, "sketch")).toBeNull();
    // A credential with no person behind it reads what the app list shows it.
    expect((await resolve(undefined, "hush"))?.id).toBe(SECRET);
  });

  it("never resolves another workspace's app, and two workspaces keep their own names", async () => {
    expect(await resolve(BEN, FOREIGN)).toBeNull();
    expect(await resolve(BEN, REPORT, ELSEWHERE)).toBeNull();
    expect((await resolve(BEN, "weekly", ELSEWHERE))?.id).toBe(FOREIGN);
    expect((await resolve(BEN, "weekly"))?.id).toBe(REPORT);
    await expect(
      renameObject(as(BEN, ELSEWHERE), "app", { ref: REPORT, title: "X" }),
    ).rejects.toMatchObject({ status: 404 });
    expect(await titleAt("apps/report")).toBe("Report");
  });
});

describe("who may rename an app", () => {
  it("an editing member renames name and link; the old link keeps opening it", async () => {
    const result = await rename(BEN, "report", {
      title: "Revenue",
      slug: "revenue",
    });
    expect(result).toMatchObject({
      kind: "app",
      id: REPORT,
      before: { title: "Report", slug: "report", url: "/apps/report" },
      after: {
        title: "Revenue",
        slug: "revenue",
        path: "apps/revenue",
        url: "/apps/revenue",
      },
      aliasesAdded: ["report"],
      commit: expect.stringMatching(/^[0-9a-f]{40}$/),
      warnings: [],
    });
    for (const old of ["report", "weekly"]) {
      expect(await resolve(VIEWER, old)).toMatchObject({
        id: REPORT,
        via: "alias",
        current: { url: "/apps/revenue" },
      });
    }
    // The same name again: nothing to do, and it says so.
    const again = await rename(BEN, "report", { slug: "revenue" });
    expect(again.warnings[0]).toMatch(/Nothing to change/);
    expect(again.commit).toBeUndefined();
  });

  it("read-only is a 403 that says so; an app the caller cannot see is not found", async () => {
    expect(await refused(rename(VIEWER, "report", { title: "Mine" }))).toMatch(
      /^403 You have read-only access to this app\./,
    );
    expect(await refused(rename(BEN, "hush", { title: "Mine" }))).toBe(
      "404 App not found.",
    );
    expect(await refused(rename(BEN, SECRET, { slug: "mine" }))).toBe(
      "404 App not found.",
    );
    expect(await refused(rename(BEN, "nope", { title: "Mine" }))).toBe(
      "404 App not found.",
    );
    expect(await titleAt("apps/report")).toBe("Report");
    expect(await titleAt("apps/Team/secret")).toBe("Secret");
  });

  it("an editor of someone's personal app renames its name, never its link", async () => {
    expect(await refused(rename(BEN, DRAFT, { slug: "bens" }))).toBe(
      "403 Only the owner of this personal folder can change the app's link.",
    );
    expect(
      await refused(rename(BEN, DRAFT, { title: "Plan", slug: "bens" })),
    ).toMatch(/^403 Only the owner/);
    expect(await titleAt("users/ana/apps/draft")).toBe("Draft");
    const titled = await rename(BEN, DRAFT, { title: "Plan" });
    expect(titled.after).toMatchObject({
      title: "Plan",
      path: "users/ana/apps/draft",
      url: `/apps/${DRAFT}`,
    });
    const moved = await rename(ANA, DRAFT, { slug: "plan" });
    expect(moved.after.path).toBe("users/ana/apps/plan");
    expect(moved.aliasesAdded).toEqual(["users/ana/apps/draft"]);
  });

  it("a credential with no person behind it changes a name, not a link — as app_move_app", async () => {
    expect(await refused(rename(undefined, "report", { slug: "x" }))).toBe(
      "403 Only workspace editors can change an app's link.",
    );
    expect(
      (await rename(undefined, "report", { title: "By key" })).after.title,
    ).toBe("By key");
  });
});

describe("end to end", () => {
  const api = new Hono();
  api.route("/api/workspaces/:workspaceId/objects", objectRoutes);
  const post = (body: Record<string, unknown>) =>
    api.request(`/api/workspaces/${WS}/objects/app/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const get = (ref: string) =>
    api.request(
      `/api/workspaces/${WS}/objects/resolve?kind=app&ref=${encodeURIComponent(ref)}`,
    );

  it("POST /objects/app/rename, then GET /objects/resolve with the old link", async () => {
    session.userId = VIEWER;
    expect((await post({ ref: "report", slug: "revenue" })).status).toBe(403);
    session.userId = BEN;
    const taken = await post({ ref: "report", slug: "Team" });
    expect(taken.status).toBe(409);
    expect((await post({ ref: "report", slug: "search" })).status).toBe(400);
    const res = await post({ ref: "report", slug: "revenue" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      success: true,
      result: { id: REPORT, after: { url: "/apps/revenue" } },
    });
    expect(await (await get("report")).json()).toMatchObject({
      resolved: { id: REPORT, via: "alias", current: { url: "/apps/revenue" } },
    });
    expect((await get("hush")).status).toBe(404);
  });

  it("rename_object offers apps wherever app_move_app is, and renames as the caller", async () => {
    type Tool = {
      inputSchema: { shape: { kind: { options: string[] } } };
      execute: (input: unknown) => Promise<Record<string, unknown>>;
    };
    const SURFACES = ["in-chat", "desktop-acp", "external-mcp"] as const;
    const tool = (userId: string, surface?: (typeof SURFACES)[number]) =>
      (
        createRenameTools(
          WS,
          userId,
          surface ? { surface } : {},
        ) as unknown as {
          rename_object: Tool;
        }
      ).rename_object;
    for (const surface of SURFACES) {
      expect(tool(BEN, surface).inputSchema.shape.kind.options).toContain(
        "app",
      );
    }
    const call = (userId: string) =>
      tool(userId).execute({ kind: "app", ref: "weekly", slug: "revenue" });
    expect(await call(VIEWER)).toMatchObject({
      success: false,
      error: expect.stringMatching(/read-only/),
    });
    expect(await call(BEN)).toMatchObject({
      success: true,
      id: REPORT,
      aliasesAdded: ["report"],
    });
  });
});

describe("reserved links", () => {
  it("are exactly the literal first segments of the apps router", () => {
    const literal = new Set<string>();
    for (const route of appsRoutes.routes) {
      const first = route.path.split("/").filter(Boolean)[0];
      if (first && !/^[:{*]/.test(first)) literal.add(first);
    }
    expect([...RESERVED_APP_LINKS]).toEqual([...literal].sort());
  });
});
