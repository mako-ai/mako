/**
 * Stale-while-revalidate for a binding's stored parquet.
 *
 * The read path must never block on a warehouse query when bytes already
 * exist: serve them, and if they are older than the binding's freshness
 * window, kick off ONE background rematerialization (binding-refresh.ts
 * inflight + cooldown). Explicit `refresh()` still waits.
 */
import type { ArtifactStore } from "../services/artifact-store.service";
import { serveParquetArtifact } from "../services/artifact-delivery.service";
import {
  AppIndexEntry,
  AppProject,
  type IAppProject,
} from "../database/workspace-schema";
import { isCronDue } from "../services/cron-due";
import {
  bindingRefreshInFlight,
  kickoffBindingRevalidate,
} from "./binding-refresh";

/** Unscheduled parquet: rebuild in the background after this age. */
export const DEFAULT_BINDING_STALE_AFTER_MS = 60 * 60 * 1000;

/** Header names the SDK reads after `__data/<name>.parquet`. */
export const ARTIFACT_BUILT_AT_HEADER = "X-Mako-Artifact-Built-At";
export const ARTIFACT_STALE_HEADER = "X-Mako-Artifact-Stale";
export const ARTIFACT_REBUILD_HEADER = "X-Mako-Rebuild";

export const ARTIFACT_REVALIDATE_EXPOSE = [
  ARTIFACT_BUILT_AT_HEADER,
  ARTIFACT_STALE_HEADER,
  ARTIFACT_REBUILD_HEADER,
].join(", ");

export type ArtifactRebuildState = "started" | "running" | "none";

export function bindingStaleAfterMs(): number {
  return readPositiveMs(
    process.env.APPS_BINDING_STALE_AFTER_MS,
    DEFAULT_BINDING_STALE_AFTER_MS,
  );
}

