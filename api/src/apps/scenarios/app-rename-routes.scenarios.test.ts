/**
 * App rename scenarios, part five: the doors people and agents actually
 * use. The real Hono routes — POST /objects/app/rename and GET
 * /objects/resolve (the explorer's rename and old-link redirect), POST
 * /apps/{id}/move (the move dialog), GET /apps (the list the client
 * resolves links from), POST /apps, PATCH /apps/folders — and the real MCP
 * server's `rename_object`, over real git and Mongo. Only authentication
 * and membership are stubbed, so the acting user, their role and the kind
 * of credential can be switched per request.
 *
 * What must hold: every refusal is the right status with a message a
 * person can act on (never a server path), the list and the resolver
 * agree on old names, nobody is shown what they cannot read, and a
 * workspace API key over MCP renames an app with no extra grant while the
 * same tool still refuses the kinds that need one.
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
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Hono } from "hono";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

const who = vi.hoisted(() => ({
  id: "",
  role: "admin" as string | undefined,
  member: true,
  kind: "session" as "session" | "apiKey",
  workspaceId: "",
}));

vi.mock("../../auth/unified-auth.middleware", () => ({
  unifiedAuthMiddleware: async (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set("authType", who.kind);
    c.set("user", { id: who.id, email: "u@example.com" });
    if (who.kind === "apiKey") {
      c.set("workspace", { _id: { toString: () => who.workspaceId } });
    }
    await next();
  },
  isSessionAuth: (c: { get: (k: string) => unknown }) =>
    c.get("authType") === "session",
}));
vi.mock("../../services/workspace.service", () => ({
  workspaceService: {
    hasAccess: async () => who.member,
    getMember: async () => (who.member && who.role ? { role: who.role } : null),
    hasRole: async (_ws: string, _user: string, roles: string[]) =>
      !!who.role && roles.includes(who.role),
  },
}));
vi.mock("../../services/auto-join.service", () => ({
  ensureAutoJoin: async () => null,
}));
vi.mock("../../inngest", () => ({
  inngest: { send: async () => ({}), createFunction: () => ({}) },
}));
// GET /apps refreshes the repo's agent template in the background, as a
// commit of its own: real, but not part of any scenario here, and it would
// land in the middle of the next one's "nothing was committed".
vi.mock("../workspace-template", async importOriginal => ({
  ...(await importOriginal<typeof import("../workspace-template")>()),
  ensureWorkspaceTemplateSoon: () => undefined,
}));

import { AppProject } from "../../database/workspace-schema";
import { ensureProjectRow, resolveProjectRef } from "../worktree.service";
import { appsRoutes } from "../../routes/apps";
import { objectRoutes } from "../../routes/objects";
import { buildMakoMcpServer } from "../../mcp/mako-mcp-server";
import { createAppsTools } from "../../agent-lib/tools/apps-tools";
import { StatelessMcpTransport } from "../../mcp/stateless-transport";
import {
  commitsSince,
  externalCommit,
  fileAt,
  headOf,
  manifest,
  newId,
  resetWorkspace,
  type ScenarioEnv,
} from "./app-scenario-harness";

let mongo: MongoMemoryServer;
let env: ScenarioEnv;
let app: Hono;

const WS = new Types.ObjectId().toString();
const WS2 = new Types.ObjectId().toString();
const ADMIN = new Types.ObjectId().toString();
const OWNER = new Types.ObjectId().toString();
const MEMBER = new Types.ObjectId().toString();
const D_ID = newId();
const P_ID = newId();
const ANCHOR = "6aa30149273767efe9ee382a";

beforeAll(async () => {
  const tmpRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "app-rename-routes-"),
  );
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  process.env.APPS_SESSIONS_ROOT = path.join(tmpRoot, "sessions");
  process.env.APPS_SANDBOX_PROVIDER = "local";
  delete process.env.APPS_CONNECTED_REPO_PUSH;
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  env = {
    tmpRoot,
    async stop() {
      await mongoose.disconnect();
      await mongo.stop();
      await fs.rm(tmpRoot, { recursive: true, force: true });
    },
  };
  app = new Hono();
  app.route("/api/workspaces/:workspaceId/apps", appsRoutes);
  app.route("/api/workspaces/:workspaceId/objects", objectRoutes);
}, 120_000);

afterAll(async () => {
  await env.stop();
});

beforeEach(async () => {
  await resetWorkspace(env, WS, {
    "apps/a/mako.json": manifest("A"),
    "apps/a/src/main.tsx": "export {};\n",
    "apps/d/mako.json": manifest("D", D_ID),
    "apps/p/mako.json": manifest("P", P_ID),
    "apps/Sales/.gitkeep": "",
    [`users/${OWNER}/apps/mine/mako.json`]: manifest("Mine"),
  });
  const p = (await resolveProjectRef(WS, "p"))!;
  await ensureProjectRow(p, OWNER);
  await AppProject.updateOne({ _id: p._id }, { $set: { access: "private" } });
  as(ADMIN, "admin");
});

function as(
  id: string,
  role: string | undefined,
  options: { member?: boolean; kind?: "session" | "apiKey" } = {},
) {
  who.id = id;
  who.role = role;
  who.member = options.member ?? true;
  who.kind = options.kind ?? "session";
  who.workspaceId = WS;
}

async function call(
  method: string,
  url: string,
  body?: unknown,
  workspaceId = WS,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await app.request(`/api/workspaces/${workspaceId}${url}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: res.status,
    json: (await res.json()) as Record<string, unknown>,
  };
}

const rename = (body: Record<string, unknown>) =>
  call("POST", "/objects/app/rename", body);
const resolve = (ref: string, workspaceId = WS) =>
  call(
    "GET",
    `/objects/resolve?${new URLSearchParams({ kind: "app", ref })}`,
    undefined,
    workspaceId,
  );
const list = async () =>
  (await call("GET", "/apps")).json.apps as Array<{
    id: string;
    path: string;
    aliases: string[];
    canWrite: boolean;
  }>;

/** A refusal: the status, a message, nothing committed, no server path. */
async function expectRefused(
  attempt: () => Promise<{ status: number; json: Record<string, unknown> }>,
  status: number,
  message?: RegExp,
) {
  const before = await headOf(WS);
  const { status: got, json } = await attempt();
  expect(got, JSON.stringify(json)).toBe(status);
  expect(json.success).toBe(false);
  expect(typeof json.error).toBe("string");
  if (message) expect(json.error).toMatch(message);
  expect(json.error).not.toMatch(/\/tmp\/|\/var\/folders\/|lifecycle-|ENOENT/);
  expect(await commitsSince(WS, before)).toBe(0);
}

