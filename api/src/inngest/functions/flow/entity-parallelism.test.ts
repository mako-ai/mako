/**
 * Entity lanes: several entities of one flow at once, each exactly once,
 * with the rows a one-at-a-time run writes; a cancel stops every lane; a
 * failed entity leaves the others whole.
 *
 * The parent is driven by a small stand-in for Inngest's executor: every
 * execution replays the function from the top, a step whose result is
 * memoized returns it, and a new `step.invoke` is started once and left
 * pending until the "server" finishes it. So the tests also check what
 * replay needs: the same step ids whichever lane runs an entity, and no
 * entity started twice.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { getEntityTableName } from "../../../sync/sync-orchestrator";
import { syncBackfillEntityFunction } from "../sync-entity";
import {
  collidingEntities,
  defaultEntityParallelism,
  entityParallelismCeiling,
  entityRunConcurrencyKey,
  resolveEntityParallelism,
  runEntityLanes,
  syncEntityViaChild,
  type EntityInvocationResult,
} from "./entity-parallelism";

const ENTITIES = [
  "leads",
  "contacts",
  "opportunities",
  "activities",
  "tasks",
  "users",
];
/** Rows each fake entity has at the source. */
const SOURCE_ROWS: Record<string, number> = {
  leads: 950,
  contacts: 420,
  opportunities: 77,
  activities: 1310,
  tasks: 5,
  users: 0,
};
const PAGE = 100;
/** Pages one child invocation reads before it yields (its step budget). */
const PAGES_PER_INVOCATION = 4;

function sourceRows(entity: string): string[] {
  return Array.from(
    { length: SOURCE_ROWS[entity] },
    (_, i) => `${entity}:${i}`,
  );
}

/**
 * The fake source + destination the child writes to, keyed by entity the
 * way checkpoints, buffers and staging tables are.
 */
class FakeWarehouse {
  /** Per-entity resume cursor (CdcEntityState). */
  readonly checkpoint = new Map<string, number>();
  /** Per-entity buffer collection (backfill_tmp_<flow>_<entity>). */
  readonly buffer = new Map<string, string[]>();
  /** Live tables, written only by an entity's final merge. */
  readonly live = new Map<string, string[]>();
  readonly merges = new Map<string, number>();
  cancelled = false;
  /** Children running right now, and the most at once. */
  running = 0;
  peak = 0;

  constructor(
    private readonly failAt: { entity: string; page: number } | null = null,
  ) {}

  /** One invocation of the child: read pages, buffer them, merge at the end. */
  async invokeChild(entity: string): Promise<EntityInvocationResult> {
    this.running++;
    this.peak = Math.max(this.peak, this.running);
    try {
      const rows = sourceRows(entity);
      let cursor = this.checkpoint.get(entity) ?? 0;
      const buffer = this.buffer.get(entity) ?? [];
      this.buffer.set(entity, buffer);
      for (let page = 0; page < PAGES_PER_INVOCATION; page++) {
        // The child's per-chunk check (sync-entity.ts).
        if (this.cancelled) {
          throw new Error("Flow execution cancelled by user");
        }
        if (cursor >= rows.length) break;
        await new Promise(r => setImmediate(r));
        if (
          this.failAt?.entity === entity &&
          cursor / PAGE === this.failAt.page
        ) {
          throw new Error(`${entity}: source returned 500`);
        }
        buffer.push(...rows.slice(cursor, cursor + PAGE));
        cursor += PAGE;
        this.checkpoint.set(entity, cursor);
      }
      if (cursor < rows.length) {
        return { completed: false, rowsWritten: buffer.length };
      }
      // Final flush + merge of this entity's own buffer into its own table.
      this.live.set(entity, [...(this.live.get(entity) ?? []), ...buffer]);
      this.merges.set(entity, (this.merges.get(entity) ?? 0) + 1);
      this.buffer.delete(entity);
      return { completed: true, rowsWritten: buffer.length };
    } finally {
      this.running--;
    }
  }
}

