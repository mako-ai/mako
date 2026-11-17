/**
 * A flow names only its own workspace's connections. Real Mongoose models on
 * a memory Mongo: the refusal the push reactor uses, the API update's own
 * check, and the source connection lookup every flow path goes through.
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
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

vi.mock("./database-connection.service", () => ({
  databaseConnectionService: {
    getMainConnection: async () => ({ db: mongoose.connection.db }),
  },
}));

import {
  DatabaseConnection,
  Flow,
  SourceConnection,
} from "../database/workspace-schema";
import { getSourceConnectionManager } from "../sync/database-data-source-manager";
import {
  flowFileConnectionRefusal,
  foreignConnectionRefusal,
} from "./flow-connection-scope";
import { applyFlowUpdate } from "./flow-mutation.service";
import type { FlowFile } from "./flow-config-files";

let mongo: MongoMemoryServer;
const WS = new Types.ObjectId();
const OTHER_WS = new Types.ObjectId();
const SOURCE = new Types.ObjectId();
const DEST = new Types.ObjectId();
const FOREIGN_SOURCE = new Types.ObjectId();
const FOREIGN_DEST = new Types.ObjectId();

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  // The manager only reads the name from it; the connection is mocked above.
  process.env.DATABASE_URL ??= mongo.getUri();
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await SourceConnection.collection.deleteMany({});
  await DatabaseConnection.collection.deleteMany({});
  await SourceConnection.collection.insertMany([
    { _id: SOURCE, workspaceId: WS, name: "Close", type: "close", config: {} },
    {
      _id: FOREIGN_SOURCE,
      workspaceId: OTHER_WS,
      name: "Their Close",
      type: "close",
      config: {},
    },
  ] as any[]);
  await DatabaseConnection.collection.insertMany([
    { _id: DEST, workspaceId: WS, name: "bq", type: "bigquery" },
    {
      _id: FOREIGN_DEST,
      workspaceId: OTHER_WS,
      name: "their bq",
      type: "bigquery",
    },
  ] as any[]);
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
        requestBaseUrl: "https://mako.test",
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
        requestBaseUrl: "https://mako.test",
      } as any),
    ).rejects.toMatchObject({
      status: 404,
      message: "Source database connection not found",
    });
    expect(String(flow.databaseSource.connectionId)).toBe(String(DEST));
  });
});
