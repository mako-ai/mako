/**
 * On-demand rematerialization of an app's data binding — the server half of
 * the SDK's `refresh()`.
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
 */
import type { IAppProject } from "../database/workspace-schema";
import {
  claimPublicBindingRefresh,
  materializeAppBinding,
  readBindingMaterialization,
  type MaterializeResult,
} from "./bindings.service";
import { loggers } from "../logging";

const logger = loggers.api("apps");

const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;

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
// scheduler's Inngest worker keys its concurrency the same way.
const inflight = new Map<string, Promise<MaterializeResult>>();

export async function refreshAppBinding(
  input: RefreshBindingInput,
  deps: RefreshBindingDeps = defaultDeps,
): Promise<RefreshBindingResult> {
  const { project, name, actorId, at, cooldownMs } = input;
  if (!NAME_RE.test(name)) {
    throw new BindingRefreshError("Invalid binding name", 400);
  }
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

  const projectId = project._id.toString();
  const key = `${projectId}:${name}:${at ?? ""}`;
  // Look up and register in ONE synchronous step — no await between them —
  // or two callers past the read above would each start a build. The
  // cooldown claim lives inside the shared build for the same reason: it is
  // asked once per build, and a refused slot answers every joiner.
  let build = inflight.get(key);
  if (!build) {
    build = (async () => {
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
      return deps.materialize(project, name, actorId, { at });
    })().finally(() => inflight.delete(key));
    inflight.set(key, build);
  }

  let result: MaterializeResult;
  try {
    result = await build;
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
  return {
    binding: name,
    materialization,
    rowCount: result.rowCount,
    byteSize: result.byteSize,
    materializedAt: result.materializedAt.toISOString(),
  };
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