type InvokeData = { entity: string };

/**
 * Inngest in miniature. Runs `fn` until it returns or throws, replaying it
 * after every finished invocation. `pick` chooses which pending invocation
 * the server finishes next, to vary which lane frees first.
 */
async function runLikeInngest(params: {
  fn: (step: {
    invoke: (id: string, data: InvokeData) => Promise<unknown>;
  }) => Promise<void>;
  child: (data: InvokeData) => Promise<unknown>;
  pick: (pendingIds: string[]) => string;
  onStart?: (id: string) => void;
}) {
  const memo = new Map<
    string,
    { ok: true; value: unknown } | { ok: false; error: unknown }
  >();
  const pending = new Map<string, InvokeData>();
  const starts = new Map<string, number>();
  let mostPending = 0;
  let executions = 0;

  for (;;) {
    executions++;
    if (executions > 10_000) throw new Error("executor did not converge");
    let settled: { ok: true } | { ok: false; error: unknown } | null = null;
    // Inngest suffixes a repeated id within one execution, which would
    // start a second child for the same entity. Fail loudly instead.
    const seenThisExecution = new Set<string>();
    const step = {
      invoke: (id: string, data: InvokeData) => {
        if (seenThisExecution.has(id)) {
          throw new Error(`step id ${id} used twice in one execution`);
        }
        seenThisExecution.add(id);
        const hit = memo.get(id);
        if (hit) {
          return hit.ok
            ? Promise.resolve(hit.value)
            : Promise.reject(hit.error);
        }
        if (!pending.has(id)) {
          pending.set(id, data);
          starts.set(id, (starts.get(id) ?? 0) + 1);
          params.onStart?.(id);
        }
        return new Promise<never>(() => {});
      },
    };
    params.fn(step).then(
      () => (settled = { ok: true }),
      error => (settled = { ok: false, error }),
    );
    // Let every memoized result flow through the lanes.
    for (let i = 0; i < 50; i++) await new Promise(r => setImmediate(r));
    mostPending = Math.max(mostPending, pending.size);
    if (settled) {
      return {
        result: settled as { ok: true } | { ok: false; error: unknown },
        starts,
        mostPending,
        executions,
        stillPending: [...pending.keys()],
      };
    }
    if (pending.size === 0) throw new Error("run stalled with nothing pending");
    const id = params.pick([...pending.keys()]);
    const data = pending.get(id)!;
    pending.delete(id);
    try {
      memo.set(id, { ok: true, value: await params.child(data) });
    } catch (error) {
      memo.set(id, { ok: false, error });
    }
  }
}

const isCancellation = (error: unknown) =>
  error instanceof Error && error.message.includes("cancelled");

/** The parent's lane loop, as connector-source.ts drives it. */
function parentRun(params: {
  parallelism: number;
  warehouse: FakeWarehouse;
  rowsByEntity: Record<string, number>;
  started: string[];
}) {
  const { parallelism, warehouse, rowsByEntity, started } = params;
  const throwIfCancelled = async () => {
    if (warehouse.cancelled) {
      throw new Error("Flow execution cancelled by user");
    }
  };
  return async (step: {
    invoke: (id: string, data: InvokeData) => Promise<unknown>;
  }) => {
    // Fresh per execution, as a replayed Inngest function's locals are.
    started.length = 0;
    await runEntityLanes({
      entities: ENTITIES,
      parallelism,
      isCancellation,
      runEntity: async entity => {
        await throwIfCancelled();
        started.push(entity);
        rowsByEntity[entity] = await syncEntityViaChild({
          entity,
          invoke: id =>
            step.invoke(id, { entity }) as Promise<EntityInvocationResult>,
          beforeContinuation: throwIfCancelled,
        });
      },
    });
  };
}

/** A seeded order for which pending invocation finishes first. */
function seededPick(seed: number) {
  let state = seed;
  return (ids: string[]) => {
    state = (state * 1103515245 + 12345) % 2 ** 31;
    return ids[state % ids.length];
  };
}

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const saved = Object.fromEntries(
    Object.keys(env).map(k => [k, process.env[k]]),
  );
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

