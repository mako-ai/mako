/**
 * The writers list of a DATABASE connection, changed in the app: as on master
 * (before source connections shared the list), only people outside the
 * workspace are refused. A viewer may be listed, and a stored writer who has
 * since become a viewer does not block saving. Source connections are
 * stricter (source-connection-writers.test.ts).
 *
 * Real routes, real Mongo (mongodb-memory-server) and real workspace roles;
 * only the session is a stand-in.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";
import { ConnectionAccessEvent } from "../access/connection-access-event";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

vi.mock("../auth/unified-auth.middleware", () => ({
  unifiedAuthMiddleware: async (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set("user", { id: "owner" });
    c.set("session", { id: "s" });
    c.set("authType", "session");
    await next();
  },
}));

import { workspaceDatabaseRoutes } from "./workspace-databases";
import {
  DatabaseConnection,
  Workspace,
  WorkspaceMember,
} from "../database/workspace-schema";

let mongo: MongoMemoryServer;
const WS = new Types.ObjectId();
const app = new OpenAPIHono();
app.route("/api/workspaces/:workspaceId/databases", workspaceDatabaseRoutes);

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  process.env.ENCRYPTION_KEY ??= "0".repeat(64);
  await Workspace.collection.insertOne({
    _id: WS,
    name: "t",
    slug: `t-${WS}`,
    createdBy: "owner",
    settings: {},
  });
  for (const [userId, role] of [
    ["owner", "owner"],
    ["vic", "viewer"],
    ["dee", "viewer"],
  ] as const) {
    await WorkspaceMember.create({
      workspaceId: WS,
      userId,
      role,
      joinedAt: new Date(),
    });
  }
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe("PUT /databases/{id}/writers in the app", () => {
  it("lists a viewer and keeps a stored writer who became a viewer", async () => {
    // Dee was listed while a member, and is a viewer now.
    const db = await DatabaseConnection.create({
      workspaceId: WS,
      name: "Warehouse",
      type: "postgresql",
      connection: { host: "localhost", database: "w" },
      createdBy: "owner",
      writers: [
        { principal: "user:dee", addedBy: "owner", addedAt: new Date() },
      ],
    });
    const put = (writers: object[]) =>
      app.request(`/api/workspaces/${WS}/databases/${db._id}/writers`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ writers }),
      });
    const res = await put([
      { principal: "user:dee" },
      { principal: "user:vic" },
    ]);
    expect(res.status, await res.clone().text()).toBe(200);
    const stored = await DatabaseConnection.findById(db._id).lean();
    expect(stored?.writers?.map(w => w.principal).sort()).toEqual([
      "user:dee",
      "user:vic",
    ]);
    // Someone outside the workspace is still refused.
    expect((await put([{ principal: "user:stranger" }])).status).toBe(400);
    // The change is recorded, with who made it; the refusal is not.
    const events = await ConnectionAccessEvent.find({
      connectionId: db._id,
    }).lean();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "database",
      via: "app",
      changes: { writers: { added: ["user:vic"], removed: [] } },
    });
    expect(events[0].actor).toBeTruthy();
  });

  it("records allowAgentWrites switched on and off, and nothing for another edit", async () => {
    const db = await DatabaseConnection.create({
      workspaceId: WS,
      name: "Agents",
      type: "postgresql",
      connection: { host: "localhost", database: "a" },
      createdBy: "owner",
    });
    const put = (body: object) =>
      app.request(`/api/workspaces/${WS}/databases/${db._id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await put({ allowAgentWrites: true })).status).toBe(200);
    // Unchanged, then a rename: neither is an access change.
    expect((await put({ allowAgentWrites: true })).status).toBe(200);
    expect((await put({ name: "Agents 2" })).status).toBe(200);
    expect((await put({ allowAgentWrites: false })).status).toBe(200);
    const events = await ConnectionAccessEvent.find({ connectionId: db._id })
      .sort({ at: 1 })
      .lean();
    expect(events.map(e => [e.actor, e.via, e.changes])).toEqual([
      ["owner", "app", { agentWrites: true }],
      ["owner", "app", { agentWrites: false }],
    ]);
  });

  it("rejects POST /databases with an unknown database type before inserting", async () => {
    const beforeCount = await DatabaseConnection.countDocuments({
      workspaceId: WS,
    });
    const res = await app.request(`/api/workspaces/${WS}/databases`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Oracle DB",
        type: "oracle",
        connection: { host: "oracle.internal" },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error?: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain("Unsupported database type");
    expect(await DatabaseConnection.countDocuments({ workspaceId: WS })).toBe(
      beforeCount,
    );
  });
});
