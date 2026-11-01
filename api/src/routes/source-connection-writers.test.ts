/**
 * The Access tab of a source connection: everyone may look, its editors and
 * the workspace owner change who writes (in the app only; an admin who is not
 * an editor cannot), and the write log shows who tried, with what the list
 * does not cover.
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
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

const who = vi.hoisted(() => ({
  authType: "session" as string,
  userId: "editor1",
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
    getMember: vi.fn(async (_ws: string, userId: string) =>
      userId === who.userId ? { role: who.role } : null,
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
import { SourceConnection } from "../database/workspace-schema";
import { ConnectionWriteEvent } from "../access/connection-write-event";

let mongo: MongoMemoryServer;
const WS = new Types.ObjectId();

const app = new Hono();
app.route(
  "/api/workspaces/:workspaceId/connections/sources",
  sourceConnectionRoutes,
);

function req(method: string, path: string, body?: unknown) {
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
  who.userId = "editor1";
  who.role = "member";
  await SourceConnection.deleteMany({});
  await ConnectionWriteEvent.deleteMany({});
  const row = await SourceConnection.create({
    workspaceId: WS,
    name: "ch_close",
    type: "close",
    config: { api_key: "x" },
    settings: { sync_batch_size: 100, rate_limit_delay_ms: 200 },
    createdBy: "editor1",
  });
  id = String(row._id);
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

  it("lets an editor allow a workflow under one path and turn live reads on and off", async () => {
    const on = await req("PUT", `/${id}/writers`, {
      writers: [],
      liveReads: true,
    });
    expect(on.status).toBe(200);
    expect(
      (await (await req("GET", `/${id}/writers`)).json()).data.liveReads,
    ).toBe(true);
    const put = await req("PUT", `/${id}/writers`, {
      writers: [{ principal: "workflow:fr-offer-to-cash", where: "/task/" }],
      liveReads: false,
    });
    expect(put.status).toBe(200);
    const stored = await SourceConnection.findById(id).lean();
    expect(stored?.writers).toMatchObject([
      {
        principal: "workflow:fr-offer-to-cash",
        where: "/task/",
        addedBy: "editor1",
      },
    ]);
    expect(stored?.liveReads).toBe(false);
  });

  it("refuses a change from an API key, an admin who is not an editor, or for a stranger", async () => {
    const body = { writers: [{ principal: "workflow:x" }] };
    who.authType = "apiKey";
    expect((await req("PUT", `/${id}/writers`, body)).status).toBe(403);
    who.authType = "session";
    who.userId = "admin1";
    who.role = "admin";
    expect((await req("PUT", `/${id}/writers`, body)).status).toBe(403);
    who.userId = "member2";
    who.role = "member";
    expect((await req("PUT", `/${id}/writers`, body)).status).toBe(403);
    who.userId = "editor1";
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

  it("someone who is not an editor sees the list but cannot edit it", async () => {
    for (const [userId, role] of [
      ["admin1", "admin"],
      ["member2", "member"],
    ]) {
      who.userId = userId;
      who.role = role;
      const { data } = await (await req("GET", `/${id}/writers`)).json();
      expect(data.canEdit).toBe(false);
    }
  });

  it("the workspace owner can always change it", async () => {
    who.userId = "owner1";
    who.role = "owner";
    expect(
      (await req("PUT", `/${id}/writers`, { writers: [], liveReads: true }))
        .status,
    ).toBe(200);
  });

  it("shows who tried to write, and what the list does not cover", async () => {
    await SourceConnection.updateOne(
      { _id: id },
      {
        $set: {
          writers: [
            { principal: "workflow:fr-offer-to-cash", where: "/task/" },
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
    ]);
    const { data } = await (await req("GET", `/${id}/writers`)).json();
    const byPrincipal = Object.fromEntries(
      data.recent.map((r: { principal: string; uncovered: string[] }) => [
        r.principal,
        r.uncovered,
      ]),
    );
    expect(byPrincipal["workflow:other-flow"]).toEqual(["POST /task/"]);
    expect(byPrincipal["workflow:fr-offer-to-cash"]).toEqual([
      "PUT /lead/lead_1/",
    ]);
    // The worker naming no workflow cannot be listed, so it is not offered.
    expect(byPrincipal["worker:workflows"]).toBeUndefined();
  });

  it("is scoped to the workspace", async () => {
    const other = await SourceConnection.create({
      workspaceId: new Types.ObjectId(),
      name: "theirs",
      type: "close",
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
