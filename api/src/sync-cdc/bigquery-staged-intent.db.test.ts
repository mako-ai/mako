import { MongoMemoryReplSet } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CdcChangeEvent, Flow } from "../database/workspace-schema";
import {
  cleanupBigQueryStagedInput,
  findBigQueryStagedCdcWrites,
  holdBigQueryStagedCdcMerge,
  holdBigQueryStagedInput,
  holdBigQueryStagedMerge,
  initializeBigQueryStagedInputStore,
  readBigQueryStagedInput,
  readPendingBigQueryQueryRequest,
  recordBigQueryStagedReceipt,
  recordObservedBigQueryQueryResult,
  type BigQueryStagedIntent,
  type BigQueryTerminalReceipt,
} from "./bigquery-staged-intent";

let mongo: MongoMemoryReplSet;
beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({
    replSet: { count: 3, args: ["--setParameter", "enableTestCommands=1"] },
  });
  await mongoose.connect(mongo.getUri());
  await initializeBigQueryStagedInputStore();
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

function makeIntent(
  suffix: string,
): Extract<BigQueryStagedIntent, { configurationFingerprint: string }> {
  return {
    job: { project: "proj", location: "eu", id: `merge_${suffix}` },
    input: {
      snapshot: {
        project: "proj",
        dataset: "stage",
        table: `snapshot_${suffix}`,
      },
      generation: "generation-1",
    },
    destination: { project: "proj", dataset: "live", table: "recordings" },
    configurationFingerprint: "synthetic-fixed-SQL-digest",
  };
}

function makeMerge(suffix: string) {
  const { job, input, destination } = makeIntent(suffix);
  return {
    binding: { job, input, destination },
    merge: {
      columns: ["id"],
      keyColumns: ["id"],
      stagingCols: new Set(["id"]),
      liveTypes: new Map([["id", "STRING"]]),
    },
    options: {
      query: {
        useLegacySql: false as const,
        priority: "BATCH" as const,
        maximumBytesBilled: "100000000",
      },
      labels: { pipeline: "cdc" },
      jobTimeoutMs: "100000",
    },
  };
}

async function makeCdcMerge(suffix: string) {
  const { binding, merge, options } = makeMerge(suffix);
  const scope = {
    workspaceId: new Types.ObjectId().toHexString(),
    flowId: new Types.ObjectId().toHexString(),
    sourceConnectionId: new Types.ObjectId().toHexString(),
    destinationConnectionId: new Types.ObjectId().toHexString(),
    definitionSha: "synthetic-flow-definition",
    entity: "recordings",
    authorizationId: "synthetic-approved-binding",
    originNamespace: "synthetic-claap-workspace",
  };
  await Flow.create({
    _id: scope.flowId,
    workspaceId: scope.workspaceId,
    dataSourceId: scope.sourceConnectionId,
    destinationDatabaseId: scope.destinationConnectionId,
    tableDestination: {
      connectionId: scope.destinationConnectionId,
      schema: binding.destination.dataset,
    },
    syncEngine: "cdc",
    schedule: { enabled: false },
    sourceBlobSha: scope.definitionSha,
    createdBy: new Types.ObjectId().toHexString(),
  });
  async function event(
    deliveryKey: string,
    ingestSeq: number,
    entity = scope.entity,
  ) {
    const row = await CdcChangeEvent.create({
      workspaceId: scope.workspaceId,
      flowId: scope.flowId,
      entity,
      recordId: deliveryKey,
      sourceKind: "webhook",
      op: "upsert",
      sourceTs: new Date(),
      ingestSeq,
      idempotencyKey: `${scope.flowId}:${ingestSeq}`,
    });
    return { id: String(row._id), deliveryKey };
  }
  return {
    binding,
    merge,
    options,
    scope,
    event,
    hold: (events: Awaited<ReturnType<typeof event>>[]) =>
      holdBigQueryStagedCdcMerge(binding, merge, options, { scope, events }),
  };
}

