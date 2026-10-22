/**
 * On-demand rematerialization of an app's data binding — the server half of
 * the SDK's `refresh()`, and the background half of stale-while-revalidate.
 *
 * The app runtime reads data at ONE app-relative URL, `__data/<name>.parquet`,
 * and asks for fresh data at its sibling, `POST __data/<name>/refresh`. It
 * knows nothing about workspaces, tokens or API hosts: whichever server
 * answers the first URL answers the second — the signed-in viewer route, the
 * preview token route, the public share, the sandbox dev server and the
 * laptop Vite plugin — each after its own authorization, and all through
 * this module, so "refresh" means the same thing everywhere: rebuild the
 * artifact the reader is looking at, record the run, and tell the caller
 * what it got.
 *
 * Two things every host gets for free here: concurrent refreshes of the same
 * binding share ONE warehouse query (a page full of viewers clicking at once
 * is one build, not N), and a binding declared `-- materialization: live`
 * has no artifact to rebuild — the runtime just re-fetches it.
 *
 * A GET of `__data/<name>.parquet` that finds a stored file serves it at
 * once. When that file is past the binding's freshness window,
 * `kickoffBindingRevalidate` starts the same rebuild in the background
 * without blocking the response. The inflight map and cooldown claim still
 * collapse N viewers to one warehouse query.
 */
import type { IAppProject } from "../database/workspace-schema";
import {
  claimPublicBindingRefresh,
  materializeAppBinding,
  readBindingMaterialization,
} from "./bindings.service";
import { loggers } from "../logging";

const logger = loggers.api("apps");

const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;

/** Background SWR: at most one claimed rebuild per binding per this window. */
export const DEFAULT_BINDING_REVALIDATE_COOLDOWN_MS = 5 * 60 * 1000;

export function bindingRevalidateCooldownMs(): number {
  const raw = process.env.APPS_BINDING_REVALIDATE_COOLDOWN_MS;
  if (raw === undefined || raw === "") {
    return DEFAULT_BINDING_REVALIDATE_COOLDOWN_MS;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0
    ? n
    : DEFAULT_BINDING_REVALIDATE_COOLDOWN_MS;
}

function refreshKey(projectId: string, name: string, at?: string): string {
  return `${projectId}:${name}:${at ?? ""}`;
}

/**
 * The app-relative refresh path, as seen by a host that has already stripped
 * its own prefix (the same input `serveDeploymentFile` and the preview route
 * match `__data/<name>.parquet` against). Returns the binding name.
 */
export function refreshPathBinding(assetPath: string): string | null {
  const m = /^__data\/([A-Za-z0-9_][A-Za-z0-9_-]*)\/refresh$/.exec(
    assetPath.replace(/^\/+/, ""),
  );
  return m ? m[1] : null;
}

export interface RefreshBindingInput {
  project: IAppProject;
  name: string;
  /** Who is building — the actor whose view of the repo defines the binding. */
  actorId: string;
  /**
   * Rebuild the binding as defined at this commit: a published app's data is
   * the bindings of its published commit, whatever the working branch says.
   */
  at?: string;
  /**
   * Anonymous callers only: at most one refresh per binding per this many
   * milliseconds, claimed atomically across instances. Signed-in members are
   * not throttled — they can already rebuild through the API and the agent.
   */
  cooldownMs?: number;
}

export interface RefreshBindingResult {
  binding: string;
  materialization: "parquet" | "live";
  rowCount?: number;
  byteSize?: number;
  /** ISO 8601. Absent for a live binding (there is no build). */
  materializedAt?: string;
}

export class BindingRefreshError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 429 | 502,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "BindingRefreshError";
  }
}

/** Swappable for tests; production wires the real service. */
export interface RefreshBindingDeps {
  readMaterialization: typeof readBindingMaterialization;
  materialize: (
    project: IAppProject,
    name: string,
    actorId: string,
    opts: { at?: string },
  ) => Promise<MaterializeResult>;
  claim: typeof claimPublicBindingRefresh;
}

const defaultDeps: RefreshBindingDeps = {
  readMaterialization: readBindingMaterialization,
  materialize: (project, name, actorId, opts) =>
    materializeAppBinding(project, name, actorId, opts),
  claim: claimPublicBindingRefresh,
};

// One build per (project, binding, commit) at a time, process-wide. A second
// caller joins the build in flight rather than starting its own; the
// scheduler's Inngest worker keys its concurrency the same way. Registered
// BEFORE the first await of refreshAppBinding so a parquet GET's background
// kickoff and a viewer's explicit refresh() share the same promise.
const inflight = new Map<string, Promise<RefreshBindingResult>>();

export function bindingRefreshInFlight(
  projectId: string,
  name: string,
  at?: string,
): boolean {
  return inflight.has(refreshKey(projectId, name, at));
}

