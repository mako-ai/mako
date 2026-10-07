/**
 * Dashboard and connection rename scenarios (graceful rename, #1037).
 *
 * Both kinds live only in Mongo and are addressed by id everywhere
 * (`/d/<id>`, share and embed tokens; `/cx/<id>`, flow files, console
 * front matter, bindings) — a rename is a display-name update: no file,
 * no alias, no uniqueness (two dashboards may share a title; an ambiguous
 * name resolves to nothing). What must hold on every entry point (the
 * objects route, `rename_object`, the editor's PUT): same id; nothing
 * else touched (definition, widgets, shares, access, published snapshot
 * except its title, secrets); the kind's own write rule (a viewer never
 * renames a dashboard; source vs database connection parity); a clear 400
 * for a blank or unusable name — never a 500; nothing of another
 * workspace resolves or renames.
 */
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

const who = vi.hoisted(() => ({ id: "", role: "member" as string | null }));

vi.mock("../../auth/unified-auth.middleware", () => ({
  unifiedAuthMiddleware: async (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set("authType", "session");
    c.set("user", { id: who.id, email: "u@example.com" });
    c.set("session", { id: "s" });
    await next();
  },
  isSessionAuth: () => true,
}));
vi.mock("../../services/workspace.service", () => ({
  workspaceService: {
    hasAccess: async () => who.role !== null,
    getMember: async () => (who.role ? { role: who.role } : null),
    getMembers: async () => [],
    isAdmin: async () => who.role === "admin" || who.role === "owner",
    hasRole: async (_ws: string, _user: string, roles: string[]) =>
      who.role !== null && roles.includes(who.role),
    getWorkspaceById: async (id: string) => ({ _id: new Types.ObjectId(id) }),
  },
}));
vi.mock("../../inngest", () => ({
  inngest: { send: async () => ({}), createFunction: () => ({}) },
}));
const realtime = vi.hoisted(() => ({ events: [] as unknown[] }));
vi.mock("../../services/realtime.service", async importOriginal => ({
  ...(await importOriginal<typeof import("../../services/realtime.service")>()),
  publishRealtimeEvent: (_ws: string, event: unknown) => {
    realtime.events.push(event);
  },
}));

import {
  Dashboard,
  DatabaseConnection,
  SourceConnection,
} from "../../database/workspace-schema";
import { renameObject, resolveObjectRef } from "../../rename/registry";
import { RenameError } from "../../rename/types";
import { dashboardRoutes } from "../dashboards";
import { sourceConnectionRoutes } from "../source-connections";
import { workspaceDatabaseRoutes } from "../workspace-databases";
import { objectRoutes } from "../objects";
import {
  capabilityGrantsFromScopes,
  resolveWorkspaceApiKeyScopes,
} from "../../auth/api-key-scopes";
import { missingInputConditionalGrant } from "../../agent-lib/capabilities/runtime";

const WS = new Types.ObjectId().toString();
const WS2 = new Types.ObjectId().toString();
const OWNER = new Types.ObjectId().toString();
const EDITOR = new Types.ObjectId().toString();
const MEMBER = new Types.ObjectId().toString();
const VIEWER = new Types.ObjectId().toString();
const ADMIN = new Types.ObjectId().toString();

let mongo: MongoMemoryServer;
let app: Hono;

beforeAll(async () => {
  process.env.ENCRYPTION_KEY =
    process.env.ENCRYPTION_KEY ??
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  app = new Hono();
  app.route("/api/workspaces/:workspaceId/dashboards", dashboardRoutes);
  app.route(
    "/api/workspaces/:workspaceId/connections/sources",
    sourceConnectionRoutes,
  );
  app.route("/api/workspaces/:workspaceId/databases", workspaceDatabaseRoutes);
  app.route("/api/workspaces/:workspaceId/objects", objectRoutes);
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await Dashboard.deleteMany({});
  await SourceConnection.deleteMany({});
  await DatabaseConnection.deleteMany({});
  realtime.events.length = 0;
});