describe("BigQuery CDC event settlement", () => {
  it("recovers an overlapping retry after the warehouse accepted one write and lost its response", async () => {
    const first = await makeCdcMerge("cdc_lost_ack");
    const a = await first.event("a", 1);
    const b = await first.event("b", 2);
    const c = await first.event("c", 3);
    const { job } = first.binding;
    await expect(first.hold([a, b])).resolves.toBe("held");
    const request = await readPendingBigQueryQueryRequest(job);
    if (!request) throw new Error("Missing original warehouse request");
    const warehouse = new Map<string, typeof request>();
    const submitAndLoseResponse = () => {
      warehouse.set(job.id, request);
      throw new Error("Simulated lost warehouse response");
    };
    expect(submitAndLoseResponse).toThrow("Simulated lost warehouse response");
    await mongoose.disconnect();
    await mongoose.connect(mongo.getUri());

    const changed = makeMerge("cdc_overlap");
    await expect(
      holdBigQueryStagedCdcMerge(
        changed.binding,
        changed.merge,
        changed.options,
        {
          scope: first.scope,
          events: [b, c],
        },
      ),
    ).rejects.toThrow("The exact pending CDC events could not be reserved");
    expect(await readBigQueryStagedInput(changed.binding.job)).toBeNull();
    const [original] = await findBigQueryStagedCdcWrites(first.scope, [
      "b",
      "c",
    ]);
    expect(original?.intent.job).toEqual(job);
    expect(original?.intent.cdc?.events).toEqual(
      [a, b].sort((left, right) => left.id.localeCompare(right.id)),
    );
    expect(
      await findBigQueryStagedCdcWrites(
        { ...first.scope, authorizationId: "other-authorization" },
        ["b", "c"],
      ),
    ).toEqual([]);
    const metadata = {
      ...warehouse.get(job.id),
      status: { state: "DONE" },
      statistics: { query: { statementType: "MERGE" } },
    };
    await expect(
      Promise.all([
        recordObservedBigQueryQueryResult(job, metadata),
        recordObservedBigQueryQueryResult(job, metadata),
      ]),
    ).resolves.toEqual([true, true]);
    const rows = await CdcChangeEvent.find({ flowId: first.scope.flowId })
      .sort({ ingestSeq: 1 })
      .readConcern("majority")
      .lean();
    expect(
      rows.map(row => [
        row.materializationStatus,
        row.materializationAttemptCount,
      ]),
    ).toEqual([
      ["applied", 1],
      ["applied", 1],
      ["pending", 0],
    ]);
    expect(rows[2]?.retainedBigQueryWrite).toBeUndefined();
    expect(warehouse.size).toBe(1);
    expect(await readPendingBigQueryQueryRequest(job)).toBeNull();
    expect((await readBigQueryStagedInput(job))?.terminal).toMatchObject({
      state: "DONE",
      outcome: "succeeded",
    });
  });

  it("keeps the stable delivery claim after the original applied CDC row is removed", async () => {
    const first = await makeCdcMerge("cdc_original");
    const a = await first.event("same-delivery", 1);
    const { job } = first.binding;
    await first.hold([a]);
    const request = await readPendingBigQueryQueryRequest(job);
    expect(
      await recordObservedBigQueryQueryResult(job, {
        ...request,
        status: { state: "DONE" },
        statistics: { query: { statementType: "MERGE" } },
      }),
    ).toBe(true);
    await CdcChangeEvent.deleteOne({ _id: a.id });
    const rebuilt = await first.event("same-delivery", 2);
    const changed = makeMerge("cdc_rebuilt");
    await expect(
      holdBigQueryStagedCdcMerge(
        changed.binding,
        changed.merge,
        changed.options,
        {
          scope: first.scope,
          events: [rebuilt],
        },
      ),
    ).rejects.toMatchObject({ code: 11000 });
    expect(
      (await CdcChangeEvent.findById(rebuilt.id).lean())?.retainedBigQueryWrite,
    ).toBeUndefined();
    const [original] = await findBigQueryStagedCdcWrites(first.scope, [
      "same-delivery",
    ]);
    expect(original?.intent.job).toEqual(job);
    expect(original?.terminal?.outcome).toBe("succeeded");
  });

  it("rejects out-of-scope CDC rows and stops dispatch and settlement after source replacement", async () => {
    const first = await makeCdcMerge("cdc_wrong_scope");
    const a = await first.event("a", 1);
    const other = await first.event("other", 2, "recording_transcripts");
    await expect(first.hold([a, other])).rejects.toThrow(
      "The exact pending CDC events could not be reserved",
    );
    const { job } = first.binding;
    expect(await readBigQueryStagedInput(job)).toBeNull();
    expect(
      (await CdcChangeEvent.findById(a.id).lean())?.retainedBigQueryWrite,
    ).toBeUndefined();

    await first.hold([a]);
    const request = await readPendingBigQueryQueryRequest(job);
    await Flow.updateOne(
      { _id: first.scope.flowId },
      {
        $set: { dataSourceId: new Types.ObjectId() },
      },
    );
    expect(await readPendingBigQueryQueryRequest(job)).toBeNull();
    expect(
      await recordObservedBigQueryQueryResult(job, {
        ...request,
        status: { state: "DONE" },
        statistics: { query: { statementType: "MERGE" } },
      }),
    ).toBe(false);
    expect((await readBigQueryStagedInput(job))?.terminal).toBeUndefined();
    expect(
      (await CdcChangeEvent.findById(a.id).lean())?.materializationStatus,
    ).toBe("pending");
  });

  it("keeps the receipt and remaining CDC rows pending if part of a bound batch disappears", async () => {
    const first = await makeCdcMerge("cdc_missing_row");
    const a = await first.event("a", 1);
    const b = await first.event("b", 2);
    const { job } = first.binding;
    await first.hold([a, b]);
    const request = await readPendingBigQueryQueryRequest(job);
    await CdcChangeEvent.deleteOne({ _id: b.id });
    expect(
      await recordObservedBigQueryQueryResult(job, {
        ...request,
        status: { state: "DONE" },
        statistics: { query: { statementType: "MERGE" } },
      }),
    ).toBe(false);
    expect(await readPendingBigQueryQueryRequest(job)).toBeNull();
    expect((await readBigQueryStagedInput(job))?.terminal).toBeUndefined();
    expect(await CdcChangeEvent.findById(a.id).lean()).toMatchObject({
      materializationStatus: "pending",
      materializationAttemptCount: 0,
    });
  });

  it("keeps CDC events pending when BigQuery reports a verified terminal failure", async () => {
    const first = await makeCdcMerge("cdc_failed_job");
    const change = await first.event("failed", 1);
    const { job } = first.binding;
    await first.hold([change]);
    const request = await readPendingBigQueryQueryRequest(job);
    expect(
      await recordObservedBigQueryQueryResult(job, {
        ...request,
        status: { state: "RUNNING" },
      }),
    ).toBe(false);
    expect((await readBigQueryStagedInput(job))?.terminal).toBeUndefined();
    expect(
      await recordObservedBigQueryQueryResult(job, {
        ...request,
        status: { state: "DONE", errorResult: { reason: "backendError" } },
      }),
    ).toBe(true);
    expect(await CdcChangeEvent.findById(change.id).lean()).toMatchObject({
      materializationStatus: "pending",
      materializationAttemptCount: 0,
    });
    expect((await readBigQueryStagedInput(job))?.terminal?.outcome).toBe(
      "failed",
    );
    expect(await readPendingBigQueryQueryRequest(job)).toBeNull();
    const drop = vi.fn(async () => undefined);
    expect(await cleanupBigQueryStagedInput(job, drop)).toBe(false);
    expect(drop).not.toHaveBeenCalled();
  });
});

