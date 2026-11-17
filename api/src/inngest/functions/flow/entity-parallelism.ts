/**
 * How many entities of one connector flow sync at once, and the lanes that
 * run them.
 *
 * The parent `flow` run used to invoke `sync-backfill-entity` once per entity,
 * one after the other. A source whose latency caps each entity (Close: about
 * 1.5 s per 200-row page) then takes the sum of every entity's time. Lanes run
 * up to N entities at once, each lane taking the next entity as soon as its
 * current one finishes.
 *
 * Knobs, read at call time:
 * - BACKFILL_ENTITY_PARALLELISM: entities per flow at once. Default 3. 1 runs
 *   them one at a time, exactly as before.
 * - a flow's own `entityParallelism` overrides it, up to the ceiling.
 * - BACKFILL_ENTITY_PARALLELISM_MAX: the ceiling, and the per-flow concurrency
 *   limit `sync-backfill-entity` registers with Inngest. Default 6.
 * - BACKFILL_BOXED_ENTITY_LIMIT: workspace (`ws:`) connector entity runs at
 *   once across all flows. Default: CONNECTOR_BOX_ACCOUNT_CEILING minus
 *   CONNECTOR_BOX_APP_RESERVE (18), so leased boxes stay under the E2B account
 *   ceiling and runs queue in Inngest instead of timing out in the box queue.
 */
import { boxLeaseConfig } from "../../../connectors/workspace/boxes/config";

export const DEFAULT_ENTITY_PARALLELISM = 3;
export const DEFAULT_ENTITY_PARALLELISM_CEILING = 6;

function positiveIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 ? value : undefined;
}

/** Entities of one flow synced at once when the flow does not say. */
export function defaultEntityParallelism(): number {
  return (
    positiveIntEnv("BACKFILL_ENTITY_PARALLELISM") ?? DEFAULT_ENTITY_PARALLELISM
  );
}

/**
 * The most entities of one flow that may ever sync at once. Also the
 * per-flow concurrency limit of `sync-backfill-entity`, so it never sits
 * below the default.
 */
export function entityParallelismCeiling(): number {
  return Math.max(
    positiveIntEnv("BACKFILL_ENTITY_PARALLELISM_MAX") ??
      DEFAULT_ENTITY_PARALLELISM_CEILING,
    defaultEntityParallelism(),
  );
}

/** Workspace-connector entity runs at once, across every flow. */
export function boxedEntityRunLimit(): number {
  const explicit = positiveIntEnv("BACKFILL_BOXED_ENTITY_LIMIT");
  if (explicit) return explicit;
  const { accountCeiling, appReserve } = boxLeaseConfig();
  return Math.max(1, accountCeiling - appReserve);
}

/**
 * The name of an entity's Mongo buffer collection suffix
 * (sync-orchestrator.ts `bulkBufferCollection`). Two entities with the same
 * key would share one buffer, and one step id prefix.
 */
export function entityBufferKey(entity: string): string {
  return entity.replace(/[^a-zA-Z0-9]/g, "_");
}

/** Entities that would share a buffer collection with another entity. */
export function collidingEntities(entities: string[]): string[] {
  const byKey = new Map<string, string[]>();
  for (const entity of entities) {
    const key = entityBufferKey(entity);
    byKey.set(key, [...(byKey.get(key) ?? []), entity]);
  }
  return [...byKey.values()].filter(group => group.length > 1).flat();
}

/**
 * The second concurrency key of `sync-backfill-entity`. Every workspace
 * connector run shares one key, so BACKFILL_BOXED_ENTITY_LIMIT caps them
 * together. Every other run gets a key of its own, which that limit never
 * reaches: built-in connectors keep no global cap.
 */
export function entityRunConcurrencyKey(params: {
  flowId: string;
  entity: string;
  boxed: boolean;
}): string {
  return params.boxed
    ? "connector-box"
    : `entity:${params.flowId}:${params.entity}`;
}

export interface EntityParallelismDecision {
  parallelism: number;
  /** Why it is below what was asked, if it is. */
  limitedBy?: "entities" | "ceiling" | "box-leases" | "buffer-collision";
}

/**
 * Lanes for one run: the flow's override or the default, within the
 * ceiling and the entity count. A workspace connector under box leases
 * keeps one of its connection's lease slots free for check, discover and
 * webhooks. Entities that would share a buffer run one at a time.
 */
