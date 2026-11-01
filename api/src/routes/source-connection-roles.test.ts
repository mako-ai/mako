/**
 * Who may configure a source connection: its editors (the creator first, then
 * whoever an editor adds) and the workspace owner. Being an admin is not
 * enough. Viewers read only, even when listed. Revealing a key follows the
 * same rule.
 *
 * Real routes + real Mongo (mongodb-memory-server); auth, roles and the
 * connector schema are mocked.
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
import { Hono } from "hono";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

const who = vi.hoisted(() => ({
  userId: "member1",
  role: "member" as string | null,
  authType: "session",
  // Everyone else's role, for checking who may be added as an editor.
  others: {
    member2: "member",
    "someone-else": "member",
    admin2: "admin",
    viewer2: "viewer",
  } as Record<string, string>,
}));

vi.mock("../auth/unified-auth.middleware", () => ({
  unifiedAuthMiddleware: async (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set("user", { id: who.userId });
    c.set("authType", who.authType);
    await next();
  },
}));

vi.mock("../services/workspace.service", () => ({
  workspaceService: {
    hasAccess: vi.fn(async () => who.role !== null),
    getMember: vi.fn(async (_ws: string, userId: string) => {
      const role = userId === who.userId ? who.role : who.others[userId];
      return role ? { role } : null;
    }),
    isAdmin: vi.fn(async () => who.role === "owner" || who.role === "admin"),
  },
}));

vi.mock("../sync/connector-registry", () => ({
  syncConnectorRegistry: {
    getConfigSchemaForType: vi.fn(async () => ({
      fields: [{ name: "api_key", type: "password", encrypted: true }],
    })),
    getConnectorFor: vi.fn(async () => null),
  },
}));

vi.mock("../connectors/registry", () => ({
  connectorRegistry: { hasConnector: vi.fn(() => true) },
}));

import { sourceConnectionRoutes } from "./source-connections";
import { SourceConnection } from "../database/workspace-schema";

let mongo: MongoMemoryServer;
const WS = new Types.ObjectId();

const app = new Hono();
app.route(
  "/api/workspaces/:workspaceId/connections/sources",
  sourceConnectionRoutes,
);

function req(method: string, path: string, body?: unknown) {
  return Promise.resolve(
    app.request(
      `/api/workspaces/${WS}/connections/sources${path === "/" ? "" : path}`,
      {
        method,
        ...(body === undefined
          ? {}
          : {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            }),
      },
    ),
  );
}

function as(role: string | null, userId: string, authType = "session") {
  who.role = role;
  who.userId = userId;
  who.authType = authType;
}

beforeAll(async () => {
  process.env.ENCRYPTION_KEY ??= "0".repeat(64);
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

let mine: string;
let theirs: string;
beforeEach(async () => {
  await SourceConnection.deleteMany({});
  const make = async (name: string, createdBy: string) =>
    String(
      (
        await SourceConnection.create({
          workspaceId: WS,
          name,
          type: "close",
          config: { api_key: "k" },
          settings: { sync_batch_size: 100, rate_limit_delay_ms: 200 },
          createdBy,
        })
      )._id,
    );
  mine = await make("mine", "member1");
  theirs = await make("theirs", "someone-else");
});

const create = () =>
  req("POST", "/", {
    name: "new",
    type: "close",
    config: { api_key: "k" },
    settings: { sync_batch_size: 100, rate_limit_delay_ms: 200 },
  });
const rename = (id: string) => req("PUT", `/${id}`, { name: "renamed" });
const enable = (id: string) =>
  req("PATCH", `/${id}/enable`, { enabled: false });
const remove = (id: string) => req("DELETE", `/${id}`);
const reveal = (id: string) =>
  req("POST", `/${id}/reveal-secret`, { field: "api_key" });
const setEditors = (id: string, editors: string[]) =>
  req("PUT", `/${id}/editors`, { editors });
const editorsOfRow = async (id: string) =>
  (await (await req("GET", `/${id}/editors`)).json()).data as {
    editors: string[];
    canEdit: boolean;
  };

describe("viewer", () => {
  beforeEach(() => as("viewer", "viewer1"));

  it("reads, and is told it cannot change anything", async () => {
    const list = await req("GET", "/");
    expect(list.status).toBe(200);
    const { data } = await list.json();
    expect(data).toHaveLength(2);
    expect(data.every((row: { canEdit: boolean }) => !row.canEdit)).toBe(true);
    const one = await (await req("GET", `/${mine}`)).json();
    expect(one.data.canEdit).toBe(false);
  });

  it("cannot create, edit, disable or delete", async () => {
    expect((await create()).status).toBe(403);
    for (const id of [mine, theirs]) {
      expect((await rename(id)).status).toBe(403);
      expect((await enable(id)).status).toBe(403);
      expect((await remove(id)).status).toBe(403);
    }
    expect(await SourceConnection.countDocuments()).toBe(2);
    expect((await SourceConnection.findById(mine).lean())?.name).toBe("mine");
  });
});

describe("member", () => {
  beforeEach(() => as("member", "member1"));

  it("creates, and is the first editor of what they create", async () => {
    const created = await create();
    expect(created.status).toBe(201);
    const body = (await created.json()).data;
    expect(body.canEdit).toBe(true);
    expect(body.editors).toEqual(["member1"]);
    expect((await rename(mine)).status).toBe(200);
    expect((await reveal(mine)).status).toBe(200);
    expect((await enable(mine)).status).toBe(200);
    expect((await remove(mine)).status).toBe(200);
  });

  it("cannot change, reveal or delete a connection they are not an editor of", async () => {
    const res = await rename(theirs);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/Only this connection's editors/);
    expect((await reveal(theirs)).status).toBe(403);
    expect((await enable(theirs)).status).toBe(403);
    expect((await remove(theirs)).status).toBe(403);
    expect((await setEditors(theirs, ["member1"])).status).toBe(403);
    const list = (await (await req("GET", "/")).json()).data as {
      name: string;
      canEdit: boolean;
    }[];
    expect(Object.fromEntries(list.map(r => [r.name, r.canEdit]))).toEqual({
      mine: true,
      theirs: false,
    });
  });
});

describe("admin", () => {
  beforeEach(() => as("admin", "admin1"));

  it("cannot configure a connection they are not an editor of", async () => {
    expect((await rename(theirs)).status).toBe(403);
    expect(
      (await req("PUT", `/${theirs}`, { config: { api_key: "new-key" } }))
        .status,
    ).toBe(403);
    expect((await reveal(theirs)).status).toBe(403);
    expect((await enable(theirs)).status).toBe(403);
    expect((await remove(theirs)).status).toBe(403);
    expect((await setEditors(theirs, ["admin1"])).status).toBe(403);
    expect(await SourceConnection.countDocuments()).toBe(2);
  });

  it("configures one once an editor adds them", async () => {
    as("member", "someone-else");
    who.others.admin1 = "admin";
    expect((await setEditors(theirs, ["someone-else", "admin1"])).status).toBe(
      200,
    );
    as("admin", "admin1");
    expect((await editorsOfRow(theirs)).canEdit).toBe(true);
    expect((await rename(theirs)).status).toBe(200);
    expect((await reveal(theirs)).status).toBe(200);
    delete who.others.admin1;
  });
});

describe("workspace owner", () => {
  beforeEach(() => as("owner", "owner1"));

  it("configures any connection, the way back when its editors are gone", async () => {
    expect((await rename(theirs)).status).toBe(200);
    expect(
      (await req("PUT", `/${theirs}`, { config: { api_key: "new-key" } }))
        .status,
    ).toBe(200);
    expect((await reveal(theirs)).status).toBe(200);
    expect((await setEditors(theirs, ["member2"])).status).toBe(200);
    expect((await enable(theirs)).status).toBe(200);
    expect((await remove(theirs)).status).toBe(200);
    expect((await create()).status).toBe(201);
  });
});

describe("editors list", () => {
  it("defaults to the creator for a connection stored without one", async () => {
    as("viewer", "viewer1");
    expect(await editorsOfRow(theirs)).toEqual({
      editors: ["someone-else"],
      canEdit: false,
    });
  });

  it("an editor hands over: the new editor configures, the old one no longer does", async () => {
    as("member", "member1");
    expect((await setEditors(mine, ["member2"])).status).toBe(200);
    expect((await rename(mine)).status).toBe(403);
    as("member", "member2");
    expect((await rename(mine)).status).toBe(200);
    expect((await editorsOfRow(mine)).editors).toEqual(["member2"]);
  });

  it("shows no one for a connection created by `system`, until the owner adds editors", async () => {
    const seeded = String(
      (
        await SourceConnection.create({
          workspaceId: WS,
          name: "seeded",
          type: "close",
          config: { api_key: "k" },
          settings: { sync_batch_size: 100, rate_limit_delay_ms: 200 },
          createdBy: "system",
        })
      )._id,
    );
    as("admin", "admin2");
    expect(await editorsOfRow(seeded)).toEqual({ editors: [], canEdit: false });
    expect((await rename(seeded)).status).toBe(403);
    as("owner", "owner1");
    expect((await editorsOfRow(seeded)).canEdit).toBe(true);
    expect((await setEditors(seeded, ["admin2"])).status).toBe(200);
    as("admin", "admin2");
    expect(await editorsOfRow(seeded)).toEqual({
      editors: ["admin2"],
      canEdit: true,
    });
    expect((await rename(seeded)).status).toBe(200);
  });

  it("does not show a listed editor who left or became a viewer", async () => {
    as("member", "member1");
    expect(
      (await setEditors(mine, ["member1", "member2", "admin2"])).status,
    ).toBe(200);
    who.others.member2 = "viewer";
    delete who.others.admin2;
    expect((await editorsOfRow(mine)).editors).toEqual(["member1"]);
    who.others.member2 = "member";
    who.others.admin2 = "admin";
  });

  it("refuses viewers, strangers and an empty list", async () => {
    as("member", "member1");
    expect((await setEditors(mine, ["member1", "viewer2"])).status).toBe(400);
    expect((await setEditors(mine, ["member1", "stranger"])).status).toBe(400);
    expect((await setEditors(mine, [])).status).toBe(400);
    expect((await editorsOfRow(mine)).editors).toEqual(["member1"]);
  });

  it("a listed member demoted to viewer loses the right", async () => {
    as("member", "member1");
    expect((await setEditors(mine, ["member1", "member2"])).status).toBe(200);
    as("viewer", "member2");
    expect((await rename(mine)).status).toBe(403);
    expect((await reveal(mine)).status).toBe(403);
  });

  it("is changed in the app only, never with an API key", async () => {
    as("member", "member1", "api_key");
    expect((await setEditors(mine, ["member1", "member2"])).status).toBe(403);
    expect((await editorsOfRow(mine)).canEdit).toBe(false);
  });

  it("cannot be set through the ordinary update", async () => {
    as("member", "member1");
    expect(
      (await req("PUT", `/${mine}`, { editors: ["member2"], name: "x" }))
        .status,
    ).toBe(200);
    expect((await editorsOfRow(mine)).editors).toEqual(["member1"]);
  });
});

describe("not a member", () => {
  it("is refused at the door", async () => {
    as(null, "stranger");
    expect((await req("GET", "/")).status).toBe(403);
    expect((await create()).status).toBe(403);
  });
});