export async function refreshAppBinding(
  input: RefreshBindingInput,
  deps: RefreshBindingDeps = defaultDeps,
): Promise<RefreshBindingResult> {
  const { project, name, at } = input;
  if (!NAME_RE.test(name)) {
    throw new BindingRefreshError("Invalid binding name", 400);
  }
  const projectId = project._id.toString();
  const key = refreshKey(projectId, name, at);
  // Look up and register in ONE synchronous step — no await between them —
  // or two callers past a prior read would each start a build. The cooldown
  // claim lives inside the shared build for the same reason: it is asked
  // once per build, and a refused slot answers every joiner.
  let build = inflight.get(key);
  if (!build) {
    build = runRefresh(input, deps).finally(() => inflight.delete(key));
    inflight.set(key, build);
  }

  return await build;
}

async function runRefresh(
  input: RefreshBindingInput,
  deps: RefreshBindingDeps,
): Promise<RefreshBindingResult> {
  const { project, name, actorId, at, cooldownMs } = input;
  const projectId = project._id.toString();
  // Repo/DB failures here are the host's problem (refreshBindingHttp lets
  // them propagate). Only the warehouse query is mapped to a 502.
  const materialization = await deps.readMaterialization(
    project,
    name,
    actorId,
    at,
  );
  if (!materialization) {
    throw new BindingRefreshError(`No binding named "${name}"`, 404);
  }
  if (materialization === "live") {
    // Nothing stored, nothing to rebuild: every read of a live binding is
    // already a fresh query. Success, so the runtime re-fetches.
    return { binding: name, materialization };
  }
  try {
    if (cooldownMs !== undefined) {
      const slot = await deps.claim(projectId, name, cooldownMs);
      if (!slot.claimed) {
        throw new BindingRefreshError(
          "This data was refreshed recently; try again in a few minutes",
          429,
          slot.retryAfterMs,
        );
      }
    }
    const result = await deps.materialize(project, name, actorId, { at });
    return {
      binding: name,
      materialization,
      rowCount: result.rowCount,
      byteSize: result.byteSize,
      materializedAt: result.materializedAt.toISOString(),
    };
  } catch (error) {
    if (error instanceof BindingRefreshError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("Apps binding refresh failed", {
      projectId,
      binding: name,
      at,
      error: message,
    });
    throw new BindingRefreshError(message, 502);
  }
}

/**
 * Start a rematerialization without waiting for it. Used by the parquet
 * read path when a stored artifact is stale. Never one build per viewer:
 * inflight de-dup plus the same atomic cooldown claim as public refresh.
 *
 * Returns "running" when a build is already in flight, "none" when the
 * cooldown refuses another attempt, "started" when this caller began one.
 * Failures are logged, not thrown — the reader already has bytes.
 */
export async function kickoffBindingRevalidate(
  input: RefreshBindingInput,
  deps: RefreshBindingDeps = defaultDeps,
): Promise<"started" | "running" | "none"> {
  const { project, name, at } = input;
  if (!NAME_RE.test(name)) return "none";
  const projectId = project._id.toString();
  if (bindingRefreshInFlight(projectId, name, at)) return "running";

  const cooldownMs = bindingRevalidateCooldownMs();
  if (cooldownMs > 0) {
    const slot = await deps.claim(projectId, name, cooldownMs);
    if (!slot.claimed) {
      return bindingRefreshInFlight(projectId, name, at) ? "running" : "none";
    }
  }
  if (bindingRefreshInFlight(projectId, name, at)) return "running";

  const run = refreshAppBinding({ ...input, cooldownMs: undefined }, deps);
  void run.catch(error => {
    if (error instanceof BindingRefreshError && error.status === 429) return;
    logger.warn("Background binding revalidate failed", {
      projectId,
      binding: name,
      at,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return "started";
}

export interface RefreshBindingHttp {
  status: 200 | 400 | 404 | 429 | 502;
  body:
    | ({ success: true } & RefreshBindingResult)
    | { success: false; error: string; retryAfterMs?: number };
  headers: Record<string, string>;
}

/**
 * The same refresh as an HTTP answer, so every host serializes it
 * identically — the SDK parses one shape. Only refresh's own failures are
 * mapped; anything else (a repo that cannot be read, a database outage)
 * propagates to the host's usual error handling.
 */
export async function refreshBindingHttp(
  input: RefreshBindingInput,
  deps?: RefreshBindingDeps,
): Promise<RefreshBindingHttp> {
  try {
    const result = await refreshAppBinding(input, deps);
    return { status: 200, body: { success: true, ...result }, headers: {} };
  } catch (error) {
    if (!(error instanceof BindingRefreshError)) throw error;
    return {
      status: error.status,
      body: {
        success: false,
        error: error.message,
        ...(error.retryAfterMs !== undefined
          ? { retryAfterMs: error.retryAfterMs }
          : {}),
      },
      headers:
        error.retryAfterMs !== undefined
          ? { "retry-after": String(Math.ceil(error.retryAfterMs / 1000)) }
          : {},
    };
  }
}