async function api(
  method: string,
  url: string,
  as: string,
  role: string | null,
  body?: unknown,
  ws = WS,
) {
  who.id = as;
  who.role = role;
  const res = await app.request(
    `/api/workspaces/${ws}${url}`,
    method === "GET"
      ? { method }
      : {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body ?? {}),
        },
  );
  const text = await res.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed };
}

const ctx = (userId: string | null, role = "member", ws = WS) =>
  userId ? { workspaceId: ws, userId, role } : { workspaceId: ws };

async function status(p: Promise<unknown>): Promise<number> {
  try {
    const r = (await p) as { status?: number };
    return typeof r?.status === "number" ? r.status : 200;
  } catch (error) {
    if (error instanceof RenameError) return error.status;
    return 500;
  }
}

// ---------------------------------------------------------------------------
// Dashboards
// ---------------------------------------------------------------------------

async function dashboard(
  title: string,
  extra: Record<string, unknown> = {},
  ws = WS,
): Promise<string> {
  const doc = await Dashboard.create({
    workspaceId: new Types.ObjectId(ws),
    title,
    description: "kept",
    createdBy: OWNER,
    owner_id: OWNER,
    access: "workspace",
    sharedWith: [{ userId: EDITOR, role: "editor" }],
    widgets: [],
    published: { title, version: 1 },
    ...extra,
  });
  return doc._id.toString();
}

/** Everything a rename must not touch, from the raw document. */
async function untouched(id: string) {
  const raw = (await Dashboard.collection.findOne({
    _id: new Types.ObjectId(id),
  })) as Record<string, unknown>;
  const { title: _t, version: _v, updatedAt: _u, published, ...rest } = raw;
  const { title: _pt, ...publishedRest } = (published ?? {}) as Record<
    string,
    unknown
  >;
  return { rest, publishedRest };
}

type DashEntry = {
  name: string;
  rename: (
    id: string,
    title: string,
    as?: string,
    role?: string | null,
  ) => Promise<number>;
};
const DASH_ENTRIES: DashEntry[] = [
  {
    name: "POST /objects/dashboard/rename (the explorer)",
    rename: async (id, title, as = OWNER, role = "member") =>
      (
        await api("POST", "/objects/dashboard/rename", as, role, {
          ref: id,
          title,
        })
      ).status,
  },
  {
    name: "rename_object (agent / MCP)",
    rename: (id, title, as = OWNER, role = "member") =>
      status(
        renameObject(ctx(as, role ?? "member"), "dashboard", {
          ref: id,
          title,
        }),
      ),
  },
];