void test("6 entities at parallelism 3: each exactly once, same rows as one at a time", async () => {
  const sequential = new FakeWarehouse();
  const seqRows: Record<string, number> = {};
  const seq = await runLikeInngest({
    fn: parentRun({
      parallelism: 1,
      warehouse: sequential,
      rowsByEntity: seqRows,
      started: [],
    }),
    child: d => sequential.invokeChild(d.entity),
    pick: ids => ids[0],
  });
  assert.deepEqual(seq.result, { ok: true });
  assert.equal(seq.mostPending, 1, "parallelism 1 runs one entity at a time");

  for (const seed of [1, 7, 42, 1234, 99991]) {
    const parallel = new FakeWarehouse();
    const rows: Record<string, number> = {};
    const run = await runLikeInngest({
      fn: parentRun({
        parallelism: 3,
        warehouse: parallel,
        rowsByEntity: rows,
        started: [],
      }),
      child: d => parallel.invokeChild(d.entity),
      pick: seededPick(seed),
    });
    assert.deepEqual(run.result, { ok: true }, `seed ${seed}`);
    assert.equal(run.mostPending, 3, `seed ${seed}: three entities at once`);
    for (const [id, count] of run.starts) {
      assert.equal(count, 1, `seed ${seed}: ${id} started ${count} times`);
    }
    for (const entity of ENTITIES) {
      assert.equal(parallel.merges.get(entity), 1, `${entity} merged once`);
      assert.deepEqual(
        parallel.live.get(entity),
        sequential.live.get(entity),
        entity,
      );
      assert.deepEqual(parallel.live.get(entity), sourceRows(entity), entity);
    }
    assert.deepEqual(rows, seqRows, `seed ${seed}: per-entity stats`);
    // Continuations kept their own ids: activities needs 4 invocations.
    assert.ok(run.starts.has("sync-entity-activities-3"));
    assert.ok(!run.starts.has("sync-entity-activities-4"));
  }
});

void test("a cancel mid-run stops every lane and every running child", async () => {
  const warehouse = new FakeWarehouse();
  const started: string[] = [];
  let finished = 0;
  const startedAfterCancel: string[] = [];
  const run = await runLikeInngest({
    fn: parentRun({ parallelism: 3, warehouse, rowsByEntity: {}, started }),
    child: async d => {
      const result = await warehouse.invokeChild(d.entity);
      if (++finished === 3) warehouse.cancelled = true; // the user hits cancel
      return result;
    },
    pick: seededPick(5),
    onStart: id => {
      if (warehouse.cancelled) startedAfterCancel.push(id);
    },
  });
  assert.equal(run.result.ok, false);
  assert.match(
    String((run.result as { error: Error }).error.message),
    /cancelled/,
  );
  assert.deepEqual(
    startedAfterCancel,
    [],
    "no invocation starts after the cancel",
  );
  assert.ok(started.length < ENTITIES.length, "some entities never started");
  // Every child that was still running stopped at its next chunk.
  for (const id of run.stillPending) {
    const entity = ENTITIES.find(e => id.startsWith(`sync-entity-${e}-`))!;
    await assert.rejects(warehouse.invokeChild(entity), /cancelled/);
  }
  assert.equal(warehouse.running, 0);
});

void test("a failed entity leaves the other entities complete and correct", async () => {
  const warehouse = new FakeWarehouse({ entity: "contacts", page: 2 });
  const run = await runLikeInngest({
    fn: parentRun({ parallelism: 3, warehouse, rowsByEntity: {}, started: [] }),
    child: d => warehouse.invokeChild(d.entity),
    pick: seededPick(3),
  });
  assert.equal(run.result.ok, false);
  assert.match(
    String((run.result as { error: Error }).error.message),
    /contacts: source returned 500/,
  );
  for (const entity of ENTITIES.filter(e => e !== "contacts")) {
    assert.equal(warehouse.merges.get(entity), 1, `${entity} still completed`);
    assert.deepEqual(warehouse.live.get(entity), sourceRows(entity), entity);
  }
  // The failed entity never merged: its live table is untouched, its
  // buffer and checkpoint hold what it read, for the retry to resume.
  assert.equal(warehouse.live.has("contacts"), false);
  assert.equal(warehouse.checkpoint.get("contacts"), 200);
  assert.deepEqual(
    warehouse.buffer.get("contacts"),
    sourceRows("contacts").slice(0, 200),
  );
  for (const [id, count] of run.starts) assert.equal(count, 1, id);
});

