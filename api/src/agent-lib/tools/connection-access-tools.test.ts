/**
 * set_connection_access: who may use a connection, changed over MCP.
 *
 * RIGHTS — the app's: the workspace owner and admins for a database
 * connection's writers; a source connection's managers and the workspace
 * owner for its writers, live reads, live readers and managers. Never a
 * member on a database connection, never an admin who is not a manager on a
 * source connection, never a viewer.
 *
 * LISTS — only workspace members; no viewer as a source writer or a manager.
 * Changes are additions and removals: other entries stay.
 *
 * NO SELF-GRANT — the caller never adds themselves as a writer or a live
 * reader (by name, or by opening a list that leaves them out to everyone),
 * and never adds a workflow, which an agent could deploy and run. Removing
 * is allowed.
 *
 * NO SILENT NO-OP — an unknown key, a call that names no change and a
 * `where` that would limit nothing are refused.
 *
 * PGlite with real connection and access repositories.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  generateObjectIdHex,
  legacyUserIdToUuidv7,
} from "../../database/pg/id-codec";
import { connectionAccessEvents } from "../../database/pg/schema";
import {
  connectionsRepo,
  pgAccessEventToRecord,
} from "../../repositories/connections";
import {
  ensureTestMember,
  ensureTestUser,
  ensureTestWorkspace,
  setupPgTestDb,
  type PgTestDb,
} from "../../test-support/pg-test";
import { createConnectionAccessTools } from "./connection-access-tools";

type Result = Record<string, unknown> & {
  access?: Record<string, unknown>;
  changed?: string[];
  error?: string;
};

const OWNER = legacyUserIdToUuidv7("owner1");
const ADMIN = legacyUserIdToUuidv7("admin1");
const MANAGER = legacyUserIdToUuidv7("manager1");
const MEMBER = legacyUserIdToUuidv7("member2");
const VIEWER = legacyUserIdToUuidv7("viewer1");
const GONE = legacyUserIdToUuidv7("gone");

let h: PgTestDb;
let WS: string;
let SOURCE: string;
let DB: string;

const as = (userId?: string) => (input: Record<string, unknown>) =>
  (
    createConnectionAccessTools(WS, userId) as unknown as {
      set_connection_access: { execute: (i: unknown) => Promise<Result> };
    }
  ).set_connection_access.execute(input);

const source = () => connectionsRepo.findSourceConnectionById(SOURCE, WS);
const database = () => connectionsRepo.findDatabaseConnectionById(DB, WS);

beforeAll(async () => {
  process.env.ENCRYPTION_KEY ??=
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  h = await setupPgTestDb();
}, 120_000);

afterAll(() => h.close());

beforeEach(async () => {
  await h.reset();
  WS = (await ensureTestWorkspace(h.db, { ownerUserId: OWNER })).id;
  for (const [userId, email, role] of [
    [ADMIN, "admin1@example.com", "admin"],
    [MANAGER, "manager1@example.com", "member"],
    [MEMBER, "member2@example.com", "member"],
    [VIEWER, "viewer1@example.com", "viewer"],
  ] as const) {
    await ensureTestUser(h.db, { id: userId, email });
    await ensureTestMember(h.db, { workspaceId: WS, userId, role });
  }
  await ensureTestUser(h.db, { email: "stranger@example.com" });
  await ensureTestUser(h.db, { id: GONE });
  SOURCE = generateObjectIdHex();
  await connectionsRepo.createSourceConnection({
    id: SOURCE,
    workspaceId: WS,
    name: "inbox",
    type: "custom_api",
    config: { base_url: "https://api.example.com" },
    isActive: true,
    settings: { rate_limit_delay_ms: 100, sync_batch_size: 100 },
    createdBy: MANAGER,
    managers: [MANAGER],
    writers: [{ principal: "workflow:send-digest", addedBy: MANAGER }],
  });
  DB = generateObjectIdHex();
  await connectionsRepo.createDatabaseConnection({
    id: DB,
    workspaceId: WS,
    name: "warehouse",
    type: "postgresql",
    connection: { host: "db.example.com" },
    createdBy: OWNER,
    writers: [{ principal: `user:${ADMIN}`, where: "finance" }],
  });
});

describe("a database connection's writers", () => {
  it("an admin adds a writer by email, limited to a table, and the others stay", async () => {
    const result = await as(ADMIN)({
      connectionId: DB,
      addWriters: [
        { principal: "member2@example.com", where: "mako_out.labels" },
        { principal: `user:${OWNER}` },
      ],
    });
    expect(result.error).toBeUndefined();
    expect(result.kind).toBe("database");
    expect(result.changed).toEqual(["writers"]);
    const stored = (await database())?.writers ?? [];
    expect(stored.map(w => [w.principal, w.where])).toEqual([
      [`user:${ADMIN}`, "finance"],
      [`user:${MEMBER}`, "mako_out.labels"],
      [`user:${OWNER}`, undefined],
    ]);
    expect(stored[1].addedBy).toBe(ADMIN);
  });

  it("removing a principal without `where` removes all of its entries", async () => {
    await as(OWNER)({
      connectionId: DB,
      addWriters: [{ principal: `user:${ADMIN}`, where: "sales.orders" }],
    });
    const result = await as(OWNER)({
      connectionId: "warehouse",
      removeWriters: [{ principal: `user:${ADMIN}` }],
    });
    expect(result.error).toBeUndefined();
    expect((await database())?.writers).toEqual([]);
  });

  it("refuses a member, a viewer and a credential with no user", async () => {
    for (const who of [MANAGER, VIEWER, undefined]) {
      const result = await as(who)({
        connectionId: DB,
        addWriters: [{ principal: `user:${MEMBER}` }],
      });
      expect(result.error).toBeTruthy();
    }
    expect((await database())?.writers).toHaveLength(1);
  });

  it("refuses someone outside the workspace, known account or not, in the same words", async () => {
    const answers = [];
    for (const principal of ["stranger@example.com", "nobody@example.com"]) {
      const result = await as(ADMIN)({
        connectionId: DB,
        addWriters: [{ principal }],
      });
      // Neither whether the address has an account, nor its id.
      expect(String(result.error)).not.toContain("user:");
      answers.push(String(result.error).replace(principal, "<email>"));
    }
    expect(answers[0]).toBe("<email> is not a member of this workspace");
    expect(answers[1]).toBe(answers[0]);
    expect((await database())?.writers).toHaveLength(1);
  });

  it("tells an unknown address from an outside account in no combination", async () => {
    // The same shape of answer whichever of the two addresses has an account.
    const answer = async (addWriters: { principal: string }[]) =>
      String((await as(ADMIN)({ connectionId: DB, addWriters })).error)
        .replace("stranger@example.com", "<email>")
        .replace("nobody@example.com", "<email>");
    const member = { principal: "member2@example.com" };
    const agent = { principal: "agent:user:x" };
    for (const others of [[], [member], [agent], [member, agent]]) {
      expect(
        await answer([{ principal: "stranger@example.com" }, ...others]),
      ).toBe(await answer([{ principal: "nobody@example.com" }, ...others]));
    }
    // Both at once: both named, neither singled out.
    expect(
      await answer([
        { principal: "nobody@example.com" },
        { principal: "stranger@example.com" },
      ]),
    ).toBe("<email>, <email> is not a member of this workspace");
    expect((await database())?.writers).toHaveLength(1);
  });

  it("gives a writer who left the workspace no further entry", async () => {
    await connectionsRepo.updateDatabaseConnection(DB, WS, {
      writers: [
        ...((await database())?.writers ?? []),
        { principal: `user:${GONE}` },
      ],
    });
    const result = await as(ADMIN)({
      connectionId: DB,
      addWriters: [{ principal: `user:${GONE}`, where: "finance" }],
    });
    expect(result.error).toMatch(/not a member/);
    // And they can still be taken off.
    const removed = await as(ADMIN)({
      connectionId: DB,
      removeWriters: [{ principal: `user:${GONE}` }],
    });
    expect(removed.changed).toEqual(["writers"]);
  });

  it("refuses the caller adding themselves, by id or by email", async () => {
    for (const principal of [`user:${ADMIN}`, "admin1@example.com"]) {
      const result = await as(ADMIN)({
        connectionId: DB,
        addWriters: [{ principal }],
      });
      expect(result.error).toMatch(/cannot add yourself/);
    }
    // Another admin (here the owner) may add them.
    const byOwner = await as(OWNER)({
      connectionId: DB,
      addWriters: [{ principal: `user:${ADMIN}` }],
    });
    expect(byOwner.error).toBeUndefined();
    expect((await database())?.writers).toHaveLength(2);
  });

  it("refuses adding a workflow, which an agent could deploy and run; removing one works", async () => {
    for (const principal of ["workflow:*", "workflow:nightly"]) {
      const result = await as(OWNER)({
        connectionId: DB,
        addWriters: [{ principal }, { principal: `user:${MEMBER}` }],
      });
      expect(result.error).toMatch(/cannot be added as a writer over MCP/);
      expect(result.error).toContain(principal);
    }
    expect((await database())?.writers).toHaveLength(1);

    await connectionsRepo.updateDatabaseConnection(DB, WS, {
      writers: [
        ...((await database())?.writers ?? []),
        { principal: "workflow:*", addedBy: OWNER },
      ],
    });
    const removed = await as(OWNER)({
      connectionId: DB,
      removeWriters: [{ principal: "workflow:*" }],
    });
    expect(removed.error).toBeUndefined();
    expect((await database())?.writers?.map(w => w.principal)).toEqual([
      `user:${ADMIN}`,
    ]);
  });

  it("refuses a `where` that would not limit a writer who writes anywhere", async () => {
    const id = DB;
    await as(OWNER)({
      connectionId: id,
      addWriters: [{ principal: `user:${MEMBER}` }],
    });
    const before = (await database())?.writers;

    // A limited entry next to the broad one limits nothing.
    const added = await as(OWNER)({
      connectionId: id,
      addWriters: [{ principal: "member2@example.com", where: "finance" }],
    });
    expect(added.error).toMatch(/already writes anywhere/);
    // Named as the caller named them.
    expect(added.error).toContain("member2@example.com");
    expect(added.error).not.toContain(`user:${MEMBER}`);
    // The reverse: there is no limited entry to remove.
    const removed = await as(OWNER)({
      connectionId: id,
      removeWriters: [{ principal: `user:${MEMBER}`, where: "finance" }],
    });
    expect(removed.error).toMatch(/no `finance` entry to remove/);
    // Both at once for one principal.
    const both = await as(OWNER)({
      connectionId: id,
      addWriters: [
        { principal: `user:${VIEWER}` },
        { principal: `user:${VIEWER}`, where: "finance" },
      ],
    });
    expect(both.error).toMatch(/both anywhere and limited/);
    expect((await database())?.writers).toEqual(before);

    // Removing the broad entry in the same call does limit them.
    const limited = await as(OWNER)({
      connectionId: id,
      removeWriters: [{ principal: `user:${MEMBER}` }],
      addWriters: [{ principal: `user:${MEMBER}`, where: "finance" }],
    });
    expect(limited.error).toBeUndefined();
    expect(limited.changed).toEqual(["writers"]);
    expect(
      (await database())?.writers
        ?.filter(w => w.principal === `user:${MEMBER}`)
        .map(w => w.where),
    ).toEqual(["finance"]);
  });

  it("refuses an unknown key, where the MCP server parses the arguments", () => {
    const { inputSchema } = (
      createConnectionAccessTools(WS, OWNER) as unknown as {
        set_connection_access: {
          inputSchema: { safeParse: (i: unknown) => { success: boolean } };
        };
      }
    ).set_connection_access;
    const connectionId = DB;
    for (const extra of [
      { writers: [{ principal: `user:${MEMBER}` }] },
      { allowAgentWrites: true },
      { addReader: [`user:${MEMBER}`] },
      { addWriters: [{ principal: `user:${MEMBER}`, schema: "finance" }] },
    ]) {
      expect(inputSchema.safeParse({ connectionId, ...extra }).success).toBe(
        false,
      );
    }
    expect(
      inputSchema.safeParse({
        connectionId,
        addWriters: [{ principal: `user:${MEMBER}`, where: "finance" }],
      }).success,
    ).toBe(true);
  });

  it("refuses a call that names no change", async () => {
    for (const input of [{}, { addWriters: [] }, { kind: "database" }]) {
      const result = await as(OWNER)({
        connectionId: DB,
        ...input,
      });
      expect(result.error).toMatch(/Name at least one change/);
      expect(result.changed).toBeUndefined();
    }
  });

  it("refuses source-only settings and an unlistable principal", async () => {
    expect(
      (await as(ADMIN)({ connectionId: DB, liveReads: true })).error,
    ).toMatch(/database connection/);
    expect(
      (
        await as(ADMIN)({
          connectionId: DB,
          addWriters: [{ principal: "agent:user:admin1" }],
        })
      ).error,
    ).toMatch(/cannot be listed/);
  });

  it("an unchanged list writes nothing", async () => {
    const result = await as(OWNER)({
      connectionId: DB,
      addWriters: [{ principal: `user:${ADMIN}`, where: "finance" }],
    });
    expect(result.changed).toEqual([]);
  });
});

describe("a source connection's access", () => {
  it("a manager turns live reads on and adds a writer and a live reader", async () => {
    const result = await as(MANAGER)({
      connectionId: SOURCE,
      liveReads: true,
      addWriters: [{ principal: `user:${MEMBER}` }],
      addLiveReaders: ["viewer1@example.com"],
    });
    expect(result.error).toBeUndefined();
    expect(result.changed).toEqual(["writers", "liveReads", "liveReaders"]);
    expect(result.access).toEqual({
      liveReads: true,
      liveReaders: [`user:${VIEWER}`],
      writers: ["workflow:send-digest", `user:${MEMBER}`],
      managers: [MANAGER],
    });
    expect(String(result.note)).toMatch(/limited/);
    const stored = await source();
    expect(stored?.liveReads).toBe(true);
    expect(stored?.writers?.[0].addedBy).toBe(MANAGER);
    expect(stored?.writers?.[1].addedBy).toBe(MANAGER);
  });

  it('`liveReaders: "everyone"` drops the list', async () => {
    await as(OWNER)({
      connectionId: SOURCE,
      addLiveReaders: [`user:${MEMBER}`, `user:${MANAGER}`],
    });
    const result = await as(MANAGER)({
      connectionId: SOURCE,
      liveReaders: "everyone",
    });
    expect(result.access?.liveReaders).toBe("everyone");
    expect((await source())?.liveReaders).toBeUndefined();
  });

  it("refuses the caller giving themselves live reads, by name or by opening the list", async () => {
    const id = SOURCE;
    for (const reader of [`user:${MANAGER}`, "manager1@example.com"]) {
      const result = await as(MANAGER)({
        connectionId: id,
        liveReads: true,
        addLiveReaders: [reader],
      });
      expect(result.error).toMatch(/cannot add yourself as a live reader/);
    }
    // Refused whole: the switch in the same call is not saved either.
    expect((await source())?.liveReads).not.toBe(true);
    expect((await source())?.liveReaders).toBeUndefined();

    // A list that leaves the caller out: opening it to everyone adds them.
    await as(MANAGER)({
      connectionId: id,
      addLiveReaders: [`user:${MEMBER}`],
    });
    const opened = await as(MANAGER)({
      connectionId: id,
      liveReaders: "everyone",
    });
    expect(opened.error).toMatch(/granting itself live reads/);
    expect((await source())?.liveReaders).toHaveLength(1);

    // Someone else adds them; a writer already reads live.
    const byOwner = await as(OWNER)({
      connectionId: id,
      addLiveReaders: [`user:${MANAGER}`],
    });
    expect(byOwner.error).toBeUndefined();
    await connectionsRepo.updateSourceConnection(SOURCE, WS, {
      liveReaders: [{ principal: `user:${MEMBER}` }],
    });
    await as(OWNER)({
      connectionId: id,
      addWriters: [{ principal: `user:${MANAGER}` }],
    });
    const asWriter = await as(MANAGER)({
      connectionId: id,
      liveReaders: "everyone",
    });
    expect(asWriter.error).toBeUndefined();
    expect(asWriter.access?.liveReaders).toBe("everyone");
  });

  it("refuses a workflow as a writer or a live reader; removing one works", async () => {
    const id = SOURCE;
    expect(
      (
        await as(MANAGER)({
          connectionId: id,
          addWriters: [{ principal: "workflow:*" }],
        })
      ).error,
    ).toMatch(/cannot be added as a writer over MCP/);
    expect(
      (
        await as(MANAGER)({
          connectionId: id,
          addLiveReaders: ["workflow:send-digest"],
        })
      ).error,
    ).toMatch(/cannot be added as a live reader over MCP/);
    const removed = await as(MANAGER)({
      connectionId: id,
      removeWriters: [{ principal: "workflow:send-digest" }],
    });
    expect(removed.error).toBeUndefined();
    expect((await source())?.writers).toEqual([]);
    expect((await source())?.liveReaders).toBeUndefined();
  });

  it("the workspace owner may, an admin who is not a manager may not, nor a viewer", async () => {
    expect(
      (await as(OWNER)({ connectionId: SOURCE, liveReads: true })).error,
    ).toBeUndefined();
    for (const who of [ADMIN, MEMBER, VIEWER]) {
      const result = await as(who)({
        connectionId: SOURCE,
        liveReads: false,
      });
      expect(result.error).toBeTruthy();
    }
    expect((await source())?.liveReads).toBe(true);
  });

  it("refuses a viewer as a writer, a stranger as a reader, and `where`", async () => {
    const id = SOURCE;
    expect(
      (
        await as(MANAGER)({
          connectionId: id,
          addWriters: [{ principal: `user:${VIEWER}` }],
        })
      ).error,
    ).toMatch(/Viewers/);
    expect(
      (await as(MANAGER)({ connectionId: id, addLiveReaders: ["user:x9"] }))
        .error,
    ).toMatch(/not a member/);
    const stranger = await as(MANAGER)({
      connectionId: id,
      addWriters: [{ principal: "stranger@example.com" }],
    });
    expect(stranger.error).toBe(
      "stranger@example.com is not a member of this workspace",
    );
    expect(
      (
        await as(MANAGER)({
          connectionId: id,
          addWriters: [{ principal: `user:${MANAGER}` }],
        })
      ).error,
    ).toMatch(/cannot add yourself/);
    expect(
      (
        await as(MANAGER)({
          connectionId: id,
          addWriters: [{ principal: `user:${MEMBER}`, where: "a.b" }],
        })
      ).error,
    ).toMatch(/where/);
    expect((await source())?.writers).toHaveLength(1);
  });

  it("a manager adds a manager, who can then act; the last one cannot be removed", async () => {
    const id = SOURCE;
    const added = await as(MANAGER)({
      connectionId: id,
      addManagers: ["member2@example.com"],
    });
    expect(added.access?.managers).toEqual([MANAGER, MEMBER]);
    const removed = await as(MEMBER)({
      connectionId: id,
      removeManagers: [`user:${MANAGER}`],
    });
    expect(removed.access?.managers).toEqual([MEMBER]);
    const last = await as(MEMBER)({
      connectionId: id,
      removeManagers: [MEMBER],
    });
    expect(last.error).toMatch(/at least one manager/);
    expect((await source())?.managers).toEqual([MEMBER]);
  });

  it("answers the same for an unknown address and an outside account as a manager", async () => {
    const answer = async (input: Record<string, unknown>) =>
      JSON.stringify(
        await as(MANAGER)({ connectionId: SOURCE, ...input }),
      ).replace(/(stranger|nobody)@example\.com/g, "<email>");
    for (const others of [[], ["workflow:*"], ["member2@example.com"]]) {
      expect(
        await answer({ addManagers: ["stranger@example.com", ...others] }),
      ).toBe(await answer({ addManagers: ["nobody@example.com", ...others] }));
    }
    // Removing either removes no one.
    expect(await answer({ removeManagers: ["stranger@example.com"] })).toBe(
      await answer({ removeManagers: ["nobody@example.com"] }),
    );
    expect((await source())?.managers).toEqual([MANAGER]);
  });

  it("asks for a manager who can no longer manage to be taken off, as the app does", async () => {
    await connectionsRepo.updateSourceConnection(SOURCE, WS, {
      managers: [MANAGER, GONE],
    });
    const id = SOURCE;
    const kept = await as(MANAGER)({
      connectionId: id,
      addManagers: [`user:${MEMBER}`],
    });
    expect(kept.error).toMatch(new RegExp(`${GONE} .*removeManagers`));
    const cleaned = await as(MANAGER)({
      connectionId: id,
      addManagers: [`user:${MEMBER}`],
      removeManagers: [GONE],
    });
    expect(cleaned.access?.managers).toEqual([MANAGER, MEMBER]);
  });

  it("refuses a viewer, a stranger or a workflow as a manager", async () => {
    for (const ref of [
      "viewer1@example.com",
      "stranger@example.com",
      "nobody@example.com",
      "workflow:*",
    ]) {
      const result = await as(MANAGER)({
        connectionId: SOURCE,
        addManagers: [ref],
      });
      expect(result.error).toBeTruthy();
    }
    expect((await source())?.managers).toEqual([MANAGER]);
  });
});

describe("every change is recorded", () => {
  it("additions, removals and the switch, with who made them; nothing for a refusal or a no-op", async () => {
    await as(OWNER)({
      connectionId: DB,
      addWriters: [{ principal: `user:${MEMBER}`, where: "mako_out" }],
      removeWriters: [{ principal: `user:${ADMIN}` }],
    });
    await as(MANAGER)({
      connectionId: SOURCE,
      liveReads: true,
      removeWriters: [{ principal: "workflow:send-digest" }],
      addManagers: [`user:${MEMBER}`],
    });
    // Refused, then unchanged: neither is an event.
    await as(MEMBER)({
      connectionId: DB,
      addWriters: [{ principal: "workflow:*" }],
    });
    await as(MANAGER)({ connectionId: SOURCE, liveReads: true });

    const events = (
      await h.db
        .select()
        .from(connectionAccessEvents)
        .orderBy(connectionAccessEvents.at)
    ).map(pgAccessEventToRecord);
    expect(
      events.map(e => [String(e.connectionId), e.kind, e.actor, e.via]),
    ).toEqual([
      [DB, "database", OWNER, "mcp"],
      [SOURCE, "source", MANAGER, "mcp"],
    ]);
    expect(events[0].changes).toEqual({
      writers: {
        added: [`user:${MEMBER} mako_out`],
        removed: [`user:${ADMIN} finance`],
      },
    });
    expect(events[1].changes).toEqual({
      writers: { added: [], removed: ["workflow:send-digest"] },
      liveReads: true,
      managers: { added: [MEMBER], removed: [] },
    });
  });
});

describe("finding the connection", () => {
  it("another workspace's connection is not found", async () => {
    const other = generateObjectIdHex();
    const foreign = await ensureTestWorkspace(h.db);
    await connectionsRepo.createSourceConnection({
      id: other,
      workspaceId: foreign.id,
      name: "theirs",
      type: "custom_api",
      config: {},
      settings: { rate_limit_delay_ms: 100, sync_batch_size: 100 },
      createdBy: OWNER,
    });
    const result = await as(OWNER)({
      connectionId: other,
      liveReads: true,
    });
    expect(result.error).toMatch(/not found/);
  });

  it("a name shared by both kinds needs `kind`", async () => {
    await connectionsRepo.updateSourceConnection(SOURCE, WS, {
      name: "warehouse",
    });
    const ambiguous = await as(OWNER)({
      connectionId: "warehouse",
      addWriters: [{ principal: `user:${MEMBER}` }],
    });
    expect(ambiguous.error).toMatch(/Several connections/);
    const picked = await as(OWNER)({
      connectionId: "warehouse",
      kind: "source",
      addWriters: [{ principal: `user:${MEMBER}` }],
    });
    expect(picked.kind).toBe("source");
  });
});