describe("BigQuery retained dispatch", () => {
  it.each([false, true])(
    "recovers the same warehouse request after reconnect, submitted before disconnect %s",
    async submittedBeforeDisconnect => {
      const { binding, merge, options } = makeMerge(
        `dispatch_${submittedBeforeDisconnect}`,
      );
      const { job, input } = binding;
      await holdBigQueryStagedMerge(binding, merge, options);
      const original = await readPendingBigQueryQueryRequest(job);
      if (!original) throw new Error("Missing original request");
      expect(original).toEqual({
        jobReference: {
          projectId: job.project,
          location: job.location,
          jobId: job.id,
        },
        configuration: {
          ...options,
          query: { ...options.query, query: expect.any(String) },
        },
      });
      expect(original.configuration.query.query).toContain(
        "MERGE INTO `proj`.`live`.`recordings` __live",
      );
      expect(original.configuration.query.query).toContain(
        `FROM \`proj\`.\`stage\`.\`${input.snapshot.table}\``,
      );

      const warehouse = new Map<string, typeof original>();
      function submit(request: NonNullable<typeof original>) {
        const jobId = request.jobReference.jobId;
        if (warehouse.has(jobId)) return 409;
        warehouse.set(jobId, structuredClone(request));
        return 200;
      }
      if (submittedBeforeDisconnect) submit(original);

      await mongoose.disconnect();
      await mongoose.connect(mongo.getUri());
      const recovered = await readPendingBigQueryQueryRequest(job);
      if (!recovered) throw new Error("Missing recovered request");
      expect(JSON.stringify(recovered)).toBe(JSON.stringify(original));
      expect(submit(recovered)).toBe(submittedBeforeDisconnect ? 409 : 200);
      expect(warehouse.size).toBe(1);
      const done = {
        ...warehouse.get(job.id),
        status: { state: "DONE", errors: [{ reason: "warning" }] },
        statistics: { query: { statementType: "MERGE" } },
      };
      await expect(recordObservedBigQueryQueryResult(job, done)).resolves.toBe(
        true,
      );
      expect(await readPendingBigQueryQueryRequest(job)).toBeNull();
      expect((await readBigQueryStagedInput(job))?.terminal).toMatchObject({
        state: "DONE",
        outcome: "succeeded",
      });
      const drop = vi.fn(async () => undefined);
      expect(await cleanupBigQueryStagedInput(job, drop)).toBe(false);
      expect(drop).not.toHaveBeenCalled();
    },
  );

  it("holds a reservation until a matching job gives a terminal result", async () => {
    const { binding, merge, options } = makeMerge("ambiguous");
    const { job } = binding;
    await holdBigQueryStagedMerge(binding, merge, options);
    const request = await readPendingBigQueryQueryRequest(job);
    if (!request) throw new Error("Missing staged request");
    const completed = {
      ...request,
      status: { state: "DONE" },
      statistics: { query: { statementType: "MERGE" } },
    };
    const { configuration, jobReference } = completed;
    for (const observed of [
      undefined,
      { ...completed, status: { state: "RUNNING" } },
      { ...completed, status: { state: "DONE", errorResult: {} } },
      { ...completed, jobReference: { ...jobReference, projectId: "other" } },
      { ...completed, jobReference: { ...jobReference, location: "us" } },
      { ...completed, jobReference: { ...jobReference, jobId: "other" } },
      { ...completed, configuration: { ...configuration, dryRun: true } },
      {
        ...completed,
        configuration: { ...configuration, jobTimeoutMs: "100" },
      },
      { ...completed, configuration: { ...configuration, labels: {} } },
      {
        ...completed,
        configuration: {
          ...configuration,
          query: {
            ...configuration.query,
            query: configuration.query.query.replace("`live`", "`other`"),
          },
        },
      },
      {
        ...completed,
        configuration: {
          ...configuration,
          query: { ...configuration.query, priority: "INTERACTIVE" },
        },
      },
      {
        ...completed,
        configuration: {
          ...configuration,
          query: {
            ...configuration.query,
            defaultDataset: { datasetId: "other" },
          },
        },
      },
      { ...completed, statistics: { query: { statementType: "SELECT" } } },
    ]) {
      expect(await recordObservedBigQueryQueryResult(job, observed)).toBe(
        false,
      );
    }
    expect(await readPendingBigQueryQueryRequest(job)).toEqual(request);

    const failure = {
      ...completed,
      jobReference: { ...jobReference, location: "EU" },
      status: { state: "DONE", errorResult: { reason: "backendError" } },
      statistics: { query: {} },
    };
    expect(await recordObservedBigQueryQueryResult(job, failure)).toBe(true);
    expect(await recordObservedBigQueryQueryResult(job, completed)).toBe(false);
    expect((await readBigQueryStagedInput(job))?.terminal).toMatchObject({
      state: "DONE",
      outcome: "failed",
    });
  });

  it("keeps digest-only records out of the retained dispatch path", async () => {
    const intent = makeIntent("legacy-digest");
    await holdBigQueryStagedInput(intent);
    expect(await readPendingBigQueryQueryRequest(intent.job)).toBeNull();
    expect(await recordObservedBigQueryQueryResult(intent.job, {})).toBe(false);
  });

  it("keeps the original request when the same job ID is held with different SQL", async () => {
    const { binding, merge, options } = makeMerge("same_job");
    const { job } = binding;
    await holdBigQueryStagedMerge(binding, merge, options);
    const original = await readPendingBigQueryQueryRequest(job);
    const edited = { ...merge, columns: ["id", "new_column"] };
    await expect(
      holdBigQueryStagedMerge(binding, edited, options),
    ).rejects.toThrow("different staged write");
    expect(await readPendingBigQueryQueryRequest(job)).toEqual(original);
  });
});

