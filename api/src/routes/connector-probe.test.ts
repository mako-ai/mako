/**
 * `POST /connectors/:id/probe` — the REST leg of the live probe.
 *
 * The route is thin on purpose: the probe's rules (bounded, read-only, no
 * secret in the result) live in `connectors/probe.service.ts` and are pinned
 * there. What the route owns, and what these specs pin, is the edge: the
 * body is parsed and validated before the service runs, a caller mistake
 * maps to its HTTP status, and the URL workspace — not the id alone — is
 * what the service is told to authorize against.
 *
 * Real route + real Hono; auth, the workspace service and the probe service
 * are mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { Types } from "mongoose";

const state = vi.hoisted(() => ({
  calls: [] as unknown[],
  next: null as unknown,
}));

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
    getMember: vi.fn(async () => ({ role: "member" })),
    isAdmin: vi.fn(async () => false),
  },
}));

vi.mock("../connectors/probe.service", async importOriginal => {
  const actual =
    await importOriginal<typeof import("../connectors/probe.service")>();
  return {
    ...actual,
    probeConnection: vi.fn(async (input: unknown) => {
      state.calls.push(input);
      if (state.next instanceof Error) throw state.next;
      return state.next;
    }),
  };
});

import { dataSourceRoutes } from "./sources";
import { ProbeError } from "../connectors/probe.service";

process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY ??
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const WS = new Types.ObjectId().toString();
const CONNECTOR = new Types.ObjectId().toString();

const app = new Hono();
app.route("/api/workspaces/:workspaceId/connectors", dataSourceRoutes);

/**
 * A bodiless POST is sent the way a client sends one — no content type —
 * because a JSON content type with nothing behind it is what the OpenAPI
 * validator (rightly) refuses as malformed before the route runs.
 */
function probe(body?: unknown, raw?: string): Promise<Response> {
  const payload =
    raw ?? (body === undefined ? undefined : JSON.stringify(body));
  return Promise.resolve(
    app.request(`/api/workspaces/${WS}/connectors/${CONNECTOR}/probe`, {
      method: "POST",
      ...(payload === undefined
        ? {}
        : { headers: { "Content-Type": "application/json" }, body: payload }),
    }),
  );
}

beforeEach(() => {
  state.calls = [];
  state.next = {
    connection: {
      id: CONNECTOR,
      name: "Vercel",
      connector: "ws:vercel-ai-gateway",
    },
    check: { success: true, message: "Connection successful" },
    durationMs: 2,
  };
});

describe("the edge", () => {
  it("binds the URL workspace and forwards the body to the service", async () => {
    const res = await probe({
      entity: "daily-usage",
      limit: 3,
      fields: ["day"],
      since: "2026-08-01T00:00:00Z",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; data: unknown };
    expect(json.success).toBe(true);
    expect(json.data).toEqual(state.next);
    expect(state.calls).toEqual([
      {
        workspaceId: WS,
        connectionId: CONNECTOR,
        entity: "daily-usage",
        limit: 3,
        fields: ["day"],
        since: new Date("2026-08-01T00:00:00Z"),
      },
    ]);
  });

  it("an empty body is a check-only probe", async () => {
    const res = await probe();
    expect(res.status).toBe(200);
    expect(state.calls).toEqual([
      {
        workspaceId: WS,
        connectionId: CONNECTOR,
        entity: undefined,
        limit: undefined,
        fields: undefined,
        since: undefined,
      },
    ]);
  });

  it("refuses a body that is not JSON, and a `since` that is not an instant", async () => {
    expect((await probe(undefined, "{not json")).status).toBe(400);
    expect((await probe({ since: "yesterday" })).status).toBe(400);
    expect(state.calls).toEqual([]);
  });

  it("maps a ProbeError to its status and keeps its code", async () => {
    state.next = new ProbeError(
      "not_found",
      "Connection not found in this workspace.",
    );
    const res = await probe();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      success: false,
      error: "Connection not found in this workspace.",
      code: "not_found",
    });

    state.next = new ProbeError("unknown_entity", "no such entity");
    expect((await probe({ entity: "x" })).status).toBe(400);

    state.next = new ProbeError("timeout", "too slow");
    expect((await probe({ entity: "x" })).status).toBe(504);
  });

  it("any other failure is a 500 with the message and no code", async () => {
    state.next = new Error("sandbox unavailable");
    const res = await probe();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      success: false,
      error: "sandbox unavailable",
    });
  });
});
