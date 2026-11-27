/**
 * The writers list of a DATABASE connection, changed in the app: as on master
 * (before source connections shared the list), only people outside the
 * workspace are refused. A viewer may be listed, and a stored writer who has
 * since become a viewer does not block saving. Source connections are
 * stricter (source-connection-writers.test.ts).
 *
 * Real routes, PGlite and real workspace roles;
 * only the session is a stand-in.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";
import {
  generateObjectIdHex,
  legacyUserIdToUuidv7,
} from "../database/pg/id-codec";
import { connectionsRepo } from "../repositories/connections";
import {
  ensureTestMember,
  ensureTestWorkspace,
  setupPgTestDb,
  type PgTestDb,
} from "../test-support/pg-test";

const OWNER = legacyUserIdToUuidv7("owner");
const VIC = legacyUserIdToUuidv7("vic");
const DEE = legacyUserIdToUuidv7("dee");

vi.mock("../auth/unified-auth.middleware", () => ({
  unifiedAuthMiddleware: async (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set("user", { id: OWNER });
    c.set("session", { id: "s" });
    c.set("authType", "session");
    await next();
  },
}));

import { workspaceDatabaseRoutes } from "./workspace-databases";
let h: PgTestDb;
const WS = generateObjectIdHex();
const app = new OpenAPIHono();
app.route("/api/workspaces/:workspaceId/databases", workspaceDatabaseRoutes);

beforeAll(async () => {
  h = await setupPgTestDb();
  process.env.ENCRYPTION_KEY ??= "0".repeat(64);
  await ensureTestWorkspace(h.db, { id: WS, ownerUserId: OWNER });
  for (const userId of [VIC, DEE]) {
    await ensureTestMember(h.db, { workspaceId: WS, userId, role: "viewer" });
  }
});

afterAll(() => h.close());

describe("PUT /databases/{id}/writers in the app", () => {
  it("lists a viewer and keeps a stored writer who became a viewer", async () => {
    // Dee was listed while a member, and is a viewer now.
    const db = await connectionsRepo.createDatabaseConnection({
      workspaceId: WS,
      name: "Warehouse",
      type: "postgresql",
      connection: { host: "localhost", database: "w" },
      createdBy: OWNER,
      writers: [
        { principal: `user:${DEE}`, addedBy: OWNER, addedAt: new Date() },
      ],
    });
    const put = (writers: object[]) =>
      app.request(`/api/workspaces/${WS}/databases/${db.id}/writers`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ writers }),
      });
    const res = await put([
      { principal: `user:${DEE}` },
      { principal: `user:${VIC}` },
    ]);
    expect(res.status, await res.clone().text()).toBe(200);
    const stored = await connectionsRepo.findDatabaseConnectionById(db.id, WS);
    expect(stored?.writers?.map(w => w.principal).sort()).toEqual(
      [`user:${DEE}`, `user:${VIC}`].sort(),
    );
    // Someone outside the workspace is still refused.
    expect((await put([{ principal: "user:stranger" }])).status).toBe(400);
    // The change is recorded, with who made it; the refusal is not.
    const events = await connectionsRepo.listConnectionAccessEvents(WS, db.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "database",
      via: "app",
      changes: { writers: { added: [`user:${VIC}`], removed: [] } },
    });
    expect(events[0].actor).toBeTruthy();
  });

  it("records allowAgentWrites switched on and off, and nothing for another edit", async () => {
    const db = await connectionsRepo.createDatabaseConnection({
      workspaceId: WS,
      name: "Agents",
      type: "postgresql",
      connection: { host: "localhost", database: "a" },
      createdBy: OWNER,
    });
    const put = (body: object) =>
      app.request(`/api/workspaces/${WS}/databases/${db.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await put({ allowAgentWrites: true })).status).toBe(200);
    // Unchanged, then a rename: neither is an access change.
    expect((await put({ allowAgentWrites: true })).status).toBe(200);
    expect((await put({ name: "Agents 2" })).status).toBe(200);
    expect((await put({ allowAgentWrites: false })).status).toBe(200);
    const events = (
      await connectionsRepo.listConnectionAccessEvents(WS, db.id)
    ).reverse();
    expect(events.map(e => [e.actor, e.via, e.changes])).toEqual([
      [OWNER, "app", { agentWrites: true }],
      [OWNER, "app", { agentWrites: false }],
    ]);
  });

  it("rejects POST /databases with an unknown database type before inserting", async () => {
    const beforeCount = await connectionsRepo.countDatabaseConnections(WS);
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
    expect(await connectionsRepo.countDatabaseConnections(WS)).toBe(
      beforeCount,
    );
  });
});
