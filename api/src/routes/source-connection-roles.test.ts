/**
 * Who may configure a source connection: its managers (the creator first, then
 * whoever a manager adds) and the workspace owner. Being an admin is not
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
  // Everyone else's role, for checking who may be added as a manager.
  others: {
    member2: "member",
    "someone-else": "member",
    admin2: "admin",
    viewer2: "viewer",
    owner1: "owner",
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
    getOwnerIds: vi.fn(async () => ["owner1"]),
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
const setManagers = (id: string, managers: string[]) =>
  req("PUT", `/${id}/managers`, { managers });
const managersOfRow = async (id: string) => {
  const { managers, canEdit } = (await (await req("GET", `/${id}`)).json())
    .data as { managers: string[]; canEdit: boolean };
  return { managers, canEdit };
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

  it("creates, and is the first manager of what they create", async () => {
    const created = await create();
    expect(created.status).toBe(201);
    const body = (await created.json()).data;
    expect(body.canEdit).toBe(true);
    expect(body.managers).toEqual(["member1"]);
    expect((await rename(mine)).status).toBe(200);
    expect((await reveal(mine)).status).toBe(200);
    expect((await enable(mine)).status).toBe(200);
    expect((await remove(mine)).status).toBe(200);
  });

  it("cannot change, reveal or delete a connection they are not a manager of", async () => {
    const res = await rename(theirs);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/Only this connection's managers/);
    expect((await reveal(theirs)).status).toBe(403);
    expect((await enable(theirs)).status).toBe(403);
    expect((await remove(theirs)).status).toBe(403);
    expect((await setManagers(theirs, ["member1"])).status).toBe(403);
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

  it("cannot configure a connection they are not a manager of", async () => {
    expect((await rename(theirs)).status).toBe(403);
    expect(
      (await req("PUT", `/${theirs}`, { config: { api_key: "new-key" } }))
        .status,
    ).toBe(403);
    expect((await reveal(theirs)).status).toBe(403);
    expect((await enable(theirs)).status).toBe(403);
    expect((await remove(theirs)).status).toBe(403);
    expect((await setManagers(theirs, ["admin1"])).status).toBe(403);
    expect(await SourceConnection.countDocuments()).toBe(2);
  });

  it("configures one once a manager adds them", async () => {
    as("member", "someone-else");
    who.others.admin1 = "admin";
    expect((await setManagers(theirs, ["someone-else", "admin1"])).status).toBe(
      200,
    );
    as("admin", "admin1");
    expect((await managersOfRow(theirs)).canEdit).toBe(true);
    expect((await rename(theirs)).status).toBe(200);
    expect((await reveal(theirs)).status).toBe(200);
    delete who.others.admin1;
  });
});

describe("workspace owner", () => {
  beforeEach(() => as("owner", "owner1"));

  it("configures any connection, the way back when its managers are gone", async () => {
    expect((await rename(theirs)).status).toBe(200);
    expect(
      (await req("PUT", `/${theirs}`, { config: { api_key: "new-key" } }))
        .status,
    ).toBe(200);
    expect((await reveal(theirs)).status).toBe(200);
    expect((await setManagers(theirs, ["member2"])).status).toBe(200);
    expect((await enable(theirs)).status).toBe(200);
    expect((await remove(theirs)).status).toBe(200);
    expect((await create()).status).toBe(201);
  });
});

describe("managers list", () => {
  it("defaults to the creator for a connection stored without one", async () => {
    as("viewer", "viewer1");
    expect(await managersOfRow(theirs)).toEqual({
      managers: ["someone-else"],
      canEdit: false,
    });
  });

  it("a manager hands over: the new manager configures, the old one no longer does", async () => {
    as("member", "member1");
    expect((await setManagers(mine, ["member2"])).status).toBe(200);
    expect((await rename(mine)).status).toBe(403);
    as("member", "member2");
    expect((await rename(mine)).status).toBe(200);
    expect((await managersOfRow(mine)).managers).toEqual(["member2"]);
  });

  it("a connection created by `system` has no manager: the workspace owner manages it", async () => {
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
    as("member", "member1");
    expect(await managersOfRow(seeded)).toEqual({
      managers: ["owner1"],
      canEdit: false,
    });
    expect((await rename(seeded)).status).toBe(403);
    // Admins have no fallback: the owner is its manager.
    as("admin", "admin2");
    expect(await managersOfRow(seeded)).toEqual({
      managers: ["owner1"],
      canEdit: false,
    });
    expect((await rename(seeded)).status).toBe(403);
    expect((await reveal(seeded)).status).toBe(403);
    // The owner hands it to someone, who then configures it.
    as("owner", "owner1");
    expect((await setManagers(seeded, ["member2"])).status).toBe(200);
    as("member", "member2");
    expect((await rename(seeded)).status).toBe(200);
  });

  it("a connection whose managers all left goes to the workspace owner", async () => {
    delete who.others["someone-else"];
    as("admin", "admin2");
    expect((await rename(theirs)).status).toBe(403);
    expect((await managersOfRow(theirs)).managers).toEqual(["owner1"]);
    as("owner", "owner1");
    expect((await rename(theirs)).status).toBe(200);
    who.others["someone-else"] = "member";
  });

  it("records the creator as the first manager when a connection is created", async () => {
    as("member", "member1");
    const created = (await (await create()).json()).data;
    const stored = await SourceConnection.findById(created._id).lean();
    expect(stored?.createdBy).toBe("member1");
    expect(stored?.managers).toEqual(["member1"]);
  });

  it("does not show a listed manager who left or became a viewer", async () => {
    as("member", "member1");
    expect(
      (await setManagers(mine, ["member1", "member2", "admin2"])).status,
    ).toBe(200);
    who.others.member2 = "viewer";
    delete who.others.admin2;
    expect((await managersOfRow(mine)).managers).toEqual(["member1"]);
    who.others.member2 = "member";
    who.others.admin2 = "admin";
  });

  it("refuses viewers, strangers and an empty list", async () => {
    as("member", "member1");
    const viewer = await setManagers(mine, ["member1", "viewer2"]);
    expect(viewer.status).toBe(400);
    expect((await viewer.json()).error).toBe(
      "Managers must be members or admins of this workspace, not viewers.",
    );
    expect((await setManagers(mine, ["member1", "stranger"])).status).toBe(400);
    expect((await setManagers(mine, [])).status).toBe(400);
    expect((await managersOfRow(mine)).managers).toEqual(["member1"]);
  });

  it("a listed member demoted to viewer loses the right", async () => {
    as("member", "member1");
    expect((await setManagers(mine, ["member1", "member2"])).status).toBe(200);
    as("viewer", "member2");
    expect((await rename(mine)).status).toBe(403);
    expect((await reveal(mine)).status).toBe(403);
  });

  it("is changed in the app only, never with an API key", async () => {
    as("member", "member1", "api_key");
    const res = await setManagers(mine, ["member1", "member2"]);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/only be changed in the app/);
    expect((await managersOfRow(mine)).managers).toEqual(["member1"]);
  });

  it("cannot be set through the ordinary update", async () => {
    as("member", "member1");
    expect(
      (await req("PUT", `/${mine}`, { managers: ["member2"], name: "x" }))
        .status,
    ).toBe(200);
    expect((await managersOfRow(mine)).managers).toEqual(["member1"]);
  });
});

describe("in the app only", () => {
  it("a key is revealed to a session, never to an API key", async () => {
    as("member", "member1", "api_key");
    const res = await reveal(mine);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(
      "Keys can only be revealed in the app",
    );
    as("member", "member1");
    expect((await reveal(mine)).status).toBe(200);
  });

  it("an API key cannot change the address or type, but can rename", async () => {
    const api = String(
      (
        await SourceConnection.create({
          workspaceId: WS,
          name: "api",
          type: "custom_api",
          config: { base_url: "https://a.example.com", token: "tok_123456" },
          settings: { sync_batch_size: 100, rate_limit_delay_ms: 200 },
          createdBy: "member1",
        })
      )._id,
    );
    as("member", "member1", "api_key");
    const moved = await req("PUT", `/${api}`, {
      config: { base_url: "https://evil.example.com" },
    });
    expect(moved.status).toBe(403);
    expect((await moved.json()).error).toBe(
      "The address can only be changed in the app",
    );
    expect((await req("PUT", `/${mine}`, { type: "stripe" })).status).toBe(403);
    const row = await SourceConnection.findById(api).lean();
    expect(row?.config?.base_url).toBe("https://a.example.com");
    expect((await req("PUT", `/${api}`, { name: "renamed" })).status).toBe(200);
    // The same address sent back unchanged is not a change.
    expect(
      (
        await req("PUT", `/${api}`, {
          config: { base_url: "https://a.example.com" },
        })
      ).status,
    ).toBe(200);
    as("member", "member1");
    expect(
      (
        await req("PUT", `/${api}`, {
          config: { base_url: "https://b.example.com" },
        })
      ).status,
    ).toBe(200);
  });
});

describe("a key with a control character inside", () => {
  beforeEach(() => as("member", "member1"));
  const REFUSAL =
    "This key contains an invalid character (a line break or control character).";

  it("is refused on create and on update", async () => {
    const created = await req("POST", "/", {
      name: "bad",
      type: "close",
      config: { api_key: "abc\ndef" },
    });
    expect(created.status).toBe(400);
    expect((await created.json()).error).toBe(REFUSAL);
    const updated = await req("PUT", `/${mine}`, {
      config: { api_key: "abc\u0000def" },
    });
    expect(updated.status).toBe(400);
    expect((await updated.json()).error).toBe(REFUSAL);
    expect(await SourceConnection.countDocuments()).toBe(2);
  });

  it("a line break at either end is trimmed, not refused", async () => {
    const created = await req("POST", "/", {
      name: "pasted",
      type: "close",
      config: { api_key: "abcdef\n" },
    });
    expect(created.status).toBe(201);
  });
});

describe("not a member", () => {
  it("is refused at the door", async () => {
    as(null, "stranger");
    expect((await req("GET", "/")).status).toBe(403);
    expect((await create()).status).toBe(403);
  });
});
