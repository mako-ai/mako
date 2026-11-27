/**
 * Dual-run helpers shared across the `workspaces_core` repository.
 *
 * `workspaces_core` is a GLOBAL domain (canary-rolled): the router is consulted
 * without a workspace override.
 *
 * Write semantics (`dualWrite`):
 *   - mongo_only / pg_only: run only that store's native operation.
 *   - dual modes: the PRIMARY store runs its native operation; the SECONDARY is
 *     then RESYNCED from the primary's resulting rows (`sync.ts`) instead of
 *     re-running the operation. Atomic primary ops (billing overage CAS, Hatchet
 *     token holder claim, single-use OAuth code redemption, refresh token rotation)
 *     therefore apply exactly once and never diverge.
 *   - Secondary failures never fail the request; they enqueue
 *     `migration/{pg,mongo}-sync-retry` with an ID-ONLY payload (zero raw secrets,
 *     hashes, tokens, or emails) that `replayWorkspacesRetry` replays idempotently.
 */
import { Types } from "mongoose";
import { getPgDb, type MakoPgDb } from "../../database/pg/client";
import { Workspace } from "../../database/workspace-schema";
import { migrationRouter, type MigrationRouter } from "../../migration/router";
import type {
  ShadowCompareOptions,
  SyncRetryEventData,
} from "../../migration/types";
import { isEntityId, toWire } from "./mapper";
import { resyncToMongo, resyncToPg, type ResyncScope } from "./sync";
import {
  WORKSPACES_DOMAIN,
  WORKSPACES_TABLES,
  type WorkspacesTableName,
} from "./types";

export interface ResyncTarget {
  table: WorkspacesTableName;
  scope: ResyncScope;
}

/** Shadow-compare redactions on top of Phase 0 defaults. */
export const WORKSPACES_SHADOW_OPTIONS: ShadowCompareOptions = {
  redactKeys: [
    "keyHash",
    "token",
    "codeHash",
    "codeChallenge",
    "accessTokenHash",
    "refreshTokenHash",
    "hatchetToken",
    "webhooks",
    "email",
    "stripeCustomerId",
    "stripeSubscriptionId",
    "pendingMeterEventIdempotencyKey",
    "planDigest",
  ],
};

export interface DualContext {
  router?: MigrationRouter;
  getDb?: () => MakoPgDb;
}

export interface DualWriteSpec<T> {
  operation: string;
  /** Rows the secondary must be resynced for; may depend on the primary's result. */
  targets: ResyncTarget[] | ((result: T) => ResyncTarget[]);
  mongo: () => Promise<T>;
  pg: () => Promise<T>;
  /** Optional entity id for logs/metrics. */
  entityId?: string;
}

function serializeTargets(
  targets: ResyncTarget[],
): Array<Record<string, unknown>> {
  return targets.map(t => ({
    table: t.table,
    entityIds: [...(t.scope.entityIds ?? [])],
    ...(t.scope.workspaceId ? { workspaceId: t.scope.workspaceId } : {}),
  }));
}

async function resyncAll(
  direction: "pg" | "mongo",
  targets: ResyncTarget[],
  getDb: () => MakoPgDb,
): Promise<void> {
  for (const t of targets) {
    if (
      !t.scope.workspaceId &&
      !(t.scope.entityIds && t.scope.entityIds.length > 0)
    ) {
      continue;
    }
    if (direction === "pg") {
      await resyncToPg(t.table, t.scope, { getDb });
    } else {
      await resyncToMongo(t.table, t.scope, { getDb });
    }
  }
}

export async function dualWrite<T>(
  spec: DualWriteSpec<T>,
  ctx: DualContext = {},
): Promise<T> {
  const router = ctx.router ?? migrationRouter;
  const getDb = ctx.getDb ?? getPgDb;
  const retryPayload: Record<string, unknown> = { targets: [] };
  let primaryRan = false;
  let result: T | undefined;

  const resolveTargets = (): ResyncTarget[] =>
    typeof spec.targets === "function"
      ? spec.targets(result as T)
      : spec.targets;

  const handler = (store: "mongo" | "pg") => async (): Promise<T> => {
    if (!primaryRan) {
      primaryRan = true;
      result = await (store === "mongo" ? spec.mongo() : spec.pg());
      retryPayload.targets = serializeTargets(resolveTargets());
      return result;
    }
    await resyncAll(store, resolveTargets(), getDb);
    return result as T;
  };

  return router.executeWrite(
    {
      domain: WORKSPACES_DOMAIN,
      operation: spec.operation,
      entityId: spec.entityId,
      retryPayload,
    },
    { mongo: handler("mongo"), pg: handler("pg") },
  );
}

export interface DualReadSpec<T> {
  operation: string;
  mongo: () => Promise<T>;
  pg: () => Promise<T>;
  canonicalize?: (value: T) => unknown;
  entityId?: string;
  shadowOptions?: ShadowCompareOptions;
}

export function dualRead<T>(
  spec: DualReadSpec<T>,
  ctx: DualContext = {},
): Promise<T> {
  const router = ctx.router ?? migrationRouter;
  return router.executeRead(
    {
      domain: WORKSPACES_DOMAIN,
      operation: spec.operation,
      entityId: spec.entityId,
    },
    {
      mongo: spec.mongo,
      pg: spec.pg,
      canonicalize: spec.canonicalize,
      shadowOptions: spec.shadowOptions ?? WORKSPACES_SHADOW_OPTIONS,
    },
  );
}

const TABLES = new Set<string>(WORKSPACES_TABLES);

/**
 * Inngest `migration/{pg,mongo}-sync-retry` replay for `workspaces_core`:
 * re-reads the primary rows named in the ID-only payload and resyncs the secondary.
 */
export async function replayWorkspacesRetry(
  data: SyncRetryEventData,
  ctx: { getDb?: () => MakoPgDb } = {},
): Promise<void> {
  const raw = (data.payload?.targets ?? []) as Array<Record<string, unknown>>;
  const targets: ResyncTarget[] = [];
  for (const t of raw) {
    if (typeof t.table !== "string" || !TABLES.has(t.table)) {
      continue;
    }
    targets.push({
      table: t.table as WorkspacesTableName,
      scope: {
        entityIds: Array.isArray(t.entityIds)
          ? t.entityIds.filter((v): v is string => typeof v === "string")
          : undefined,
        workspaceId:
          typeof t.workspaceId === "string" ? t.workspaceId : undefined,
      },
    });
  }
  await resyncAll(data.target, targets, ctx.getDb ?? getPgDb);
  if (data.target === "mongo") {
    const unsetPrompt = data.payload?.unsetLegacyCustomPrompt as
      { workspaceId?: unknown; includeSelfDirective?: unknown } | undefined;
    if (
      unsetPrompt &&
      typeof unsetPrompt.workspaceId === "string" &&
      isEntityId(unsetPrompt.workspaceId)
    ) {
      const unset: Record<string, ""> = { "settings.customPrompt": "" };
      if (unsetPrompt.includeSelfDirective === true) {
        unset.selfDirective = "";
      }
      await Workspace.collection.updateOne(
        { _id: new Types.ObjectId(toWire(unsetPrompt.workspaceId)) },
        { $unset: unset },
      );
    }
  }
}
