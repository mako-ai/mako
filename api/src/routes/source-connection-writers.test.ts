/**
 * The Access tab of a source connection: everyone may look, the people who
 * configure it change who writes (in the app only; who configures is tested
 * in source-connection-roles.test.ts), and the write log shows who tried,
 * with what the list does not cover.
 *
 * Real routes and PGlite; auth and workspace roles
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
import { Types } from "mongoose";
import { legacyUserIdToUuidv7 } from "../database/pg/id-codec";
import { connectionsRepo } from "../repositories/connections";
import {
  type PgTestDb,
  setupPgTestDb,
  ensureTestWorkspace,
  ensureTestUser,
  ensureTestMember,
} from "../test-support/pg-test";

const who = vi.hoisted(() => ({
  authType: "session" as string,
  userId: "",
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
        : userId === MANAGER
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
import { writersOutsideRefusal } from "../access/connection-writers-list";

const MANAGER = legacyUserIdToUuidv7("manager1");
const VERA = legacyUserIdToUuidv7("vera");

let pg: PgTestDb;
const WS = new Types.ObjectId().toString();

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
  pg = await setupPgTestDb();
});

afterAll(async () => {
  await pg?.close();
});

let id: string;
beforeEach(async () => {
  who.authType = "session";
  who.userId = MANAGER;
  who.role = "member";
  await pg.reset();
  await ensureTestWorkspace(pg.db, { id: WS });
  await ensureTestUser(pg.db, { id: MANAGER });
  const row = await connectionsRepo.createSourceConnection({
    workspaceId: WS,
    name: "ch_close",
    type: "stripe",
    config: { api_key: "x" },
    settings: { sync_batch_size: 100, rate_limit_delay_ms: 200 },
    createdBy: MANAGER,
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
    const stored = await connectionsRepo.findSourceConnectionById(id, WS);
    expect(stored?.writers).toMatchObject([
      { principal: "workflow:fr-offer-to-cash", addedBy: MANAGER },
      { principal: "workflow:other-flow", addedBy: MANAGER },
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
    const events = (
      await connectionsRepo.listConnectionAccessEvents(WS, id)
    ).reverse();
    expect(events.map(e => [e.actor, e.via, e.changes])).toEqual([
      [MANAGER, "app", { liveReads: true }],
      [
        MANAGER,
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
        MANAGER,
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
    await ensureTestMember(pg.db, {
      workspaceId: WS,
      userId: VERA,
      role: "viewer",
    });
    const put = await req("PUT", `/${id}/writers`, {
      writers: [],
      liveReads: true,
      liveReaders: [
        { principal: `user:${VERA}` },
        { principal: "workflow:fr-offer-to-cash" },
        { principal: "workflow:other-flow" },
      ],
    });
    expect(put.status).toBe(200);
    const { data } = await (await req("GET", `/${id}/writers`)).json();
    expect(data.liveReaders).toMatchObject([
      { principal: `user:${VERA}`, addedBy: MANAGER },
      { principal: "workflow:fr-offer-to-cash", where: null },
      { principal: "workflow:other-flow", where: null },
    ]);
    // Omitted: unchanged, while the writers change.
    await req("PUT", `/${id}/writers`, {
      writers: [{ principal: "workflow:*" }],
    });
    expect(
      (await connectionsRepo.findSourceConnectionById(id, WS))?.liveReaders,
    ).toHaveLength(3);
    // An empty list: only the writers.
    await req("PUT", `/${id}/writers`, { writers: [], liveReaders: [] });
    expect(
      (await connectionsRepo.findSourceConnectionById(id, WS))?.liveReaders,
    ).toEqual([]);
    // Null: everyone again.
    await req("PUT", `/${id}/writers`, { writers: [], liveReaders: null });
    expect(
      (await connectionsRepo.findSourceConnectionById(id, WS))?.liveReaders,
    ).toBeUndefined();
    // Limiting, emptying and reopening live reads are each recorded.
    const readers = (await connectionsRepo.listConnectionAccessEvents(WS, id))
      .reverse()
      .flatMap(e => (e.changes.liveReaders ? [e.changes.liveReaders] : []));
    expect(readers).toEqual([
      {
        added: [
          `user:${VERA}`,
          "workflow:fr-offer-to-cash",
          "workflow:other-flow",
        ],
        removed: [],
        limited: true,
      },
      {
        added: [],
        removed: [
          `user:${VERA}`,
          "workflow:fr-offer-to-cash",
          "workflow:other-flow",
        ],
      },
      { added: [], removed: [], everyone: true },
    ]);
    // An empty list where everyone read before adds no one and removes no
    // one, and still shuts live reads to all but the writers: recorded.
    await req("PUT", `/${id}/writers`, { writers: [], liveReaders: [] });
    const [shut] = await connectionsRepo.listConnectionAccessEvents(WS, id, 1);
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
          liveReaders: [{ principal: `agent:user:${MANAGER}` }],
        })
      ).status,
    ).toBe(400);
    who.authType = "apiKey";
    expect(
      (
        await req("PUT", `/${id}/writers`, {
          writers: [],
          liveReaders: [{ principal: `user:${MANAGER}` }],
        })
      ).status,
    ).toBe(403);
    expect(
      (await connectionsRepo.findSourceConnectionById(id, WS))?.liveReaders,
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
      (await connectionsRepo.findSourceConnectionById(id, WS))?.writers,
    ).toBeUndefined();
  });

  it("refuses a viewer, or an agent's attempt, as a writer", async () => {
    await ensureTestMember(pg.db, {
      workspaceId: WS,
      userId: VERA,
      role: "viewer",
    });
    const viewer = await req("PUT", `/${id}/writers`, {
      writers: [{ principal: `user:${VERA}` }],
    });
    expect(viewer.status).toBe(400);
    expect(((await viewer.json()) as { error: string }).error).toMatch(
      /^Viewers can't write through a connection/,
    );
    expect(
      (
        await req("PUT", `/${id}/writers`, {
          writers: [{ principal: `agent:user:${MANAGER}` }],
        })
      ).status,
    ).toBe(400);
    expect(
      await writersOutsideRefusal(WS, [{ principal: `agent:user:${MANAGER}` }]),
    ).toMatch(/cannot be on a writers list/);
    expect(
      (await connectionsRepo.findSourceConnectionById(id, WS))?.writers,
    ).toBeUndefined();
  });

  it("shows who tried to write, and what the list does not cover", async () => {
    // A `where` stored on a source writer (from before writers were
    // connection-wide) is ignored: the writer writes anywhere.
    await connectionsRepo.updateSourceConnection(id, WS, {
      writers: [{ principal: "workflow:fr-offer-to-cash", where: "/legacy/" }],
    });
    const event = (principal: string, target: string, allowed: boolean) => ({
      workspaceId: WS,
      connectionId: id,
      principal,
      target,
      allowed,
    });
    for (const entry of [
      event("workflow:other-flow", "POST /task/", false),
      event("workflow:fr-offer-to-cash", "POST /task/", true),
      event("workflow:fr-offer-to-cash", "PUT /lead/lead_1/", false),
      event("worker:workflows", "POST /task/", false),
      event(`agent:user:${MANAGER}`, "POST /task/", false),
    ]) {
      await connectionsRepo.recordConnectionWriteEvent(entry);
    }
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
    expect(byPrincipal[`agent:user:${MANAGER}`]).toBeUndefined();
  });

  it("offers each refused workflow by its name", async () => {
    const event = (principal: string, target: string) => ({
      workspaceId: WS,
      connectionId: id,
      principal,
      target,
      allowed: false,
    });
    for (const entry of [
      event("workflow:a-flow", "POST /task/"),
      event("workflow:b-flow", "PUT /lead/1/"),
    ]) {
      await connectionsRepo.recordConnectionWriteEvent(entry);
    }
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
    await ensureTestMember(pg.db, {
      workspaceId: WS,
      userId: VERA,
      role: "viewer",
    });
    // Listed before vera became a viewer.
    await connectionsRepo.updateSourceConnection(id, WS, {
      writers: [{ principal: `user:${VERA}` }],
    });
    const toggle = await req("PUT", `/${id}/writers`, {
      writers: [{ principal: `user:${VERA}` }],
      liveReads: true,
    });
    expect(toggle.status).toBe(200);
    expect(
      (await connectionsRepo.findSourceConnectionById(id, WS))?.liveReads,
    ).toBe(true);
    // A newcomer is still checked.
    expect(
      (
        await req("PUT", `/${id}/writers`, {
          writers: [
            { principal: `user:${VERA}` },
            { principal: "user:stranger" },
          ],
        })
      ).status,
    ).toBe(400);
    expect(
      await writersOutsideRefusal(
        WS,
        [{ principal: `user:${VERA}` }],
        [{ principal: `user:${VERA}` }],
      ),
    ).toBeNull();
  });

  it("is scoped to the workspace", async () => {
    const otherWorkspace = await ensureTestWorkspace(pg.db);
    const other = await connectionsRepo.createSourceConnection({
      workspaceId: otherWorkspace.id,
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
