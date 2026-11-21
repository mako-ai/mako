/**
 * The Access tab of a source connection: everyone may look, the people who
 * configure it change who writes (in the app only; who configures is tested
 * in source-connection-roles.test.ts), and the write log shows who tried,
 * with what the list does not cover.
 *
 * Real routes + real Mongo (mongodb-memory-server); auth and workspace roles
 * are mocked.
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
import { ConnectionAccessEvent } from "../access/connection-access-event";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

const who = vi.hoisted(() => ({
  authType: "session" as string,
  userId: "manager1",
  role: "member" as string,
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
    hasAccess: vi.fn(async () => true),
    // The caller has their test role; the connection's creator is a member.
    getMember: vi.fn(async (_ws: string, userId: string) =>
      userId === who.userId
        ? { role: who.role }
        : userId === "manager1"
          ? { role: "member" }
          : null,
    ),
  },
}));

vi.mock("../access/connection-writes", async importOriginal => ({
  ...(await importOriginal<typeof import("../access/connection-writes")>()),
  principalsOutsideWorkspace: vi.fn(async (_ws: string, list: string[]) =>
    list.filter(p => p === "user:stranger"),
  ),
}));

import { sourceConnectionRoutes } from "./source-connections";
import {
  SourceConnection,
  WorkspaceMember,
} from "../database/workspace-schema";
import { writersOutsideRefusal } from "../access/connection-writers-list";
import { ConnectionWriteEvent } from "../access/connection-write-event";
import { syncConnectorRegistry } from "../sync/connector-registry";

let mongo: MongoMemoryServer;
const WS = new Types.ObjectId();

const app = new Hono();
app.route(
  "/api/workspaces/:workspaceId/connections/sources",
  sourceConnectionRoutes,
);

/** A test response whose `json()` is untyped: each assertion states the shape it expects. */
type TestResponse = Omit<Response, "json"> & { json(): Promise<any> };

function req(
  method: string,
  path: string,
  body?: unknown,
): Promise<TestResponse> {
  return Promise.resolve(
    app.request(`/api/workspaces/${WS}/connections/sources${path}`, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
    }),
  );
}

