import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.hoisted(() =>
  vi.fn<(req: Request) => Promise<Response>>(),
);

// Route the shared singleton through a stub transport with an absolute base
// (Node's Request rejects relative URLs); the middleware stays the real one.
vi.mock("./client", async importOriginal => {
  const real = await importOriginal<typeof import("./client")>();
  return {
    ...real,
    api: real.createApiClient("https://test.local", req =>
      fetchMock(req as Request),
    ),
  };
});

import { setWorkspaceIdSource } from "./client";
import { ApiError, bodyWithStatus } from "./result";
import { unspecced } from "./unspecced";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("unspecced", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    setWorkspaceIdSource(() => "ws_1");
  });

  it("goes through the shared client: workspace header, query, JSON body", async () => {
    fetchMock.mockResolvedValue(json({ success: true, runs: [] }));
    const res = await unspecced.get<{ runs: unknown[] }>(
      "/api/workspaces/ws_1/dbt/projects/p1/runs",
      { jobId: "j1", limit: "100" },
    );
    expect(res.runs).toEqual([]);
    const req = fetchMock.mock.calls[0][0];
    expect(req.method).toBe("GET");
    expect(req.url).toBe(
      "https://test.local/api/workspaces/ws_1/dbt/projects/p1/runs?jobId=j1&limit=100",
    );
    expect(req.headers.get("x-workspace-id")).toBe("ws_1");
  });

  it("sends no Content-Type for a body-less POST", async () => {
    fetchMock.mockResolvedValue(json({ success: true }));
    await unspecced.post("/api/workspaces/ws_1/dbt/projects/p1/runs/r1/cancel");
    const req = fetchMock.mock.calls[0][0];
    expect(req.method).toBe("POST");
    expect(req.headers.get("content-type")).toBeNull();
  });

  it("serializes a JSON body", async () => {
    fetchMock.mockResolvedValue(json({ success: true }));
    await unspecced.put("/api/workspaces/ws_1/x", { content: "a" });
    const req = fetchMock.mock.calls[0][0];
    expect(req.headers.get("content-type")).toBe("application/json");
    expect(await req.json()).toEqual({ content: "a" });
  });

  it("resolves an empty 2xx body to {}", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(unspecced.delete("/api/workspaces/ws_1/x")).resolves.toEqual(
      {},
    );
  });

  it("throws ApiError with the server's message and status", async () => {
    fetchMock.mockResolvedValue(json({ error: "Project not found" }, 404));
    const err = (await unspecced
      .get("/api/workspaces/ws_1/x")
      .catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(404);
    expect(err.message).toBe("Project not found");
  });
});

describe("bodyWithStatus", () => {
  const result = (status: number, payload: unknown) => {
    const response = new Response(null, { status });
    return response.ok
      ? { data: payload, response }
      : { error: payload, response };
  };

  it("returns the body of a 2xx", () => {
    expect(bodyWithStatus(result(200, { success: true }), [409])).toEqual({
      status: 200,
      body: { success: true },
    });
  });

  it("returns the error body of an allowed status instead of throwing", () => {
    expect(
      bodyWithStatus(result(409, { draftConflict: { content: "x" } }), [409]),
    ).toEqual({ status: 409, body: { draftConflict: { content: "x" } } });
  });

  it("throws ApiError for any other failure", () => {
    expect(() => bodyWithStatus(result(500, { error: "boom" }), [409])).toThrow(
      ApiError,
    );
  });
});