function readPositiveMs(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Whether a stored artifact should be rematerialized in the background.
 *
 * A `-- schedule:` cron uses the same due predicate as the scheduler: the
 * file is stale once the next occurrence after its write time has passed.
 * Unscheduled parquet uses `ttlMs` (env `APPS_BINDING_STALE_AFTER_MS`,
 * default 1 hour). An unparseable cron is treated as unscheduled, matching
 * publish. Live bindings are not an artifact and must not be asked.
 */
export function isBindingArtifactStale(input: {
  builtAt: Date | null;
  schedule?: string | null;
  timezone?: string | null;
  now?: Date;
  ttlMs?: number;
}): boolean {
  const now = input.now ?? new Date();
  const ttlMs = input.ttlMs ?? bindingStaleAfterMs();
  const cron = input.schedule?.trim();
  if (cron) {
    try {
      return isCronDue({
        cron,
        timezone: input.timezone,
        lastRunAt: input.builtAt,
        now,
      });
    } catch {
      // Invalid cron/tz: the scheduler skips these; freshness falls back
      // to the unscheduled TTL rather than rebuilding on every read.
    }
  }
  if (!input.builtAt) return true;
  return now.getTime() - input.builtAt.getTime() >= ttlMs;
}

export function artifactFreshnessHeaders(input: {
  builtAt: Date | null;
  stale: boolean;
  rebuild: ArtifactRebuildState;
}): Record<string, string> {
  const headers: Record<string, string> = {
    [ARTIFACT_REBUILD_HEADER]: input.rebuild,
    "Access-Control-Expose-Headers": ARTIFACT_REVALIDATE_EXPOSE,
  };
  if (input.builtAt) {
    headers[ARTIFACT_BUILT_AT_HEADER] = input.builtAt.toISOString();
  }
  if (input.stale) {
    headers[ARTIFACT_STALE_HEADER] = "1";
  }
  return headers;
}

const SCHEDULE_CACHE_MS = 60_000;
const scheduleCache = new Map<
  string,
  {
    expiresAt: number;
    byName: Map<string, { cron: string; timezone?: string }>;
  }
>();

export function resetBindingScheduleCache(): void {
  scheduleCache.clear();
}

/** `-- schedule:` from the apps index (no repo read). Cached per project. */
export async function lookupBindingSchedule(
  projectId: string,
  name: string,
): Promise<{ cron: string; timezone?: string } | undefined> {
  const now = Date.now();
  let cached = scheduleCache.get(projectId);
  if (!cached || cached.expiresAt <= now) {
    const entry = await AppIndexEntry.findOne({ appId: projectId })
      .select("schedules")
      .lean<{
        schedules?: Array<{ binding: string; cron: string; timezone?: string }>;
      } | null>();
    const byName = new Map<string, { cron: string; timezone?: string }>();
    for (const s of entry?.schedules ?? []) {
      byName.set(s.binding, { cron: s.cron, timezone: s.timezone });
    }
    cached = { expiresAt: now + SCHEDULE_CACHE_MS, byName };
    scheduleCache.set(projectId, cached);
  }
  return cached.byName.get(name);
}

export interface BindingRevalidateOpts {
  store: Pick<ArtifactStore, "getLastModified">;
  key: string;
  projectId: string;
  project?: IAppProject | null;
  name: string;
  actorId: string;
  at?: string;
  schedule?: string;
  timezone?: string;
  /**
   * When false, only report inflight/staleness — do not start a build.
   * Used by the SDK's cheap `?mako_meta=1` poll.
   */
  kickoff?: boolean;
  now?: Date;
  lookupSchedule?: typeof lookupBindingSchedule;
  kickoffRevalidate?: typeof kickoffBindingRevalidate;
  inFlight?: typeof bindingRefreshInFlight;
  loadProject?: (id: string) => Promise<IAppProject | null>;
}

/**
 * Headers for a parquet that is about to be served, and (when stale) the
 * side-effect of starting at most one background rebuild.
 */
export async function artifactRevalidateHeaders(
  opts: BindingRevalidateOpts,
): Promise<Record<string, string>> {
  const builtAt = await opts.store.getLastModified(opts.key).catch(() => null);
  let schedule = opts.schedule;
  let timezone = opts.timezone;
  if (schedule === undefined) {
    const lookup = opts.lookupSchedule ?? lookupBindingSchedule;
    const found = await lookup(opts.projectId, opts.name).catch(
      () => undefined,
    );
    schedule = found?.cron;
    timezone = found?.timezone;
  }
  const stale = isBindingArtifactStale({
    builtAt,
    schedule,
    timezone,
    now: opts.now,
  });
  const inFlight =
    opts.inFlight ??
    ((projectId: string, name: string, at?: string) =>
      bindingRefreshInFlight(projectId, name, at));
  let rebuild: ArtifactRebuildState = inFlight(
    opts.projectId,
    opts.name,
    opts.at,
  )
    ? "running"
    : "none";
  if (stale && opts.kickoff !== false && rebuild !== "running") {
    let project = opts.project ?? null;
    if (!project) {
      const load = opts.loadProject ?? (id => AppProject.findById(id));
      project = await load(opts.projectId);
    }
    if (project) {
      const kickoff = opts.kickoffRevalidate ?? kickoffBindingRevalidate;
      rebuild = await kickoff({
        project,
        name: opts.name,
        actorId: opts.actorId,
        at: opts.at,
      });
    }
  }
  return artifactFreshnessHeaders({ builtAt, stale, rebuild });
}

export function isArtifactMetaRequest(url: string): boolean {
  try {
    return new URL(url).searchParams.has("mako_meta");
  } catch {
    return false;
  }
}

/**
 * Serve a stored parquet, attaching freshness headers and kicking a
 * background rebuild when it is stale. `meta: true` answers 204 with those
 * headers and no body so the SDK can poll without re-downloading.
 */
export async function serveBindingParquetWithRevalidate(input: {
  store: ArtifactStore;
  key: string;
  cacheControl: string;
  extraHeaders?: Record<string, string>;
  revalidate?: Omit<
    BindingRevalidateOpts,
    | "store"
    | "key"
    | "lookupSchedule"
    | "kickoffRevalidate"
    | "inFlight"
    | "loadProject"
  >;
  meta?: boolean;
}): Promise<Response | null> {
  const extraHeaders = { ...input.extraHeaders };
  if (input.revalidate) {
    Object.assign(
      extraHeaders,
      await artifactRevalidateHeaders({
        store: input.store,
        key: input.key,
        ...input.revalidate,
        kickoff: input.meta ? false : input.revalidate.kickoff,
      }),
    );
  }
  if (input.meta) {
    return new Response(null, {
      status: 204,
      headers: {
        "Cache-Control": "no-store",
        ...extraHeaders,
      },
    });
  }
  return serveParquetArtifact(input.store, input.key, {
    cacheControl: input.cacheControl,
    extraHeaders,
  });
}
