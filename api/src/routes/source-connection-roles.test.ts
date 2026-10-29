/**
 * Who may configure a source connection: viewers read only; members create,
 * and change or delete the connections they created; owners and admins change
 * or delete any. Revealing a key stays owner/admin only.
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
}));

vi.mock("../auth/unified-auth.middleware", () => ({
  unifiedAuthMiddleware: async (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set("user", { id: who.userId });
    await next();
  },
}));

vi.mock("../services/workspace.service", () => ({
  workspaceService: {
    hasAccess: vi.fn(async () => who.role !== null),
    getMember: vi.fn(async () => (who.role ? { role: who.role } : null)),
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

function as(role: string | null, userId: string) {
  who.role = role;
  who.userId = userId;
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

  it("creates, and may change what they created", async () => {
    const created = await create();
    expect(created.status).toBe(201);
    expect((await created.json()).data.canEdit).toBe(true);
    expect((await rename(mine)).status).toBe(200);
    expect((await enable(mine)).status).toBe(200);
    expect((await remove(mine)).status).toBe(200);
  });

  it("cannot change or delete someone else's", async () => {
    const res = await rename(theirs);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(
      /only the source connections they created/,
    );
    expect((await enable(theirs)).status).toBe(403);
    expect((await remove(theirs)).status).toBe(403);
    const list = (await (await req("GET", "/")).json()).data as {
      name: string;
      canEdit: boolean;
    }[];
    expect(Object.fromEntries(list.map(r => [r.name, r.canEdit]))).toEqual({
      mine: true,
      theirs: false,
    });
  });

  it("cannot reveal a key, even of their own connection", async () => {
    expect(
      (await req("POST", `/${mine}/reveal-secret`, { field: "api_key" }))
        .status,
    ).toBe(403);
  });
});

describe("admin and owner", () => {
  for (const role of ["admin", "owner"]) {
    it(`${role} changes, replaces the key of, and deletes anyone's`, async () => {
      as(role, `${role}1`);
      expect((await rename(theirs)).status).toBe(200);
      expect(
        (await req("PUT", `/${theirs}`, { config: { api_key: "new-key" } }))
          .status,
      ).toBe(200);
      expect((await enable(theirs)).status).toBe(200);
      expect((await remove(theirs)).status).toBe(200);
      expect((await create()).status).toBe(201);
    });
  }
});

describe("not a member", () => {
  it("is refused at the door", async () => {
    as(null, "stranger");
    expect((await req("GET", "/")).status).toBe(403);
    expect((await create()).status).toBe(403);
  });
});