describe("the explorer's rename: POST /objects/app/rename", () => {
  it("renames title and link in one commit; the list and the resolver agree on the old name", async () => {
    const before = await headOf(WS);
    const { status, json } = await rename({
      ref: "a",
      title: "Acquisition",
      slug: "acq",
    });
    expect(status).toBe(200);
    expect(await commitsSince(WS, before)).toBe(1);
    const result = json.result as {
      id: string;
      after: { url: string; title: string };
    };
    expect(result.after).toMatchObject({
      url: "/apps/acq",
      title: "Acquisition",
    });
    const row = (await list()).find(a => a.id === result.id)!;
    expect(row).toMatchObject({ path: "apps/acq", aliases: ["a"] });
    expect((await resolve("a")).json).toMatchObject({
      success: true,
      resolved: { id: result.id, via: "alias", current: { url: "/apps/acq" } },
    });
  });

  it("refuses with the right status and an actionable message — never a 500, never a server path", async () => {
    await expectRefused(
      () => rename({ ref: "a", slug: "CON" }),
      400,
      /Windows/,
    );
    await expectRefused(() => rename({ ref: "a", slug: D_ID }), 400, /app id/);
    await expectRefused(() => rename({ ref: "a", slug: "../x" }), 400);
    await expectRefused(
      () => rename({ ref: "a", slug: "d" }),
      409,
      /\/apps\/d/,
    );
    await expectRefused(() => rename({ ref: "a", slug: "D" }), 409, /case/);
    await expectRefused(
      () => rename({ ref: "a", title: "x\u0000y" }),
      400,
      /control characters/,
    );
    await expectRefused(
      () => rename({ ref: "a", title: "x".repeat(1001) }),
      400,
    );
    await expectRefused(() => rename({ ref: "ghost", title: "G" }), 404);
    await expectRefused(() => rename({ ref: "a" }), 400);
    // Someone else's private app: not found, nothing revealed.
    await expectRefused(() => rename({ ref: P_ID, title: "Mine now" }), 404);
    await expectRefused(
      () => rename({ ref: `users/${OWNER}/apps/mine`, slug: "x" }),
      404,
    );
    // A member who reads but does not write it: read-only, not "not found".
    as(MEMBER, "member");
    await expectRefused(
      () => rename({ ref: "a", title: "X" }),
      403,
      /read-only/,
    );
    // An API key renames through MCP (rename_object), not this route.
    as(ADMIN, "admin", { kind: "apiKey" });
    await expectRefused(
      () => rename({ ref: "a", title: "X" }),
      403,
      /signed-in user/,
    );
  });
});

