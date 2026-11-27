/**
 * A flow names only its own workspace's connections. Exercise the push
 * reactor, update and source lookup with Postgres connections, and read
 * persisted flows from MongoDB.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  ensureTestDatabaseConnection,
  ensureTestSourceConnection,
  setupPgTestDb,
  type PgTestDb,
} from "../test-support/pg-test";

import { Flow } from "../database/workspace-schema";
import { getSourceConnectionManager } from "../sync/database-data-source-manager";
import {
  flowFileConnectionRefusal,
  foreignConnectionRefusal,
} from "./flow-connection-scope";
import { applyFlowUpdate } from "./flow-mutation.service";
import { DestinationWriter } from "./destination-writer/writer";
import { MongoDbDestinationAdapter } from "../sync-cdc/adapters/mongodb";
import { createFlowSyncTools } from "../agent-lib/tools/flow-sync-tools";
import { inWorkspace } from "../utils/workspace-scope";
import type { FlowFile } from "./flow-config-files";

let pg: PgTestDb;
let mongo: MongoMemoryServer;
const WS = new Types.ObjectId();
const OTHER_WS = new Types.ObjectId();
const SOURCE = new Types.ObjectId();
const DEST = new Types.ObjectId();
const FOREIGN_SOURCE = new Types.ObjectId();
const FOREIGN_DEST = new Types.ObjectId();

beforeAll(async () => {
  pg = await setupPgTestDb();
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}, 120_000);

afterAll(async () => {
  await pg?.close();
  await mongoose.disconnect();
  await mongo?.stop();
});

beforeEach(async () => {
  await Promise.all([pg.reset(), Flow.deleteMany({})]);
  await ensureTestSourceConnection(pg.db, {
    id: String(SOURCE),
    workspaceId: String(WS),
    name: "Close",
    type: "close",
  });
  await ensureTestSourceConnection(pg.db, {
    id: String(FOREIGN_SOURCE),
    workspaceId: String(OTHER_WS),
    name: "Their Close",
    type: "close",
  });
  await ensureTestDatabaseConnection(pg.db, {
    id: String(DEST),
    workspaceId: String(WS),
    name: "bq",
    type: "bigquery",
  });
  await ensureTestDatabaseConnection(pg.db, {
    id: String(FOREIGN_DEST),
    workspaceId: String(OTHER_WS),
    name: "their bq",
    type: "bigquery",
  });
});

function file(
  source: Types.ObjectId,
  dest: Types.ObjectId,
  table?: Types.ObjectId,
): FlowFile {
  return {
    name: "f",
    source: { type: "connector", connectionId: String(source) },
    destination: {
      connectionId: String(dest),
      ...(table ? { table: { connectionId: String(table) } } : {}),
    },
  } as unknown as FlowFile;
}

describe("the refusal a push applies", () => {
  it("accepts a file whose connections are all in the workspace", async () => {
    expect(
      await flowFileConnectionRefusal(String(WS), file(SOURCE, DEST, DEST)),
    ).toBeNull();
  });

  it("refuses another workspace's source, destination and table destination", async () => {
    expect(
      await flowFileConnectionRefusal(String(WS), file(FOREIGN_SOURCE, DEST)),
    ).toBe(
      `\`source.connection_id: ${FOREIGN_SOURCE}\` does not name a source connection in this workspace`,
    );
    expect(
      await flowFileConnectionRefusal(String(WS), file(SOURCE, FOREIGN_DEST)),
    ).toContain(`destination.connection_id: ${FOREIGN_DEST}`);
    expect(
      await flowFileConnectionRefusal(
        String(WS),
        file(SOURCE, DEST, FOREIGN_DEST),
      ),
    ).toContain(`destination.table.connection_id: ${FOREIGN_DEST}`);
  });

  it("reads a missing connection the same as a foreign one", async () => {
    const missing = new Types.ObjectId();
    expect(
      await flowFileConnectionRefusal(String(WS), file(missing, DEST)),
    ).toBe(
      `\`source.connection_id: ${missing}\` does not name a source connection in this workspace`,
    );
  });

  it("checks a database source against database connections", async () => {
    const refs = [
      {
        field: "source.connection_id",
        id: String(SOURCE),
        kind: "database" as const,
      },
    ];
    expect(await foreignConnectionRefusal(String(WS), refs)).toContain(
      "does not name a database connection",
    );
  });
});

describe("the source connection lookup", () => {
  const manager = {
    getSourceConnection: (id: string, ws?: string) =>
      getSourceConnectionManager().getSourceConnection(id, ws),
  };

  it("finds the flow's own connection in its workspace", async () => {
    const found = await manager.getSourceConnection(String(SOURCE), String(WS));
    expect(found?.name).toBe("Close");
  });

  it("reads another workspace's connection as missing", async () => {
    expect(
      await manager.getSourceConnection(String(FOREIGN_SOURCE), String(WS)),
    ).toBeNull();
    expect(
      await manager.getSourceConnection(String(SOURCE), "not-an-id"),
    ).toBeNull();
  });
});

describe("the API update", () => {
  function flowDoc() {
    return new Flow({
      workspaceId: WS,
      slug: "f",
      createdBy: "u",
      name: "f",
      sourceType: "database",
      databaseSource: { connectionId: DEST, query: "select 1" },
      destinationDatabaseId: DEST,
      tableDestination: { connectionId: DEST, schema: "s", tableName: "t" },
    }) as any;
  }

  it("refuses another workspace's table destination", async () => {
    const flow = flowDoc();
    await expect(
      applyFlowUpdate({
        workspaceId: String(WS),
        flow,
        body: { tableDestination: { connectionId: String(FOREIGN_DEST) } },
      } as any),
    ).rejects.toMatchObject({
      status: 404,
      message: "Destination database connection not found",
    });
    expect(String(flow.tableDestination.connectionId)).toBe(String(DEST));
  });

  it("refuses another workspace's database source", async () => {
    const flow = flowDoc();
    await expect(
      applyFlowUpdate({
        workspaceId: String(WS),
        flow,
        body: {
          databaseSource: {
            connectionId: String(FOREIGN_DEST),
            query: "select 1",
          },
        },
      } as any),
    ).rejects.toMatchObject({
      status: 404,
      message: "Source database connection not found",
    });
    expect(String(flow.databaseSource.connectionId)).toBe(String(DEST));
  });
});

/**
 * Defence in depth: a row written before the apply-time check could still
 * name a foreign connection. The runtime reads it as missing.
 */
