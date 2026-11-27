/**
 * A source connection whose connector type was removed (no config schema).
 *
 * Its stored config cannot be edited (a new secret would be stored in
 * plaintext), decrypted or sent (ciphertext would go out as a credential).
 * Name, description and DELETE still work. The type is generic: any name the
 * registry has no schema for.
 *
 * Real routes, proxy, and PGlite; auth and the
 * connector schema are mocked; the HTTP transport is a spy that must stay
 * unused.
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
} from "../test-support/pg-test";

vi.mock("../auth/unified-auth.middleware", () => ({
  unifiedAuthMiddleware: async (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set("user", { id: OWNER_ID });
    c.set("authType", "session");
    await next();
  },
}));

vi.mock("../services/workspace.service", () => ({
  workspaceService: {
    hasAccess: vi.fn(async () => true),
    getMember: vi.fn(async () => ({ role: "owner" })),
    getOwnerIds: vi.fn(async () => [OWNER_ID]),
  },
}));

// "gcs" and "wise" have no schema here (removed connectors); "close" does.
vi.mock("../sync/connector-registry", () => ({
  syncConnectorRegistry: {
    getConfigSchemaForType: vi.fn(async (type: string) => {
      // A workspace connector that is retrying: loading its schema throws.
      if (type === "ws:acme") throw new Error("The connector acme is retrying");
      return type === "close"
        ? { fields: [{ name: "api_key", type: "password", encrypted: true }] }
        : null;
    }),
    getConnectorFor: vi.fn(async () => null),
  },
}));

vi.mock("../connectors/registry", () => ({
  connectorRegistry: { hasConnector: vi.fn(() => true) },
}));

import { sourceConnectionRoutes } from "./source-connections";
import {
  applySchemaEncryption,
  isOrphanConnectorType,
} from "../connectors/source-connection-create.service";
import { connectionRequest } from "../connections/proxy.service";
import { setTransportForTests } from "../connections/forward";
import { probeConnection, ProbeError } from "../connectors/probe.service";
import { getSourceConnectionManager } from "../sync/database-data-source-manager";
import { createConnectionWriteTools } from "../agent-lib/tools/connection-write-tools";

let pg: PgTestDb;
const OWNER_ID = legacyUserIdToUuidv7("owner1");
const WS = new Types.ObjectId().toString();
const CIPHERTEXT = "00112233445566778899aabbccddeeff:deadbeef";

const app = new Hono();
app.route(
  "/api/workspaces/:workspaceId/connections/sources",
  sourceConnectionRoutes,
);

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

const transport = vi.fn();

beforeAll(async () => {
  process.env.ENCRYPTION_KEY ??= "0".repeat(64);
  pg = await setupPgTestDb();
});

afterAll(async () => {
  setTransportForTests(null);
  await pg?.close();
});

let orphan: string;
beforeEach(async () => {
  transport.mockReset();
  setTransportForTests(transport);
  await pg.reset();
  await ensureTestWorkspace(pg.db, { id: WS });
  await ensureTestUser(pg.db, { id: OWNER_ID });
  orphan = String(
    (
      await connectionsRepo.createSourceConnection({
        workspaceId: WS,
        name: "old gcs",
        type: "gcs",
        config: { api_key: CIPHERTEXT, bucket: "b" },
        settings: { sync_batch_size: 100, rate_limit_delay_ms: 200 },
        liveReads: true,
        createdBy: OWNER_ID,
        managers: [OWNER_ID],
      })
    )._id,
  );
});

const stored = async () =>
  await connectionsRepo.findSourceConnectionById(orphan, WS);

describe("an orphan type (no config schema)", () => {
  it("refuses a new secret and leaves the row untouched", async () => {
    const before = await stored();
    const res = await req("PUT", `/${orphan}`, {
      config: { api_key: "sk_live_plaintext" },
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/no longer available/);
    expect(await stored()).toEqual(before);
  });

  it("refuses a changed plain field, settings, targets and switching on", async () => {
    const before = await stored();
    for (const body of [
      { config: { bucket: "other" } },
      { settings: { sync_batch_size: 5 } },
      { targetDatabases: [String(new Types.ObjectId())] },
      { isActive: true, type: "gcs2" },
      { type: "close" },
    ]) {
      const res = await req("PUT", `/${orphan}`, body);
      expect(res.status).toBe(409);
    }
    expect(await stored()).toEqual(before);
  });

  it("renames and re-describes", async () => {
    const res = await req("PUT", `/${orphan}`, {
      name: "retired gcs",
      description: "kept for the record",
    });
    expect(res.status).toBe(200);
    const row = await stored();
    expect(row?.name).toBe("retired gcs");
    expect(row?.description).toBe("kept for the record");
    expect((row?.config as Record<string, string>).api_key).toBe(CIPHERTEXT);
  });

  it("deletes", async () => {
    const res = await req("DELETE", `/${orphan}`);
    expect(res.status).toBe(200);
    expect(await stored()).toBeNull();
  });

  it("call_connection is refused before any HTTP request", async () => {
    await expect(
      connectionRequest({
        workspaceId: WS,
        connection: orphan,
        request: { method: "GET", path: "/" },
        actor: { userId: OWNER_ID },
      } as never),
    ).rejects.toMatchObject({ status: 409 });
    expect(transport).not.toHaveBeenCalled();
  });

  it("the encryption helper throws instead of passing a config through", () => {
    expect(() => applySchemaEncryption({ api_key: "x" }, null)).toThrow(
      /no longer available/,
    );
    expect(applySchemaEncryption({}, null)).toEqual({});
  });

  it("PATCH enable is refused, and the row stays off", async () => {
    await connectionsRepo.updateSourceConnection(orphan, WS, {
      isActive: false,
    });
    const on = await req("PATCH", `/${orphan}/enable`, { enabled: true });
    expect(on.status).toBe(409);
    expect((await stored())?.isActive).toBe(false);
    const off = await req("PATCH", `/${orphan}/enable`, { enabled: false });
    expect(off.status).toBe(200);
  });

  it("MCP update_connection active:true is refused, a rename works", async () => {
    await connectionsRepo.updateSourceConnection(orphan, WS, {
      isActive: false,
    });
    const tools = createConnectionWriteTools(WS, OWNER_ID);
    const exec = (input: Record<string, unknown>) =>
      (
        tools.update_connection as unknown as {
          execute: (i: unknown, o: unknown) => Promise<any>;
        }
      ).execute({ connectionId: orphan, ...input }, {});
    const on = await exec({ active: true });
    expect(on.error).toMatch(/no longer available/);
    expect((await stored())?.isActive).toBe(false);
    const renamed = await exec({ name: "mcp renamed" });
    expect(renamed.error).toBeUndefined();
    expect((await stored())?.name).toBe("mcp renamed");
  });

  it("probe is refused before any request", async () => {
    await expect(
      probeConnection({
        workspaceId: WS,
        connectionId: orphan,
        actor: { userId: OWNER_ID },
      } as never),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ProbeError && e.code === "connector_unavailable",
    );
    expect(transport).not.toHaveBeenCalled();
  });

  it("decryptConfig withholds the config for a null schema", async () => {
    const manager = getSourceConnectionManager() as unknown as {
      decryptConfig: (c: unknown, t: string, w?: string) => Promise<unknown>;
    };
    const out = await manager.decryptConfig({ api_key: CIPHERTEXT }, "gcs", WS);
    expect(out).toEqual({});
  });
});

describe("a workspace connector that is retrying", () => {
  it("is not an orphan, and its connection can still be switched on", async () => {
    expect(await isOrphanConnectorType("ws:acme", WS)).toBe(false);
    expect(await isOrphanConnectorType("gcs", WS)).toBe(true);
    const live = await connectionsRepo.createSourceConnection({
      workspaceId: WS,
      name: "acme",
      type: "ws:acme",
      config: {},
      isActive: false,
      settings: { sync_batch_size: 100, rate_limit_delay_ms: 200 },
      createdBy: OWNER_ID,
      managers: [OWNER_ID],
    });
    const res = await req("PATCH", `/${live._id}/enable`, { enabled: true });
    expect(res.status).toBe(200);
  });
});