describe("old links: GET /objects/resolve", () => {
  it("answers an old name with the current address, and nothing for what the caller cannot see or another workspace's app", async () => {
    as(OWNER, "owner");
    await rename({ ref: P_ID, slug: "p-new" });
    expect((await resolve("p")).json).toMatchObject({
      resolved: { id: P_ID, via: "alias", current: { path: "apps/p-new" } },
    });
    as(ADMIN, "admin");
    for (const ref of ["p", "p-new", P_ID]) {
      expect((await resolve(ref)).status, ref).toBe(404);
    }
    // Another workspace's app, by id or name: never resolved here.
    const OTHER = newId();
    await resetWorkspace(env, WS2, {
      "apps/elsewhere/mako.json": manifest("Elsewhere", OTHER),
    });
    expect((await resolve(OTHER)).status).toBe(404);
    expect((await resolve("elsewhere")).status).toBe(404);
    // Not a member of the workspace at all: refused at the door.
    as(new Types.ObjectId().toString(), undefined, { member: false });
    expect((await resolve("a")).status).toBe(403);
    // A ref longer than any name: a 400, not a scan.
    as(ADMIN, "admin");
    expect((await resolve("x".repeat(1001))).status).toBe(400);
  });

  it("the real-world anchor: /apps/seller-media-buying-3 opens /apps/traffic-performance", async () => {
    const desc = {
      description: "Acquisition dashboard for the non-pro funnels.",
    };
    await externalCommit(WS, {
      "apps/seller-media-buying-3/mako.json": manifest(
        "Seller Media Buying",
        undefined,
        desc,
      ),
      "apps/seller-media-buying-3/src/main.tsx": "export {};\n",
    });
    await AppProject.create({
      _id: new Types.ObjectId(ANCHOR),
      workspaceId: new Types.ObjectId(WS),
      title: "Seller Media Buying",
      slug: "seller-media-buying-3",
      path: "apps/seller-media-buying-3",
      access: "workspace",
      owner_id: ADMIN,
    });
    // The move Mako's UI made before aliases existed: id stamped, no alias.
    await externalCommit(
      WS,
      {
        "apps/traffic-performance/mako.json": manifest(
          "Traffic Performance",
          ANCHOR,
          desc,
        ),
        "apps/traffic-performance/src/main.tsx": "export {};\n",
      },
      [
        "apps/seller-media-buying-3/mako.json",
        "apps/seller-media-buying-3/src/main.tsx",
      ],
      "Move app (apps/seller-media-buying-3 → apps/traffic-performance)",
    );
    expect((await resolve("seller-media-buying-3")).json).toMatchObject({
      resolved: {
        id: ANCHOR,
        via: "alias",
        current: {
          url: "/apps/traffic-performance",
          title: "Traffic Performance",
        },
      },
    });
    const row = (await list()).find(a => a.id === ANCHOR)!;
    expect(row.aliases).toEqual(["seller-media-buying-3"]);
    // GET /apps/<old name> opens it too (every route resolves the same way).
    const opened = await call("GET", "/apps/seller-media-buying-3");
    expect(opened.status).toBe(200);
    expect(opened.json.app).toMatchObject({
      id: ANCHOR,
      path: "apps/traffic-performance",
    });
  });
});

