/**
 * set_connection_access: who may use a connection, changed over MCP.
 *
 * RIGHTS — the app's: the workspace owner and admins for a database
 * connection's writers; a source connection's managers and the workspace
 * owner for its writers, live reads, live readers and managers. Never a
 * member on a database connection, never an admin who is not a manager on a
 * source connection, never a viewer.
 *
 * LISTS — only workspace members and workflows; no viewer as a source writer
 * or a manager. Changes are additions and removals: other entries stay.
 *
 * Real Mongo (mongodb-memory-server).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

import { ConnectionAccessEvent } from "../../access/connection-access-event";
import { User } from "../../database/schema";
import {
  DatabaseConnection,
  SourceConnection,
  WorkspaceMember,
} from "../../database/workspace-schema";
import { createConnectionAccessTools } from "./connection-access-tools";

type Result = Record<string, unknown> & {
  access?: Record<string, unknown>;
  changed?: string[];
  error?: string;
};

let mongo: MongoMemoryServer;
let WS: string;
let SOURCE: Types.ObjectId;
let DB: Types.ObjectId;

const as = (userId?: string) => (input: Record<string, unknown>) =>
  (
    createConnectionAccessTools(WS, userId) as unknown as {
      set_connection_access: { execute: (i: unknown) => Promise<Result> };
    }
  ).set_connection_access.execute(input);

const source = () => SourceConnection.findById(SOURCE).lean();
const database = () => DatabaseConnection.findById(DB).lean();

beforeAll(async () => {
  process.env.ENCRYPTION_KEY ??=
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await Promise.all([
    SourceConnection.deleteMany({}),
    DatabaseConnection.deleteMany({}),
    WorkspaceMember.deleteMany({}),
    User.deleteMany({}),
    ConnectionAccessEvent.deleteMany({}),
  ]);
  WS = new Types.ObjectId().toString();
  for (const [userId, role] of [
    ["owner1", "owner"],
    ["admin1", "admin"],
    ["manager1", "member"],
    ["member2", "member"],
    ["viewer1", "viewer"],
  ] as const) {
    await WorkspaceMember.create({
      workspaceId: new Types.ObjectId(WS),
      userId,
      role,
      joinedAt: new Date(),
    });
  }
  await User.collection.insertMany([
    { _id: "member2", email: "member2@example.com" },
    { _id: "viewer1", email: "viewer1@example.com" },
    { _id: "stranger", email: "stranger@example.com" },
  ] as never[]);
  SOURCE = new Types.ObjectId();
  await SourceConnection.create({
    _id: SOURCE,
    workspaceId: new Types.ObjectId(WS),
    name: "inbox",
    type: "custom_api",
    config: { base_url: "https://api.example.com" },
    isActive: true,
    settings: { rate_limit_delay_ms: 100, sync_batch_size: 100 },
    createdBy: "manager1",
    managers: ["manager1"],
    writers: [{ principal: "workflow:send-digest", addedBy: "manager1" }],
  });
  DB = new Types.ObjectId();
  await DatabaseConnection.create({
    _id: DB,
    workspaceId: new Types.ObjectId(WS),
    name: "warehouse",
    type: "postgresql",
    connection: { host: "db.example.com" },
    createdBy: "owner1",
    writers: [{ principal: "user:admin1", where: "finance" }],
  });
});

describe("a database connection's writers", () => {
  it("an admin adds a writer by email, limited to a table, and the others stay", async () => {
    const result = await as("admin1")({
      connectionId: DB.toString(),
      addWriters: [
        { principal: "member2@example.com", where: "mako_out.labels" },
        { principal: "workflow:*" },
      ],
    });
    expect(result.error).toBeUndefined();
    expect(result.kind).toBe("database");
    expect(result.changed).toEqual(["writers"]);
    const stored = (await database())?.writers ?? [];
    expect(stored.map(w => [w.principal, w.where])).toEqual([
      ["user:admin1", "finance"],
      ["user:member2", "mako_out.labels"],
      ["workflow:*", undefined],
    ]);
    expect(stored[1].addedBy).toBe("admin1");
  });

  it("removing a principal without `where` removes all of its entries", async () => {
    await as("owner1")({
      connectionId: DB.toString(),
      addWriters: [{ principal: "user:admin1", where: "sales.orders" }],
    });
    const result = await as("owner1")({
      connectionId: "warehouse",
      removeWriters: [{ principal: "user:admin1" }],
    });
    expect(result.error).toBeUndefined();
    expect((await database())?.writers).toEqual([]);
  });

  it("refuses a member, a viewer and a credential with no user", async () => {
    for (const who of ["manager1", "viewer1", undefined]) {
      const result = await as(who)({
        connectionId: DB.toString(),
        addWriters: [{ principal: "user:member2" }],
      });
      expect(result.error).toBeTruthy();
    }
    expect((await database())?.writers).toHaveLength(1);
  });

  it("refuses someone outside the workspace, known account or not, in the same words", async () => {
    const answers = [];
    for (const principal of ["stranger@example.com", "nobody@example.com"]) {
      const result = await as("admin1")({
        connectionId: DB.toString(),
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

  it("refuses the caller adding themselves, by id or by email", async () => {
    await User.collection.insertOne({
      _id: "admin1",
      email: "admin1@example.com",
    } as never);
    for (const principal of ["user:admin1", "admin1@example.com"]) {
      const result = await as("admin1")({
        connectionId: DB.toString(),
        addWriters: [{ principal }],
      });
      expect(result.error).toMatch(/cannot add yourself/);
    }
    // Another admin (here the owner) may add them.
    const byOwner = await as("owner1")({
      connectionId: DB.toString(),
      addWriters: [{ principal: "user:admin1" }],
    });
    expect(byOwner.error).toBeUndefined();
    expect((await database())?.writers).toHaveLength(2);
  });

  it("refuses source-only settings and an unlistable principal", async () => {
    expect(
      (await as("admin1")({ connectionId: DB.toString(), liveReads: true }))
        .error,
    ).toMatch(/database connection/);
    expect(
      (
        await as("admin1")({
          connectionId: DB.toString(),
          addWriters: [{ principal: "agent:user:admin1" }],
        })
      ).error,
    ).toMatch(/cannot be listed/);
  });

  it("an unchanged list writes nothing", async () => {
    const result = await as("owner1")({
      connectionId: DB.toString(),
      addWriters: [{ principal: "user:admin1", where: "finance" }],
    });
    expect(result.changed).toEqual([]);
  });
});

describe("a source connection's access", () => {
  it("a manager turns live reads on and adds a writer and a live reader", async () => {
    const result = await as("manager1")({
      connectionId: SOURCE.toString(),
      liveReads: true,
      addWriters: [{ principal: "user:member2" }],
      addLiveReaders: ["viewer1@example.com"],
    });
    expect(result.error).toBeUndefined();
    expect(result.changed).toEqual(["writers", "liveReads", "liveReaders"]);
    expect(result.access).toEqual({
      liveReads: true,
      liveReaders: ["user:viewer1"],
      writers: ["workflow:send-digest", "user:member2"],
      managers: ["manager1"],
    });
    expect(String(result.note)).toMatch(/limited/);
    const stored = await source();
    expect(stored?.liveReads).toBe(true);
    expect(stored?.writers?.[0].addedBy).toBe("manager1");
    expect(stored?.writers?.[1].addedBy).toBe("manager1");
  });

  it('`liveReaders: "everyone"` drops the list', async () => {
    await as("manager1")({
      connectionId: SOURCE.toString(),
      addLiveReaders: ["user:member2"],
    });
    const result = await as("manager1")({
      connectionId: SOURCE.toString(),
      liveReaders: "everyone",
    });
    expect(result.access?.liveReaders).toBe("everyone");
    expect((await source())?.liveReaders).toBeUndefined();
  });

  it("the workspace owner may, an admin who is not a manager may not, nor a viewer", async () => {
    expect(
      (await as("owner1")({ connectionId: SOURCE.toString(), liveReads: true }))
        .error,
    ).toBeUndefined();
    for (const who of ["admin1", "member2", "viewer1"]) {
      const result = await as(who)({
        connectionId: SOURCE.toString(),
        liveReads: false,
      });
      expect(result.error).toBeTruthy();
    }
    expect((await source())?.liveReads).toBe(true);
  });

  it("refuses a viewer as a writer, a stranger as a reader, and `where`", async () => {
    const id = SOURCE.toString();
    expect(
      (
        await as("manager1")({
          connectionId: id,
          addWriters: [{ principal: "user:viewer1" }],
        })
      ).error,
    ).toMatch(/Viewers/);
    expect(
      (await as("manager1")({ connectionId: id, addLiveReaders: ["user:x9"] }))
        .error,
    ).toMatch(/not a member/);
    const stranger = await as("manager1")({
      connectionId: id,
      addWriters: [{ principal: "stranger@example.com" }],
    });
    expect(stranger.error).toBe(
      "stranger@example.com is not a member of this workspace",
    );
    expect(
      (
        await as("manager1")({
          connectionId: id,
          addWriters: [{ principal: "user:manager1" }],
        })
      ).error,
    ).toMatch(/cannot add yourself/);
    expect(
      (
        await as("manager1")({
          connectionId: id,
          addWriters: [{ principal: "user:member2", where: "a.b" }],
        })
      ).error,
    ).toMatch(/where/);
    expect((await source())?.writers).toHaveLength(1);
  });

  it("a manager adds a manager, who can then act; the last one cannot be removed", async () => {
    const id = SOURCE.toString();
    const added = await as("manager1")({
      connectionId: id,
      addManagers: ["member2@example.com"],
    });
    expect(added.access?.managers).toEqual(["manager1", "member2"]);
    const removed = await as("member2")({
      connectionId: id,
      removeManagers: ["user:manager1"],
    });
    expect(removed.access?.managers).toEqual(["member2"]);
    const last = await as("member2")({
      connectionId: id,
      removeManagers: ["member2"],
    });
    expect(last.error).toMatch(/at least one manager/);
    expect((await source())?.managers).toEqual(["member2"]);
  });

  it("refuses a viewer, a stranger or a workflow as a manager", async () => {
    for (const ref of [
      "viewer1@example.com",
      "stranger@example.com",
      "nobody@example.com",
      "workflow:*",
    ]) {
      const result = await as("manager1")({
        connectionId: SOURCE.toString(),
        addManagers: [ref],
      });
      expect(result.error).toBeTruthy();
    }
    expect((await source())?.managers).toEqual(["manager1"]);
  });
});

describe("every change is recorded", () => {
  it("additions, removals and the switch, with who made them; nothing for a refusal or a no-op", async () => {
    await as("owner1")({
      connectionId: DB.toString(),
      addWriters: [{ principal: "user:member2", where: "mako_out" }],
      removeWriters: [{ principal: "user:admin1" }],
    });
    await as("manager1")({
      connectionId: SOURCE.toString(),
      liveReads: true,
      removeWriters: [{ principal: "workflow:send-digest" }],
      addManagers: ["user:member2"],
    });
    // Refused, then unchanged: neither is an event.
    await as("member2")({
      connectionId: DB.toString(),
      addWriters: [{ principal: "workflow:*" }],
    });
    await as("manager1")({ connectionId: SOURCE.toString(), liveReads: true });

    const events = await ConnectionAccessEvent.find({}).sort({ at: 1 }).lean();
    expect(
      events.map(e => [String(e.connectionId), e.kind, e.actor, e.via]),
    ).toEqual([
      [DB.toString(), "database", "owner1", "mcp"],
      [SOURCE.toString(), "source", "manager1", "mcp"],
    ]);
    expect(events[0].changes).toEqual({
      writers: {
        added: ["user:member2 mako_out"],
        removed: ["user:admin1 finance"],
      },
    });
    expect(events[1].changes).toEqual({
      writers: { added: [], removed: ["workflow:send-digest"] },
      liveReads: true,
      managers: { added: ["member2"], removed: [] },
    });
  });
});

describe("finding the connection", () => {
  it("another workspace's connection is not found", async () => {
    const other = new Types.ObjectId();
    await SourceConnection.create({
      _id: other,
      workspaceId: new Types.ObjectId(),
      name: "theirs",
      type: "custom_api",
      config: {},
      settings: { rate_limit_delay_ms: 100, sync_batch_size: 100 },
      createdBy: "owner1",
    });
    const result = await as("owner1")({
      connectionId: other.toString(),
      liveReads: true,
    });
    expect(result.error).toMatch(/not found/);
  });

  it("a name shared by both kinds needs `kind`", async () => {
    await SourceConnection.updateOne({ _id: SOURCE }, { name: "warehouse" });
    const ambiguous = await as("owner1")({
      connectionId: "warehouse",
      addWriters: [{ principal: "user:member2" }],
    });
    expect(ambiguous.error).toMatch(/Several connections/);
    const picked = await as("owner1")({
      connectionId: "warehouse",
      kind: "source",
      addWriters: [{ principal: "user:member2" }],
    });
    expect(picked.kind).toBe("source");
  });
});