export function resolveEntityParallelism(params: {
  entities: string[];
  flowOverride?: number | null;
  boxed: boolean;
  leasesEnabled: boolean;
  maxLeasesPerConnection: number;
}): EntityParallelismDecision {
  const override = params.flowOverride;
  const asked =
    typeof override === "number" && Number.isInteger(override) && override >= 1
      ? override
      : defaultEntityParallelism();
  let parallelism = asked;
  let limitedBy: EntityParallelismDecision["limitedBy"];

  const ceiling = entityParallelismCeiling();
  if (parallelism > ceiling) {
    parallelism = ceiling;
    limitedBy = "ceiling";
  }
  if (params.boxed && params.leasesEnabled) {
    const leaseRoom = Math.max(1, params.maxLeasesPerConnection - 1);
    if (parallelism > leaseRoom) {
      parallelism = leaseRoom;
      limitedBy = "box-leases";
    }
  }
  if (parallelism > 1 && collidingEntities(params.entities).length > 0) {
    parallelism = 1;
    limitedBy = "buffer-collision";
  }
  const count = Math.max(1, params.entities.length);
  if (parallelism > count) {
    parallelism = count;
    limitedBy = limitedBy ?? "entities";
  }
  return { parallelism, ...(limitedBy ? { limitedBy } : {}) };
}

/** An entity's step id fragment, as the parent and the child both build it. */
export function entityStepId(entity: string): string {
  return entity.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** What one `sync-backfill-entity` invocation returns. */
export interface EntityInvocationResult {
  completed: boolean;
  rowsWritten: number;
}

/** Most invocations of one entity in one run (each yields after ~900 steps). */
export const MAX_ENTITY_INVOCATIONS = 100;

/**
 * Invoke the child for one entity until it says it is complete. Each
 * invocation has the step id `sync-entity-<entity>-<n>`, so the ids depend
 * only on the entity and how far it got, never on which lane ran it.
 * `beforeContinuation` runs before every invocation after the first.
 * Returns the rows the entity wrote.
 */
export async function syncEntityViaChild(params: {
  entity: string;
  invoke: (stepId: string) => Promise<EntityInvocationResult>;
  beforeContinuation?: (invocationIndex: number) => Promise<void>;
}): Promise<number> {
  const { entity, invoke, beforeContinuation } = params;
  const stepIdBase = `sync-entity-${entityStepId(entity)}`;
  for (let invocationIndex = 0; ; invocationIndex++) {
    if (invocationIndex >= MAX_ENTITY_INVOCATIONS) {
      throw new Error(
        `Entity ${entity} exceeded ${MAX_ENTITY_INVOCATIONS} continuation invocations`,
      );
    }
    if (invocationIndex > 0) await beforeContinuation?.(invocationIndex);
    const result = await invoke(`${stepIdBase}-${invocationIndex}`);
    if (result.completed) return result.rowsWritten;
  }
}

/** A cancellation the lanes must stop on, rather than a failed entity. */
export type IsCancellation = (error: unknown) => boolean;

/**
 * Run `runEntity` for every entity, at most `parallelism` at once.
 *
 * - Each lane takes the next entity in list order when its current one
 *   finishes, so the entities started are always a prefix of the list.
 * - A failed entity does not stop the others: every entity still runs, its
 *   own staging and checkpoint untouched by the failure, and the first
 *   failure in list order is thrown at the end. A retry of the run then
 *   skips the entities that completed.
 * - A cancellation stops every lane from taking another entity, and is
 *   thrown once the lanes in flight return.
 * - `parallel` wraps the lanes when there is more than one (Inngest's
 *   `group.parallel`, so a finished lane resumes the run at once instead of
 *   waiting for the whole wave). With one lane, entities run in a plain loop.
 */
export async function runEntityLanes(params: {
  entities: string[];
  parallelism: number;
  runEntity: (entity: string) => Promise<void>;
  isCancellation: IsCancellation;
  parallel?: <T>(fn: () => Promise<T>) => Promise<T>;
}): Promise<void> {
  const { entities, runEntity, isCancellation } = params;
  const lanes = Math.max(1, Math.min(params.parallelism, entities.length));
  const failures = new Map<string, unknown>();
  let cancellation: { error: unknown } | null = null;
  let next = 0;

  const lane = async () => {
    while (!cancellation && next < entities.length) {
      const entity = entities[next++];
      try {
        await runEntity(entity);
      } catch (error) {
        if (isCancellation(error)) {
          cancellation = cancellation ?? { error };
        } else {
          failures.set(entity, error);
        }
      }
    }
  };

  const all = () => Promise.all(Array.from({ length: lanes }, () => lane()));
  if (lanes > 1 && params.parallel) {
    await params.parallel(all);
  } else {
    await all();
  }

  if (cancellation) throw (cancellation as { error: unknown }).error;
  for (const entity of entities) {
    if (failures.has(entity)) throw failures.get(entity);
  }
}