beforeAll(async () => {
  process.env.ENCRYPTION_KEY ??=
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

let id: string;
beforeEach(async () => {
  who.authType = "session";
  who.userId = "manager1";
  who.role = "member";
  await SourceConnection.deleteMany({});
  await ConnectionWriteEvent.deleteMany({});
  await ConnectionAccessEvent.deleteMany({});
  // Tests that add a viewer each create her.
  await WorkspaceMember.deleteMany({ userId: "vera" });
  const row = await SourceConnection.create({
    workspaceId: WS,
    name: "ch_close",
    type: "stripe",
    config: { api_key: "x" },
    settings: { sync_batch_size: 100, rate_limit_delay_ms: 200 },
    createdBy: "manager1",
  });
  id = String(row._id);
});

describe("source connection revision characterization", () => {
  it("can store two config values with the same updatedAt and __v in one millisecond", async () => {
    const clock = vi
      .spyOn(mongoose, "now")
      .mockReturnValue(new Date("2026-01-01T00:00:00.000Z"));
    try {
      await SourceConnection.updateOne(
        { _id: id },
        { $set: { "config.endpoint": "https://first.invalid" } },
      );
      const firstWrite = await SourceConnection.findById(id).lean();
      await SourceConnection.updateOne(
        { _id: id },
        { $set: { "config.endpoint": "https://second.invalid" } },
      );
      const secondWrite = await SourceConnection.findById(id).lean();
      expect(firstWrite?.config.endpoint).toBe("https://first.invalid");
      expect(secondWrite?.config.endpoint).toBe("https://second.invalid");
      expect(secondWrite?.updatedAt).toEqual(firstWrite?.updatedAt);
      expect(secondWrite?.__v).toBe(firstWrite?.__v);
    } finally {
      clock.mockRestore();
    }
  });
});

describe("source connection config revisions", () => {
  it("increments legacy rows for config and active edits, without exposing the counter", async () => {
    const edited = await req("PUT", `/${id}`, { config: { example: "one" } });
    const body = await edited.json();
    expect(edited.status, JSON.stringify(body)).toBe(200);
    expect(body.data.configRevision).toBeUndefined();
    expect(
      (await SourceConnection.findById(id).select("+configRevision").lean())
        ?.configRevision,
    ).toBe(1);

    const disabled = await req("PATCH", `/${id}/enable`, { enabled: false });
    expect(disabled.status).toBe(200);
    expect(
      (await SourceConnection.findById(id).select("+configRevision").lean())
        ?.configRevision,
    ).toBe(2);
    await req("PATCH", `/${id}/enable`, { enabled: false });
    expect(
      (await SourceConnection.findById(id).select("+configRevision").lean())
        ?.configRevision,
    ).toBe(2);
  });

  it("rejects a stale hydrated config after a concurrent active edit", async () => {
    let release!: () => void;
    let reached!: () => void;
    const waiting = new Promise<void>(resolve => {
      reached = resolve;
    });
    const resume = new Promise<void>(resolve => {
      release = resolve;
    });
    const original = syncConnectorRegistry.getConfigSchemaForType.bind(
      syncConnectorRegistry,
    );
    let paused = false;
    const spy = vi
      .spyOn(syncConnectorRegistry, "getConfigSchemaForType")
      .mockImplementation(async (...args) => {
        if (!paused) {
          paused = true;
          reached();
          await resume;
        }
        return original(...args);
      });
    try {
      const edit = req("PUT", `/${id}`, { config: { example: "stale" } });
      await waiting;
      expect(
        (await req("PATCH", `/${id}/enable`, { enabled: false })).status,
      ).toBe(200);
      release();
      expect((await edit).status).toBe(409);
      const row = await SourceConnection.findById(id)
        .select("+configRevision")
        .lean();
      expect(row?.isActive).toBe(false);
      expect(row?.config.example).toBeUndefined();
      expect(row?.configRevision).toBe(1);
    } finally {
      release();
      spy.mockRestore();
    }
  });
});

describe("source connection writers", () => {
  it("starts with no one, and live reads off on an existing connection", async () => {
    const res = await req("GET", `/${id}/writers`);
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data).toMatchObject({
      writers: [],
      canEdit: true,
      liveReads: false,
      callable: true,
      recent: [],
    });
  });

  it("lets a manager allow a workflow and turn live reads on and off", async () => {
    const on = await req("PUT", `/${id}/writers`, {
      writers: [],
      liveReads: true,
    });
    expect(on.status).toBe(200);
    expect(
      (await (await req("GET", `/${id}/writers`)).json()).data.liveReads,
    ).toBe(true);
    // Each deployed workflow acts as itself, so each is kept by its name.
    const put = await req("PUT", `/${id}/writers`, {
      writers: [
        { principal: "workflow:fr-offer-to-cash" },
        { principal: "workflow:other-flow" },
        { principal: "workflow:other-flow" },
      ],
      liveReads: false,
    });
    expect(put.status).toBe(200);
    const stored = await SourceConnection.findById(id).lean();
    expect(stored?.writers).toMatchObject([
      { principal: "workflow:fr-offer-to-cash", addedBy: "manager1" },
      { principal: "workflow:other-flow", addedBy: "manager1" },
    ]);
    expect(stored?.writers).toHaveLength(2);
    expect(stored?.writers?.[0].where).toBeUndefined();
    // Or every deployed workflow at once.
    expect(
      (
        await req("PUT", `/${id}/writers`, {
          writers: [{ principal: "workflow:*" }],
        })
      ).status,
    ).toBe(200);
    expect(stored?.liveReads).toBe(false);
    // Each change is recorded: the switch, what was added, what was removed.
    const events = await ConnectionAccessEvent.find({ connectionId: id })
      .sort({ at: 1 })
      .lean();
    expect(events.map(e => [e.actor, e.via, e.changes])).toEqual([
      ["manager1", "app", { liveReads: true }],
      [
        "manager1",
        "app",
        {
          liveReads: false,
          writers: {
            added: ["workflow:fr-offer-to-cash", "workflow:other-flow"],
            removed: [],
          },
        },
      ],
      [
        "manager1",
        "app",
        {
          writers: {
            added: ["workflow:*"],
            removed: ["workflow:fr-offer-to-cash", "workflow:other-flow"],
          },
        },
      ],
    ]);
  });

  it("limits live reads to the listed, viewers included, and opens them again", async () => {
    expect(
      (await (await req("GET", `/${id}/writers`)).json()).data.liveReaders,
    ).toBeNull();
    await WorkspaceMember.create({
      workspaceId: WS,
      userId: "vera",
      role: "viewer",
      joinedAt: new Date(),
    });
    const put = await req("PUT", `/${id}/writers`, {
      writers: [],
      liveReads: true,
      liveReaders: [
        { principal: "user:vera" },
        { principal: "workflow:fr-offer-to-cash" },
        { principal: "workflow:other-flow" },
      ],
    });
    expect(put.status).toBe(200);
    const { data } = await (await req("GET", `/${id}/writers`)).json();
    expect(data.liveReaders).toMatchObject([
      { principal: "user:vera", addedBy: "manager1" },
      { principal: "workflow:fr-offer-to-cash", where: null },
      { principal: "workflow:other-flow", where: null },
    ]);
    // Omitted: unchanged, while the writers change.
    await req("PUT", `/${id}/writers`, {
      writers: [{ principal: "workflow:*" }],
    });
    expect(
      (await SourceConnection.findById(id).lean())?.liveReaders,
    ).toHaveLength(3);
    // An empty list: only the writers.
    await req("PUT", `/${id}/writers`, { writers: [], liveReaders: [] });
    expect((await SourceConnection.findById(id).lean())?.liveReaders).toEqual(
      [],
    );
    // Null: everyone again.
    await req("PUT", `/${id}/writers`, { writers: [], liveReaders: null });
    expect(
      (await SourceConnection.findById(id).lean())?.liveReaders,
    ).toBeUndefined();
    // Limiting, emptying and reopening live reads are each recorded.
    const readers = (
      await ConnectionAccessEvent.find({ connectionId: id })
        .sort({ at: 1 })
        .lean()
    ).flatMap(e => (e.changes.liveReaders ? [e.changes.liveReaders] : []));
    expect(readers).toEqual([
      {
        added: [
          "user:vera",
          "workflow:fr-offer-to-cash",
          "workflow:other-flow",
        ],
        removed: [],
        limited: true,
      },
      {
        added: [],
        removed: [
          "user:vera",
          "workflow:fr-offer-to-cash",
          "workflow:other-flow",
        ],
      },
      { added: [], removed: [], everyone: true },
    ]);
    // An empty list where everyone read before adds no one and removes no
    // one, and still shuts live reads to all but the writers: recorded.
    await ConnectionAccessEvent.deleteMany({});
    await req("PUT", `/${id}/writers`, { writers: [], liveReaders: [] });
    const [shut] = await ConnectionAccessEvent.find({
      connectionId: id,
    }).lean();
    expect(shut.changes).toEqual({
      liveReaders: { added: [], removed: [], limited: true },
    });
  });

  it("refuses a stranger, an agent or an API key as a live reader", async () => {
    expect(
      (
        await req("PUT", `/${id}/writers`, {
          writers: [],
          liveReaders: [{ principal: "user:stranger" }],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await req("PUT", `/${id}/writers`, {
          writers: [],
          liveReaders: [{ principal: "agent:user:manager1" }],
        })
      ).status,
    ).toBe(400);
    who.authType = "apiKey";
    expect(
      (
        await req("PUT", `/${id}/writers`, {
          writers: [],
          liveReaders: [{ principal: "user:manager1" }],
        })
      ).status,
    ).toBe(403);
    expect(
      (await SourceConnection.findById(id).lean())?.liveReaders,
    ).toBeUndefined();
  });

  it("refuses a change from an API key, or for a stranger", async () => {
    who.authType = "apiKey";
    expect(
      (
        await req("PUT", `/${id}/writers`, {
          writers: [{ principal: "workflow:x" }],
        })
      ).status,
    ).toBe(403);
    who.authType = "session";
    expect(
      (
        await req("PUT", `/${id}/writers`, {
          writers: [{ principal: "user:stranger" }],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await req("PUT", `/${id}/writers`, {
          writers: [{ principal: "worker:workflows" }],
        })
      ).status,
    ).toBe(400);
    expect(
      (await SourceConnection.findById(id).lean())?.writers,
    ).toBeUndefined();
  });

  it("refuses a viewer, or an agent's attempt, as a writer", async () => {
    await WorkspaceMember.create({
      workspaceId: WS,
      userId: "vera",
      role: "viewer",
      joinedAt: new Date(),
    });
    const viewer = await req("PUT", `/${id}/writers`, {
      writers: [{ principal: "user:vera" }],
    });
    expect(viewer.status).toBe(400);
    expect(((await viewer.json()) as { error: string }).error).toMatch(
      /^Viewers can't write through a connection/,
    );
    expect(
      (
        await req("PUT", `/${id}/writers`, {
          writers: [{ principal: "agent:user:manager1" }],
        })
      ).status,
    ).toBe(400);
    expect(
      await writersOutsideRefusal(String(WS), [
        { principal: "agent:user:manager1" },
      ]),
    ).toMatch(/cannot be on a writers list/);
    expect(
      (await SourceConnection.findById(id).lean())?.writers,
    ).toBeUndefined();
  });

  it("shows who tried to write, and what the list does not cover", async () => {
    // A `where` stored on a source writer (from before writers were
    // connection-wide) is ignored: the writer writes anywhere.
    await SourceConnection.updateOne(
      { _id: id },
      {
        $set: {
          writers: [
            { principal: "workflow:fr-offer-to-cash", where: "/legacy/" },
          ],
        },
      },
    );
    const event = (principal: string, target: string, allowed: boolean) => ({
      workspaceId: WS,
      connectionId: new Types.ObjectId(id),
      principal,
      target,
      allowed,
    });
    await ConnectionWriteEvent.create([
      event("workflow:other-flow", "POST /task/", false),
      event("workflow:fr-offer-to-cash", "POST /task/", true),
      event("workflow:fr-offer-to-cash", "PUT /lead/lead_1/", false),
      event("worker:workflows", "POST /task/", false),
      event("agent:user:manager1", "POST /task/", false),
    ]);
    const { data } = await (await req("GET", `/${id}/writers`)).json();
    // Shown by its name, without the ignored `where`.
    expect(data.writers).toMatchObject([
      { principal: "workflow:fr-offer-to-cash", where: null },
    ]);
    const byPrincipal = Object.fromEntries(
      data.recent.map((r: { principal: string; uncovered: string[] }) => [
        r.principal,
        r.uncovered,
      ]),
    );
    // Each workflow's attempts are its own entry: the listed one is covered
    // everywhere, the other is offered.
    expect(byPrincipal["workflow:fr-offer-to-cash"]).toEqual([]);
    expect(byPrincipal["workflow:other-flow"]).toEqual(["POST /task/"]);
    // The worker naming no workflow cannot be listed, so it is not offered.
    expect(byPrincipal["worker:workflows"]).toBeUndefined();
    // Nor an agent's refused attempt: agents never write.
    expect(byPrincipal["agent:user:manager1"]).toBeUndefined();
  });

  it("offers each refused workflow by its name", async () => {
    const event = (principal: string, target: string) => ({
      workspaceId: WS,
      connectionId: new Types.ObjectId(id),
      principal,
      target,
      allowed: false,
    });
    await ConnectionWriteEvent.create([
      event("workflow:a-flow", "POST /task/"),
      event("workflow:b-flow", "PUT /lead/1/"),
    ]);
    const { data } = await (await req("GET", `/${id}/writers`)).json();
    expect(
      data.recent
        .map((r: { principal: string; uncovered: string[] }) => [
          r.principal,
          r.uncovered,
        ])
        .sort(),
    ).toEqual([
      ["workflow:a-flow", ["POST /task/"]],
      ["workflow:b-flow", ["PUT /lead/1/"]],
    ]);
    // Allowing every deployed workflow covers both.
    expect(
      (
        await req("PUT", `/${id}/writers`, {
          writers: [{ principal: "workflow:*" }],
        })
      ).status,
    ).toBe(200);
    const after = await (await req("GET", `/${id}/writers`)).json();
    for (const r of after.data.recent) expect(r.uncovered).toEqual([]);
  });

  it("checks only writers new to the list: a stored viewer blocks no other change", async () => {
    await WorkspaceMember.create({
      workspaceId: WS,
      userId: "vera",
      role: "viewer",
      joinedAt: new Date(),
    });
    // Listed before vera became a viewer.
    await SourceConnection.updateOne(
      { _id: id },
      { $set: { writers: [{ principal: "user:vera" }] } },
    );
    const toggle = await req("PUT", `/${id}/writers`, {
      writers: [{ principal: "user:vera" }],
      liveReads: true,
    });
    expect(toggle.status).toBe(200);
    expect((await SourceConnection.findById(id).lean())?.liveReads).toBe(true);
    // A newcomer is still checked.
    expect(
      (
        await req("PUT", `/${id}/writers`, {
          writers: [{ principal: "user:vera" }, { principal: "user:stranger" }],
        })
      ).status,
    ).toBe(400);
    expect(
      await writersOutsideRefusal(
        String(WS),
        [{ principal: "user:vera" }],
        [{ principal: "user:vera" }],
      ),
    ).toBeNull();
  });

  it("is scoped to the workspace", async () => {
    const other = await SourceConnection.create({
      workspaceId: new Types.ObjectId(),
      name: "theirs",
      type: "stripe",
      config: {},
      settings: { sync_batch_size: 100, rate_limit_delay_ms: 200 },
      createdBy: "x",
    });
    expect((await req("GET", `/${other._id}/writers`)).status).toBe(404);
    expect(
      (await req("PUT", `/${other._id}/writers`, { writers: [] })).status,
    ).toBe(404);
  });
});
