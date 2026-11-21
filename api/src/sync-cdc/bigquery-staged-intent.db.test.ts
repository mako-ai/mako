import { createHash } from "node:crypto";
import { mkdtemp, rmdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { DuckDBInstance } from "@duckdb/node-api";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  CdcChangeEvent,
  DatabaseConnection,
  Flow,
  WebhookEvent,
} from "../database/workspace-schema";
import { databaseConnectionService } from "../services/database-connection.service";
import * as flowSync from "../services/flow-sync.service";
import { sourceConnectionManager } from "../sync/database-data-source-manager";
import { databaseRegistry } from "../databases/registry";
import { BigQueryDatabaseDriver } from "../databases/drivers/bigquery/driver";
import * as dataDiff from "./data-diff";
import * as backfillLifecycle from "./backfill/lifecycle";
import { BigQueryDestinationAdapter } from "./adapters/bigquery";
import { enableLoadJobLabels } from "./adapters/bigquery-load-labels";
import { getSchemaCacheKey } from "./adapters/bigquery-schema";
import type { BigQueryTarget } from "./adapters/bigquery-target";
import { buildCdcEntityLayout } from "./adapters/registry";
import * as adapterRegistry from "./adapters/registry";
import { bigQueryReplayDeliveryKey } from "./bigquery-staged-cdc";
import { getCdcEventStore } from "./event-store";
import { CdcConsumerService, parkPausedFlowWebhookEvents } from "./consumer";
import { cleanupStalePendingCdcEvents } from "./cdc-stale-pending-cleanup";
import { resyncFlow, withCdcEventReset } from "./backfill/resync";
import { backfillEntitiesFallback } from "./backfill/repartition";
import {
  reconcileWebhookApplyStatus,
  resetFailedWebhookEvents,
} from "./backfill/webhook-maintenance";
import { resolveOrphanedWebhookApplyStatusForFlow } from "./cdc-orphan-applystatus";
import { withCdcResyncFence } from "./cdc-resync-fence";
import { bigQueryStagingTableName } from "./adapters/bigquery-sql";
import {
  dispatchRestBigQueryTruncate,
  recordRestBigQueryTruncateResult,
  retainRestBigQueryTruncate,
  settleReservedBigQueryRestTruncate,
} from "./bigquery-rest-overwrite-intent";
import {
  bigQuerySnapshotGeneration,
  retainedQueryOutcome,
} from "./bigquery-retained-query";
import { captureRestBigQueryOverwriteSnapshot } from "./bigquery-rest-overwrite-snapshot";
import {
  readVerifiedRestBigQueryOverwriteManifest,
  sealRestBigQueryOverwriteManifest,
  settleRestBigQueryOverwriteManifest,
  verifyRestBigQueryOverwriteManifest,
} from "./bigquery-rest-overwrite-manifest";
import {
  assertRetainedWritesDrainedForResync,
  cleanupBigQueryStagedInput,
  dispatchRestBigQueryReplacement,
  findBigQueryStagedCdcWrites,
  holdBigQueryStagedCdcMerge,
  holdBigQueryStagedCdcReplay,
  holdBigQueryRestOverwriteInsert,
  holdBigQueryStagedInput,
  holdBigQueryStagedMerge,
  initializeBigQueryStagedInputStore,
  readBigQueryRestOverwriteWrites,
  readBigQueryStagedInput,
  readBigQueryStagedCdcReplay,
  readPendingBigQueryQueryRequest,
  recordBigQueryStagedReceipt,
  recordObservedBigQueryQueryResult,
  retryFailedBigQueryReplayMember,
  settleReservedBigQueryStagedJob,
  type BigQueryStagedIntent,
  type BigQueryTerminalReceipt,
} from "./bigquery-staged-intent";
import {
  admitRestEntity,
  closeRestEntityAdmission,
  hasPendingRestEntityOverwrite,
  reserveRestEntityOverwrite,
  type RestEntityOverwriteReservation,
} from "./rest-entity-admission";
import {
  acquireTableWriteLease,
  CdcTableWriteLease,
  TableWriteLeaseBusyError,
  type LeaseJobControl,
} from "./table-write-lease";