describe("BigQuery staged input retention", () => {
  for (const submittedBeforeCrash of [false, true]) {
    it(`retains the input when the submitting process dies ${submittedBeforeCrash ? "after" : "before"} dispatch`, async () => {
      const intent = makeIntent(String(submittedBeforeCrash));
      const warehouse = new Map<string, BigQueryStagedIntent>();
      const dispatch = (request: BigQueryStagedIntent) => {
        if (warehouse.has(request.job.id)) return 409;
        warehouse.set(request.job.id, request);
        return 200;
      };
      const drop = vi.fn(async () => undefined);
      await holdBigQueryStagedInput(intent);
      if (submittedBeforeCrash) expect(dispatch(intent)).toBe(200);

      // The restarted worker only has the durable job key and the warehouse metadata.
      await mongoose.disconnect();
      await mongoose.connect(mongo.getUri());
      const restored = await readBigQueryStagedInput(intent.job);
      expect(restored?.intent).toEqual(intent);
      if (!restored || restored.intent.configuration !== undefined) {
        throw new Error("Missing digest-only intent after restart");
      }
      expect(await cleanupBigQueryStagedInput(restored.intent.job, drop)).toBe(
        false,
      );
      expect(dispatch(restored.intent)).toBe(submittedBeforeCrash ? 409 : 200);
      expect(warehouse.size).toBe(1);

      const receipt: BigQueryTerminalReceipt = {
        ...restored.intent,
        state: "DONE",
        outcome: "succeeded",
      };
      for (const mismatch of [
        { ...receipt, input: { ...receipt.input, generation: "generation-2" } },
        { ...receipt, destination: { ...receipt.destination, table: "other" } },
        { ...receipt, job: { ...receipt.job, location: "US" } },
        { ...receipt, configurationFingerprint: "different-config" },
      ]) {
        expect(await recordBigQueryStagedReceipt(mismatch)).toBe(false);
        expect(
          await cleanupBigQueryStagedInput(restored.intent.job, drop),
        ).toBe(false);
      }
      expect(drop).not.toHaveBeenCalled();

      expect(await recordBigQueryStagedReceipt(receipt)).toBe(true);
      const checkedDrop = vi.fn(async () => {
        expect(
          (await readBigQueryStagedInput(restored.intent.job))?.terminal,
        ).toEqual(receipt);
      });
      await expect(
        cleanupBigQueryStagedInput(restored.intent.job, checkedDrop),
      ).resolves.toBe(true);
      expect(checkedDrop).toHaveBeenCalledExactlyOnceWith(intent.input);
      await expect(
        cleanupBigQueryStagedInput(restored.intent.job, checkedDrop),
      ).resolves.toBe(true);
      expect(checkedDrop).toHaveBeenCalledTimes(1);
    });
  }

  it("keeps the snapshot when the worker dies after BigQuery succeeds but before storing the receipt", async () => {
    const intent = makeIntent("done-before-receipt");
    const snapshots = new Map([
      [intent.input.snapshot.table, intent.input.generation],
    ]);
    const warehouse = new Map<string, BigQueryTerminalReceipt>();
    await holdBigQueryStagedInput(intent);
    warehouse.set(intent.job.id, {
      ...intent,
      state: "DONE",
      outcome: "succeeded",
    });

    // BigQuery and the snapshot outlive the worker. Mongo has no terminal receipt yet.
    await mongoose.disconnect();
    await mongoose.connect(mongo.getUri());
    const restored = await readBigQueryStagedInput(intent.job);
    expect(restored?.terminal).toBeUndefined();
    expect(restored?.intent.input).toEqual(intent.input);
    const drop = vi.fn(async (input: BigQueryStagedIntent["input"]) => {
      expect(snapshots.get(input.snapshot.table)).toBe(input.generation);
      snapshots.delete(input.snapshot.table);
    });
    await expect(cleanupBigQueryStagedInput(intent.job, drop)).resolves.toBe(
      false,
    );
    expect(drop).not.toHaveBeenCalled();
    expect(snapshots.get(intent.input.snapshot.table)).toBe(
      intent.input.generation,
    );

    const providerReceipt = warehouse.get(intent.job.id);
    if (!providerReceipt) {
      throw new Error("missing successful warehouse receipt");
    }
    await expect(recordBigQueryStagedReceipt(providerReceipt)).resolves.toBe(
      true,
    );
    await expect(cleanupBigQueryStagedInput(intent.job, drop)).resolves.toBe(
      true,
    );
    expect(drop).toHaveBeenCalledExactlyOnceWith(intent.input);
    expect(snapshots.has(intent.input.snapshot.table)).toBe(false);
  });

  it("keeps one job per snapshot and one immutable snapshot per job", async () => {
    const intent = makeIntent("exclusive");
    await holdBigQueryStagedInput(intent);
    await holdBigQueryStagedInput(intent);
    await expect(
      holdBigQueryStagedInput({
        ...intent,
        input: { ...intent.input, generation: "different" },
      }),
    ).rejects.toThrow("different staged write");
    await expect(
      holdBigQueryStagedInput({
        ...intent,
        job: { ...intent.job, id: "other" },
      }),
    ).rejects.toMatchObject({ code: 11000 });
    expect((await readBigQueryStagedInput(intent.job))?.intent).toEqual(intent);
  });

  it("copies caller input and treats location aliases as one job", async () => {
    const intent = makeIntent("copy");
    const requested = structuredClone(intent);
    requested.job.location = "EU";
    const held = holdBigQueryStagedInput(requested);
    requested.input.generation = "different";
    await expect(held).resolves.toBe("held");
    expect((await readBigQueryStagedInput(intent.job))?.intent).toEqual(intent);
    await expect(holdBigQueryStagedInput(requested)).rejects.toThrow(
      "different staged write",
    );
    await recordBigQueryStagedReceipt({
      ...intent,
      state: "DONE",
      outcome: "succeeded",
    });
    await cleanupBigQueryStagedInput(intent.job, async () => undefined);
    await expect(holdBigQueryStagedInput(intent)).resolves.toBe("terminal");
  });

  it("refuses a hold without the snapshot ownership index", async () => {
    const collection = mongoose.connection.collection(
      "cdc_bigquery_staged_writes",
    );
    await collection.dropIndex("snapshotKey_1");
    try {
      await expect(
        holdBigQueryStagedInput(makeIntent("no-index")),
      ).rejects.toThrow("ownership index is missing");
    } finally {
      await initializeBigQueryStagedInputStore();
    }
  });

  it("does not delete after a primary-local receipt until majority commitment", async () => {
    const intent = makeIntent("majority");
    await holdBigQueryStagedInput(intent);
    const stored = await readBigQueryStagedInput(intent.job);
    if (!stored) throw new Error("missing held input");
    const terminal: BigQueryTerminalReceipt = {
      ...intent,
      state: "DONE",
      outcome: "succeeded",
    };
    const db = mongoose.connection.db;
    if (!db) throw new Error("missing test database");
    const status = (await db.admin().command({ replSetGetStatus: 1 })) as {
      members: { stateStr: string; name: string }[];
    };
    const replicas = status.members.filter(
      member => member.stateStr === "SECONDARY",
    );
    expect(replicas).toHaveLength(2);
    const secondaries = replicas.map(member =>
      mongoose.createConnection(`mongodb://${member.name}/admin`, {
        directConnection: true,
      }),
    );
    const collection = db.collection<{
      _id: string;
      terminal?: BigQueryTerminalReceipt;
    }>("cdc_bigquery_staged_writes");
    const drop = vi.fn(async () => undefined);
    try {
      for (const secondary of secondaries) {
        await secondary.asPromise();
        const admin = secondary.db?.admin();
        if (!admin) throw new Error("missing secondary test database");
        const enabled = await admin.command({
          configureFailPoint: "stopReplProducer",
          mode: "alwaysOn",
        });
        await admin.command({
          waitForFailPoint: "stopReplProducer",
          timesEntered: Number(enabled.count) + 1,
          maxTimeMS: 10_000,
        });
      }
      await collection.updateOne(
        { _id: stored._id },
        { $set: { terminal } },
        { writeConcern: { w: 1 } },
      );
      expect(
        (
          await collection.findOne(
            { _id: stored._id },
            { readConcern: { level: "local" } },
          )
        )?.terminal,
      ).toBeDefined();
      await expect(cleanupBigQueryStagedInput(intent.job, drop)).resolves.toBe(
        false,
      );
      expect(drop).not.toHaveBeenCalled();
    } finally {
      for (const secondary of secondaries) {
        await secondary.db
          ?.admin()
          .command({ configureFailPoint: "stopReplProducer", mode: "off" });
        await secondary.close();
      }
    }
    await expect(recordBigQueryStagedReceipt(terminal)).resolves.toBe(true);
    await expect(cleanupBigQueryStagedInput(intent.job, drop)).resolves.toBe(
      true,
    );
    expect(drop).toHaveBeenCalledExactlyOnceWith(intent.input);
  });

  it("retries a failed cleanup using the exact retained generation", async () => {
    const intent = makeIntent("cleanup");
    await holdBigQueryStagedInput(intent);
    await recordBigQueryStagedReceipt({
      ...intent,
      state: "DONE",
      outcome: "failed",
    });
    const cleanup = vi
      .fn(async () => undefined)
      .mockRejectedValueOnce(new Error("snapshot delete interrupted"));
    await expect(
      cleanupBigQueryStagedInput(intent.job, cleanup),
    ).rejects.toThrow("snapshot delete interrupted");
    expect(
      (await readBigQueryStagedInput(intent.job))?.cleanedAt,
    ).toBeUndefined();
    await expect(cleanupBigQueryStagedInput(intent.job, cleanup)).resolves.toBe(
      true,
    );
    expect(cleanup.mock.calls).toEqual([[intent.input], [intent.input]]);
  });
});