void test("lanes: the first failure in list order is thrown, a cancel wins", async () => {
  const order: string[] = [];
  await assert.rejects(
    runEntityLanes({
      entities: ["a", "b", "c", "d"],
      parallelism: 2,
      isCancellation,
      runEntity: async entity => {
        order.push(entity);
        await new Promise(r => setTimeout(r, entity === "b" ? 1 : 5));
        if (entity === "d" || entity === "b") {
          throw new Error(`${entity} failed`);
        }
      },
    }),
    /b failed/,
  );
  assert.deepEqual(
    [...order].sort(),
    ["a", "b", "c", "d"],
    "a failure does not stop the others",
  );

  const ran: string[] = [];
  await assert.rejects(
    runEntityLanes({
      entities: ["a", "b", "c", "d", "e"],
      parallelism: 2,
      isCancellation,
      runEntity: async entity => {
        ran.push(entity);
        if (entity === "a") {
          await new Promise(r => setTimeout(r, 5));
          throw new Error("x failed");
        }
        if (entity === "b") throw new Error("Flow execution cancelled by user");
      },
    }),
    /cancelled/,
  );
  assert.deepEqual(ran, ["a", "b"], "nothing starts after a cancel");
});

void test("lanes: one lane is a plain loop, more lanes use the parallel wrapper", async () => {
  let wrapped = 0;
  const parallel = <T>(fn: () => Promise<T>) => {
    wrapped++;
    return fn();
  };
  const seen: string[] = [];
  await runEntityLanes({
    entities: ["a", "b"],
    parallelism: 1,
    isCancellation,
    parallel,
    runEntity: async e => void seen.push(e),
  });
  assert.equal(wrapped, 0);
  assert.deepEqual(seen, ["a", "b"]);
  await runEntityLanes({
    entities: ["a", "b"],
    parallelism: 2,
    isCancellation,
    parallel,
    runEntity: async () => {},
  });
  assert.equal(wrapped, 1);
});

