/**
 * Shared DuckDB bridge for token-authorized viewers (public share + draft
 * preview): descriptor adaptation, lazy hydration, and run-duckdb serving.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ensureBindingLoaded = vi.fn<() => Promise<boolean>>();
const queryAppDuckDB =
  vi.fn<() => Promise<{ rows: unknown[]; fields: string[] }>>();

vi.mock("./duckdb", () => ({
  ensureBindingLoaded: (...args: unknown[]) =>
    ensureBindingLoaded(...(args as [])),
  queryAppDuckDB: (...args: unknown[]) => queryAppDuckDB(...(args as [])),
  checkSandboxDuckDbSql: (sql: string) =>
    /drop\s/i.test(sql)
      ? { ok: false, error: "Statement not allowed" }
      : { ok: true },
  resolveSandboxRowLimit: (limit: unknown) =>
    typeof limit === "number" ? limit : 1000,
  applySandboxRowLimit: (rows: unknown[], limit: number | null) =>
    limit != null && rows.length > limit
      ? { rows: rows.slice(0, limit), truncated: true }
      : { rows, truncated: false },
}));

import {
  hydrateReadyBindings,
  serveSandboxDuckDbRequest,
  toLoadableBinding,
  type TokenViewerBinding,
} from "./preview-duckdb";

const readyBinding: TokenViewerBinding = {
  id: "b1",
  name: "orders",
  materialization: "parquet",
  ready: true,
  rowCount: 42,
  materializedAt: "2026-08-01T00:00:00Z",
  artifactUrl: "/api/preview/tok/binding/b1/artifact?rev=r1",
};

const unbuiltBinding: TokenViewerBinding = {
  ...readyBinding,
  id: "b2",
  name: "pending",
  ready: false,
  artifactUrl: null,
};

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  ensureBindingLoaded.mockResolvedValue(true);
  queryAppDuckDB.mockResolvedValue({ rows: [{ n: 1 }], fields: ["n"] });
});

describe("preview-duckdb shared bridge", () => {
  it("adapts only ready bindings with artifacts into loadables", () => {
    const loadable = toLoadableBinding(readyBinding);
    expect(loadable).toMatchObject({
      name: "orders",
      materialization: "parquet",
      cache: {
        parquetUrl: readyBinding.artifactUrl,
        parquetBuildStatus: "ready",
      },
    });
    expect(toLoadableBinding(unbuiltBinding)).toBeNull();
  });

  it("hydrates only ready bindings", () => {
    hydrateReadyBindings("preview-tok", [readyBinding, unbuiltBinding]);
    expect(ensureBindingLoaded).toHaveBeenCalledTimes(1);
  });

  it("serves a run-duckdb request against hydrated artifacts", async () => {
    const post = vi.fn();
    serveSandboxDuckDbRequest({
      duckAppId: "preview-tok",
      bindings: [readyBinding, unbuiltBinding],
      requestId: "r1",
      sql: 'SELECT COUNT(*) FROM "orders"',
      rowLimit: undefined,
      post,
    });
    await flush();
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "r1",
        success: true,
        rows: [{ n: 1 }],
        fields: ["n"],
      }),
    );
  });

  it("rejects unsafe SQL without touching DuckDB", async () => {
    const post = vi.fn();
    serveSandboxDuckDbRequest({
      duckAppId: "preview-tok",
      bindings: [readyBinding],
      requestId: "r2",
      sql: "DROP TABLE orders",
      rowLimit: undefined,
      post,
    });
    await flush();
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "r2", success: false }),
    );
    expect(queryAppDuckDB).not.toHaveBeenCalled();
  });

  it("reports DuckDB failures as a correctable error", async () => {
    queryAppDuckDB.mockRejectedValue(new Error("table missing"));
    const post = vi.fn();
    serveSandboxDuckDbRequest({
      duckAppId: "preview-tok",
      bindings: [readyBinding],
      requestId: "r3",
      sql: "SELECT 1",
      rowLimit: undefined,
      post,
    });
    await flush();
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "r3",
        success: false,
        error: "table missing",
      }),
    );
  });
});
