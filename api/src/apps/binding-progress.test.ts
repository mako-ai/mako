/**
 * Phase events on the request doing the work: the stream shape every host
 * answers with, the joiner of a shared refresh hearing the same build, and
 * a stored artifact's GET turning into resolving → signing → ready + url.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";
import type { IAppProject } from "../database/workspace-schema";
import type { ArtifactStore } from "../services/artifact-store.service";
import {
  LIVE_BINDING_STREAM_CONTENT_TYPE,
  bindingProgressResponse,
  parquetLinkOutcome,
  reportBindingPhase,
  serverTimingHeader,
  wantsBindingProgress,
} from "./binding-progress";
import {
  refreshBindingProgress,
  type RefreshBindingDeps,
} from "./binding-refresh";

async function events(res: Response) {
  return (await res.text())
    .trim()
    .split("\n")
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

describe("wantsBindingProgress", () => {
  it("matches the media type, not a substring of another", () => {
    expect(wantsBindingProgress("application/x-ndjson")).toBe(true);
    expect(wantsBindingProgress("application/x-ndjson, */*;q=0.5")).toBe(true);
    expect(wantsBindingProgress("*/*")).toBe(false);
    expect(wantsBindingProgress(undefined)).toBe(false);
    expect(wantsBindingProgress("application/x-ndjsonx")).toBe(false);
    expect(
      wantsBindingProgress(
        LIVE_BINDING_STREAM_CONTENT_TYPE,
        LIVE_BINDING_STREAM_CONTENT_TYPE,
      ),
    ).toBe(true);
  });
});

describe("bindingProgressResponse", () => {
  it("streams reported phases, then the outcome as `ready`", async () => {
    const res = bindingProgressResponse(
      async () => {
        reportBindingPhase("querying_warehouse");
        reportBindingPhase("writing_parquet", { rowsWritten: 5000 });
        reportBindingPhase("uploading", { rowsWritten: 9000, bytes: 4096 });
        return { status: 200, body: { success: true, rowCount: 9000 } };
      },
      { throttleMs: 0 },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-ndjson");
    // Neither compress() nor Cloudflare may hold the stream to gzip it.
    expect(res.headers.get("cache-control")).toContain("no-transform");
    const lines = await events(res);
    expect(lines.map(e => e.phase)).toEqual([
      "querying_warehouse",
      "writing_parquet",
      "uploading",
      "ready",
    ]);
    expect(lines[1]).toMatchObject({ rowsWritten: 5000 });
    expect(lines[3]).toMatchObject({ success: true, rowCount: 9000 });
    expect(lines[3].elapsedMs).toEqual(expect.any(Number));
  });

  it("ends in `failed` with the status the plain route would answer", async () => {
    const res = bindingProgressResponse(async () => ({
      status: 429,
      body: { success: false, error: "too soon", retryAfterMs: 1000 },
    }));
    const lines = await events(res);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      phase: "failed",
      status: 429,
      error: "too soon",
      retryAfterMs: 1000,
    });
  });

  it("answers a thrown error as a 500 without leaking it", async () => {
    const res = bindingProgressResponse(async () => {
      throw new Error("mongo password is hunter2");
    });
    const [line] = await events(res);
    expect(line).toMatchObject({ phase: "failed", status: 500 });
    expect(JSON.stringify(line)).not.toContain("hunter2");
  });

  it("coalesces row counts of one phase, keeping the latest", async () => {
    const res = bindingProgressResponse(
      async () => {
        for (let rows = 5000; rows <= 50_000; rows += 5000) {
          reportBindingPhase("writing_parquet", { rowsWritten: rows });
        }
        return { status: 200, body: {} };
      },
      { throttleMs: 60_000 },
    );
    const lines = await events(res);
    expect(lines.map(e => e.phase)).toEqual([
      "writing_parquet",
      "writing_parquet",
      "ready",
    ]);
    expect(lines[0].rowsWritten).toBe(5000);
    expect(lines[1].rowsWritten).toBe(50_000);
  });

  it("repeats a long phase as a heartbeat", async () => {
    const res = bindingProgressResponse(
      async () => {
        reportBindingPhase("querying_warehouse");
        await new Promise(resolve => setTimeout(resolve, 120));
        return { status: 200, body: {} };
      },
      { heartbeatMs: 30, throttleMs: 5 },
    );
    const lines = await events(res);
    const beats = lines.filter(e => e.phase === "querying_warehouse");
    expect(beats.length).toBeGreaterThan(1);
  });

  it("puts a tail file's bytes after the terminal line and deletes it", async () => {
    const file = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), "mako-tail-")),
      "x.parquet",
    );
    await fs.writeFile(file, "PAR1-bytes-PAR1");
    const res = bindingProgressResponse(
      async () => {
        reportBindingPhase("querying_warehouse");
        return { status: 200, body: { rowCount: 3 }, tailFile: file };
      },
      { contentType: LIVE_BINDING_STREAM_CONTENT_TYPE },
    );
    expect(res.headers.get("content-type")).toBe(
      LIVE_BINDING_STREAM_CONTENT_TYPE,
    );
    const text = await res.text();
    const [first, second, ...rest] = text.split("\n");
    expect(JSON.parse(first).phase).toBe("querying_warehouse");
    expect(JSON.parse(second)).toMatchObject({
      phase: "ready",
      rowCount: 3,
      bytes: 15,
    });
    expect(rest.join("\n")).toBe("PAR1-bytes-PAR1");
    await expect(fs.stat(file)).rejects.toThrow();
  });
});

