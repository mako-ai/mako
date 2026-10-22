/**
 * Freshness window + stale-while-revalidate headers for stored parquet.
 * Pure: the store, schedule lookup and kickoff are injected.
 */
import { describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";
import type { IAppProject } from "../database/workspace-schema";
import {
  ARTIFACT_BUILT_AT_HEADER,
  ARTIFACT_REBUILD_HEADER,
  ARTIFACT_STALE_HEADER,
  artifactFreshnessHeaders,
  artifactRevalidateHeaders,
  isArtifactMetaRequest,
  isBindingArtifactStale,
} from "./binding-freshness";

const now = new Date("2026-09-08T12:00:00Z");
const hourAgo = new Date("2026-09-08T11:00:00Z");
const twoHoursAgo = new Date("2026-09-08T10:00:00Z");
const project = { _id: new Types.ObjectId() } as unknown as IAppProject;
const projectId = project._id.toString();

describe("isBindingArtifactStale", () => {
  it("treats a scheduled artifact as stale once the cron is due", () => {
    // Daily at 03:00 UTC; last built yesterday.
    expect(
      isBindingArtifactStale({
        builtAt: new Date("2026-09-07T03:05:00Z"),
        schedule: "0 3 * * *",
        timezone: "UTC",
        now,
      }),
    ).toBe(true);
    expect(
      isBindingArtifactStale({
        builtAt: new Date("2026-09-08T03:05:00Z"),
        schedule: "0 3 * * *",
        timezone: "UTC",
        now,
      }),
    ).toBe(false);
  });

  it("an unscheduled artifact is stale after the TTL, not before", () => {
    expect(
      isBindingArtifactStale({
        builtAt: hourAgo,
        now,
        ttlMs: 60 * 60 * 1000,
      }),
    ).toBe(true);
    expect(
      isBindingArtifactStale({
        builtAt: new Date("2026-09-08T11:00:01Z"),
        now,
        ttlMs: 60 * 60 * 1000,
      }),
    ).toBe(false);
  });

  it("unknown write time is stale (same cheap side as publish)", () => {
    expect(isBindingArtifactStale({ builtAt: null, now, ttlMs: 60_000 })).toBe(
      true,
    );
    expect(
      isBindingArtifactStale({
        builtAt: null,
        schedule: "0 3 * * *",
        now,
      }),
    ).toBe(true);
  });

  it("falls back to the TTL when the cron cannot be parsed", () => {
    expect(
      isBindingArtifactStale({
        builtAt: hourAgo,
        schedule: "not a cron",
        now,
        ttlMs: 3 * 60 * 60 * 1000,
      }),
    ).toBe(false);
    expect(
      isBindingArtifactStale({
        builtAt: twoHoursAgo,
        schedule: "not a cron",
        now,
        ttlMs: 60 * 60 * 1000,
      }),
    ).toBe(true);
  });
});

describe("artifactFreshnessHeaders", () => {
  it("exposes built-at, stale and rebuild to CORS readers", () => {
    const headers = artifactFreshnessHeaders({
      builtAt: hourAgo,
      stale: true,
      rebuild: "started",
    });
    expect(headers[ARTIFACT_BUILT_AT_HEADER]).toBe(hourAgo.toISOString());
    expect(headers[ARTIFACT_STALE_HEADER]).toBe("1");
    expect(headers[ARTIFACT_REBUILD_HEADER]).toBe("started");
    expect(headers["Access-Control-Expose-Headers"]).toMatch(/X-Mako-Rebuild/);
  });

  it("omits the stale header when the artifact is current", () => {
    const headers = artifactFreshnessHeaders({
      builtAt: hourAgo,
      stale: false,
      rebuild: "none",
    });
    expect(headers[ARTIFACT_STALE_HEADER]).toBeUndefined();
    expect(headers[ARTIFACT_REBUILD_HEADER]).toBe("none");
  });
});

describe("artifactRevalidateHeaders", () => {
  const store = (builtAt: Date | null) => ({
    getLastModified: vi.fn(async () => builtAt),
  });

  it("serves a fresh artifact without starting a rebuild", async () => {
    const kickoff = vi.fn(async () => "started" as const);
    const headers = await artifactRevalidateHeaders({
      store: store(new Date("2026-09-08T11:30:00Z")),
      key: "apps/bindings/c/h.parquet",
      projectId,
      project,
      name: "sales",
      actorId: "u1",
      now,
      lookupSchedule: async () => undefined,
      kickoffRevalidate: kickoff,
      inFlight: () => false,
    });
    expect(headers[ARTIFACT_STALE_HEADER]).toBeUndefined();
    expect(headers[ARTIFACT_REBUILD_HEADER]).toBe("none");
    expect(kickoff).not.toHaveBeenCalled();
  });

  it("starts one background rebuild when the stored file is past the TTL", async () => {
    const kickoff = vi.fn(async () => "started" as const);
    const headers = await artifactRevalidateHeaders({
      store: store(twoHoursAgo),
      key: "apps/bindings/c/h.parquet",
      projectId,
      project,
      name: "sales",
      actorId: "u1",
      at: "abc",
      now,
      lookupSchedule: async () => undefined,
      kickoffRevalidate: kickoff,
      inFlight: () => false,
    });
    expect(headers[ARTIFACT_STALE_HEADER]).toBe("1");
    expect(headers[ARTIFACT_REBUILD_HEADER]).toBe("started");
    expect(kickoff).toHaveBeenCalledWith({
      project,
      name: "sales",
      actorId: "u1",
      at: "abc",
    });
  });

  it("reports running when a rebuild is already in flight, without starting another", async () => {
    const kickoff = vi.fn(async () => "started" as const);
    const headers = await artifactRevalidateHeaders({
      store: store(twoHoursAgo),
      key: "k",
      projectId,
      project,
      name: "sales",
      actorId: "u1",
      now,
      lookupSchedule: async () => undefined,
      kickoffRevalidate: kickoff,
      inFlight: () => true,
    });
    expect(headers[ARTIFACT_REBUILD_HEADER]).toBe("running");
    expect(kickoff).not.toHaveBeenCalled();
  });

  it("does not kick off on a meta poll (the GET already did)", async () => {
    const kickoff = vi.fn(async () => "started" as const);
    const headers = await artifactRevalidateHeaders({
      store: store(twoHoursAgo),
      key: "k",
      projectId,
      project,
      name: "sales",
      actorId: "",
      now,
      kickoff: false,
      lookupSchedule: async () => undefined,
      kickoffRevalidate: kickoff,
      inFlight: () => false,
    });
    expect(headers[ARTIFACT_STALE_HEADER]).toBe("1");
    expect(headers[ARTIFACT_REBUILD_HEADER]).toBe("none");
    expect(kickoff).not.toHaveBeenCalled();
  });

  it("uses the binding's cron when the apps index has a schedule", async () => {
    const kickoff = vi.fn(async () => "started" as const);
    const headers = await artifactRevalidateHeaders({
      store: store(new Date("2026-09-08T03:05:00Z")),
      key: "k",
      projectId,
      project,
      name: "sales",
      actorId: "u1",
      now,
      lookupSchedule: async () => ({ cron: "0 3 * * *", timezone: "UTC" }),
      kickoffRevalidate: kickoff,
      inFlight: () => false,
    });
    // Built at 03:05, next due is tomorrow 03:00 — not stale at noon.
    expect(headers[ARTIFACT_STALE_HEADER]).toBeUndefined();
    expect(kickoff).not.toHaveBeenCalled();
  });
});

describe("isArtifactMetaRequest", () => {
  it("matches the SDK's cheap poll query", () => {
    expect(
      isArtifactMetaRequest(
        "https://app.example/__data/sales.parquet?mako_meta=1",
      ),
    ).toBe(true);
    expect(
      isArtifactMetaRequest("https://app.example/__data/sales.parquet"),
    ).toBe(false);
  });
});