void test("parallelism: env default, per-flow override, ceiling and limits", () => {
  const base = {
    entities: ENTITIES,
    boxed: false,
    leasesEnabled: false,
    maxLeasesPerConnection: 4,
  };
  withEnv(
    {
      BACKFILL_ENTITY_PARALLELISM: undefined,
    },
    () => {
      assert.equal(defaultEntityParallelism(), 3);
      assert.equal(entityParallelismCeiling(), 6);
      assert.deepEqual(resolveEntityParallelism(base), { parallelism: 3 });
      assert.deepEqual(resolveEntityParallelism({ ...base, flowOverride: 5 }), {
        parallelism: 5,
      });
      assert.deepEqual(resolveEntityParallelism({ ...base, flowOverride: 1 }), {
        parallelism: 1,
      });
      assert.deepEqual(
        resolveEntityParallelism({ ...base, flowOverride: 50 }),
        {
          parallelism: 6,
          limitedBy: "ceiling",
        },
      );
      assert.deepEqual(resolveEntityParallelism({ ...base, flowOverride: 0 }), {
        parallelism: 3,
      });
      assert.deepEqual(
        resolveEntityParallelism({ ...base, entities: ["a", "b"] }),
        {
          parallelism: 2,
          limitedBy: "entities",
        },
      );
      // Workspace connector under leases: keep one lease slot free.
      assert.deepEqual(
        resolveEntityParallelism({
          ...base,
          boxed: true,
          leasesEnabled: true,
          maxLeasesPerConnection: 3,
          flowOverride: 5,
        }),
        { parallelism: 2, limitedBy: "box-leases" },
      );
      // Sync-box mode (no leases): sessions share the workspace box.
      assert.deepEqual(resolveEntityParallelism({ ...base, boxed: true }), {
        parallelism: 3,
      });
      // Entities that would share a buffer collection run one at a time.
      assert.deepEqual(
        resolveEntityParallelism({ ...base, entities: ["a-b", "a_b", "c"] }),
        {
          parallelism: 1,
          limitedBy: "name-collision",
        },
      );
      // Entities that would write one destination table run one at a time:
      // `activities:Call` and `call_activities` are both `call_activities`.
      const tableNameOf = (entity: string) =>
        getEntityTableName("close", entity);
      assert.deepEqual(
        resolveEntityParallelism({
          ...base,
          entities: ["activities:Call", "call_activities", "leads"],
          tableNameOf,
        }),
        { parallelism: 1, limitedBy: "name-collision" },
      );
      assert.deepEqual(
        resolveEntityParallelism({
          ...base,
          entities: ["activities:Call", "activities:Email", "leads"],
          tableNameOf,
        }),
        { parallelism: 3 },
      );
    },
  );
  withEnv({ BACKFILL_ENTITY_PARALLELISM: "1" }, () => {
    assert.deepEqual(resolveEntityParallelism(base), { parallelism: 1 });
  });
  withEnv(
    {
      BACKFILL_ENTITY_PARALLELISM: "10",
    },
    () => {
      assert.equal(
        entityParallelismCeiling(),
        10,
        "the ceiling never sits below the default",
      );
    },
  );
  withEnv({ BACKFILL_ENTITY_PARALLELISM: "zero" }, () => {
    assert.equal(defaultEntityParallelism(), 3);
  });
});

void test("per-entity keys: buffers, step ids and concurrency keys", () => {
  assert.deepEqual(collidingEntities(ENTITIES), []);
  assert.deepEqual(collidingEntities(["custom.lead", "custom_lead", "x"]), [
    "custom.lead",
    "custom_lead",
  ]);
  const key = (
    flowId: string,
    entity: string,
    boxed: boolean,
    leasesEnabled: boolean,
  ) => entityRunConcurrencyKey({ flowId, entity, boxed, leasesEnabled });
  // Leased boxes count against the E2B account: one shared pool.
  assert.equal(key("f1", "leads", true, true), "connector-box");
  assert.equal(key("f2", "deals", true, true), "connector-box");
  // Sessions mode: one box per workspace, so no cross-tenant pool.
  assert.equal(key("f1", "leads", true, false), "entity:f1:leads");
  assert.equal(key("f1", "leads", false, true), "entity:f1:leads");
});

void test("per-entity table collisions are found, case-insensitively", () => {
  const tableNameOf = (entity: string) => getEntityTableName("", entity);
  assert.deepEqual(
    collidingEntities(["Leads", "leads", "contacts"], tableNameOf),
    ["Leads", "leads"],
  );
  assert.deepEqual(
    collidingEntities(["activities:Call", "call_activities"], tableNameOf),
    ["activities:Call", "call_activities"],
  );
  assert.deepEqual(collidingEntities(ENTITIES, tableNameOf), []);
});

void test("sync-backfill-entity: one run per flow + entity, ever", () => {
  const opts = (
    syncBackfillEntityFunction as unknown as {
      opts: { concurrency: Array<{ limit: number; key: string }> };
    }
  ).opts;
  assert.equal(opts.concurrency.length, 2);
  // An orphaned child of a cancelled run blocks a new one for the same
  // entity: buffer and staging names carry no run id (#1318).
  assert.deepEqual(opts.concurrency[0], {
    limit: 1,
    key: 'event.data.flowId + ":" + event.data.entity',
  });
  assert.equal(opts.concurrency[1].key, "event.data.runConcurrencyKey");
});