describe("the move dialog: POST /apps/{id}/move", () => {
  it("renames the folder (one commit, old name kept) and refuses what the rules forbid", async () => {
    const id = (await resolveProjectRef(WS, "a"))!._id.toString();
    const before = await headOf(WS);
    const moved = await call("POST", `/apps/${id}/move`, {
      folder: "apps/Sales",
      name: "acq",
    });
    expect(moved.status).toBe(200);
    expect(moved.json).toMatchObject({ to: "apps/Sales/acq", warnings: [] });
    expect(await commitsSince(WS, before)).toBe(1);
    expect((await resolve("a")).json).toMatchObject({
      resolved: { id, via: "alias" },
    });
    await expectRefused(
      () => call("POST", `/apps/${id}/move`, { folder: "apps", name: "aux" }),
      400,
    );
    await expectRefused(
      () => call("POST", `/apps/${id}/move`, { folder: "apps/../users" }),
      400,
    );
    await expectRefused(
      () => call("POST", `/apps/${id}/move`, { folder: `users/${OWNER}/apps` }),
      403,
    );
    as(MEMBER, "viewer");
    await expectRefused(
      () => call("POST", `/apps/${id}/move`, { folder: "apps", name: "z" }),
      403,
      /read-only/,
    );
  });
});

describe("filing an app into a personal folder (it becomes private to the mover)", () => {
  const EDITOR = new Types.ObjectId().toString();
  const W_ID = newId();

  beforeEach(async () => {
    // P is OWNER's private app, shared with EDITOR as an editor; W is a
    // workspace app OWNER owns that every member may edit.
    await AppProject.updateOne(
      { _id: new Types.ObjectId(P_ID) },
      { $set: { sharedWith: [{ userId: EDITOR, role: "editor" }] } },
    );
    await externalCommit(WS, {
      "apps/Team/w/mako.json": manifest("W", W_ID),
    });
    const w = (await resolveProjectRef(WS, W_ID))!;
    await ensureProjectRow(w, OWNER);
    await AppProject.updateOne(
      { _id: w._id },
      { $set: { access: "workspace", workspaceRole: "editor" } },
    );
  });

  it("an editor it is only shared with cannot take it over — not by the move dialog, the agent tool, or a folder move", async () => {
    as(EDITOR, "member");
    await expectRefused(
      () =>
        call("POST", `/apps/${P_ID}/move`, {
          folder: `users/${EDITOR}/apps`,
        }),
      403,
      /owner or a workspace admin/,
    );
    const tools = createAppsTools({ workspaceId: WS, userId: EDITOR });
    const viaTool = (await tools.app_move_app.execute!(
      { appId: P_ID, folder: `users/${EDITOR}/apps` },
      { toolCallId: "t", messages: [] },
    )) as { success: boolean; error?: string };
    expect(viaTool).toMatchObject({
      success: false,
      error: expect.stringMatching(/owner or a workspace admin/),
    });
    // A member may edit W (workspaceRole editor), not privatize it.
    await expectRefused(
      () =>
        call("POST", `/apps/${W_ID}/move`, {
          folder: `users/${EDITOR}/apps`,
        }),
      403,
    );
    await expectRefused(
      () =>
        call("PATCH", "/apps/folders", {
          path: "apps/Team",
          to: `users/${EDITOR}/apps/Team`,
        }),
      403,
    );
    expect(await AppProject.findById(P_ID).lean()).toMatchObject({
      owner_id: OWNER,
      access: "private",
      path: "apps/p",
    });
    // Editing what it is shared for still works: a title, a link.
    expect((await rename({ ref: P_ID, slug: "p-renamed" })).status).toBe(200);
  });

  it("its owner — or a workspace admin — may", async () => {
    as(OWNER, "member");
    const mine = await call("POST", `/apps/${P_ID}/move`, {
      folder: `users/${OWNER}/apps`,
    });
    expect(mine.status).toBe(200);
    expect(await AppProject.findById(P_ID).lean()).toMatchObject({
      owner_id: OWNER,
      access: "private",
      path: `users/${OWNER}/apps/p`,
    });
    as(ADMIN, "admin");
    const admin = await call("POST", `/apps/${W_ID}/move`, {
      folder: `users/${ADMIN}/apps`,
    });
    expect(admin.status).toBe(200);
  });
});