describe("runtime lookups read another workspace's connection as missing", () => {
  it("the destination writer refuses a foreign table destination", async () => {
    const writer = new DestinationWriter({
      workspaceId: String(WS),
      tableDestination: {
        connectionId: FOREIGN_DEST,
        schema: "s",
        tableName: "t",
      } as any,
    });
    await expect(writer.initialize()).rejects.toThrow(
      `Database connection not found: ${FOREIGN_DEST}`,
    );
  });

  it("a CDC adapter refuses a foreign destination", async () => {
    const adapter = new MongoDbDestinationAdapter({
      destinationDatabaseId: String(FOREIGN_DEST),
      workspaceId: String(WS),
      tableDestination: {
        connectionId: String(FOREIGN_DEST),
        schema: "s",
        tableName: "t",
      },
    } as any);
    await expect((adapter as any).resolveDestination()).rejects.toThrow(
      "not found",
    );
  });

  it("a missing or malformed id finds nothing and never throws", async () => {
    const flow = await Flow.create({
      workspaceId: WS,
      slug: "scoped",
      name: "Scoped flow",
      type: "scheduled",
      sourceType: "connector",
      dataSourceId: SOURCE,
      destinationDatabaseId: DEST,
      schedule: { enabled: false },
      createdBy: "u",
    });
    expect(await Flow.findOne(inWorkspace(undefined, WS))).toBeNull();
    expect(await Flow.findOne(inWorkspace("close", WS))).toBeNull();
    expect(await Flow.findOne(inWorkspace(flow._id, "not-an-id"))).toBeNull();
    expect((await Flow.findOne(inWorkspace(flow._id, WS)))?.name).toBe(
      "Scoped flow",
    );
  });

  it("flow_list names only this workspace's connections", async () => {
    await Flow.collection.insertOne({
      _id: new Types.ObjectId(),
      workspaceId: WS,
      slug: "leaky",
      name: "Leaky",
      createdBy: "u",
      sourceType: "connector",
      dataSourceId: FOREIGN_SOURCE,
      destinationDatabaseId: FOREIGN_DEST,
    } as any);
    const tools = createFlowSyncTools({ workspaceId: String(WS) });
    const result: any = await (tools.flow_list as any).execute({}, {} as any);
    expect(result.success).toBe(true);
    const text = JSON.stringify(result.flows);
    expect(text).not.toContain("Their Close");
    expect(text).not.toContain("their bq");
  });
});