describe.each(DASH_ENTRIES)("dashboard — $name", entry => {
  it("renames the title and the published copy's title: same id, version +1, nothing else", async () => {
    const id = await dashboard("Before");
    const before = await untouched(id);
    const version = (await Dashboard.findById(id))!.version;
    expect(await entry.rename(id, "After")).toBe(200);
    const doc = (await Dashboard.findById(id))!;
    expect(doc.title).toBe("After");
    expect(doc.published?.title).toBe("After");
    expect(doc.version).toBe(version + 1);
    expect(await untouched(id)).toEqual(before);
  });

  it("back and forth, onto another's title, its own title in another case — ids never change", async () => {
    const a = await dashboard("Alpha");
    const b = await dashboard("Beta");
    expect(await entry.rename(a, "Beta")).toBe(200);
    // Two dashboards may share a title: the bare title is ambiguous now.
    expect(await resolveObjectRef(ctx(OWNER), "dashboard", "Beta")).toBeNull();
    expect(await entry.rename(a, "Alpha")).toBe(200);
    expect(await entry.rename(a, "ALPHA")).toBe(200);
    expect((await Dashboard.findById(a))!.title).toBe("ALPHA");
    expect((await Dashboard.findById(b))!.title).toBe("Beta");
    expect((await resolveObjectRef(ctx(OWNER), "dashboard", "Beta"))?.id).toBe(
      b,
    );
  });

  it("the write rule: owner, a shared editor and an admin rename; a viewer, a plain member and a non-member never", async () => {
    const id = await dashboard("Guarded");
    const priv = await dashboard("Private", { access: "private" });
    const refused: Array<[string, string | null]> = [
      [MEMBER, "member"],
      [VIEWER, "viewer"],
    ];
    // Not a member at all: only the REST route has a membership to check
    // (`rename_object` runs inside a member's session).
    if (entry.name.startsWith("POST")) refused.push([EDITOR, null]);
    for (const [as, role] of refused) {
      expect([403, 404], `${as}/${role}`).toContain(
        await entry.rename(id, "Nope", as, role),
      );
    }
    // Another member's private dashboard: not even there.
    expect([403, 404]).toContain(await entry.rename(priv, "Nope", MEMBER));
    expect([403, 404]).toContain(
      await entry.rename(priv, "Nope", ADMIN, "admin"),
    );
    expect((await Dashboard.findById(id))!.title).toBe("Guarded");
    expect((await Dashboard.findById(priv))!.title).toBe("Private");
    expect(await entry.rename(id, "By editor", EDITOR, "member")).toBe(200);
    expect(await entry.rename(id, "By admin", ADMIN, "admin")).toBe(200);
    expect(await entry.rename(priv, "By owner", OWNER)).toBe(200);
    // A rename never changes who sees it.
    expect((await Dashboard.findById(priv))!.access).toBe("private");
    expect((await Dashboard.findById(id))!.access).toBe("workspace");
  });

  it("someone else's edit lock refuses it; the lock holder renames", async () => {
    const id = await dashboard("Locked", {
      editLock: {
        userId: EDITOR,
        userName: "Ed",
        acquiredAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    expect(await entry.rename(id, "Mine now", OWNER)).toBe(409);
    expect(await entry.rename(id, "Ed's", EDITOR)).toBe(200);
  });
});

describe("dashboard — names", () => {
  it("hostile titles: blank refused (400) on every path, never a 500; anything else is display text", async () => {
    const id = await dashboard("Start");
    for (const bad of ["", "   ", "\n\t"]) {
      expect(
        await status(
          renameObject(ctx(OWNER), "dashboard", { ref: id, title: bad }),
        ),
      ).toBe(400);
      const put = await api("PUT", `/dashboards/${id}`, OWNER, "member", {
        title: bad,
      });
      expect(put.status, JSON.stringify(put.body)).toBe(400);
      const patch = await api("PATCH", `/dashboards/${id}`, OWNER, "member", {
        title: bad,
      });
      expect([400, 422], JSON.stringify(patch.body)).toContain(patch.status);
    }
    expect((await Dashboard.findById(id))!.title).toBe("Start");
    for (const title of [
      "x".repeat(1000),
      "📊 émoji تقرير",
      "../../etc/passwd",
      "507f1f77bcf86cd799439011",
      "a\u0000b",
    ]) {
      expect(
        await status(renameObject(ctx(OWNER), "dashboard", { ref: id, title })),
      ).toBe(200);
      // The read routes still answer with it.
      const r = await api("GET", `/dashboards/${id}`, OWNER, "member");
      expect(r.status).toBe(200);
    }
    // An id-looking title never shadows a dashboard's id.
    const other = await dashboard("Other");
    await renameObject(ctx(OWNER), "dashboard", { ref: id, title: other });
    expect((await resolveObjectRef(ctx(OWNER), "dashboard", other))?.id).toBe(
      other,
    );
  });

  it("a duplicate is a new private dashboard; renaming either never touches the other", async () => {
    const id = await dashboard("Original");
    const r = await api(
      "POST",
      `/dashboards/${id}/duplicate`,
      MEMBER,
      "member",
    );
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    const copyId = String(
      (r.body.data as { _id?: string; id?: string })?._id ??
        (r.body.data as { id?: string })?.id,
    );
    expect(copyId).not.toBe(id);
    const copy = (await Dashboard.findById(copyId))!;
    expect(copy.access).toBe("private");
    expect(copy.sharedWith ?? []).toEqual([]);
    await renameObject(ctx(MEMBER), "dashboard", {
      ref: copyId,
      title: "Original",
    });
    expect((await Dashboard.findById(id))!.title).toBe("Original");
    expect((await Dashboard.findById(copyId))!.title).toBe("Original");
  });

  it("two renames at once: one title wins, the published copy agrees, the version moved twice", async () => {
    const id = await dashboard("Race");
    const version = (await Dashboard.findById(id))!.version;
    const codes = await Promise.all([
      status(renameObject(ctx(OWNER), "dashboard", { ref: id, title: "One" })),
      status(renameObject(ctx(OWNER), "dashboard", { ref: id, title: "Two" })),
    ]);
    expect(codes).toEqual([200, 200]);
    const doc = (await Dashboard.findById(id))!;
    expect(["One", "Two"]).toContain(doc.title);
    expect(doc.published?.title).toBe(doc.title);
    expect(doc.version).toBe(version + 2);
  });

  it("another workspace's dashboard never resolves or renames here", async () => {
    const foreign = await dashboard("Foreign", {}, WS2);
    expect(
      await resolveObjectRef(ctx(ADMIN, "admin"), "dashboard", foreign),
    ).toBeNull();
    expect(
      await status(
        renameObject(ctx(ADMIN, "admin"), "dashboard", {
          ref: foreign,
          title: "x",
        }),
      ),
    ).toBe(404);
    expect(
      (
        await api("POST", "/objects/dashboard/rename", ADMIN, "admin", {
          ref: foreign,
          title: "x",
        })
      ).status,
    ).toBe(404);
    expect((await Dashboard.findById(foreign))!.title).toBe("Foreign");
  });
});

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

async function source(name: string, ws = WS): Promise<string> {
  const doc = await SourceConnection.create({
    workspaceId: new Types.ObjectId(ws),
    name,
    type: "stripe",
    config: { api_key: "sk_test_SECRET" },
    createdBy: OWNER,
    settings: { sync_batch_size: 100, rate_limit_delay_ms: 0, max_retries: 1 },
    isActive: true,
  });
  return doc._id.toString();
}

async function database(name: string, ws = WS): Promise<string> {
  const doc = await DatabaseConnection.create({
    workspaceId: new Types.ObjectId(ws),
    name,
    type: "postgresql",
    connection: { host: "db.local", database: "app", password: "pw-SECRET" },
    createdBy: OWNER,
  });
  return doc._id.toString();
}

describe("connections", () => {
  it("rename either kind through the objects route and rename_object: same id, secrets and config untouched", async () => {
    const s = await source("Stripe live");
    const d = await database("Warehouse");
    const rawBefore = async () => ({
      s: await SourceConnection.collection.findOne({
        _id: new Types.ObjectId(s),
      }),
      d: await DatabaseConnection.collection.findOne({
        _id: new Types.ObjectId(d),
      }),
    });
    const before = await rawBefore();
    expect(
      (
        await api("POST", "/objects/connection/rename", MEMBER, "member", {
          ref: s,
          title: "Stripe (live)",
        })
      ).status,
    ).toBe(200);
    expect(
      await status(
        renameObject(ctx(MEMBER), "connection", { ref: d, title: "DWH" }),
      ),
    ).toBe(200);
    const after = await rawBefore();
    expect(after.s?.name).toBe("Stripe (live)");
    expect(after.d?.name).toBe("DWH");
    expect(after.s?.config).toEqual(before.s?.config);
    expect(after.d?.connection).toEqual(before.d?.connection);
    expect(after.s?.settings).toEqual(before.s?.settings);
    expect((await resolveObjectRef(ctx(MEMBER), "connection", "DWH"))?.id).toBe(
      d,
    );
    expect(
      (await resolveObjectRef(ctx(MEMBER), "connection", s))?.current.url,
    ).toBe(`/cx/${s}`);
  });

  it("the write rule per kind: a viewer renames a source but not a database; a non-member nothing", async () => {
    const s = await source("Src");
    const d = await database("Db");
    expect(
      await status(
        renameObject(ctx(VIEWER, "viewer"), "connection", {
          ref: s,
          title: "Src 2",
        }),
      ),
    ).toBe(200);
    expect(
      await status(
        renameObject(ctx(VIEWER, "viewer"), "connection", {
          ref: d,
          title: "Db 2",
        }),
      ),
    ).toBe(403);
    expect(
      (
        await api("POST", "/objects/connection/rename", MEMBER, null, {
          ref: d,
          title: "x",
        })
      ).status,
    ).toBe(403);
    expect((await DatabaseConnection.findById(d))!.name).toBe("Db");
  });

  it("blank or unusable names are a clear 400 on every path — never a 500", async () => {
    const s = await source("Src");
    const d = await database("Db");
    for (const bad of ["", "   "]) {
      for (const id of [s, d]) {
        expect(
          await status(
            renameObject(ctx(MEMBER), "connection", { ref: id, title: bad }),
          ),
        ).toBe(400);
      }
      const put = await api(
        "PUT",
        `/connections/sources/${s}`,
        MEMBER,
        "member",
        { name: bad },
      );
      expect(put.status, JSON.stringify(put.body)).not.toBe(500);
      const putDb = await api("PUT", `/databases/${d}`, MEMBER, "member", {
        name: bad,
      });
      expect(putDb.status, JSON.stringify(putDb.body)).not.toBe(500);
    }
    expect((await SourceConnection.findById(s))!.name).toBe("Src");
    expect((await DatabaseConnection.findById(d))!.name).toBe("Db");
    // Display text otherwise — the id addresses it.
    for (const title of ["x".repeat(1000), "a\u0000b", "📊", "../../x"]) {
      expect(
        await status(
          renameObject(ctx(MEMBER), "connection", { ref: s, title }),
        ),
      ).toBe(200);
    }
  });

  it("an id-looking name never shadows another connection's id; an ambiguous name resolves to nothing", async () => {
    const a = await source("A");
    const b = await database("B");
    await renameObject(ctx(MEMBER), "connection", { ref: a, title: b });
    expect((await resolveObjectRef(ctx(MEMBER), "connection", b))?.id).toBe(b);
    await renameObject(ctx(MEMBER), "connection", { ref: b, title: "Same" });
    await renameObject(ctx(MEMBER), "connection", { ref: a, title: "Same" });
    expect(
      await resolveObjectRef(ctx(MEMBER), "connection", "Same"),
    ).toBeNull();
  });

  it("another workspace's connection never resolves or renames here", async () => {
    const foreign = await source("Foreign", WS2);
    expect(
      await resolveObjectRef(ctx(ADMIN, "admin"), "connection", foreign),
    ).toBeNull();
    expect(
      await status(
        renameObject(ctx(ADMIN, "admin"), "connection", {
          ref: foreign,
          title: "x",
        }),
      ),
    ).toBe(404);
    expect((await SourceConnection.findById(foreign))!.name).toBe("Foreign");
  });
});

describe("an MCP key with `mcp query:read` only", () => {
  it("passes rename_object's gate for consoles, notebooks, dashboards and connections — and not for dbt jobs, skills or connectors", () => {
    // What such a key holds: no scope maps to a grant; the implicit
    // headless-authoring grants external MCP always has (no git or
    // warehouse write among them).
    const grants = new Set([
      ...capabilityGrantsFromScopes(
        resolveWorkspaceApiKeyScopes(["mcp", "query:read"]),
      ),
      "artifact-write" as const,
      "schedule-write" as const,
    ]);
    for (const kind of ["console", "notebook", "dashboard", "connection"]) {
      expect(
        missingInputConditionalGrant("rename_object", { kind }, grants),
        kind,
      ).toBeNull();
    }
    for (const kind of ["dbt_job", "skill", "connector"]) {
      expect(
        missingInputConditionalGrant("rename_object", { kind }, grants),
        kind,
      ).not.toBeNull();
    }
  });
});
