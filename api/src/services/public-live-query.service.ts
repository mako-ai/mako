/**
 * Public-share live query execution (apps only).
 *
 * Lets the anonymous `/share/:token` app viewer run an app's *published* live
 * bindings against the workspace database — but only when the owner has opted
 * in via `publicShare.allowLiveQueries`. The safety model is deliberately
 * narrow:
 *
 *   - The SQL is always the OWNER's published binding code, resolved from the
 *     immutable published snapshot. The viewer never supplies SQL (so "live"
 *     never means "arbitrary").
 *   - Execution reuses the read-only preview path
 *     (`databaseConnectionService.executePreviewQuery`), which enforces
 *     `checkPreviewQuerySafety` (SELECT/WITH, single statement, no DML) and a
 *     hard 500-row cap.
 *   - Credentials never leave the server; the viewer gets rows only.
 *   - A per-(token, binding) rate limit + short-TTL result cache keep a public
 *     link from hammering the database.
 */

import { createHash } from "node:crypto";
import { Types } from "mongoose";
import {
  DatabaseConnection,
  type IMakoApp,
} from "../database/workspace-schema";
import { buildAppSnapshot, type AppSnapshot } from "./app-version.service";
import { databaseConnectionService } from "./database-connection.service";
import { checkPreviewQuerySafety } from "./query-pagination.service";
import { loggers } from "../logging";

const logger = loggers.api("public-live-query");

/** Short cache so repeated loads of a public link don't re-hit the DB. */
const RESULT_TTL_MS = 15 * 1000;
/** Cache-miss executions allowed per (token, binding) inside the window. */
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

interface CachedResult {
  expiresAt: number;
  payload: PublicLiveQuerySuccess;
}

type PublicLiveQuerySuccess = {
  success: true;
  rows: Record<string, unknown>[];
  fields: Array<{ name: string; type?: string }>;
  rowCount: number;
};

export type PublicLiveQueryResult =
  | (PublicLiveQuerySuccess & { cached: boolean })
  | { success: false; error: string; status: number };

const resultCache = new Map<string, CachedResult>();
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function cacheKey(token: string, bindingId: string, queryHash: string): string {
  return `${token}:${bindingId}:${queryHash}`;
}

function isRateLimited(key: string): boolean {
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt < now) {
    rateBuckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }
  bucket.count += 1;
  // Opportunistic GC so the map can't grow unbounded for popular links.
  if (rateBuckets.size > 10_000) {
    for (const [k, v] of rateBuckets) {
      if (v.resetAt < now) rateBuckets.delete(k);
    }
  }
  return bucket.count > RATE_LIMIT_MAX;
}

interface PublishedBinding {
  id: string;
  name: string;
  connectionId?: string;
  language?: string;
  code?: string;
  databaseId?: string;
  databaseName?: string;
  materialization?: string;
}

/**
 * Resolve a binding from the app's PUBLISHED snapshot (falling back to the live
 * draft for never-published apps, matching the public content builder). This is
 * what guarantees the viewer can only ever run owner-published SQL.
 */
function findPublishedBinding(
  app: IMakoApp,
  bindingId: string,
): PublishedBinding | null {
  const def = (app.published as AppSnapshot | undefined) ?? buildAppSnapshot(app);
  const binding = (def.dataBindings ?? []).find(
    b => (b as PublishedBinding).id === bindingId,
  ) as PublishedBinding | undefined;
  return binding ?? null;
}

/**
 * Execute one published live binding for an anonymous public-share viewer.
 * Returns rows only — never SQL, connection ids, or credentials.
 */
export async function executePublicAppLiveBinding(input: {
  app: IMakoApp;
  bindingId: string;
  token: string;
}): Promise<PublicLiveQueryResult> {
  const { app, bindingId, token } = input;

  if (!app.publicShare?.allowLiveQueries) {
    return {
      success: false,
      error: "Live queries are not enabled for this shared app",
      status: 403,
    };
  }

  const binding = findPublishedBinding(app, bindingId);
  if (!binding) {
    return { success: false, error: "Data source not found", status: 404 };
  }

  // v1 supports SQL bindings only. MongoDB/JS live execution would need its own
  // safety story; until then it stays snapshot-only on public links.
  if (binding.language !== "sql") {
    return {
      success: false,
      error: "Live queries are only supported for SQL data sources",
      status: 400,
    };
  }

  const code = typeof binding.code === "string" ? binding.code.trim() : "";
  if (!code) {
    return { success: false, error: "Data source has no query", status: 400 };
  }

  // Defense in depth: the preview path enforces this too, but reject unsafe
  // (non read-only) SQL up front with a clear message.
  const safety = checkPreviewQuerySafety(code);
  if (!safety.safe) {
    return {
      success: false,
      error: `Query failed read-only safety checks: ${safety.errors.join(" ")}`,
      status: 400,
    };
  }

  const queryHash = createHash("sha256").update(code).digest("hex").slice(0, 16);
  const key = cacheKey(token, bindingId, queryHash);

  const cached = resultCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return { ...cached.payload, cached: true };
  }

  if (isRateLimited(`${token}:${bindingId}`)) {
    return {
      success: false,
      error: "Too many live requests — please wait a moment and retry",
      status: 429,
    };
  }

  if (!binding.connectionId || !Types.ObjectId.isValid(binding.connectionId)) {
    return { success: false, error: "Data source not found", status: 404 };
  }

  const connection = await DatabaseConnection.findOne({
    _id: new Types.ObjectId(binding.connectionId),
    workspaceId: app.workspaceId,
  });
  if (!connection) {
    return { success: false, error: "Data source not found", status: 404 };
  }

  const result = await databaseConnectionService.executePreviewQuery(
    connection,
    code,
    {
      databaseId: binding.databaseId,
      databaseName: binding.databaseName,
    },
  );

  if (!result.success) {
    logger.warn("Public live query failed", {
      appId: app._id.toString(),
      bindingId,
      error: result.error,
    });
    return {
      success: false,
      error: result.error || "Query failed",
      status: 502,
    };
  }

  const rows = (result.rows ?? []) as Record<string, unknown>[];
  const payload: PublicLiveQuerySuccess = {
    success: true,
    rows,
    fields: (result.fields ?? []) as Array<{ name: string; type?: string }>,
    rowCount: result.rowCount ?? rows.length,
  };

  resultCache.set(key, { expiresAt: Date.now() + RESULT_TTL_MS, payload });
  return { ...payload, cached: false };
}