describe("refreshBindingProgress", () => {
  const project = { _id: new Types.ObjectId() } as unknown as IAppProject;

  it("lets a joiner of the shared build hear its phases too", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const deps: RefreshBindingDeps = {
      readMaterialization: vi.fn(async () => "parquet" as const),
      claim: vi.fn(async () => ({ claimed: true as const })),
      materialize: vi.fn(async () => {
        reportBindingPhase("querying_warehouse");
        await gate;
        reportBindingPhase("uploading", { rowsWritten: 9, bytes: 99 });
        return {
          artifactKey: "apps/bindings/c/h.parquet",
          rowCount: 9,
          byteSize: 99,
          materializedAt: new Date("2026-10-22T10:00:00Z"),
        };
      }),
    };
    const input = { project, name: "sales", actorId: "u1" };
    const first = refreshBindingProgress(input, { throttleMs: 0 }, deps);
    // Let the first caller reach the build before the second joins it.
    await new Promise(resolve => setTimeout(resolve, 5));
    const second = refreshBindingProgress(input, { throttleMs: 0 }, deps);
    await new Promise(resolve => setTimeout(resolve, 5));
    release();
    const [a, b] = await Promise.all([events(first), events(second)]);
    expect(deps.materialize).toHaveBeenCalledTimes(1);
    expect(a.map(e => e.phase)).toEqual([
      "checking",
      "querying_warehouse",
      "uploading",
      "ready",
    ]);
    // The joiner starts from where the build is.
    expect(b.map(e => e.phase)).toEqual([
      "checking",
      "querying_warehouse",
      "uploading",
      "ready",
    ]);
    expect(b[3]).toMatchObject({
      success: true,
      binding: "sales",
      rowCount: 9,
      byteSize: 99,
    });
  });
});

describe("parquetLinkOutcome", () => {
  function store(overrides: Partial<ArtifactStore> = {}): ArtifactStore {
    return {
      type: "gcs",
      exists: vi.fn(async () => true),
      getSignedUrl: vi.fn(async () => "https://storage.test/signed?sig=1"),
      ensureBrowserCors: vi.fn(async () => true),
      ...overrides,
    } as unknown as ArtifactStore;
  }

  it("is resolving, then signing, then the signed url and both durations", async () => {
    const s = store();
    const res = bindingProgressResponse(
      () => parquetLinkOutcome("sales", async () => ({ store: s, key: "k" })),
      { throttleMs: 0 },
    );
    const lines = await events(res);
    expect(lines.map(e => e.phase)).toEqual(["resolving", "signing", "ready"]);
    expect(lines[2]).toMatchObject({
      binding: "sales",
      url: "https://storage.test/signed?sig=1",
      timings: {
        resolveMs: expect.any(Number),
        signMs: expect.any(Number),
      },
    });
  });

  it("is a 404 for a name with no artifact, before or after resolving", async () => {
    expect(await parquetLinkOutcome("x", async () => null)).toMatchObject({
      status: 404,
    });
    const gone = store({ exists: vi.fn(async () => false) });
    expect(
      await parquetLinkOutcome("x", async () => ({ store: gone, key: "k" })),
    ).toMatchObject({ status: 404 });
  });

  it("omits the url when the store streams, so the client GETs the bytes", async () => {
    const fsStore = store({ type: "filesystem", ensureBrowserCors: undefined });
    const outcome = await parquetLinkOutcome("sales", async () => ({
      store: fsStore,
      key: "k",
    }));
    expect(outcome.status).toBe(200);
    expect(outcome.body).not.toHaveProperty("url");
  });
});

describe("serverTimingHeader", () => {
  it("formats rounded durations", () => {
    expect(serverTimingHeader({ resolve: 12.6, sign: 3 })).toBe(
      "resolve;dur=13, sign;dur=3",
    );
  });
});