let mongo: MongoMemoryReplSet;
beforeAll(async () => {
  vi.stubEnv("ENCRYPTION_KEY", "0".repeat(64));
  databaseRegistry.getOrRegister(
    "bigquery",
    () => new BigQueryDatabaseDriver(),
  );
  mongo = await MongoMemoryReplSet.create({
    replSet: {
      count: 3,
      args: [
        "--setParameter",
        "enableTestCommands=1",
        "--setParameter",
        "ttlMonitorEnabled=false",
      ],
    },
  });
  await mongoose.connect(mongo.getUri());
  await initializeBigQueryStagedInputStore();
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  vi.unstubAllEnvs();
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

async function captureFixture(
  { scope, overwrite }: RestEntityOverwriteReservation,
  sourceRowsBefore: number,
  expectedRows: number,
) {
  const project = "proj";
  const dataset = overwrite.schema;
  const asOf = new Date("2026-11-21T16:00:00.000Z");
  let providerJob: unknown;
  const target = {
    bq: {
      async createJob({
        jobId,
        location,
        configuration,
      }: {
        jobId: string;
        location: string;
        configuration: unknown;
      }) {
        providerJob = {
          jobReference: { projectId: project, location, jobId },
          configuration,
          status: { state: "DONE" },
          statistics: { query: { statementType: "CREATE_SNAPSHOT_TABLE" } },
        };
      },
      job: () => ({
        async getMetadata() {
          if (!providerJob) throw { code: 404 };
          return [providerJob];
        },
      }),
      dataset: () => ({
        table: (tableId: string) => ({
          async getMetadata() {
            return [
              {
                type: "SNAPSHOT",
                tableReference: {
                  projectId: project,
                  datasetId: dataset,
                  tableId,
                },
                location: "EU",
                id: tableId,
                etag: "fixture-generation",
                creationTime: String(asOf.getTime() + 1000),
                numRows: String(expectedRows),
                snapshotDefinition: {
                  baseTableReference: {
                    projectId: project,
                    datasetId: dataset,
                    tableId: "staging",
                  },
                  snapshotTime: asOf.toISOString(),
                },
              },
            ];
          },
        }),
      }),
    },
    projectId: project,
    dataset,
    datasetLocation: "EU",
    destination: {
      _id: overwrite.destinationId,
      workspaceId: scope.workspaceId,
    },
  } as unknown as BigQueryTarget;
  const captured = await captureRestBigQueryOverwriteSnapshot(
    mongoose.connection,
    target,
    { scope, overwrite },
    {
      sourceRowsBefore,
      source: { project, dataset, table: "staging" },
      asOf,
      expectedRows,
    },
    { query: { useLegacySql: false, priority: "BATCH" } },
  );
  if (!captured) throw new Error("Missing captured fixture");
  return captured.input;
}

describe("retained overwrite query metadata", () => {
  it("reserves only one unfinished overwrite per destination in a source scope", async () => {
    const scope = {
      workspaceId: new Types.ObjectId(),
      flowId: new Types.ObjectId(),
      sourceConnectionId: new Types.ObjectId(),
    };
    const overwrite = {
      runId: "first",
      entity: "contacts",
      destinationId: "fixture-database",
      destinationConnectionId: "fixture-connection",
      destinationDatabaseName: null,
      schema: "live",
      tableName: "contacts",
    };
    const competing = { ...overwrite, runId: "second" };
    const reserve = (input: typeof overwrite) =>
      reserveRestEntityOverwrite(mongoose.connection, scope, input);
    const results = await Promise.allSettled([
      reserve(overwrite),
      reserve(competing),
    ]);
    expect(
      results.filter(result => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.find(result => result.status === "rejected");
    expect(rejected?.reason).toMatchObject({
      message: "Another REST overwrite for this destination is still in flight",
    });
    const admitted = results[0].status === "fulfilled" ? overwrite : competing;
    await expect(reserve(admitted)).resolves.toBeUndefined();
    await expect(
      reserve({ ...competing, tableName: "other_contacts" }),
    ).resolves.toBeUndefined();
    await expect(
      closeRestEntityAdmission(mongoose.connection, scope),
    ).rejects.toThrow("REST overwrite is still in flight");
    await expect(reserve(admitted)).resolves.toBeUndefined();
    await expect(
      reserve({ ...admitted, tableName: "unreserved_contacts" }),
    ).rejects.toThrow("REST entity admission is closed");
  });

  it("serializes a retained REST replacement with resync of the same table", async () => {
    const fixture = makeIntent("rest_resync_fence");
    const destination = { ...fixture.destination, table: "rest_resync_fence" };
    const scope = {
      workspaceId: new Types.ObjectId(),
      flowId: new Types.ObjectId(),
      sourceConnectionId: new Types.ObjectId(),
    };
    const overwrite = {
      runId: "rest-resync-fence",
      entity: "recordings",
      destinationId: "fixture-database",
      destinationConnectionId: "fixture-connection",
      destinationDatabaseName: null,
      schema: destination.dataset,
      tableName: destination.table,
    };
    const reservation = { scope, overwrite };
    await reserveRestEntityOverwrite(mongoose.connection, scope, overwrite);
    const input = await captureFixture(reservation, 0, 2);
    const hold = () =>
      holdBigQueryRestOverwriteInsert(
        { job: fixture.job, input, destination },
        ["id", "body"],
        { query: { useLegacySql: false, priority: "BATCH" } },
        { ...reservation, sourceRowsBefore: 0, expectedRows: 2 },
      );
    const resync = {
      workspaceId: scope.workspaceId.toHexString(),
      flowId: new Types.ObjectId().toHexString(),
      tables: [destination],
    };
    await withCdcResyncFence(
      resync,
      session => assertRetainedWritesDrainedForResync(resync, session),
      async () => {
        await expect(hold()).rejects.toThrow(
          "A CDC resync is holding this flow or table",
        );
        await expect(readBigQueryStagedInput(fixture.job)).resolves.toBeNull();
      },
    );
    await expect(hold()).resolves.toBe("held");
    const reset = vi.fn(async () => undefined);
    await expect(
      withCdcResyncFence(
        resync,
        session => assertRetainedWritesDrainedForResync(resync, session),
        reset,
      ),
    ).rejects.toThrow(
      "CDC resync is blocked by an unsettled write or retained snapshot",
    );
    expect(reset).not.toHaveBeenCalled();
  });

  it("blocks resync and another REST truncate until empty overwrite settlement", async () => {
    const connection = mongoose.connection;
    const scope = {
      workspaceId: new Types.ObjectId(),
      flowId: new Types.ObjectId(),
      sourceConnectionId: new Types.ObjectId(),
    };
    const table = {
      project: "proj",
      dataset: "live",
      table: "rest_empty_resync_fence",
    };
    const overwrite = {
      runId: "empty-rest-overwrite",
      entity: "recordings",
      destinationId: "fixture-database",
      destinationConnectionId: "fixture-connection",
      destinationDatabaseName: null,
      schema: table.dataset,
      tableName: table.table,
    };
    const reservation = { scope, overwrite };
    const competing = {
      scope: { ...scope, flowId: new Types.ObjectId() },
      overwrite: { ...overwrite, destinationId: "fixture-database-alias" },
    };
    await reserveRestEntityOverwrite(connection, scope, overwrite);
    await reserveRestEntityOverwrite(
      connection,
      competing.scope,
      competing.overwrite,
    );
    const retain = (owner: RestEntityOverwriteReservation) =>
      retainRestBigQueryTruncate(
        connection,
        owner.scope,
        owner.overwrite,
        {
          projectId: table.project,
          dataset: table.dataset,
          table: table.table,
          location: "EU",
        },
        { query: { useLegacySql: false, priority: "BATCH" } },
      );
    const resync = {
      workspaceId: scope.workspaceId.toHexString(),
      flowId: new Types.ObjectId().toHexString(),
      tables: [table],
    };
    const runResync = (reset: () => Promise<void>) =>
      withCdcResyncFence(
        resync,
        session => assertRetainedWritesDrainedForResync(resync, session),
        reset,
      );
    await runResync(async () => {
      await expect(retain(reservation)).rejects.toThrow(
        "A CDC resync is holding this flow or table",
      );
    });
    const reset = vi.fn(async () => undefined);
    const blocked = "CDC resync is blocked by an unsettled REST overwrite";
    const competingBlocked = "Another REST overwrite is holding this table";
    const [first, second] = await Promise.allSettled([
      retain(reservation),
      retain(competing),
    ]);
    const [accepted, refused, owner, waiter] =
      first.status === "fulfilled"
        ? ([first, second, reservation, competing] as const)
        : ([second, first, competing, reservation] as const);
    expect(refused).toMatchObject({
      status: "rejected",
      reason: { message: competingBlocked },
    });
    if (accepted.status !== "fulfilled") throw accepted.reason;
    const truncate = accepted.value;
    await expect(runResync(reset)).rejects.toThrow(blocked);
    await expect(retain(owner)).resolves.toEqual(truncate);
    await expect(
      recordRestBigQueryTruncateResult(connection, truncate, {
        jobReference: {
          projectId: truncate.job.project,
          location: truncate.job.location,
          jobId: truncate.job.id,
        },
        configuration: truncate.configuration,
        status: { state: "DONE" },
        statistics: { query: { statementType: "DELETE" } },
      }),
    ).resolves.toBe("succeeded");
    const manifest = {
      reservation: owner,
      sourceRows: 0,
      replacementFingerprints: [],
    };
    await expect(
      sealRestBigQueryOverwriteManifest(connection, manifest),
    ).resolves.toBe(true);
    await expect(runResync(reset)).rejects.toThrow(blocked);
    await expect(retain(waiter)).rejects.toThrow(competingBlocked);
    expect(reset).not.toHaveBeenCalled();
    await expect(
      settleRestBigQueryOverwriteManifest(connection, manifest),
    ).resolves.toBe(true);
    await runResync(reset);
    expect(reset).toHaveBeenCalledTimes(1);
    await expect(retain(waiter)).resolves.toMatchObject(waiter);
  });

  it.each([
    { coverage: "contiguous", start: 2 },
    { coverage: "overlapping", start: 1 },
    { coverage: "gapped", start: 3 },
    { coverage: "uncaptured", start: 2 },
  ])("checks $coverage REST ranges", async ({ coverage, start }) => {
    const {
      job,
      input,
      destination: fixtureDestination,
    } = makeIntent(`rest_replacement_${coverage}`);
    const destination = {
      ...fixtureDestination,
      table: `${fixtureDestination.table}_${coverage}`,
    };
    const scope = {
      workspaceId: new Types.ObjectId(),
      flowId: new Types.ObjectId(),
      sourceConnectionId: new Types.ObjectId(),
    };
    const overwrite = {
      runId: "rest-overwrite-run",
      entity: "recordings",
      destinationId: "fixture-database",
      destinationConnectionId: "fixture-connection",
      destinationDatabaseName: null,
      schema: destination.dataset,
      tableName: destination.table,
    };
    const binding = { job, input, destination };
    const options = {
      query: { useLegacySql: false, priority: "BATCH" },
    } as const;
    const hold = () =>
      holdBigQueryRestOverwriteInsert(binding, ["id", "body"], options, {
        scope,
        overwrite,
        sourceRowsBefore: 0,
        expectedRows: 2,
      });
    const pendingError = "requires a pending, unsealed REST overwrite";
    await expect(hold()).rejects.toThrow(pendingError);
    await reserveRestEntityOverwrite(mongoose.connection, scope, overwrite);
    binding.input = await captureFixture({ scope, overwrite }, 0, 2);
    await expect(hold()).resolves.toBe("held");
    const request = await readPendingBigQueryQueryRequest(job);
    expect(request?.configuration.query.query).toBe(
      `INSERT INTO \`proj\`.\`live\`.\`${destination.table}\` (\`id\`, \`body\`) SELECT \`id\`, \`body\` FROM \`proj\`.\`live\`.\`${binding.input.snapshot.table}\``,
    );
    const held = await readBigQueryStagedInput(job);
    if (!held) throw new Error("Missing held replacement");
    expect(held.intent).toMatchObject({
      input: binding.input,
      destination,
      restOverwrite: {
        workspaceId: scope.workspaceId.toHexString(),
        flowId: scope.flowId.toHexString(),
        sourceConnectionId: scope.sourceConnectionId.toHexString(),
        overwrite,
        sourceRowsBefore: 0,
        expectedRows: 2,
      },
    });
    const providerJob = { ...request, status: { state: "DONE" } };
    await expect(
      recordObservedBigQueryQueryResult(job, {
        ...providerJob,
        statistics: { query: { statementType: "MERGE" } },
      }),
    ).resolves.toBe(false);
    await expect(
      recordObservedBigQueryQueryResult(job, {
        ...providerJob,
        statistics: { query: { statementType: "INSERT" } },
      }),
    ).resolves.toBe(false);
    await expect(
      recordObservedBigQueryQueryResult(job, {
        ...providerJob,
        statistics: {
          query: { statementType: "INSERT", numDmlAffectedRows: "1" },
        },
      }),
    ).resolves.toBe(false);
    const getMetadata = vi.fn<() => Promise<[unknown]>>();
    const adapter = new BigQueryDestinationAdapter({
      destinationDatabaseId: overwrite.destinationId,
      workspaceId: String(scope.workspaceId),
      tableDestination: {
        connectionId: overwrite.destinationConnectionId,
        schema: destination.dataset,
        tableName: destination.table,
      },
    });
    const target = {
      bq: { job: () => ({ getMetadata }) },
      projectId: destination.project,
      dataset: destination.dataset,
      datasetLocation: job.location,
      destination: {
        _id: overwrite.destinationId,
        workspaceId: scope.workspaceId,
      },
    } as unknown as BigQueryTarget;
    const control = adapter["leaseJobControl"](target, destination.table);
    const ref = {
      jobId: job.id,
      location: job.location,
      intentFingerprint: held.fingerprint,
      reservedBeforeDispatch: true,
    };
    const wrongLocation = adapter["leaseJobControl"](
      { ...target, datasetLocation: "us" },
      destination.table,
    );
    await expect(wrongLocation.isReservedJobDone?.(ref)).resolves.toBe(false);
    expect(getMetadata).not.toHaveBeenCalled();
    const key = getSchemaCacheKey(
      destination.project,
      destination.dataset,
      destination.table,
    );
    const acquire = () =>
      acquireTableWriteLease(key, {
        jobs: control,
        path: "final",
        maxWaitMs: 0,
      });
    const original = await acquire();
    getMetadata.mockRejectedValue({ code: 404 });
    try {
      await original.reserveJob(ref);
    } finally {
      await original.release();
    }
    const expire = () =>
      CdcTableWriteLease.updateOne(
        { _id: key },
        { $set: { expiresAt: new Date(0) } },
        { writeConcern: { w: "majority" } },
      );
    const metadata = (numDmlAffectedRows: string) => ({
      ...providerJob,
      statistics: { query: { statementType: "INSERT", numDmlAffectedRows } },
    });
    await expire();
    getMetadata.mockResolvedValue([metadata("1")]);
    await expect(acquire()).rejects.toBeInstanceOf(TableWriteLeaseBusyError);
    expect((await readBigQueryStagedInput(job))?.terminal).toBeUndefined();
    await expire();
    getMetadata.mockResolvedValue([metadata("2")]);
    const recovered = await acquire();
    await recovered.release();
    expect((await readBigQueryStagedInput(job))?.terminal).toMatchObject({
      state: "DONE",
      outcome: "succeeded",
      affectedRows: 2,
    });
    expect(await readPendingBigQueryQueryRequest(job)).toBeNull();
    const replacement = await readBigQueryStagedInput(job);
    if (!replacement) throw new Error("Missing replacement fixture");
    const manifest = {
      reservation: { scope, overwrite },
      sourceRows: 2,
      replacementFingerprints: [replacement.fingerprint],
    };
    const verify = (candidate = manifest) =>
      verifyRestBigQueryOverwriteManifest(mongoose.connection, candidate);
    await expect(verify()).resolves.toBe(false);
    const truncate = await retainRestBigQueryTruncate(
      mongoose.connection,
      scope,
      overwrite,
      {
        projectId: destination.project,
        dataset: destination.dataset,
        location: job.location,
        table: destination.table,
      },
      options,
    );
    await expect(
      recordRestBigQueryTruncateResult(mongoose.connection, truncate, {
        jobReference: {
          projectId: truncate.job.project,
          location: truncate.job.location,
          jobId: truncate.job.id,
        },
        configuration: truncate.configuration,
        status: { state: "DONE" },
        statistics: { query: { statementType: "DELETE" } },
      }),
    ).resolves.toBe("succeeded");
    await expect(verify()).resolves.toBe(true);
    await expect(
      closeRestEntityAdmission(mongoose.connection, scope),
    ).rejects.toThrow("REST overwrite is still in flight");
    await expect(verify({ ...manifest, sourceRows: 3 })).resolves.toBe(false);
    await expect(
      verify({
        ...manifest,
        replacementFingerprints: [
          replacement.fingerprint,
          replacement.fingerprint,
        ],
      }),
    ).resolves.toBe(false);

    const seal = (candidate = manifest) =>
      sealRestBigQueryOverwriteManifest(mongoose.connection, candidate);
    const settle = (candidate = manifest) =>
      settleRestBigQueryOverwriteManifest(mongoose.connection, candidate);
    await expect(settle()).resolves.toBe(false);
    await expect(seal({ ...manifest, sourceRows: 3 })).resolves.toBe(false);

    const holdExtra = (extra: ReturnType<typeof makeIntent>) =>
      holdBigQueryRestOverwriteInsert(
        { ...binding, input: extra.input, job: extra.job },
        ["id", "body"],
        options,
        { scope, overwrite, sourceRowsBefore: start, expectedRows: 1 },
      );
    const extra = makeIntent(`rest_replacement_unlisted_${coverage}`);
    if (coverage !== "uncaptured") {
      extra.input = await captureFixture({ scope, overwrite }, start, 1);
    }
    const recordExtra = async () => {
      const pending = await readPendingBigQueryQueryRequest(extra.job);
      const retained = await readBigQueryStagedInput(extra.job);
      if (!pending || !retained) throw new Error("Missing extra replacement");
      manifest.sourceRows++;
      manifest.replacementFingerprints.push(retained.fingerprint);
      await expect(seal()).resolves.toBe(false);
      await expect(
        recordObservedBigQueryQueryResult(extra.job, {
          ...pending,
          status: { state: "DONE" },
          statistics: {
            query: { statementType: "INSERT", numDmlAffectedRows: "1" },
          },
        }),
      ).resolves.toBe(true);
    };
    if (coverage !== "contiguous") {
      await expect(holdExtra(extra)).resolves.toBe("held");
      await recordExtra();
      await expect(seal()).resolves.toBe(false);
      await expect(settle()).resolves.toBe(false);
      await expect(
        closeRestEntityAdmission(mongoose.connection, scope),
      ).rejects.toThrow("REST overwrite is still in flight");
      return;
    }
    const [sealedFirst, extraHeld] = await Promise.all([
      seal(),
      holdExtra(extra).then(
        () => true,
        error => {
          expect(error.message).toContain(pendingError);
          return false;
        },
      ),
    ]);
    expect(sealedFirst).not.toBe(extraHeld);

    if (extraHeld) {
      await expect(seal()).resolves.toBe(false);
      await recordExtra();
    }
    await expect(seal()).resolves.toBe(true);
    await expect(
      seal({
        ...manifest,
        replacementFingerprints: [
          ...manifest.replacementFingerprints,
        ].reverse(),
      }),
    ).resolves.toBe(true);
    await expect(hold()).resolves.toBe("terminal");
    const late = makeIntent("rest_replacement_after_seal");
    await expect(holdExtra(late)).rejects.toThrow(pendingError);
    await expect(readBigQueryStagedInput(late.job)).resolves.toBeNull();
    await expect(
      closeRestEntityAdmission(mongoose.connection, scope),
    ).rejects.toThrow("REST overwrite is still in flight");
    await expect(
      settle({ ...manifest, sourceRows: manifest.sourceRows + 1 }),
    ).resolves.toBe(false);
    await expect(
      settle({
        ...manifest,
        reservation: {
          scope: { ...scope, sourceConnectionId: new Types.ObjectId() },
          overwrite,
        },
      }),
    ).resolves.toBe(false);
    await expect(
      settle({
        ...manifest,
        reservation: {
          scope,
          overwrite: { ...overwrite, tableName: "wrong_destination" },
        },
      }),
    ).resolves.toBe(false);
    const pendingOverwrite = () =>
      hasPendingRestEntityOverwrite(mongoose.connection, scope, overwrite);
    await expect(pendingOverwrite()).resolves.toBe(true);
    await expect(settle()).resolves.toBe(true);
    await expect(pendingOverwrite()).resolves.toBe(false);
    await expect(admitRestEntity(mongoose.connection, scope)).resolves.toBe(
      false,
    );
    await expect(
      reserveRestEntityOverwrite(mongoose.connection, scope, overwrite),
    ).rejects.toThrow("already has a verified manifest");
    await expect(holdExtra(late)).rejects.toThrow(pendingError);
    await expect(
      closeRestEntityAdmission(mongoose.connection, scope),
    ).resolves.toBeUndefined();
    await expect(admitRestEntity(mongoose.connection, scope)).resolves.toBe(
      false,
    );
    await expect(settle()).resolves.toBe(true);
  });

  it("keeps the same staging snapshot time and job across an ambiguous submission", async () => {
    const scope = {
      workspaceId: new Types.ObjectId(),
      flowId: new Types.ObjectId(),
      sourceConnectionId: new Types.ObjectId(),
    };
    const source = {
      project: "proj",
      dataset: "rest_snapshot",
      table: "staging",
    };
    const overwrite = {
      runId: "snapshot-run",
      entity: "recordings",
      destinationId: new Types.ObjectId().toHexString(),
      destinationConnectionId: new Types.ObjectId().toHexString(),
      destinationDatabaseName: null,
      schema: source.dataset,
      tableName: "recordings",
    };
    const batch = {
      sourceRowsBefore: 10,
      source,
      asOf: new Date("2026-11-21T16:00:00.000Z"),
      expectedRows: 2,
    };
    let providerJob: unknown;
    let snapshotTable: string | undefined;
    let providerTime = batch.asOf.toISOString();
    const jobMetadata = vi.fn(async () => {
      if (!providerJob) throw { code: 404 };
      return [providerJob];
    });
    const tableMetadata = vi.fn(async () => [
      {
        type: "SNAPSHOT",
        tableReference: {
          projectId: source.project,
          datasetId: source.dataset,
          tableId: snapshotTable,
        },
        location: "EU",
        id: "synthetic-provider-table",
        etag: "synthetic-generation",
        creationTime: String(batch.asOf.getTime() + 1000),
        numRows: "2",
        snapshotDefinition: {
          baseTableReference: {
            projectId: source.project,
            datasetId: source.dataset,
            tableId: source.table,
          },
          snapshotTime: providerTime,
        },
      },
    ]);
    const createJob = vi.fn(
      async (submitted: {
        jobId: string;
        location: string;
        configuration: unknown;
      }) => {
        snapshotTable = `_${submitted.jobId}`;
        providerJob = {
          jobReference: {
            projectId: source.project,
            location: submitted.location,
            jobId: submitted.jobId,
          },
          configuration: submitted.configuration,
          status: { state: "DONE" },
          statistics: { query: { statementType: "CREATE_SNAPSHOT_TABLE" } },
        };
        throw { code: 503, message: "Lost snapshot acknowledgement" };
      },
    );
    const target = {
      bq: {
        createJob,
        job: () => ({ getMetadata: jobMetadata }),
        dataset: () => ({
          table: (table: string) => {
            expect(table).toBe(snapshotTable);
            return { getMetadata: tableMetadata };
          },
        }),
      },
      projectId: source.project,
      dataset: source.dataset,
      datasetLocation: "EU",
      destination: {
        _id: overwrite.destinationId,
        workspaceId: scope.workspaceId,
      },
    } as unknown as BigQueryTarget;
    const capture = (input = batch) =>
      captureRestBigQueryOverwriteSnapshot(
        mongoose.connection,
        target,
        { scope, overwrite },
        input,
        { query: { useLegacySql: false, priority: "BATCH" } },
      );
    await expect(capture()).rejects.toThrow(
      "requires a pending REST overwrite",
    );
    expect(jobMetadata).not.toHaveBeenCalled();
    await reserveRestEntityOverwrite(mongoose.connection, scope, overwrite);
    await expect(capture()).rejects.toMatchObject({ code: 503 });
    expect(createJob).toHaveBeenCalledTimes(1);
    const submitted = createJob.mock.calls[0]?.[0];
    expect(submitted).toMatchObject({
      jobId: expect.stringMatching(/^mako_rest_snapshot_/),
      location: "eu",
      configuration: {
        query: {
          query: `CREATE SNAPSHOT TABLE \`proj\`.\`rest_snapshot\`.\`${snapshotTable}\` CLONE \`proj\`.\`rest_snapshot\`.\`staging\` FOR SYSTEM_TIME AS OF TIMESTAMP_MILLIS(${batch.asOf.getTime()})`,
        },
      },
    });
    await expect(
      capture({ ...batch, asOf: new Date(batch.asOf.getTime() + 1) }),
    ).rejects.toThrow("snapshot batch changed");
    await expect(capture({ ...batch, expectedRows: 3 })).rejects.toThrow(
      "snapshot batch changed",
    );
    expect(createJob).toHaveBeenCalledTimes(1);
    providerTime = new Date(batch.asOf.getTime() + 1).toISOString();
    await expect(capture()).rejects.toThrow(
      "does not match the retained staging version",
    );
    providerTime = batch.asOf.toISOString();
    const captured = await capture();
    expect(captured).toMatchObject({
      input: { snapshot: { ...source, table: snapshotTable } },
      rows: 2,
      baseTable: source,
      asOf: providerTime,
    });
    jobMetadata.mockClear();
    tableMetadata.mockClear();
    await expect(capture()).resolves.toEqual(captured);
    expect(jobMetadata).not.toHaveBeenCalled();
    expect(tableMetadata).not.toHaveBeenCalled();
    expect(createJob).toHaveBeenCalledTimes(1);
  });

  it.each([0, 1])("dispatch checks range %i", async start => {
    const fixture = makeIntent(`rest_replacement_dispatch_${start}`);
    const { job, destination } = fixture;
    destination.table = `replacement_dispatch_${start}`;
    const snapshot = { ...destination, table: "" };
    const sourceTable = "staging_recordings";
    const scope = {
      workspaceId: new Types.ObjectId(),
      flowId: new Types.ObjectId(),
      sourceConnectionId: new Types.ObjectId(),
    };
    const overwrite = {
      runId: "replacement-dispatch",
      entity: "recordings",
      destinationId: new Types.ObjectId().toHexString(),
      destinationConnectionId: new Types.ObjectId().toHexString(),
      destinationDatabaseName: null,
      schema: destination.dataset,
      tableName: destination.table,
    };
    const table = {
      type: "SNAPSHOT",
      tableReference: {
        projectId: snapshot.project,
        datasetId: snapshot.dataset,
        tableId: snapshot.table,
      },
      location: "EU",
      id: "synthetic-snapshot",
      etag: "original-generation",
      creationTime: "1720000000000",
      numRows: "2",
      snapshotDefinition: {
        baseTableReference: {
          projectId: snapshot.project,
          datasetId: snapshot.dataset,
          tableId: sourceTable,
        },
        snapshotTime: "2024-07-03T09:46:40Z",
      },
    };
    const readTable = vi.fn(async () => [table]);
    const providerJobs = new Map<string, unknown>();
    const getMetadata = vi.fn(async (id: string) => {
      if (providerJobs.has(id)) return [providerJobs.get(id)];
      throw { code: 404 };
    });
    const createJob = vi.fn(
      async (submitted: {
        jobId: string;
        location: string;
        configuration: unknown;
      }) => {
        const isSnapshot = submitted.jobId.startsWith("mako_rest_snapshot_");
        if (isSnapshot) {
          snapshot.table = `_${submitted.jobId}`;
          table.tableReference.tableId = snapshot.table;
        }
        providerJobs.set(submitted.jobId, {
          jobReference: {
            projectId: job.project,
            jobId: submitted.jobId,
            location: submitted.location,
          },
          configuration: structuredClone(submitted.configuration),
          status: { state: "DONE" },
          statistics: {
            query: isSnapshot
              ? { statementType: "CREATE_SNAPSHOT_TABLE" }
              : { statementType: "INSERT", numDmlAffectedRows: "2" },
          },
        });
        if (isSnapshot) return;
        throw { code: 503, message: "Lost submission acknowledgement" };
      },
    );
    const target = {
      bq: {
        dataset: (name: string) => {
          expect(name).toBe(snapshot.dataset);
          return {
            table: (name: string) => {
              expect(name).toBe(snapshot.table);
              return { getMetadata: readTable };
            },
          };
        },
        job: (id: string) => ({ getMetadata: () => getMetadata(id) }),
        createJob,
      },
      projectId: destination.project,
      dataset: destination.dataset,
      datasetLocation: job.location,
      destination: {
        _id: overwrite.destinationId,
        workspaceId: scope.workspaceId,
      },
    } as unknown as BigQueryTarget;
    const reservation = { scope, overwrite };
    await reserveRestEntityOverwrite(mongoose.connection, scope, overwrite);
    const query = {
      query: { useLegacySql: false, priority: "BATCH" },
    } as const;
    const captured = await captureRestBigQueryOverwriteSnapshot(
      mongoose.connection,
      target,
      reservation,
      {
        sourceRowsBefore: start,
        source: { ...snapshot, table: sourceTable },
        asOf: new Date(table.snapshotDefinition.snapshotTime),
        expectedRows: 2,
      },
      query,
    );
    if (!captured) throw new Error("Missing captured snapshot");
    expect(captured.rows).toBe(2);
    getMetadata.mockClear();
    readTable.mockClear();
    createJob.mockClear();
    await holdBigQueryRestOverwriteInsert(
      { job, destination, input: captured.input },
      ["id", "body"],
      query,
      { ...reservation, sourceRowsBefore: 0, expectedRows: captured.rows },
    );
    const held = await readBigQueryStagedInput(job);
    if (!held) throw new Error("Missing retained replacement");
    const ref = {
      jobId: job.id,
      location: job.location,
      intentFingerprint: held.fingerprint,
      reservedBeforeDispatch: true,
    };
    const dispatch = () =>
      dispatchRestBigQueryReplacement(
        target,
        destination.table,
        {
          connectionId: overwrite.destinationConnectionId,
          databaseName: overwrite.destinationDatabaseName,
        },
        ref,
      );
    await expect(dispatch()).rejects.toThrow("requires its table lease");
    expect(getMetadata).not.toHaveBeenCalled();

    const adapter = new BigQueryDestinationAdapter({
      destinationDatabaseId: overwrite.destinationId,
      workspaceId: String(scope.workspaceId),
      tableDestination: {
        connectionId: overwrite.destinationConnectionId,
        schema: destination.dataset,
        tableName: destination.table,
      },
    });
    const key = getSchemaCacheKey(
      destination.project,
      destination.dataset,
      destination.table,
    );
    const lease = await acquireTableWriteLease(key, {
      jobs: adapter["leaseJobControl"](target, destination.table),
      path: "final",
      maxWaitMs: 0,
    });
    try {
      await lease.reserveJob(ref);
      if (start !== 0) {
        await expect(dispatch()).rejects.toThrow(
          "no capture for its source range",
        );
        await expect(
          adapter["leaseJobControl"](
            target,
            destination.table,
          ).isReservedJobDone?.(ref),
        ).resolves.toBe(false);
        expect(getMetadata).not.toHaveBeenCalled();
        expect(readTable).not.toHaveBeenCalled();
        expect(createJob).not.toHaveBeenCalled();
        return;
      }
      readTable.mockResolvedValueOnce([
        { ...table, etag: "replacement-generation" },
      ]);
      await expect(dispatch()).rejects.toThrow("input snapshot changed");
      readTable.mockResolvedValueOnce([{ ...table, numRows: "3" }]);
      await expect(dispatch()).rejects.toThrow("input snapshot changed");
      expect(createJob).not.toHaveBeenCalled();
      await expect(dispatch()).rejects.toMatchObject({ code: 503 });
      expect(createJob).toHaveBeenCalledExactlyOnceWith({
        jobId: job.id,
        location: job.location,
        configuration: held.intent.configuration,
      });
      await expect(dispatch()).resolves.toBe("succeeded");
      await expect(dispatch()).resolves.toBe("succeeded");
      expect(createJob).toHaveBeenCalledTimes(1);
      expect((await readBigQueryStagedInput(job))?.terminal).toMatchObject({
        fingerprint: held.fingerprint,
        state: "DONE",
        outcome: "succeeded",
        affectedRows: 2,
      });
    } finally {
      await lease.release();
      if (start !== 0) {
        const heldLease = await CdcTableWriteLease.findOneAndDelete({
          _id: key,
          jobId: job.id,
        });
        expect(heldLease).not.toBeNull();
      }
    }
    expect(await CdcTableWriteLease.exists({ _id: key })).toBeNull();
    await expect(
      closeRestEntityAdmission(mongoose.connection, scope),
    ).rejects.toThrow("REST overwrite is still in flight");
  });

  it("recovers leased REST truncate and replacement through the adapter", async () => {
    const scope = {
      workspaceId: new Types.ObjectId(),
      flowId: new Types.ObjectId(),
      sourceConnectionId: new Types.ObjectId(),
    };
    const destinationId = new Types.ObjectId().toHexString();
    const overwrite = {
      runId: "adapter-run",
      entity: "contacts",
      destinationId,
      destinationConnectionId: destinationId,
      destinationDatabaseName: null,
      schema: "lease_recovery",
      tableName: "contacts",
    };
    const reservation = { scope, overwrite };
    const tableKey = getSchemaCacheKey(
      "project",
      overwrite.schema,
      overwrite.tableName,
    );
    const layout = buildCdcEntityLayout({
      entity: overwrite.entity,
      tableName: overwrite.tableName,
      writeMode: "overwrite",
    });
    await reserveRestEntityOverwrite(mongoose.connection, scope, overwrite);

    const jobs = new Map<string, unknown>();
    let canRead = false;
    let liveTableExists = true;
    let stageRows = 1;
    const stageTime = Date.parse("2026-11-21T16:00:00.000Z");
    const stageTable = bigQueryStagingTableName(
      overwrite.tableName,
      scope.flowId.toHexString(),
    );
    const createJob = vi.fn(
      async (request: {
        jobId: string;
        location: string;
        configuration: unknown;
      }) => {
        const snapshot = request.jobId.startsWith("mako_rest_snapshot_");
        const insert = request.jobId.startsWith("mako_rest_replacement_");
        if (!snapshot) {
          expect(
            await CdcTableWriteLease.findById(tableKey).lean(),
          ).toMatchObject({
            jobId: request.jobId,
            jobLocation: request.location,
            jobReservedBeforeDispatch: true,
            jobIntentFingerprint: expect.any(String),
          });
        }
        jobs.set(request.jobId, {
          jobReference: {
            projectId: "project",
            location: request.location,
            jobId: request.jobId,
          },
          configuration: request.configuration,
          status: { state: "DONE" },
          statistics: {
            query: snapshot
              ? { statementType: "CREATE_SNAPSHOT_TABLE" }
              : insert
                ? { statementType: "INSERT", numDmlAffectedRows: "2" }
                : { statementType: "DELETE" },
          },
        });
        if (snapshot) return;
        throw Object.assign(new Error("ambiguous submit"), { code: 503 });
      },
    );
    const provider = {
      projectId: "project",
      dataset: overwrite.schema,
      datasetLocation: "EU",
      destination: {
        _id: destinationId,
        workspaceId: scope.workspaceId,
        connection: {},
      },
      bq: {
        dataset: () => ({
          table: (tableId: string) => ({
            exists: async () => [liveTableExists],
            getMetadata: async () =>
              tableId === stageTable
                ? [
                    {
                      numRows: String(stageRows),
                      lastModifiedTime: String(stageTime),
                    },
                  ]
                : [
                    {
                      type: "SNAPSHOT",
                      tableReference: {
                        projectId: "project",
                        datasetId: overwrite.schema,
                        tableId,
                      },
                      location: "EU",
                      id: tableId,
                      etag: "adapter-generation",
                      creationTime: String(stageTime + 1000),
                      numRows: "2",
                      snapshotDefinition: {
                        baseTableReference: {
                          projectId: "project",
                          datasetId: overwrite.schema,
                          tableId: stageTable,
                        },
                        snapshotTime: new Date(stageTime).toISOString(),
                      },
                    },
                  ],
          }),
        }),
        createJob,
        job: (id: string) => ({
          getMetadata: async () => {
            const metadata = canRead && jobs.get(id);
            if (!metadata) {
              throw Object.assign(new Error("missing job"), { code: 404 });
            }
            return [metadata];
          },
        }),
      },
    } as unknown as BigQueryTarget;
    const adapter = new BigQueryDestinationAdapter({
      destinationDatabaseId: destinationId,
      workspaceId: scope.workspaceId.toHexString(),
      tableDestination: {
        connectionId: destinationId,
        schema: overwrite.schema,
        tableName: overwrite.tableName,
      },
    });
    (
      adapter as unknown as { _resolvedClient: BigQueryTarget }
    )._resolvedClient = provider;

    const replace = () =>
      adapter.mergeFromStaging(
        layout,
        { _id: scope.flowId, dataSourceId: scope.sourceConnectionId },
        scope.flowId.toHexString(),
        undefined,
        {
          restBigQueryOverwrite: {
            reservation,
            sourceRowsBefore: 0,
            expectedRows: 2,
          },
        },
      );
    await expect(replace()).rejects.toThrow("requires its completed truncate");

    await expect(
      adapter.truncateLiveTable(layout, reservation),
    ).rejects.toThrow("ambiguous submit");
    expect(await CdcTableWriteLease.findById(tableKey).lean()).toMatchObject({
      jobReservedBeforeDispatch: true,
    });
    canRead = true;
    await expect(
      adapter.truncateLiveTable(layout, reservation),
    ).resolves.toBeUndefined();
    await expect(
      adapter.truncateLiveTable(layout, reservation),
    ).resolves.toBeUndefined();
    expect(createJob).toHaveBeenCalledTimes(1);
    await expect(
      closeRestEntityAdmission(mongoose.connection, scope),
    ).rejects.toThrow("REST overwrite is still in flight");

    await CdcTableWriteLease.updateOne(
      { _id: tableKey },
      { $set: { expiresAt: new Date(0) } },
    );
    const successor = await acquireTableWriteLease(tableKey, {
      path: "truncate",
      jobs: {
        isDone: async () => false,
        isReservedJobDone: job =>
          settleReservedBigQueryRestTruncate(
            mongoose.connection,
            provider,
            overwrite.tableName,
            job,
          ),
        cancel: async () => undefined,
      },
    });
    await successor.release();
    expect(await CdcTableWriteLease.exists({ _id: tableKey })).toBeNull();

    const query = vi
      .spyOn(databaseConnectionService, "executeQuery")
      .mockResolvedValue({
        success: true,
        data: [stageTable, overwrite.tableName].map(table_name => ({
          table_name,
          column_name: "id",
          data_type: "STRING",
        })),
      });
    try {
      await expect(replace()).rejects.toThrow(
        "staging metadata does not match",
      );
      expect(createJob).toHaveBeenCalledTimes(1);
      stageRows = 2;
      await expect(replace()).rejects.toThrow("ambiguous submit");
      expect(createJob).toHaveBeenCalledTimes(3);
      query.mockClear();
      stageRows = 0;
      await expect(replace()).resolves.toEqual({ written: 2 });
      await expect(replace()).resolves.toEqual({ written: 2 });
      expect(query).not.toHaveBeenCalled();
      expect(createJob).toHaveBeenCalledTimes(3);
    } finally {
      query.mockRestore();
    }

    await CdcTableWriteLease.updateOne(
      { _id: tableKey },
      { $set: { expiresAt: new Date(0) } },
    );
    const afterReplacement = await acquireTableWriteLease(tableKey, {
      path: "final",
      jobs: adapter["leaseJobControl"](provider, overwrite.tableName),
    });
    await afterReplacement.release();

    const writes = await readBigQueryRestOverwriteWrites(reservation);
    const manifest = {
      reservation,
      sourceRows: 2,
      replacementFingerprints: writes.map(write => write.fingerprint),
    };
    const fetchState = {
      hasMore: false,
      totalProcessed: 2,
      iterationsInChunk: 1,
      metadata: { offset: 2 },
    };
    const sealed = { ...manifest, fetchState };
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(
        sealRestBigQueryOverwriteManifest(mongoose.connection, sealed),
      ).resolves.toBe(true);
    }
    await expect(
      sealRestBigQueryOverwriteManifest(mongoose.connection, {
        ...manifest,
        fetchState: { ...fetchState, metadata: { offset: 1 } },
      }),
    ).resolves.toBe(false);
    await expect(
      closeRestEntityAdmission(mongoose.connection, scope),
    ).rejects.toThrow("REST overwrite is still in flight");
    await expect(
      readVerifiedRestBigQueryOverwriteManifest(
        mongoose.connection,
        reservation,
      ),
    ).resolves.toEqual(sealed);
    await expect(
      closeRestEntityAdmission(mongoose.connection, scope),
    ).rejects.toThrow("REST overwrite is still in flight");
    await expect(
      settleRestBigQueryOverwriteManifest(mongoose.connection, sealed),
    ).resolves.toBe(true);
    await expect(
      readVerifiedRestBigQueryOverwriteManifest(
        mongoose.connection,
        reservation,
      ),
    ).resolves.toEqual(manifest);

    const firstWrite = {
      scope: { ...scope, sourceConnectionId: new Types.ObjectId() },
      overwrite: { ...overwrite, runId: "absent-table" },
    };
    await reserveRestEntityOverwrite(
      mongoose.connection,
      firstWrite.scope,
      firstWrite.overwrite,
    );
    liveTableExists = false;
    await expect(
      adapter.truncateLiveTable(layout, firstWrite),
    ).resolves.toBeUndefined();
    expect(await CdcTableWriteLease.exists({ _id: tableKey })).toBeNull();
    liveTableExists = true;
    await expect(
      adapter.truncateLiveTable(layout, firstWrite),
    ).resolves.toBeUndefined();
    expect(createJob).toHaveBeenCalledTimes(3);
  });

  it("retains one provider request under the original REST source and grants", async () => {
    const database = mongoose.connection.db;
    if (!database) throw new Error("Synthetic MongoDB is not connected");
    const scope = {
      workspaceId: new Types.ObjectId(),
      flowId: new Types.ObjectId(),
      sourceConnectionId: new Types.ObjectId(),
    };
    const source = {
      _id: scope.sourceConnectionId,
      workspaceId: scope.workspaceId,
      type: "rest",
      managers: ["synthetic-manager"],
      liveReads: true,
      liveReaders: [{ principal: "synthetic-reader" }],
      writers: [{ principal: "synthetic-writer" }],
    };
    const sources = database.collection("connectors");
    await sources.insertOne(source);
    const overwrite = {
      runId: "original-run",
      entity: "recordings",
      destinationId: new Types.ObjectId().toHexString(),
      destinationDatabaseName: null,
      destinationConnectionId: new Types.ObjectId().toHexString(),
      schema: "live",
      tableName: "recordings",
    };
    const target = {
      projectId: "proj",
      dataset: "live",
      location: "EU",
      table: "recordings",
    };
    const options = {
      query: { useLegacySql: false, priority: "BATCH" },
    } as const;
    const retain = () =>
      retainRestBigQueryTruncate(
        mongoose.connection,
        scope,
        overwrite,
        target,
        options,
      );
    await expect(retain()).rejects.toThrow("requires a pending REST overwrite");
    await reserveRestEntityOverwrite(mongoose.connection, scope, overwrite);
    const record = await retain();
    expect(await retain()).toEqual(record);
    expect(record.overwrite).toEqual(overwrite);
    expect(record.scope).toEqual(scope);
    expect(record.configuration.query.query).toBe(
      "DELETE FROM `proj`.`live`.`recordings` WHERE TRUE",
    );

    const completed = {
      jobReference: { projectId: "proj", location: "EU", jobId: record.job.id },
      configuration: record.configuration,
      status: { state: "DONE" },
      statistics: { query: { statementType: "DELETE" } },
    };
    await expect(
      recordRestBigQueryTruncateResult(mongoose.connection, record, {
        ...completed,
        jobReference: {
          ...completed.jobReference,
          projectId: "another-project",
        },
      }),
    ).resolves.toBeNull();
    expect((await retain()).terminal).toBeUndefined();
    await expect(
      recordRestBigQueryTruncateResult(
        mongoose.connection,
        {
          ...record,
          fingerprint: "different-reservation",
        },
        completed,
      ),
    ).resolves.toBeNull();
    const getMetadata = vi
      .fn()
      .mockRejectedValueOnce({ code: 404 })
      .mockRejectedValueOnce({ code: 404 })
      .mockRejectedValueOnce({ code: 404 })
      .mockResolvedValue([completed]);
    const createJob = vi
      .fn()
      .mockRejectedValueOnce({ code: 503 })
      .mockRejectedValueOnce({ code: 409 });
    const provider = {
      projectId: target.projectId,
      dataset: target.dataset,
      datasetLocation: target.location,
      destination: {
        _id: overwrite.destinationId,
        workspaceId: scope.workspaceId,
      },
      bq: { job: () => ({ getMetadata }), createJob },
    } as unknown as BigQueryTarget;
    const dispatch = () =>
      dispatchRestBigQueryTruncate(mongoose.connection, provider, record);
    await expect(dispatch()).rejects.toThrow(
      "requires its table and REST reservations",
    );
    expect(getMetadata).not.toHaveBeenCalled();
    expect(createJob).not.toHaveBeenCalled();

    const tableKey = getSchemaCacheKey(
      target.projectId,
      target.dataset,
      target.table,
    );
    const lease = await acquireTableWriteLease(tableKey, {
      path: "final",
      jobs: {
        isDone: async () => false,
        isReservedJobDone: job =>
          settleReservedBigQueryRestTruncate(
            mongoose.connection,
            provider,
            target.table,
            job,
          ),
        cancel: async () => undefined,
      },
    });
    try {
      const jobRef = {
        jobId: record.job.id,
        location: record.job.location,
        intentFingerprint: record.fingerprint,
        reservedBeforeDispatch: true,
      };
      await lease.reserveJob(jobRef);
      await expect(dispatch()).rejects.toMatchObject({ code: 503 });
      expect((await retain()).terminal).toBeUndefined();
      await expect(
        settleReservedBigQueryRestTruncate(
          mongoose.connection,
          provider,
          target.table,
          jobRef,
        ),
      ).resolves.toBe(false);
      await expect(dispatch()).resolves.toBe("succeeded");
      getMetadata.mockClear();
      await expect(dispatch()).resolves.toBe("succeeded");
      expect(getMetadata).not.toHaveBeenCalled();
      const exactOptions = {
        jobId: record.job.id,
        location: record.job.location,
        configuration: record.configuration,
      };
      expect(createJob.mock.calls).toEqual([[exactOptions], [exactOptions]]);
    } finally {
      await lease.release();
    }
    expect(await CdcTableWriteLease.exists({ _id: tableKey })).toBeNull();
    expect((await retain()).terminal).toBe("succeeded");
    await expect(
      closeRestEntityAdmission(mongoose.connection, scope),
    ).rejects.toThrow("REST overwrite is still in flight");
    expect(await sources.findOne({ _id: source._id })).toEqual(source);
  });

  it.each(["DELETE", "INSERT"] as const)(
    "accepts only the exact terminal %s under the reserved provider identity",
    statementType => {
      const job = { project: "proj", location: "eu", id: "rest_run" };
      const sql =
        statementType === "DELETE"
          ? "DELETE FROM `proj`.`live`.`recordings` WHERE TRUE"
          : "INSERT INTO `proj`.`live`.`recordings` SELECT * FROM `proj`.`stage`.`sealed_input`";
      const configuration = {
        query: {
          query: sql,
          useLegacySql: false as const,
          priority: "BATCH" as const,
        },
      };
      const completed = {
        jobReference: { projectId: job.project, location: "EU", jobId: job.id },
        configuration,
        status: { state: "DONE" },
        statistics: { query: { statementType } },
      };
      expect(
        retainedQueryOutcome(job, configuration, completed, statementType),
      ).toBe("succeeded");
      expect(retainedQueryOutcome(job, configuration, completed)).toBeNull();
      expect(
        retainedQueryOutcome(
          job,
          configuration,
          {
            ...completed,
            configuration: {
              query: {
                ...configuration.query,
                query: sql.replace("`live`", "`other`"),
              },
            },
          },
          statementType,
        ),
      ).toBeNull();
      expect(
        retainedQueryOutcome(
          job,
          configuration,
          {
            ...completed,
            jobReference: { ...completed.jobReference, jobId: "another_run" },
          },
          statementType,
        ),
      ).toBeNull();
      expect(
        retainedQueryOutcome(
          job,
          configuration,
          {
            ...completed,
            status: { state: "RUNNING" },
          },
          statementType,
        ),
      ).toBeNull();
    },
  );
});

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

function sealFixtureSnapshot({
  job,
  input,
}: ReturnType<typeof makeMerge>["binding"]) {
  const { snapshot } = input;
  const metadata = {
    type: "SNAPSHOT",
    location: job.location,
    tableReference: {
      projectId: snapshot.project,
      datasetId: snapshot.dataset,
      tableId: snapshot.table,
    },
    creationTime: "1795276800000",
    etag: "sealed-generation",
    snapshotDefinition: {
      baseTableReference: {
        projectId: snapshot.project,
        datasetId: snapshot.dataset,
        tableId: "staging",
      },
      snapshotTime: "2026-11-21T16:00:00.000Z",
    },
  };
  const generation = bigQuerySnapshotGeneration(
    snapshot,
    job.location,
    metadata,
  );
  if (!generation) throw new Error("Missing snapshot generation");
  input.generation = generation;
  return metadata;
}

async function makeCdcMerge(suffix: string, dataset = "live") {
  const { binding, merge, options } = makeMerge(suffix);
  binding.destination.dataset = dataset;
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

async function makeResyncFlow(suffix: string, dataset: string) {
  const fixture = await makeCdcMerge(suffix, dataset);
  const { workspaceId, flowId, destinationConnectionId } = fixture.scope;
  await DatabaseConnection.create({
    _id: destinationConnectionId,
    workspaceId,
    name: "Synthetic resync connection",
    type: "bigquery",
    connection: { project_id: fixture.binding.destination.project },
    createdBy: "synthetic-test",
  });
  const flow = await Flow.findByIdAndUpdate(
    flowId,
    { $set: { entityFilter: ["recordings"] } },
    { returnDocument: "after" },
  );
  if (!flow) throw new Error("Missing synthetic resync flow");
  return { ...fixture, flow };
}

describe("BigQuery CDC event settlement", () => {
  it("seals exact CDC rows from one load and one copy across lost acknowledgements", async () => {
    const target = await makeCdcMerge("sealed_replay_input", "sealed_target");
    const readyAt = new Date("2026-11-21T18:00:00.000Z");
    const eventId = "synthetic-sealed-input-provider-event";
    const origin = {
      _id: new Types.ObjectId(),
      workspaceId: new Types.ObjectId(target.scope.workspaceId),
      flowId: new Types.ObjectId(),
      dataSourceId: new Types.ObjectId(),
      eventId,
      eventType: "recording_added",
      receivedAt: readyAt,
      status: "dormant",
      applyStatus: "dormant",
      rawPayload: { eventId },
    };
    await WebhookEvent.collection.insertOne(origin);
    const expectedRows = [
      { id: "rec-a", title: "First" },
      { id: "rec-b", title: "Second" },
    ];
    const tag = createHash("sha256").update(eventId).digest("hex");
    const events = await Promise.all(
      expectedRows.map(async ({ id, title }, index) => {
        const row = await target.event(id, index + 1);
        await CdcChangeEvent.updateOne(
          { _id: row.id },
          {
            $set: {
              webhookEventId: String(origin._id),
              payload: { id: "payload-id-must-not-win", title },
            },
          },
        );
        return {
          id: row.id,
          deliveryKey: bigQueryReplayDeliveryKey(tag, id),
          originalReceipt: {
            id: String(origin._id),
            flowId: String(origin.flowId),
            sourceConnectionId: String(origin.dataSourceId),
            eventIdSha256: tag,
            receivedAt: readyAt.toISOString(),
            recordId: id,
          },
        };
      }),
    );
    const cdc = { scope: target.scope, events };
    const { job: mergeJob, destination } = target.binding;
    const jobs = new Map<string, unknown>();
    const notFound = Object.assign(new Error("not found"), { code: 404 });
    const loadEnd = readyAt.valueOf() + 500;
    const copyEnd = loadEnd + 1000;
    let upload:
      | { bytes: Buffer; jobId: string; labels: unknown; table: string }
      | undefined;
    let snapshot: unknown;
    let defaultTableExpirationMs: string | undefined = "86400000";
    const copy = vi.fn(
      async (request: {
        jobId: string;
        configuration: {
          copy: { sourceTables: unknown[]; destinationTable: unknown };
        };
      }) => {
        expect(request.configuration.copy).toMatchObject({
          operationType: "SNAPSHOT",
          writeDisposition: "WRITE_EMPTY",
        });
        throw new Error("Simulated lost copy acknowledgement");
      },
    );
    const uploadStream = vi.fn(
      (table: string, metadata: Record<string, unknown>) => {
        const chunks: Buffer[] = [];
        return new Writable({
          write: (chunk, _encoding, done) => {
            chunks.push(Buffer.from(chunk));
            done();
          },
          final: done => {
            upload = {
              bytes: Buffer.concat(chunks),
              jobId: String(metadata.jobId),
              labels: metadata.labels,
              table,
            };
            done(new Error("Simulated lost upload acknowledgement"));
          },
        });
      },
    );
    const bq = {
      makeAuthenticatedRequest: () => undefined,
      createJob: copy,
      job: (id: string) => ({
        getMetadata: async () => {
          if (!jobs.has(id)) throw notFound;
          return [jobs.get(id)];
        },
      }),
      dataset: () => ({
        getMetadata: async () => [{ defaultTableExpirationMs }],
        table: (table: string) => ({
          createWriteStream: (metadata: Record<string, unknown>) =>
            uploadStream(table, metadata),
          getMetadata: async () => {
            if (!snapshot) throw notFound;
            return [snapshot];
          },
        }),
      }),
    };
    enableLoadJobLabels(bq);
    const adapter = new BigQueryDestinationAdapter({
      destinationDatabaseId: target.scope.destinationConnectionId,
      workspaceId: target.scope.workspaceId,
      tableDestination: {
        connectionId: target.scope.destinationConnectionId,
        schema: destination.dataset,
        tableName: destination.table,
      },
    });
    (adapter as unknown as { _resolvedClient: unknown })._resolvedClient = {
      bq,
      projectId: destination.project,
      dataset: destination.dataset,
      datasetLocation: mergeJob.location,
      destination: {
        _id: target.scope.destinationConnectionId,
        workspaceId: target.scope.workspaceId,
        type: "bigquery",
      },
    };
    const prepare = () =>
      adapter.prepareRetainedReplayInput({
        mergeJob,
        cdc,
        stagedAt: readyAt,
        layout: buildCdcEntityLayout({
          entity: target.scope.entity,
          tableName: destination.table,
        }),
      });
    await expect(prepare()).rejects.toThrow("without automatic table expiry");
    expect(uploadStream).not.toHaveBeenCalled();
    defaultTableExpirationMs = undefined;
    await expect(prepare()).resolves.toEqual({
      state: "pending",
      phase: "load",
    });
    if (!upload) throw new Error("Missing retained Parquet upload");
    const sent = upload;
    const digest = createHash("sha256").update(sent.bytes).digest("hex");
    expect(sent.labels).toEqual({
      replay_input: digest.slice(0, 32),
      replay_input_hash: digest.slice(32),
    });
    const tempDir = await mkdtemp(join(tmpdir(), "claap-replay-input-"));
    const file = join(tempDir, "sealed.parquet");
    const db = await DuckDBInstance.create(":memory:");
    const conn = await db.connect();
    try {
      await writeFile(file, sent.bytes);
      const reader = await conn.runAndReadAll(
        `SELECT id, title FROM read_parquet('${file.replace(/'/g, "''")}') ORDER BY id`,
      );
      expect(reader.getRowObjects()).toEqual(expectedRows);
    } finally {
      conn.closeSync();
      db.closeSync();
      await rm(file, { force: true });
      await rmdir(tempDir);
    }
    const jobRef = (jobId: string) => ({
      projectId: mergeJob.project,
      location: mergeJob.location,
      jobId,
    });
    const sourceTable = {
      projectId: destination.project,
      datasetId: destination.dataset,
      tableId: sent.table,
    };
    await expect(
      mongoose.connection.transaction(session =>
        assertRetainedWritesDrainedForResync(
          {
            workspaceId: target.scope.workspaceId,
            flowId: target.scope.flowId,
            tables: [{ ...destination, table: sent.table }],
          },
          session,
        ),
      ),
    ).rejects.toThrow("retained replay input table");
    const load = {
      jobReference: jobRef(sent.jobId),
      status: { state: "DONE" },
      configuration: {
        load: {
          destinationTable: sourceTable,
          sourceFormat: "PARQUET",
          writeDisposition: "WRITE_EMPTY",
          createDisposition: "CREATE_IF_NEEDED",
        },
        labels: sent.labels,
      },
      statistics: {
        endTime: String(loadEnd),
        load: {
          inputFiles: "1",
          inputFileBytes: String(sent.bytes.length),
          outputRows: "1",
        },
      },
    };
    await mongoose.disconnect();
    await mongoose.connect(mongo.getUri());
    await expect(prepare()).resolves.toEqual({
      state: "pending",
      phase: "load",
    });
    jobs.set(sent.jobId, load);
    await expect(prepare()).rejects.toThrow("load counts differ");
    expect(copy).not.toHaveBeenCalled();
    load.statistics.load.outputRows = "2";
    await expect(prepare()).resolves.toEqual({
      state: "pending",
      phase: "copy",
    });
    await expect(prepare()).resolves.toEqual({
      state: "pending",
      phase: "copy",
    });
    expect(uploadStream).toHaveBeenCalledTimes(1);
    expect(copy).toHaveBeenCalledTimes(1);
    const request = copy.mock.calls[0]?.[0];
    if (!request) throw new Error("Missing snapshot copy request");
    const snapshotTable = request.configuration.copy.destinationTable;
    const copyReceipt = {
      ...request,
      jobReference: jobRef(request.jobId),
      status: { state: "DONE" },
      statistics: { endTime: String(copyEnd) },
    };
    jobs.set(request.jobId, {
      ...copyReceipt,
      configuration: {
        copy: {
          ...request.configuration.copy,
          sourceTables: [{ ...sourceTable, tableId: "different" }],
        },
      },
    });
    await expect(prepare()).rejects.toThrow("copy job differs");
    jobs.set(request.jobId, copyReceipt);
    snapshot = {
      type: "SNAPSHOT",
      tableReference: snapshotTable,
      location: mergeJob.location,
      creationTime: String(copyEnd),
      etag: "sealed-input-fixture",
      expirationTime: String(copyEnd + 1_000),
      numRows: "2",
      snapshotDefinition: {
        baseTableReference: sourceTable,
        snapshotTime: new Date(loadEnd + 1).toISOString(),
      },
    };
    await expect(prepare()).rejects.toThrow("snapshot metadata differs");
    snapshot = {
      ...(snapshot as Record<string, unknown>),
      expirationTime: undefined,
    };
    const sealed = await prepare();
    if (sealed.state !== "ready") {
      throw new Error("Missing retained input seal");
    }
    const plan = {
      expectedRecords: expectedRows.map(row => ({
        entity: target.scope.entity,
        recordId: row.id,
      })),
      jobs: [
        {
          binding: { ...target.binding, input: sealed.input },
          merge: {
            ...target.merge,
            columns: [...target.merge.columns, "_syncedAt"],
            stagingCols: new Set([...target.merge.stagingCols, "_syncedAt"]),
            liveTypes: new Map([
              ...target.merge.liveTypes,
              ["_syncedAt", "TIMESTAMP"],
            ]),
          },
          options: target.options,
          cdc,
        },
      ],
    };
    const member = plan.jobs[0];
    if (!member) throw new Error("Missing sealed replay job");
    await expect(
      holdBigQueryStagedCdcReplay({
        ...plan,
        jobs: [
          {
            ...member,
            cdc: {
              ...cdc,
              scope: { ...cdc.scope, originNamespace: "different" },
            },
          },
        ],
      }),
    ).rejects.toThrow("input seal differs");
    await expect(holdBigQueryStagedCdcReplay(plan)).resolves.toMatchObject({
      status: "held",
    });
    await expect(
      readPendingBigQueryQueryRequest(mergeJob),
    ).resolves.toMatchObject({
      configuration: {
        query: {
          query: expect.stringContaining("CURRENT_TIMESTAMP() AS `_syncedAt`"),
        },
      },
    });
  });

  const replayOutcomes = ["succeeded", "failed"] as const;
  it.each(replayOutcomes)(
    "recovers a %s replay after expiry",
    async outcome => {
      const target = await makeCdcMerge(
        `original_inbox_${outcome}`,
        `boxed_${outcome}`,
      );
      target.scope.entity = "recording_transcripts";
      target.binding.destination.table = "recording_transcripts";
      const eventId = "synthetic-provider-event-for-two-languages";
      const receivedAt = new Date("2026-11-18T17:35:16.117Z");
      const origin = {
        _id: new Types.ObjectId(),
        workspaceId: new Types.ObjectId(target.scope.workspaceId),
        flowId: new Types.ObjectId(),
        dataSourceId: new Types.ObjectId(),
        eventId,
        eventType: "recording_added",
        receivedAt,
        status: "dormant",
        applyStatus: "dormant",
        rawPayload: { eventId },
      };
      // The closed intake writes this receipt through the raw collection.
      await WebhookEvent.collection.insertOne(origin);
      const eventIdSha256 = createHash("sha256").update(eventId).digest("hex");
      const receipt = {
        id: String(origin._id),
        flowId: String(origin.flowId),
        sourceConnectionId: String(origin.dataSourceId),
        eventIdSha256,
        receivedAt: receivedAt.toISOString(),
      };
      const english = await target.event(
        "recording:en",
        1,
        target.scope.entity,
      );
      const french = await target.event("recording:fr", 2, target.scope.entity);
      const rows = [english, french];
      const replayEvent = (row: typeof english) => ({
        id: row.id,
        deliveryKey: bigQueryReplayDeliveryKey(eventIdSha256, row.deliveryKey),
        originalReceipt: { ...receipt, recordId: row.deliveryKey },
      });
      const events = rows.map(replayEvent);
      const recording = await target.event("recording", 3, "recordings");
      const recordingJob = makeMerge(`recording_replay_${outcome}`).binding;
      recordingJob.destination.dataset = target.binding.destination.dataset;
      const snapshotMetadata = sealFixtureSnapshot(recordingJob);
      const recordingIntent = {
        binding: recordingJob,
        merge: target.merge,
        options: target.options,
        cdc: {
          scope: { ...target.scope, entity: "recordings" },
          events: [replayEvent(recording)],
        },
      };
      const expectedRecords = [
        ...events.map(event => ({
          entity: target.scope.entity,
          recordId: event.originalReceipt.recordId,
        })),
        { entity: "recordings", recordId: recording.deliveryKey },
      ];
      const transcriptIntent = {
        binding: target.binding,
        merge: target.merge,
        options: target.options,
        cdc: { scope: target.scope, events },
      };
      const plan = {
        expectedRecords,
        jobs: [transcriptIntent, recordingIntent],
      };
      const hold = (binding = target.binding, replayEvents = events) =>
        holdBigQueryStagedCdcReplay({
          ...plan,
          jobs: [
            {
              ...transcriptIntent,
              binding,
              cdc: { scope: target.scope, events: replayEvents },
            },
            recordingIntent,
          ],
        });
      await expect(
        holdBigQueryStagedCdcMerge(
          target.binding,
          target.merge,
          target.options,
          transcriptIntent.cdc,
        ),
      ).rejects.toThrow("complete delivery plan");
      await expect(
        holdBigQueryStagedCdcReplay({ ...plan, jobs: [transcriptIntent] }),
      ).rejects.toThrow("cover every expected record");
      await CdcChangeEvent.updateMany(
        { _id: { $in: rows.map(row => row.id) } },
        { $set: { webhookEventId: receipt.id } },
      );
      // The second job cannot reserve its unbound row. The first job and all
      // of its claims must roll back with it before either job can dispatch.
      await expect(hold()).rejects.toThrow("could not be reserved");
      await expect(
        readBigQueryStagedInput(target.binding.job),
      ).resolves.toBeNull();
      await expect(
        readBigQueryStagedInput(recordingJob.job),
      ).resolves.toBeNull();
      for (const row of rows) {
        await expect(
          CdcChangeEvent.findById(row.id).lean(),
        ).resolves.not.toHaveProperty("retainedBigQueryWrite");
      }
      await CdcChangeEvent.updateOne(
        { _id: recording.id },
        { $set: { webhookEventId: receipt.id } },
      );
      const [first, ...rest] = events;
      if (!first) throw new Error("Missing test replay event");
      await WebhookEvent.collection.updateOne(
        { _id: origin._id },
        { $set: { workspaceId: new Types.ObjectId() } },
      );
      await expect(hold()).rejects.toThrow(
        "does not match the original inbox receipt",
      );
      await WebhookEvent.collection.updateOne(
        { _id: origin._id },
        { $set: { workspaceId: origin.workspaceId } },
      );
      for (const invalid of [
        { ...first, deliveryKey: "unbound-retry-key" },
        {
          ...first,
          originalReceipt: {
            ...first.originalReceipt,
            flowId: target.scope.flowId,
          },
        },
        {
          ...first,
          originalReceipt: {
            ...first.originalReceipt,
            sourceConnectionId: target.scope.sourceConnectionId,
          },
        },
        {
          ...first,
          originalReceipt: {
            ...first.originalReceipt,
            receivedAt: new Date(0).toISOString(),
          },
        },
        {
          ...first,
          originalReceipt: {
            ...first.originalReceipt,
            eventIdSha256: "0".repeat(64),
          },
        },
      ]) {
        await expect(hold(target.binding, [invalid, ...rest])).rejects.toThrow(
          "does not match the original inbox receipt",
        );
      }
      const job = target.binding.job;
      await expect(readBigQueryStagedInput(job)).resolves.toBeNull();
      const [admitted, retry] = await Promise.all([hold(), hold()]);
      expect(retry).toEqual(admitted);
      const { replayId, status } = admitted;
      expect(status).toBe("held");
      await expect(
        readBigQueryStagedCdcReplay(target.scope.workspaceId, replayId),
      ).resolves.toBe("held");
      await expect(
        readBigQueryStagedCdcReplay(String(new Types.ObjectId()), replayId),
      ).resolves.toBeNull();

      const duplicate = await target.event(
        english.deliveryKey,
        4,
        target.scope.entity,
      );
      await CdcChangeEvent.updateOne(
        { _id: duplicate.id },
        { $set: { webhookEventId: receipt.id } },
      );
      const alternate = makeMerge(`competing_original_${outcome}`).binding;
      alternate.destination = target.binding.destination;
      await expect(
        hold(alternate, [{ ...first, id: duplicate.id }, ...rest]),
      ).rejects.toThrow("different retained replay plan");
      await expect(readBigQueryStagedInput(alternate.job)).resolves.toBeNull();
      await expect(
        CdcChangeEvent.findById(duplicate.id).lean(),
      ).resolves.not.toHaveProperty("retainedBigQueryWrite");

      const request = await readPendingBigQueryQueryRequest(job);
      expect(request).not.toBeNull();
      await CdcChangeEvent.updateOne(
        { _id: english.id },
        { $set: { webhookEventId: String(new Types.ObjectId()) } },
      );
      await expect(readPendingBigQueryQueryRequest(job)).resolves.toBeNull();
      const done = {
        ...request,
        status: { state: "DONE" },
        statistics: { query: { statementType: "MERGE" } },
      };
      await expect(recordObservedBigQueryQueryResult(job, done)).resolves.toBe(
        false,
      );
      await CdcChangeEvent.updateOne(
        { _id: english.id },
        { $set: { webhookEventId: receipt.id } },
      );
      await expect(recordObservedBigQueryQueryResult(job, done)).resolves.toBe(
        true,
      );
      await expect(
        readBigQueryStagedCdcReplay(target.scope.workspaceId, replayId),
      ).resolves.toBe("held");
      const recordingRequest = await readPendingBigQueryQueryRequest(
        recordingJob.job,
      );
      expect(recordingRequest).not.toBeNull();
      const retryRecording = () =>
        retryFailedBigQueryReplayMember(
          target.scope.workspaceId,
          replayId,
          recordingJob.job,
        );
      await expect(retryRecording()).rejects.toThrow("verified failed member");
      await expect(
        recordObservedBigQueryQueryResult(recordingJob.job, {
          ...recordingRequest,
          status:
            outcome === "succeeded"
              ? { state: "DONE" }
              : { state: "DONE", errorResult: { reason: "invalidQuery" } },
          statistics: { query: { statementType: "MERGE" } },
        }),
      ).resolves.toBe(true);
      await expect(
        readBigQueryStagedCdcReplay(target.scope.workspaceId, replayId),
      ).resolves.toBe(outcome);
      if (outcome === "failed") {
        await expect(
          retryFailedBigQueryReplayMember(
            target.scope.workspaceId,
            replayId,
            job,
          ),
        ).rejects.toThrow("verified failed member");
        await CdcChangeEvent.updateOne(
          { _id: recording.id },
          { $unset: { webhookEventId: "" } },
        );
        await expect(retryRecording()).rejects.toThrow("claims could not move");
        await expect(
          readBigQueryStagedCdcReplay(target.scope.workspaceId, replayId),
        ).resolves.toBe("failed");
        await CdcChangeEvent.updateOne(
          { _id: recording.id },
          { $set: { webhookEventId: receipt.id } },
        );
        const [replacement, concurrent] = await Promise.all([
          retryRecording(),
          retryRecording(),
        ]);
        expect(concurrent).toEqual(replacement);
        expect(replacement.id).not.toBe(recordingJob.job.id);
        const replacementRequest =
          await readPendingBigQueryQueryRequest(replacement);
        expect(replacementRequest).toEqual({
          ...recordingRequest,
          jobReference: {
            projectId: replacement.project,
            location: replacement.location,
            jobId: replacement.id,
          },
        });
        const { scope: recordingScope, events: recordingEvents } =
          recordingIntent.cdc;
        await expect(
          findBigQueryStagedCdcWrites(
            recordingScope,
            recordingEvents.map(event => event.deliveryKey),
          ),
        ).resolves.toMatchObject([
          {
            intent: {
              job: replacement,
              input: recordingJob.input,
              destination: recordingJob.destination,
            },
          },
        ]);
        await expect(
          readPendingBigQueryQueryRequest(recordingJob.job),
        ).resolves.toBeNull();
        await expect(
          recordObservedBigQueryQueryResult(recordingJob.job, {
            ...recordingRequest,
            status: { state: "DONE" },
            statistics: { query: { statementType: "MERGE" } },
          }),
        ).resolves.toBe(false);
        await expect(
          readBigQueryStagedCdcReplay(target.scope.workspaceId, replayId),
        ).resolves.toBe("held");

        const table = recordingJob.destination;
        const assertDrained = (targetTable = table) =>
          mongoose.connection.transaction(session =>
            assertRetainedWritesDrainedForResync(
              {
                workspaceId: recordingScope.workspaceId,
                flowId: recordingScope.flowId,
                entities: [recordingScope.entity],
                tables: [targetTable],
              },
              session,
            ),
          );
        await expect(assertDrained()).rejects.toThrow(
          "unsettled write or retained snapshot",
        );
        const predecessor = await readBigQueryStagedInput(recordingJob.job);
        if (!predecessor) throw new Error("Missing failed recording receipt");
        const readAgain = vi.fn(async () => null);
        await expect(
          settleReservedBigQueryStagedJob(
            {
              ...table,
              workspaceId: recordingScope.workspaceId,
              destinationConnectionId: recordingScope.destinationConnectionId,
            },
            {
              jobId: recordingJob.job.id,
              location: recordingJob.job.location,
              intentFingerprint: predecessor.fingerprint,
              reservedBeforeDispatch: true,
            },
            readAgain,
          ),
        ).resolves.toBe(true);
        expect(readAgain).not.toHaveBeenCalled();
        const createJob = vi.fn(async () => {
          throw new Error("Simulated lost retry acknowledgement");
        });
        const warehouseJob = vi.fn((id: string) => ({
          getMetadata: async () => {
            expect(id).toBe(replacement.id);
            return [
              {
                ...replacementRequest,
                status: { state: "DONE" },
                statistics: { query: { statementType: "MERGE" } },
              },
            ];
          },
        }));
        const adapter = new BigQueryDestinationAdapter({
          destinationDatabaseId: recordingScope.destinationConnectionId,
          workspaceId: recordingScope.workspaceId,
          tableDestination: {
            connectionId: recordingScope.destinationConnectionId,
            schema: table.dataset,
            tableName: table.table,
          },
          hooks: { lease: { maxWaitMs: 0 } },
        });
        (adapter as unknown as { _resolvedClient: unknown })._resolvedClient = {
          bq: {
            createJob,
            job: warehouseJob,
            dataset: () => ({
              table: () => ({ getMetadata: async () => [snapshotMetadata] }),
            }),
          },
          projectId: table.project,
          dataset: table.dataset,
          datasetLocation: replacement.location,
          destination: {
            _id: recordingScope.destinationConnectionId,
            workspaceId: recordingScope.workspaceId,
            type: "bigquery",
          },
        };
        const dispatch = () =>
          adapter.dispatchRetainedCdcMerge(
            buildCdcEntityLayout({
              entity: recordingScope.entity,
              tableName: table.table,
            }),
            recordingScope.flowId,
            replacement.id,
          );
        await expect(dispatch()).resolves.toBe("succeeded");
        await expect(dispatch()).resolves.toBe("succeeded");
        expect(createJob).toHaveBeenCalledExactlyOnceWith({
          jobId: replacement.id,
          location: replacement.location,
          configuration: replacementRequest?.configuration,
        });
        await expect(
          readBigQueryStagedInput(recordingJob.job),
        ).resolves.toMatchObject({
          terminal: { state: "DONE", outcome: "failed" },
        });
        await expect(
          readBigQueryStagedCdcReplay(target.scope.workspaceId, replayId),
        ).resolves.toBe("succeeded");
        await expect(assertDrained()).resolves.toBeUndefined();
        await expect(
          assertDrained(recordingJob.input.snapshot),
        ).rejects.toThrow("unsettled write or retained snapshot");
      }
      // The per-entity result must leave the original inbox available for the recordings job.
      await expect(
        WebhookEvent.findById(origin._id).lean(),
      ).resolves.toMatchObject({
        applyStatus: "dormant",
      });
      for (const row of [...rows, recording]) {
        await expect(
          CdcChangeEvent.findById(row.id).lean(),
        ).resolves.toMatchObject({
          materializationStatus: "applied",
          materializationAttemptCount: 1,
        });
      }
      await WebhookEvent.deleteOne({ _id: origin._id });
      await CdcChangeEvent.deleteMany({
        _id: { $in: [...rows, recording].map(row => row.id) },
      });
      await mongoose.disconnect();
      await mongoose.connect(mongo.getUri());
      await expect(
        holdBigQueryStagedCdcReplay({
          ...plan,
          jobs: [...plan.jobs].reverse(),
        }),
      ).resolves.toEqual({ replayId, status: "succeeded" });
      await expect(
        readBigQueryStagedCdcReplay(target.scope.workspaceId, replayId),
      ).resolves.toBe("succeeded");
      const retained = await readBigQueryStagedInput(job);
      expect(retained).toMatchObject({
        intent: { destination: target.binding.destination, cdc: { events } },
        terminal: { state: "DONE", outcome: "succeeded" },
      });
      expect(JSON.stringify(retained)).not.toContain(eventId);
    },
  );

  it.each(["applied", "failed", "dropped"] as const)(
    "keeps a shared receipt pending when ordinary CDC marks a sibling %s",
    async outcome => {
      const first = await makeResyncFlow(
        `receipt_${outcome}`,
        `receipt_${outcome}`,
      );
      const { workspaceId, flowId } = first.scope;
      await Flow.updateOne(
        { _id: flowId },
        {
          $set: {
            streamState: "active",
            entityFilter:
              outcome === "dropped"
                ? ["recordings"]
                : ["recordings", "transcripts"],
          },
        },
      );
      const receipt = (eventId: string) =>
        WebhookEvent.create({
          workspaceId,
          flowId,
          eventId,
          eventType: "synthetic_delivery",
          status: "completed",
          applyStatus: "pending",
          rawPayload: { synthetic: true },
        });
      const shared = await receipt("shared-receipt");
      const ordinary = await receipt("ordinary-receipt");
      const retainedEvent = await first.event("retained-peer", 1);
      const sibling = await first.event("ordinary-peer", 2, "transcripts");
      const control = await first.event("ordinary-control", 3, "transcripts");
      await CdcChangeEvent.updateMany(
        { _id: { $in: [retainedEvent.id, sibling.id] } },
        {
          $set: { webhookEventId: String(shared._id) },
        },
      );
      await CdcChangeEvent.updateOne(
        { _id: control.id },
        { $set: { webhookEventId: String(ordinary._id) } },
      );
      if (outcome === "dropped") {
        await expect(first.hold([retainedEvent])).resolves.toBe("held");
      }

      const warehouseFailure = new Error(
        "Simulated ordinary warehouse failure",
      );
      const applyEvents = vi.fn(async () => {
        // The normal batch already owns its rows when the other entity claims this delivery.
        await expect(first.hold([retainedEvent])).resolves.toBe("held");
        if (outcome === "failed") throw warehouseFailure;
        return { applied: 2 };
      });
      const adapter = vi
        .spyOn(adapterRegistry, "resolveCdcDestinationAdapter")
        .mockReturnValue({
          destinationType: "bigquery",
          ensureLiveTable: async () => undefined,
          applyEvents,
          applyBatch: async () => ({ written: 0 }),
        });
      const freshness = vi
        .spyOn(flowSync, "ensureFlowDerivedCache")
        .mockResolvedValue("ok");
      const connector = vi
        .spyOn(sourceConnectionManager, "getSourceConnection")
        .mockResolvedValue(null);
      try {
        const run = new CdcConsumerService().materializeEntity({
          workspaceId,
          flowId,
          entity: "transcripts",
        });
        if (outcome === "failed") {
          await expect(run).rejects.toBe(warehouseFailure);
        } else {
          await expect(run).resolves.toMatchObject({
            processed: 2,
            [outcome]: 2,
          });
        }
        expect(applyEvents).toHaveBeenCalledTimes(
          outcome === "dropped" ? 0 : 1,
        );
      } finally {
        adapter.mockRestore();
        freshness.mockRestore();
        connector.mockRestore();
      }
      await expect(
        WebhookEvent.findById(shared._id).readConcern("majority").lean(),
      ).resolves.toMatchObject({
        status: "completed",
        applyStatus: "pending",
      });
      await expect(
        WebhookEvent.findById(ordinary._id).readConcern("majority").lean(),
      ).resolves.toMatchObject({
        status: outcome === "failed" ? "failed" : "completed",
        applyStatus: outcome,
      });
      await expect(
        CdcChangeEvent.findById(sibling.id).lean(),
      ).resolves.toMatchObject({ materializationStatus: outcome });
      await expect(
        readPendingBigQueryQueryRequest(first.binding.job),
      ).resolves.not.toBeNull();

      if (outcome === "applied") {
        await WebhookEvent.updateOne(
          { _id: ordinary._id },
          { $set: { applyStatus: "pending" } },
        );
        await expect(
          reconcileWebhookApplyStatus(workspaceId, flowId),
        ).resolves.toBe(1);
        await expect(
          WebhookEvent.findById(shared._id).lean(),
        ).resolves.toMatchObject({ applyStatus: "pending" });

        const request = await readPendingBigQueryQueryRequest(
          first.binding.job,
        );
        await expect(
          recordObservedBigQueryQueryResult(first.binding.job, {
            ...request,
            status: { state: "DONE" },
            statistics: { query: { statementType: "MERGE" } },
          }),
        ).resolves.toBe(true);
        await WebhookEvent.updateOne(
          { _id: ordinary._id },
          { $set: { applyStatus: "pending" } },
        );
        await expect(
          resolveOrphanedWebhookApplyStatusForFlow({ workspaceId, flowId }),
        ).resolves.toBe(1);
        await expect(
          WebhookEvent.findById(shared._id).lean(),
        ).resolves.toMatchObject({ applyStatus: "pending" });
      }
      if (outcome === "failed") {
        await WebhookEvent.updateOne(
          { _id: shared._id },
          { $set: { status: "failed", applyStatus: "failed" } },
        );
        await expect(
          resetFailedWebhookEvents(workspaceId, flowId),
        ).resolves.toBe(1);
        await expect(
          WebhookEvent.findById(shared._id).lean(),
        ).resolves.toMatchObject({ applyStatus: "failed" });
        await expect(
          WebhookEvent.findById(ordinary._id).lean(),
        ).resolves.toMatchObject({ applyStatus: "pending" });
      }
    },
  );

  it("blocks full and subset resets before deleting rows for a shared retained table", async () => {
    const retained = await makeResyncFlow("resync_retained", "reset_shared");
    const neighbor = await makeResyncFlow("resync_neighbor", "reset_shared");
    const first = await retained.event("held-for-resync", 1);
    const second = await neighbor.event("neighbor-unclaimed", 1);
    const inbox = await WebhookEvent.create({
      workspaceId: retained.scope.workspaceId,
      flowId: retained.scope.flowId,
      eventId: "resync-retained-inbox",
      eventType: "synthetic_delivery",
      rawPayload: { synthetic: true },
    });
    await expect(retained.hold([first])).resolves.toBe("held");
    const observe = vi
      .spyOn(dataDiff, "openFlowDataDiff")
      .mockResolvedValue(undefined);
    const queue = vi
      .spyOn(backfillLifecycle, "startBackfill")
      .mockRejectedValue(new Error("Unexpected backfill"));
    const driver = databaseRegistry.getDriver("bigquery");
    if (!driver?.dropTable) throw new Error("Missing BigQuery driver");
    const drop = vi
      .spyOn(driver, "dropTable")
      .mockRejectedValue(new Error("Unexpected BigQuery drop"));
    try {
      await expect(
        resyncFlow({
          workspaceId: retained.scope.workspaceId,
          flowId: retained.scope.flowId,
          clearWebhookEvents: true,
        }),
      ).rejects.toThrow(
        "CDC resync is blocked by an unsettled write or retained snapshot",
      );
      await expect(
        backfillEntitiesFallback(
          neighbor.flow,
          neighbor.scope.workspaceId,
          neighbor.scope.flowId,
          ["recordings"],
          true,
        ),
      ).rejects.toThrow(
        "CDC resync is blocked by an unsettled write or retained snapshot",
      );
      expect(observe).not.toHaveBeenCalled();
      expect(drop).not.toHaveBeenCalled();
      expect(queue).not.toHaveBeenCalled();
    } finally {
      observe.mockRestore();
      drop.mockRestore();
      queue.mockRestore();
    }
    await expect(
      WebhookEvent.findById(inbox._id).lean(),
    ).resolves.not.toBeNull();
    for (const event of [first, second]) {
      await expect(
        CdcChangeEvent.findById(event.id).lean(),
      ).resolves.toMatchObject({ materializationStatus: "pending" });
    }
    await expect(
      readPendingBigQueryQueryRequest(retained.binding.job),
    ).resolves.not.toBeNull();
  });

  it("blocks cross-flow admission during a reset and preserves an interrupted reset fence", async () => {
    const retained = await makeResyncFlow("resync_claim", "reset_then_resume");
    const neighbor = await makeResyncFlow("resync_owner", "reset_then_resume");
    const event = await retained.event("claim-after-reset", 1);
    const options = { entities: ["recordings"], deleteDestination: true };
    await withCdcEventReset(neighbor.flow, options, async () => {
      await expect(retained.hold([event])).rejects.toThrow(
        "A CDC resync is holding this flow or table",
      );
      await expect(
        readBigQueryStagedInput(retained.binding.job),
      ).resolves.toBeNull();
    });
    await expect(retained.hold([event])).resolves.toBe("held");

    const interrupted = await makeResyncFlow(
      "resync_interrupted",
      "reset_no_ack",
    );
    const pending = await interrupted.event("never-admitted", 1);
    const observe = vi
      .spyOn(dataDiff, "openFlowDataDiff")
      .mockResolvedValue(undefined);
    const driver = databaseRegistry.getDriver("bigquery");
    if (!driver?.dropTable) throw new Error("Missing BigQuery driver");
    const drop = vi.spyOn(driver, "dropTable").mockResolvedValue({
      success: false,
      error: "Simulated lost acknowledgement",
    });
    try {
      await expect(
        withCdcEventReset(interrupted.flow, options, drop => drop()),
      ).rejects.toThrow("BigQuery resync could not verify a table drop");
      expect(drop).toHaveBeenCalledTimes(1);
    } finally {
      observe.mockRestore();
      drop.mockRestore();
    }
    await mongoose.disconnect();
    await mongoose.connect(mongo.getUri());
    await expect(interrupted.hold([pending])).rejects.toThrow(
      "A CDC resync is holding this flow or table",
    );
    await expect(
      readBigQueryStagedInput(interrupted.binding.job),
    ).resolves.toBeNull();
  });

  it("keeps a retained snapshot protected after a terminal receipt", async () => {
    const retained = await makeResyncFlow(
      "resync_snapshot_owner",
      "snapshot_write_target",
    );
    const snapshotFlow = await makeResyncFlow(
      "resync_snapshot_table",
      "snapshot_table",
    );
    retained.binding.input.snapshot = snapshotFlow.binding.destination;
    const event = await retained.event("settled-before-snapshot-reset", 1);
    const job = retained.binding.job;
    await expect(retained.hold([event])).resolves.toBe("held");
    const request = await readPendingBigQueryQueryRequest(job);
    await expect(
      recordObservedBigQueryQueryResult(job, {
        ...request,
        status: { state: "DONE" },
        statistics: { query: { statementType: "MERGE" } },
      }),
    ).resolves.toBe(true);

    const reset = vi.fn(async () => undefined);
    await expect(
      withCdcEventReset(snapshotFlow.flow, { deleteDestination: true }, reset),
    ).rejects.toThrow(
      "CDC resync is blocked by an unsettled write or retained snapshot",
    );
    expect(reset).not.toHaveBeenCalled();
    await expect(
      withCdcEventReset(retained.flow, {}, reset),
    ).resolves.toBeUndefined();
    expect(reset).toHaveBeenCalledOnce();
  });

  it("preserves retained and sibling rows during parking and a stale cleanup race", async () => {
    const first = await makeCdcMerge("cdc_maintenance_fence");
    const { workspaceId, flowId } = first.scope;
    const staleAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const inbox = (eventId: string, receivedAt: Date) =>
      WebhookEvent.create({
        workspaceId,
        flowId,
        eventId,
        eventType: "synthetic_delivery",
        receivedAt,
        status: "completed",
        applyStatus: "pending",
        rawPayload: { synthetic: true },
      });
    const sharedInbox = await inbox("shared", staleAt);
    const parkedInbox = await inbox("parked", new Date());
    const staleInbox = await inbox("stale-control", staleAt);
    const racingInbox = await inbox("stale-race", staleAt);
    const retained = await first.event("retained", 1);
    const sibling = await first.event("sibling", 2, "transcripts");
    const parked = await first.event("parked", 3, "transcripts");
    const stale = await first.event("stale", 4);
    const racing = await first.event("racing", 5);
    const link = (eventId: string, inboxId: Types.ObjectId) =>
      CdcChangeEvent.updateOne(
        { _id: eventId },
        { $set: { webhookEventId: String(inboxId) } },
      );
    await Promise.all([
      link(retained.id, sharedInbox._id),
      link(sibling.id, sharedInbox._id),
      link(parked.id, parkedInbox._id),
      link(stale.id, staleInbox._id),
      link(racing.id, racingInbox._id),
    ]);
    await expect(first.hold([retained])).resolves.toBe("held");
    await expect(
      parkPausedFlowWebhookEvents({ flowId, entity: "transcripts" }),
    ).resolves.toBe(1);

    const second = makeMerge("cdc_maintenance_after_scan");
    const find = WebhookEvent.find.bind(WebhookEvent);
    const scan = vi
      .spyOn(WebhookEvent, "find")
      .mockImplementationOnce((filter, projection, options) => {
        const query = find(filter, projection, options);
        const exec = query.exec.bind(query);
        query.exec = async () => {
          const candidates = await exec();
          await expect(
            holdBigQueryStagedCdcMerge(
              second.binding,
              second.merge,
              second.options,
              {
                scope: first.scope,
                events: [racing],
              },
            ),
          ).resolves.toBe("held");
          return candidates;
        };
        return query;
      });
    try {
      await expect(cleanupStalePendingCdcEvents()).resolves.toMatchObject({
        scanned: 3,
        droppedCdc: 1,
        droppedWebhooks: 1,
      });
    } finally {
      scan.mockRestore();
    }
    const rows = await CdcChangeEvent.find({ flowId })
      .sort({ ingestSeq: 1 })
      .readConcern("majority")
      .lean();
    expect(rows.map(row => row.materializationStatus)).toEqual([
      "pending",
      "pending",
      "dropped",
      "dropped",
      "pending",
    ]);
    const receipts = await WebhookEvent.find({ flowId })
      .readConcern("majority")
      .lean();
    expect(
      Object.fromEntries(receipts.map(row => [row.eventId, row.applyStatus])),
    ).toEqual({
      shared: "pending",
      parked: "dropped",
      "stale-control": "dropped",
      "stale-race": "pending",
    });
    await expect(
      readPendingBigQueryQueryRequest(first.binding.job),
    ).resolves.not.toBeNull();
    await expect(
      readPendingBigQueryQueryRequest(second.binding.job),
    ).resolves.not.toBeNull();
  });

  it("gives retained and ordinary retries exclusive ownership of the same pending event", async () => {
    const first = await makeCdcMerge("cdc_ownership_fence");
    const retained = await first.event("retained-wins", 1);
    const ordinary = await first.event("ordinary-wins", 2);
    const store = getCdcEventStore();
    const { workspaceId, flowId, entity } = first.scope;
    const read = () =>
      store.readAfter({ flowId, entity, afterIngestSeq: 0, limit: 10 });
    const claim = (eventIds: string[]) =>
      store.claimOrdinaryWebhookUpserts({
        workspaceId,
        flowId,
        entity,
        eventIds,
      });
    const seen = await read();
    expect(seen.map(event => event.id)).toEqual([retained.id, ordinary.id]);

    await expect(first.hold([retained])).resolves.toBe("held");
    await expect(claim(seen.map(event => event.id))).resolves.toBe(false);
    expect((await read()).map(event => event.id)).toEqual([ordinary.id]);
    await expect(claim([ordinary.id])).resolves.toBe(true);
    await expect(claim([ordinary.id])).resolves.toBe(true);

    const second = makeMerge("cdc_ordinary_already_claimed");
    await expect(
      holdBigQueryStagedCdcMerge(second.binding, second.merge, second.options, {
        scope: first.scope,
        events: [ordinary],
      }),
    ).rejects.toThrow("The exact pending CDC events could not be reserved");
    await expect(
      readBigQueryStagedInput(second.binding.job),
    ).resolves.toBeNull();
    await expect(
      readPendingBigQueryQueryRequest(first.binding.job),
    ).resolves.not.toBeNull();
    const persisted = await CdcChangeEvent.findById(retained.id)
      .readConcern("majority")
      .lean();
    expect(persisted?.ordinaryWebhookWriteStarted).toBeUndefined();
  });

  async function expectSingleDispatch(reservationType: "new" | "inherited") {
    const first = await makeCdcMerge(
      `cdc_retained_dispatch_${reservationType}`,
    );
    const event = await first.event("dispatch-delivery", 1);
    const { job, input, destination } = first.binding;
    const { snapshot } = input;
    const key = `${destination.project}.${destination.dataset}.${destination.table}`;
    const snapshotMetadata = sealFixtureSnapshot(first.binding);
    await expect(first.hold([event])).resolves.toBe("held");
    const staged = await readBigQueryStagedInput(job);
    const request = await readPendingBigQueryQueryRequest(job);
    if (!staged || !request) throw new Error("Missing staged request");

    const lostAcknowledgement = new Error("Warehouse acknowledgement lost");
    const createJob = vi.fn(async () => {
      expect(
        await CdcTableWriteLease.findById(key).readConcern("majority").lean(),
      ).toMatchObject({
        jobId: job.id,
        jobLocation: job.location,
        jobReservedBeforeDispatch: true,
        jobIntentFingerprint: staged.fingerprint,
        jobDispatchState: "attempted",
      });
      throw lostAcknowledgement;
    });
    const cancel = vi.fn();
    const getJob = vi.fn(async (): Promise<unknown[]> => {
      throw Object.assign(new Error("Job not visible yet"), { code: 404 });
    });
    const getSnapshot = vi.fn().mockResolvedValue([snapshotMetadata]);
    const snapshotTable = vi.fn(() => ({ getMetadata: getSnapshot }));
    const dataset = vi.fn(() => ({ table: snapshotTable }));
    const warehouseJob = vi.fn(() => ({ getMetadata: getJob, cancel }));
    const adapter = () => {
      const instance = new BigQueryDestinationAdapter({
        destinationDatabaseId: first.scope.destinationConnectionId,
        workspaceId: first.scope.workspaceId,
        tableDestination: {
          connectionId: first.scope.destinationConnectionId,
          schema: destination.dataset,
          tableName: destination.table,
        },
        hooks: { lease: { maxWaitMs: 0 } },
      });
      (instance as unknown as { _resolvedClient: unknown })._resolvedClient = {
        bq: {
          dataset,
          job: warehouseJob,
          createJob,
        },
        projectId: destination.project,
        dataset: destination.dataset,
        datasetLocation: "EU",
        destination: {
          _id: first.scope.destinationConnectionId,
          workspaceId: first.scope.workspaceId,
          type: "bigquery",
        },
      };
      return instance;
    };
    const dispatch = () =>
      adapter().dispatchRetainedCdcMerge(
        buildCdcEntityLayout({
          entity: first.scope.entity,
          tableName: destination.table,
        }),
        first.scope.flowId,
        job.id,
      );

    getSnapshot.mockResolvedValueOnce([
      { ...snapshotMetadata, expirationTime: "1795363200000" },
    ]);
    await expect(dispatch()).rejects.toThrow("snapshot generation changed");
    getSnapshot.mockResolvedValueOnce([
      { ...snapshotMetadata, etag: "recreated-generation" },
    ]);
    await expect(dispatch()).rejects.toThrow("snapshot generation changed");
    expect(createJob).not.toHaveBeenCalled();
    expect(await CdcTableWriteLease.findById(key)).toBeNull();

    const expire = () =>
      CdcTableWriteLease.updateOne(
        { _id: key },
        { $set: { expiresAt: new Date(0) } },
        { writeConcern: { w: "majority" } },
      );
    if (reservationType === "inherited") {
      const old = await acquireTableWriteLease(key, {
        path: "live",
        maxWaitMs: 0,
        jobs: {
          isDone: async () => false,
          isReservedJobDone: async () => false,
          cancel,
        },
      });
      const reservation = {
        jobId: job.id,
        location: job.location,
        intentFingerprint: staged.fingerprint,
      };
      try {
        await old.reserveJob(reservation, { guardDispatch: true });
        await expect(
          CdcTableWriteLease.findById(key).readConcern("majority").lean(),
        ).resolves.toMatchObject({
          jobDispatchState: "ready",
          jobId: job.id,
        });
        await expire();
        getSnapshot.mockImplementationOnce(async () => {
          await expect(
            old.beginReservedJobDispatch(reservation),
          ).rejects.toBeInstanceOf(TableWriteLeaseBusyError);
          return [snapshotMetadata];
        });
        await expect(dispatch()).rejects.toBe(lostAcknowledgement);
      } finally {
        await old.release();
      }
    } else {
      await expect(dispatch()).rejects.toBe(lostAcknowledgement);
    }
    expect(dataset).toHaveBeenLastCalledWith(snapshot.dataset, {
      projectId: snapshot.project,
      location: job.location,
    });
    expect(snapshotTable).toHaveBeenLastCalledWith(snapshot.table);
    expect(createJob).toHaveBeenCalledExactlyOnceWith({
      jobId: job.id,
      location: job.location,
      configuration: request.configuration,
    });
    expect(
      await CdcTableWriteLease.findById(key).readConcern("majority").lean(),
    ).toMatchObject({ jobId: job.id });
    expect(await CdcChangeEvent.findById(event.id).lean()).toMatchObject({
      materializationStatus: "pending",
      materializationAttemptCount: 0,
    });

    await mongoose.disconnect();
    await mongoose.connect(mongo.getUri());
    await expire();
    await expect(dispatch()).rejects.toBeInstanceOf(TableWriteLeaseBusyError);
    expect(createJob).toHaveBeenCalledTimes(1);
    await expire();
    getJob.mockImplementation(async () => [
      {
        ...request,
        status: { state: "DONE" },
        statistics: { query: { statementType: "MERGE" } },
      },
    ]);
    await expect(dispatch()).resolves.toBe("succeeded");
    await expect(dispatch()).resolves.toBe("succeeded");
    expect(warehouseJob).toHaveBeenLastCalledWith(job.id, {
      location: job.location,
    });
    expect(createJob).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
    expect(await CdcTableWriteLease.findById(key)).toBeNull();
    expect(
      await CdcChangeEvent.findById(event.id).readConcern("majority").lean(),
    ).toMatchObject({
      materializationStatus: "applied",
      materializationAttemptCount: 1,
    });
  }

  it.each(["new", "inherited"] as const)(
    "dispatches a %s reservation once and recovers a late job",
    expectSingleDispatch,
  );

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

  it("settles the exact reserved job only after the authorized binding is restored", async () => {
    const first = await makeCdcMerge("cdc_rollback");
    const event = await first.event("rollback-delivery", 1);
    const { job, destination } = first.binding;
    const tableKey = ({ project, dataset, table }: typeof destination) =>
      `${project}.${dataset}.${table}`;
    const key = tableKey(destination);
    const replacement = makeMerge("cdc_rollback_competitor");
    replacement.binding.destination.dataset = "wrong";
    const replacementScope = {
      ...first.scope,
      sourceConnectionId: new Types.ObjectId().toHexString(),
      definitionSha: "replacement-flow-definition",
    };
    const setBinding = (scope: typeof first.scope, dataset: string) =>
      Flow.updateOne(
        { _id: scope.flowId },
        {
          $set: {
            dataSourceId: scope.sourceConnectionId,
            sourceBlobSha: scope.definitionSha,
            "tableDestination.schema": dataset,
          },
        },
        { writeConcern: { w: "majority" } },
      );

    type Request = NonNullable<
      Awaited<ReturnType<typeof readPendingBigQueryQueryRequest>>
    >;
    const rows = new Map<string, string[]>();
    const metadata = new Map<string, Request & { status: { state: "DONE" } }>();
    const submit = vi.fn((request: Request) => {
      const target = /^MERGE INTO `([^`]+)`\.`([^`]+)`\.`([^`]+)` /u.exec(
        request.configuration.query.query,
      );
      if (!target) throw new Error("Missing synthetic MERGE destination");
      const targetKey = target.slice(1).join(".");
      rows.set(targetKey, [...(rows.get(targetKey) ?? []), event.deliveryKey]);
      metadata.set(request.jobReference.jobId, {
        ...structuredClone(request),
        status: { state: "DONE" },
      });
      throw new Error("Simulated lost warehouse acknowledgement");
    });
    const dispatchPending = async (identity: typeof job) => {
      const request = await readPendingBigQueryQueryRequest(identity);
      if (request) submit(request);
    };
    const isDone = vi.fn(async () => true);
    const cancel = vi.fn(async () => undefined);
    const target = {
      ...destination,
      workspaceId: first.scope.workspaceId,
      destinationConnectionId: first.scope.destinationConnectionId,
    };
    const readMetadata = vi.fn(async (id: string) => {
      const record = metadata.get(id);
      return record
        ? { ...record, statistics: { query: { statementType: "MERGE" } } }
        : null;
    });
    const jobs: LeaseJobControl = {
      isDone,
      cancel,
      isReservedJobDone: ref =>
        settleReservedBigQueryStagedJob(target, ref, () =>
          readMetadata(ref.jobId),
        ),
    };
    const acquire = (holder: string, table = key) =>
      acquireTableWriteLease(table, {
        holder,
        jobs,
        path: "live",
        maxWaitMs: 0,
      });
    const expire = () =>
      CdcTableWriteLease.updateOne(
        { _id: key },
        { $set: { expiresAt: new Date(0) } },
        { writeConcern: { w: "majority" } },
      );

    const original = await acquire("rollback-original");
    try {
      await expect(first.hold([event])).resolves.toBe("held");
      const staged = await readBigQueryStagedInput(job);
      if (!staged) throw new Error("Missing durable staged intent");
      const reservation = {
        jobId: job.id,
        location: job.location,
        intentFingerprint: staged.fingerprint,
        reservedBeforeDispatch: true,
      };
      await original.reserveJob(reservation);
      await expect(
        CdcTableWriteLease.findById(key).readConcern("majority").lean(),
      ).resolves.toMatchObject({
        jobId: job.id,
        jobLocation: job.location,
        jobIntentFingerprint: staged.fingerprint,
        jobReservedBeforeDispatch: true,
      });
      for (const other of [
        { ...target, dataset: "wrong" },
        { ...target, table: "wrong" },
        { ...target, workspaceId: new Types.ObjectId().toHexString() },
        {
          ...target,
          destinationConnectionId: new Types.ObjectId().toHexString(),
        },
      ]) {
        expect(
          await settleReservedBigQueryStagedJob(other, reservation, () =>
            readMetadata(job.id),
          ),
        ).toBe(false);
      }
      expect(
        await settleReservedBigQueryStagedJob(
          target,
          { ...reservation, intentFingerprint: "different-intent" },
          () => readMetadata(job.id),
        ),
      ).toBe(false);
      expect(readMetadata).not.toHaveBeenCalled();
      expect(await jobs.isReservedJobDone?.(reservation)).toBe(false);
      expect((await readBigQueryStagedInput(job))?.terminal).toBeUndefined();
      await expect(dispatchPending(job)).rejects.toThrow(
        "Simulated lost warehouse acknowledgement",
      );
      await setBinding(
        replacementScope,
        replacement.binding.destination.dataset,
      );
    } finally {
      await original.release();
    }
    await mongoose.disconnect();
    await mongoose.connect(mongo.getUri());

    await expect(readPendingBigQueryQueryRequest(job)).resolves.toBeNull();
    await expire();
    await expect(acquire("rollback-blocked")).rejects.toBeInstanceOf(
      TableWriteLeaseBusyError,
    );
    expect((await CdcTableWriteLease.findById(key).lean())?.jobId).toBe(job.id);
    expect((await readBigQueryStagedInput(job))?.terminal).toBeUndefined();
    expect(await CdcChangeEvent.findById(event.id).lean()).toMatchObject({
      materializationStatus: "pending",
      materializationAttemptCount: 0,
    });

    // A different dataset has its own table lease. The existing CDC claim
    // still blocks a competing dispatch for the same event.
    const wrongKey = tableKey(replacement.binding.destination);
    const competing = await acquire("rollback-competing", wrongKey);
    try {
      await expect(
        holdBigQueryStagedCdcMerge(
          replacement.binding,
          replacement.merge,
          replacement.options,
          { scope: replacementScope, events: [event] },
        ),
      ).rejects.toThrow("The exact pending CDC events could not be reserved");
      await dispatchPending(replacement.binding.job);
    } finally {
      await competing.release();
    }
    expect(submit).toHaveBeenCalledTimes(1);

    await setBinding(first.scope, destination.dataset);
    await expire();
    const warehouseJob = vi.fn((jobId: string) => ({
      getMetadata: async () => [await readMetadata(jobId)],
      cancel,
    }));
    const adapter = new BigQueryDestinationAdapter({
      destinationDatabaseId: target.destinationConnectionId,
      workspaceId: target.workspaceId,
      tableDestination: {
        connectionId: target.destinationConnectionId,
        schema: target.dataset,
        tableName: target.table,
      },
    });
    (adapter as unknown as { _resolvedClient: unknown })._resolvedClient = {
      bq: {
        dataset: () => ({ table: () => ({ exists: async () => [true] }) }),
        job: warehouseJob,
      },
      projectId: target.project,
      dataset: target.dataset,
      datasetLocation: job.location,
      destination: {
        _id: target.destinationConnectionId,
        workspaceId: target.workspaceId,
        type: "bigquery",
      },
    };
    const runWarehouseStatement = vi
      .spyOn(databaseConnectionService, "executeQuery")
      .mockImplementation(async () => {
        expect((await readBigQueryStagedInput(job))?.terminal).toMatchObject({
          state: "DONE",
          outcome: "succeeded",
        });
        return { success: true, data: [] };
      });
    try {
      await expect(
        adapter.repartitionLiveTable(
          buildCdcEntityLayout({
            entity: first.scope.entity,
            tableName: target.table,
          }),
        ),
      ).resolves.toEqual({ repartitioned: true });
      expect(warehouseJob).toHaveBeenCalledWith(job.id, {
        location: job.location,
      });
      expect(runWarehouseStatement).toHaveBeenCalledTimes(3);
      const settled = await readBigQueryStagedInput(job);
      expect(settled?.terminal).toMatchObject({
        state: "DONE",
        outcome: "succeeded",
        fingerprint: settled?.fingerprint,
      });
      if (!settled) throw new Error("Missing durable terminal receipt");
      readMetadata.mockClear();
      expect(
        await jobs.isReservedJobDone?.({
          jobId: job.id,
          location: job.location,
          intentFingerprint: settled.fingerprint,
          reservedBeforeDispatch: true,
        }),
      ).toBe(true);
      expect(readMetadata).not.toHaveBeenCalled();
      expect(
        await CdcChangeEvent.findById(event.id).readConcern("majority").lean(),
      ).toMatchObject({
        materializationStatus: "applied",
        materializationAttemptCount: 1,
        retainedBigQueryWrite: settled?.fingerprint,
      });
      await expect(first.hold([event])).resolves.toBe("terminal");
      await dispatchPending(job);
    } finally {
      runWarehouseStatement.mockRestore();
    }
    expect(submit).toHaveBeenCalledTimes(1);
    expect(metadata.size).toBe(1);
    expect(rows.get(key)).toEqual([event.deliveryKey]);
    expect(rows.get(wrongKey) ?? []).toEqual([]);
    expect(await readBigQueryStagedInput(replacement.binding.job)).toBeNull();
    expect(await CdcTableWriteLease.countDocuments()).toBe(0);
    expect(isDone).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
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
