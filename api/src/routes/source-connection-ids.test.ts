/**
 * Garbage source-connection ids must not become mongoose CastError 500s.
 *
 * Deep links are `/cx/:id` with `[a-zA-Z0-9-]+`, so values like `undefined`
 * and `new` are legal URLs. The tab then GETs that id. Before this pin,
 * mongoose threw Cast to ObjectId and the route mapped it to 500 with the
 * CastError message in the body.
 *
 * Real routes + real Mongo (mongodb-memory-server); auth and workspace
 * access are mocked.
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

vi.mock("../auth/unified-auth.middleware", () => ({
  unifiedAuthMiddleware: async (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set("user", { id: "u1" });
    await next();
  },
}));

vi.mock("../services/workspace.service", () => ({
  workspaceService: {
    hasAccess: vi.fn(async () => true),
    getMember: vi.fn(async () => ({ role: "owner" })),
    isAdmin: vi.fn(async () => true),
  },
}));

import { sourceConnectionRoutes } from "./source-connections";

let mongo: MongoMemoryServer;
const WS = new Types.ObjectId().toString();

const app = new Hono();
app.route(
  "/api/workspaces/:workspaceId/connections/sources",
  sourceConnectionRoutes,
);
app.route("/api/workspaces/:workspaceId/connectors", sourceConnectionRoutes);

function req(method: string, path: string, body?: unknown): Promise<Response> {
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
  process.env.ENCRYPTION_KEY =
    process.env.ENCRYPTION_KEY ??
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  const { Connector } = await import("../database/workspace-schema");
  await Connector.deleteMany({});
});

describe("invalid source-connection ids are 400, not 500", () => {
  it.each([
    ["GET", "/undefined"],
    ["PUT", "/undefined"],
    ["DELETE", "/undefined"],
    ["GET", "/new"],
    ["PATCH", "/undefined/enable"],
    ["POST", "/undefined/test"],
    ["GET", "/undefined/entities"],
    ["POST", "/undefined/probe"],
  ] as const)("%s %s", async (method, path) => {
    const res = await req(
      method,
      path,
      method === "GET" || method === "DELETE"
        ? undefined
        : method === "PATCH"
          ? { enabled: true }
          : {},
    );
    expect(res.status, await res.clone().text()).toBe(400);
    const body = (await res.json()) as { success: boolean; error?: string };
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/invalid/i);
    expect(JSON.stringify(body)).not.toMatch(/Cast to ObjectId/i);
  });
});