describe("GET /apps", () => {
  it("says who may write each app, and lists nobody's private app to anyone else", async () => {
    as(MEMBER, "member");
    const forMember = await list();
    expect(forMember.find(a => a.path === "apps/a")?.canWrite).toBe(false);
    expect(forMember.some(a => a.id === P_ID)).toBe(false);
    expect(forMember.some(a => a.path.startsWith("users/"))).toBe(false);
    as(OWNER, "owner");
    const forOwner = await list();
    expect(forOwner.find(a => a.id === P_ID)?.canWrite).toBe(true);
    expect(forOwner.some(a => a.path === `users/${OWNER}/apps/mine`)).toBe(
      true,
    );
  });
});

describe("POST /apps and PATCH /apps/folders", () => {
  it("files a new app named like a device as con-2, and refuses control characters", async () => {
    const created = await call("POST", "/apps", { title: "Con" });
    expect(created.status).toBe(200);
    expect(created.json.app).toMatchObject({ path: "apps/con-2" });
    await expectRefused(
      () => call("POST", "/apps", { title: "Bad\u0000" }),
      400,
      /control characters/,
    );
  });

  it("refuses a folder renamed to a device name", async () => {
    await expectRefused(
      () =>
        call("PATCH", "/apps/folders", { path: "apps/Sales", to: "apps/nul" }),
      400,
      /Windows/,
    );
    expect(await fileAt(WS, "apps/Sales/.gitkeep")).toBe("");
  });
});

describe("rename_object over MCP with a workspace API key (mcp, query:read)", () => {
  async function mcpCall(args: Record<string, unknown>) {
    const server = buildMakoMcpServer({
      workspaceId: WS,
      userId: ADMIN,
      memberRole: "admin",
      scopes: ["mcp", "query:read"],
    });
    const transport = new StatelessMcpTransport();
    await server.connect(transport);
    try {
      const [response] = (await transport.handle(
        [
          {
            jsonrpc: "2.0",
            id: "1",
            method: "tools/call",
            params: { name: "rename_object", arguments: args },
          },
        ] as unknown as JSONRPCMessage[],
        60_000,
      )) as unknown as Array<{
        result: { content: Array<{ text: string }>; isError?: boolean };
      }>;
      return response.result;
    } finally {
      await server.close();
    }
  }

  it("renames an app with no extra grant; the kinds that need one are still refused", async () => {
    const ok = await mcpCall({ kind: "app", ref: "a", slug: "via-mcp" });
    expect(ok.isError).toBeFalsy();
    expect(JSON.parse(ok.content[0].text)).toMatchObject({
      success: true,
      after: { path: "apps/via-mcp" },
      aliasesAdded: ["a"],
    });
    for (const kind of ["dbt_job", "skill", "connector"]) {
      const refused = await mcpCall({ kind, ref: "x", slug: "y" });
      expect(refused.isError, kind).toBe(true);
      expect(refused.content[0].text).toMatch(/grant/);
    }
    // The repo was touched once, by the app rename.
    expect(await fileAt(WS, "apps/via-mcp/mako.json")).not.toBeNull();
  });
});
