/**
 * A connector that lives in the workspace repo, adapted into the contract the
 * engine already speaks.
 *
 * `BaseConnector` does not change and neither does anything downstream: the
 * orchestrator, the Inngest functions, the CDC materializer, the destination
 * adapters and the flow form all still see one `BaseConnector`, and they
 * cannot tell whether its methods are a class in this repository or a process
 * in a sandbox. That is the whole design — the plugin runtime is one more
 * connector, not a second engine.
 *
 * Everything here is lazy. Constructing a connector must not boot a microVM:
 * the registry builds one to answer questions as ordinary as "what is this
 * type called", and paying for a sandbox to answer that is how a listing page
 * ends up starting a machine per row.
 */
import {
  BaseConnector,
  type NormalizedCdcRecord,
  type ConnectionTestResult,
  type ConnectorEntitySchema,
  type EntityMetadata,
  type FetchOptions,
  type FetchState,
  type IncrementalCapabilities,
  type ResumableFetchOptions,
} from "../base/BaseConnector";
import { randomBytes } from "node:crypto";
import { NonRetriableError } from "inngest";
import { loggers } from "../../logging";
import {
  ensureBundle,
  ConnectorOutputTooLargeError,
  MAX_CONNECTOR_PROTOCOL_BYTES,
  failureMessage,
  firstOfType,
  materializeConnector,
  retireLegacySyncBox,
  retireSyncBox,
  runConnectorCommand,
  syncBoxContext,
  type ConnectorCommand,
  type ProtocolMessage,
  type RunResult,
} from "./sync-box";
import { jsonSchemaToEntitySchema } from "./spec-translation";
import {
  BundleBuildError,
  prepareBundledConnector,
  recordRunBuild,
  shouldBundle,
} from "./bundle/bundle.service";
import {
  connectorRuntimeId,
  ensureConnectorRuntime,
  loadConnectorDefinition,
  readConnectorFolder,
  type LoadedConnector,
} from "./resolver";
import { connectorBoxLeasesEnabled } from "./boxes/config";
import { getBoxScheduler } from "./boxes/scheduler";

const logger = loggers.connector();

/**
 * A chunk's byte budget (`--max-bytes`): half the protocol cap, so the page
 * that crosses it still fits. 10 pages of large emails measured 33 MB in
 * bench G1 and broke the 32 MiB cap on 4 of 30 chunks.
 */
/** The settings every connection gets at create time when none are given. */
const CREATE_DEFAULT_BATCH_SIZE = 100;
const CREATE_DEFAULT_RATE_LIMIT_MS = 200;

export const CHUNK_BYTE_BUDGET = Math.floor(MAX_CONNECTOR_PROTOCOL_BYTES / 2);

/**
 * A record's own time, from its declared cursor field first, then from the
 * update and creation fields APIs commonly use. Unix epochs count, in seconds
 * or milliseconds: Stripe sends `created` as seconds, and the base resolver
 * reads ISO strings only, which gave every boxed Stripe row "now".
 */
const UPDATED_FIELDS = [
  "date_updated",
  "updated_at",
  "updatedAt",
  "date_modified",
  "updated",
];
const CREATED_FIELDS = [
  "date_created",
  "created_at",
  "createdAt",
  "created",
  "start_date",
  "timestamp",
];

export function recordTimestamp(
  payload: Record<string, unknown> | undefined,
  cursorField?: string,
): Date | null {
  const names = [
    ...(cursorField ? [cursorField] : []),
    ...UPDATED_FIELDS,
    ...CREATED_FIELDS,
  ];
  for (const name of names) {
    const date = toDate(payload?.[name]);
    if (date) return date;
  }
  return null;
}

/** Outside this window a "timestamp" is a misread number, not a time. */
const EARLIEST_SOURCE_TS = Date.UTC(1990, 0, 1);
const LATEST_SOURCE_TS = Date.UTC(2100, 0, 1);

/** An epoch in seconds, milliseconds or microseconds, by its size. */
function fromEpoch(value: number): Date | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  const ms = value > 1e14 ? value / 1000 : value > 1e12 ? value : value * 1000;
  return new Date(ms);
}

function toDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === "") return null;
  let date: Date | null;
  if (value instanceof Date) {
    date = value;
  } else if (typeof value === "number") {
    date = fromEpoch(value);
  } else if (typeof value === "string") {
    const text = value.trim();
    if (/^\d+$/.test(text)) {
      // A digit string is an epoch or nothing. `new Date("2024")` would read
      // a year, and `new Date("7")` a July 2001.
      date = text.length >= 9 ? fromEpoch(Number(text)) : null;
    } else if (/^\d{4}-\d{2}-\d{2}/.test(text) || /[a-z]{3}/i.test(text)) {
      // ISO 8601, or a written date such as an RFC 2822 header.
      date = new Date(text);
    } else {
      date = null;
    }
  } else {
    return null;
  }
  if (!date) return null;
  const time = date.getTime();
  return Number.isNaN(time) ||
    time < EARLIEST_SOURCE_TS ||
    time >= LATEST_SOURCE_TS
    ? null
    : date;
}

/** `ws:acme` -> `acme`. */
export const WORKSPACE_TYPE_PREFIX = "ws:";

export function isWorkspaceConnectorType(type: string | undefined): boolean {
  return typeof type === "string" && type.startsWith(WORKSPACE_TYPE_PREFIX);
}

export function slugFromType(type: string): string {
  return type.slice(WORKSPACE_TYPE_PREFIX.length);
}

/** The protocol's log levels are Airbyte's; the engine's are narrower. */
function mapLogLevel(
  level: string | undefined,
): "debug" | "info" | "warn" | "error" {
  switch (String(level).toUpperCase()) {
    case "DEBUG":
    case "TRACE":
      return "debug";
    case "WARN":
      return "warn";
    case "ERROR":
    case "FATAL":
      return "error";
    default:
      return "info";
  }
}

/**
 * The `--state` of one chunk: the last STATE the connector emitted, with the
 * engine's `since` in its stream state.
 *
 * The engine passes `since` as `options.since`, the in-process connectors read
 * it there, and a boxed connector can only read its files, so it goes into
 * the stream state as ISO 8601 (`state.mako.since`). Without this every boxed read
 * was a full read.
 *
 * A backfill passes `options.since` on every chunk, but a scheduled
 * incremental sync passes it on the first chunk only. So the anchor is also
 * kept in the chunk's own metadata (`MAKO_SINCE_KEY`) and re-injected from
 * there: a connector that does not copy `since` into its state must still see
 * it on chunk 2, or it walks the whole history from its cursor.
 */
export const MAKO_SINCE_KEY = "makoSince";

export function chunkSince(
  since: Date | undefined,
  previous: unknown,
): string | undefined {
  if (since instanceof Date && !Number.isNaN(since.getTime())) {
    return since.toISOString();
  }
  const kept =
    previous && typeof previous === "object"
      ? (previous as Record<string, unknown>)[MAKO_SINCE_KEY]
      : undefined;
  return typeof kept === "string" && !Number.isNaN(new Date(kept).getTime())
    ? kept
    : undefined;
}

export function readState(
  entity: string,
  previous: unknown,
  since: Date | undefined,
): unknown[] | undefined {
  const base =
    previous && typeof previous === "object"
      ? (previous as Record<string, any>)
      : undefined;
  const anchor = chunkSince(since, previous);
  if (!anchor) return base ? [base] : undefined;
  const stream = (base?.stream ?? {}) as Record<string, any>;
  return [
    {
      ...(base ?? { type: "STREAM" }),
      stream: {
        ...stream,
        stream_descriptor: stream.stream_descriptor ?? { name: entity },
        stream_state: withMakoSince(stream.stream_state, anchor),
      },
    },
  ];
}

/**
 * `since` lives under `mako` in the stream state (`state.mako.since`): the
 * `mako` key is Mako's, so a connector's own `since` (a vendor cursor, say)
 * is never overwritten. A connector whose state uses `mako` for something
 * that is not an object fails loudly rather than losing either value.
 */
function withMakoSince(
  streamState: unknown,
  since: string,
): Record<string, unknown> {
  const own =
    streamState && typeof streamState === "object"
      ? (streamState as Record<string, unknown>)
      : {};
  const mako = own.mako;
  if (mako !== undefined && (mako === null || typeof mako !== "object")) {
    throw new Error(
      "The connector's state uses the reserved key `mako`; Mako keeps " +
        "`state.mako.since` there. Rename the connector's own key.",
    );
  }
  return {
    ...own,
    mako: { ...((mako as Record<string, unknown>) ?? {}), since },
  };
}

/** Chunk metadata that remembers the run's `since` for the next chunk. */
function withSince(metadata: unknown, since: string | undefined): unknown {
  if (!since) return metadata;
  const base =
    metadata && typeof metadata === "object"
      ? (metadata as Record<string, unknown>)
      : {};
  return { ...base, [MAKO_SINCE_KEY]: since };
}

export class SandboxedConnector extends BaseConnector {
  protected loaded: LoadedConnector | null = null;
  private materializedDir: string | null = null;
  private runtimeId: string | null = null;
  /** The bundle's entry when this connector runs from one; else the definition's. */
  private runEntry: string | null = null;
  private catalogCache: ProtocolMessage | null = null;

  private get slug(): string {
    return slugFromType(this.sourceConnection.type);
  }

  private get workspaceId(): string {
    const id = (this.sourceConnection as { workspaceId?: unknown }).workspaceId;
    if (!id) {
      throw new Error(
        `Workspace connector "${this.sourceConnection.type}" needs a workspaceId on its data source; ` +
          `a workspace connector cannot be resolved globally.`,
      );
    }
    return String(id);
  }

  /** The indexed definition, loaded once per instance. */
  protected async definition(): Promise<LoadedConnector> {
    if (!this.loaded) {
      this.loaded = await loadConnectorDefinition(this.workspaceId, this.slug);
    }
    return this.loaded;
  }

  /**
   * Get the connector's files into the box, once.
   *
   * The folder is read from the repo at the sha the definition was indexed at,
   * never from `main` as it stands now: a sync that started before a push must
   * finish against the code it started with.
   */
  private async ready(): Promise<{
    dir: string;
    runtimeId: string;
    entry: string;
    ctx: ReturnType<typeof syncBoxContext>;
  }> {
    const definition = await this.definition();
    const ctx = syncBoxContext(this.workspaceId);
    await retireLegacySyncBox(this.workspaceId);
    if (!this.materializedDir || !this.runtimeId) {
      const runtimeId = await ensureConnectorRuntime(ctx);
      const files = await readConnectorFolder(
        this.workspaceId,
        definition.slug,
        definition.sha,
      );
      if (shouldBundle(definition.runtime, files)) {
        // A folder with dependencies runs its bundle. A run that finds none
        // for its hash builds it first (RFC connector-runtime §5.1).
        const bundled = await this.prepareBundle({
          ctx,
          runtimeId,
          definition,
          files,
        });
        this.materializedDir = bundled.dir;
        this.runEntry = bundled.entry;
      } else {
        this.materializedDir = await materializeConnector({
          ctx,
          runtimeId,
          slug: definition.slug,
          sourceSha: definition.sourceSha,
          files,
        });
      }
      this.runtimeId = runtimeId;
    }
    return {
      dir: this.materializedDir,
      runtimeId: this.runtimeId,
      entry: this.runEntry ?? definition.entry,
      ctx,
    };
  }

  private folderCache: Map<string, Uint8Array> | null = null;

  /** The folder at the indexed sha, read once per instance. */
  private async folder(definition: LoadedConnector) {
    this.folderCache ??= await readConnectorFolder(
      this.workspaceId,
      definition.slug,
      definition.sha,
    );
    return this.folderCache;
  }

  /** The saved data source's id, or null for a connection not saved yet. */
  private connectionId(): string | null {
    const id = (this.sourceConnection as { _id?: unknown })._id;
    return id ? String(id) : null;
  }

  /**
   * Run one protocol command.
   *
   * Flag off (CONNECTOR_BOX_LEASES unset): exactly the old path, the
   * workspace's one sync box. Flag on: a lease on a box keyed by this
   * connection and the connector's hash, released when the command ends.
   *
   * The one seam between this adapter and the box: everything above it
   * builds inputs and reads messages, and tests replace only this.
   */
  protected async run(
    command: ConnectorCommand,
    options: {
      config?: Record<string, unknown>;
      catalog?: Record<string, unknown>;
      state?: Record<string, unknown> | unknown[];
      maxIterations?: number;
      maxBytes?: number;
      timeoutMs?: number;
    },
  ): Promise<RunResult> {
    if (!connectorBoxLeasesEnabled()) {
      const { dir, runtimeId, entry, ctx } = await this.ready();
      let cleanupFailure: string | null = null;
      let result: RunResult;
      try {
        result = await runConnectorCommand({
          ctx,
          runtimeId,
          connectorDir: dir,
          command,
          entry,
          ...options,
          onCleanupFailure: reason => {
            cleanupFailure = reason;
          },
        });
      } catch (error) {
        // The box may have been killed under this run (another run's failed
        // cleanup retires the whole sync box). Forget what this instance put
        // in it, so the chunk's retry rebuilds a fresh box instead of failing
        // on a connector directory that no longer exists.
        this.materializedDir = null;
        this.runtimeId = null;
        throw error;
      }
      if (cleanupFailure) {
        // The box may hold this run's credential or a live thread of it:
        // kill it, and make the next command rebuild a fresh one.
        this.materializedDir = null;
        this.runtimeId = null;
        await retireSyncBox(this.workspaceId, cleanupFailure);
      }
      return result;
    }

    const definition = await this.definition();
    const saved = this.connectionId();
    return getBoxScheduler().withLease(
      {
        workspaceId: this.workspaceId,
        // A connection being tested before it is saved has no id. It gets a
        // one-off key, so its credential never enters a box another run uses.
        connectionId: saved ?? `unsaved:${randomBytes(8).toString("hex")}`,
        bundleHash: definition.sourceSha,
        command,
        runtimeId: await connectorRuntimeId(),
        timeoutMs: options.timeoutMs,
        oneOff: saved === null,
      },
      async lease => {
        const { dir, runtimeId, entry } = await ensureBundle({
          ctx: lease.ctx,
          hash: definition.sourceSha,
          slug: definition.slug,
          entry: definition.entry,
          files: () => this.folder(definition),
          ensureRuntime: ensureConnectorRuntime,
          bundle: async ({ ctx, runtimeId, files }) =>
            shouldBundle(definition.runtime, files)
              ? this.prepareBundle({ ctx, runtimeId, definition, files })
              : null,
        });
        lease.noteRuntime(runtimeId);
        // Before any credentialed command: the template must hold none.
        await lease.snapshotPristine(runtimeId);
        const result = await runConnectorCommand({
          ctx: lease.ctx,
          runtimeId,
          connectorDir: dir,
          command,
          entry,
          ...options,
          // A run whose cleanup failed may have left its credential or a
          // process behind: the box is killed, never handed to the next run.
          onCleanupFailure: reason => lease.markUnhealthy(reason),
        });
        if (result.timedOut) lease.markFailed("timed out");
        return result;
      },
    );
  }

  private async prepareBundle(input: {
    ctx: ReturnType<typeof syncBoxContext>;
    runtimeId: string;
    definition: LoadedConnector;
    files: Map<string, Uint8Array>;
  }): Promise<{ dir: string; entry: string }> {
    const { ctx, runtimeId, definition, files } = input;
    try {
      const prepared = await prepareBundledConnector({
        ctx,
        runtimeId,
        workspaceId: this.workspaceId,
        slug: definition.slug,
        entry: definition.entry,
        files,
      });
      if (prepared.build) {
        await recordRunBuild({
          workspaceId: this.workspaceId,
          slug: definition.slug,
          sourceSha: definition.sourceSha,
          build: prepared.build,
        });
      }
      return prepared;
    } catch (error) {
      if (error instanceof BundleBuildError) {
        await recordRunBuild({
          workspaceId: this.workspaceId,
          slug: definition.slug,
          sourceSha: definition.sourceSha,
          build: { status: "failed", hash: error.hash, error: error.reason },
        });
      }
      throw error;
    }
  }

  private config(): Record<string, unknown> {
    return (this.sourceConnection.config ?? {}) as Record<string, unknown>;
  }

  /**
   * The config a `read` gets: the credential, plus the batch size and rate
   * limit the engine knows, under the SDK's reserved `__` keys. A box has no
   * other way to learn them.
   *
   * Every saved connection carries `sync_batch_size` 100 and
   * `rate_limit_delay_ms` 200 whether or not anyone chose them: they are
   * filled in at create time (source-connection-create.service.ts). Passing
   * those would override every connector's own defaults. So a setting goes
   * to the box only when it differs from the create-time default, or when
   * the caller passes it in `options`; otherwise the connector's default
   * applies.
   */
  private readConfig(options: ResumableFetchOptions): Record<string, unknown> {
    const settings = (this.sourceConnection.settings ?? {}) as {
      sync_batch_size?: unknown;
      rate_limit_delay_ms?: unknown;
    };
    const positive = (value: unknown): number | undefined =>
      typeof value === "number" && Number.isFinite(value) && value > 0
        ? value
        : undefined;
    const chosen = (value: unknown, createDefault: number) => {
      const number = positive(value);
      return number === createDefault ? undefined : number;
    };
    const pageSize =
      positive(options.batchSize) ??
      chosen(settings.sync_batch_size, CREATE_DEFAULT_BATCH_SIZE);
    const rateLimitDelay =
      positive(options.rateLimitDelay) ??
      chosen(settings.rate_limit_delay_ms, CREATE_DEFAULT_RATE_LIMIT_MS);
    return {
      ...this.config(),
      ...(pageSize !== undefined ? { __page_size: pageSize } : {}),
      ...(rateLimitDelay !== undefined
        ? { __rate_limit_delay_ms: rateLimitDelay }
        : {}),
    };
  }

  /** An entity's declared cursor field, once `discover` has run. */
  private cursorField(entity: string): string | undefined {
    const streams = (this.catalogCache?.catalog as any)?.streams;
    if (!Array.isArray(streams)) return undefined;
    const field = streams.find(
      (s: any) => s?.name === entity,
    )?.default_cursor_field;
    return Array.isArray(field) && typeof field.at(-1) === "string"
      ? field.at(-1)
      : undefined;
  }

  /**
   * The record's own time, never "now" when the record carries one. The
   * entity's cursor field comes first, then update and creation fields, in
   * ISO or Unix-epoch form (see `recordTimestamp`).
   */
  protected resolveRecordTimestamp(payload?: Record<string, unknown>): Date {
    return recordTimestamp(payload) ?? super.resolveRecordTimestamp(payload);
  }

  normalizeBackfillRecord(
    entity: string,
    record: Record<string, unknown>,
  ): NormalizedCdcRecord | null {
    const normalized = super.normalizeBackfillRecord(entity, record);
    if (!normalized) return null;
    return {
      ...normalized,
      sourceTs:
        recordTimestamp(record, this.cursorField(entity)) ??
        normalized.sourceTs,
    };
  }

  async testConnection(): Promise<ConnectionTestResult> {
    try {
      const result = await this.run("check", { config: this.config() });
      const failure = failureMessage(result);
      if (failure) return { success: false, message: failure };

      const status = firstOfType<{
        connectionStatus?: { status?: string; message?: string };
      }>(result.messages, "CONNECTION_STATUS");
      if (!status?.connectionStatus) {
        return {
          success: false,
          message: "The connector ran but never reported a connection status.",
        };
      }
      const succeeded = status.connectionStatus.status === "SUCCEEDED";
      return {
        success: succeeded,
        message:
          status.connectionStatus.message ??
          (succeeded ? "Connection successful" : "Connection failed"),
      };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * The entity list, from the index rather than from a sandbox.
   *
   * This is called on hot UI paths (the flow form, a listing), and it is
   * synchronous by contract, so it can only ever answer from what the push
   * reconciler already stored.
   */
  getAvailableEntities(): string[] {
    return this.loaded?.entities ?? [];
  }

  getEntityMetadata(): EntityMetadata[] {
    const declared = (this.loaded?.spec?.mako as any)?.entities ?? {};
    return this.getAvailableEntities().map(name => ({
      name,
      label:
        declared?.[name]?.label ?? name.charAt(0).toUpperCase() + name.slice(1),
      description: declared?.[name]?.description,
      // The SDK puts an entity's declared `layout` in its spec; it is the
      // in-process `layoutSuggestion`, under the name RFC §4 gives it.
      ...(declared?.[name]?.layout
        ? { layoutSuggestion: declared[name].layout }
        : {}),
    }));
  }

  /** Warm `getAvailableEntities` for callers that can await. */
  async loadDefinition(): Promise<void> {
    await this.definition();
  }

  /**
   * Pin a connection check to the code this instance will run.
   *
   * Calling this before `testConnection` warms the same cached definition that
   * `ready` consumes, so a concurrent push cannot make the test and the status
   * update refer to different source revisions.
   */
  async sourceShaForConnectionCheck(): Promise<string> {
    return (await this.definition()).sourceSha;
  }

  private async catalog(): Promise<ProtocolMessage | null> {
    if (this.catalogCache) return this.catalogCache;
    const result = await this.run("discover", { config: this.config() });
    const failure = failureMessage(result);
    if (failure) throw new Error(`discover failed: ${failure}`);
    this.catalogCache = firstOfType(result.messages, "CATALOG") ?? null;
    return this.catalogCache;
  }

  async resolveSchema(entity: string): Promise<ConnectorEntitySchema | null> {
    const catalog = await this.catalog();
    const streams = (catalog?.catalog as any)?.streams;
    if (!Array.isArray(streams)) return null;
    const stream = streams.find((candidate: any) => candidate?.name === entity);
    if (!stream) return null;
    return jsonSchemaToEntitySchema(entity, stream);
  }

  /**
   * One chunk of a sync.
   *
   * The engine asks for at most `maxIterations` pages and expects to be able
   * to resume. The SDK's `read` takes that budget and exits, so a chunk is one
   * process: nothing is left running between chunks, and there is no detached
   * stream to reattach to. Foreign runtimes whose `read` cannot be told to
   * stop need a different adapter, and they are not this iteration.
   */
  async fetchEntityChunk(options: ResumableFetchOptions): Promise<FetchState> {
    // The entity check needs the indexed definition only. The box is taken
    // (flag off: readied; flag on: leased) by `run`, for the command itself.
    await this.definition();

    // An entity the connector does not declare is a failure, not an empty
    // sync. The runner's stream selection silently drops an unknown name, so
    // a flow whose `entityFilter` points at an entity a later push renamed or
    // removed would otherwise report a successful sync of zero rows forever.
    const declared = this.getAvailableEntities();
    if (declared.length > 0 && !declared.includes(options.entity)) {
      throw new Error(
        `The connector "${this.slug}" has no entity "${options.entity}". ` +
          `It offers: ${declared.join(", ")}.`,
      );
    }

    const previous = options.state;
    let maxIterations = options.maxIterations ?? 10;
    const maxBytes = CHUNK_BYTE_BUDGET;
    const read = () =>
      this.run("read", {
        config: this.readConfig(options),
        catalog: {
          streams: [
            { stream: { name: options.entity }, sync_mode: "incremental" },
          ],
        },
        state: readState(options.entity, previous?.metadata, options.since),
        maxIterations,
        maxBytes,
      });

    // A chunk over the protocol cap fails the same way every time it is
    // retried as it was: same state, same pages, same bytes. The byte budget
    // already ends a chunk after the page that crosses half the cap, so an
    // over-cap chunk means its last page was large. Retry once with a single
    // page. If one page alone is over the cap, no budget can help: fail at
    // once, and tell Inngest not to replay the same read.
    let result: RunResult;
    for (;;) {
      try {
        result = await read();
        break;
      } catch (error) {
        if (!(error instanceof ConnectorOutputTooLargeError)) throw error;
        if (maxIterations <= 1) {
          throw new NonRetriableError(
            `read failed for "${options.entity}": one page of it is over the ` +
              `${MAX_CONNECTOR_PROTOCOL_BYTES}-byte chunk cap. Lower the ` +
              `connection's batch size. (${error.message})`,
            { cause: error },
          );
        }
        maxIterations = 1;
        options.onLog?.(
          "warn",
          `A chunk of "${options.entity}" was over the protocol cap; retrying it with one page.`,
        );
      }
    }

    const failure = failureMessage(result);
    if (failure) {
      throw new Error(`read failed for "${options.entity}": ${failure}`);
    }

    const records: unknown[] = [];
    let stateMessage: ProtocolMessage | undefined;
    for (const message of result.messages) {
      if (message.type === "RECORD") {
        const record = message.record as { stream?: string; data?: unknown };
        if (record?.stream === options.entity) records.push(record.data);
      } else if (message.type === "STATE") {
        stateMessage = message;
      } else if (message.type === "LOG") {
        // The connector's own log lines belong in the flow run's log, where
        // whoever wrote the connector will look when a sync misbehaves.
        const log = message.log as { message?: string; level?: string };
        if (log?.message) options.onLog?.(mapLogLevel(log.level), log.message);
      }
    }

    if (records.length > 0) {
      const batchSize = options.batchSize ?? records.length;
      for (let i = 0; i < records.length; i += batchSize) {
        await options.onBatch(records.slice(i, i + batchSize));
      }
      options.onProgress?.(records.length);
    }

    const state = (stateMessage?.state ?? {}) as {
      mako?: { hasMore?: boolean };
      stream?: unknown;
    };
    // No STATE at all means the connector never checkpointed. Treating that as
    // "there is more" would re-read the same first chunk forever, so an absent
    // state ends the entity rather than looping.
    const hasMore = state.mako?.hasMore === true;

    return {
      totalProcessed: (previous?.totalProcessed ?? 0) + records.length,
      hasMore,
      iterationsInChunk: maxIterations,
      metadata: withSince(
        stateMessage?.state ?? previous?.metadata,
        chunkSince(options.since, previous?.metadata),
      ),
    };
  }

  supportsResumableFetching(): boolean {
    return true;
  }

  /** The unbounded form, for callers that predate chunking. */
  async fetchEntity(options: FetchOptions): Promise<void> {
    let state: FetchState | undefined;
    // A ceiling rather than `while (hasMore)`: a connector whose state never
    // advances would otherwise spin here until the process is killed.
    for (let chunk = 0; chunk < 10_000; chunk++) {
      state = await this.fetchEntityChunk({ ...options, state });
      if (!state.hasMore) return;
    }
    logger.warn("fetchEntity stopped at the chunk ceiling", {
      type: this.sourceConnection.type,
      entity: options.entity,
    });
  }

  getIncrementalCapabilities(): IncrementalCapabilities {
    // Honest by default: only entities whose spec declares what they do with
    // `state.mako.since` (the SDK's `incremental`) are offered incremental. A
    // connector that declares nothing re-reads everything, and says so.
    const declared = ((this.loaded?.spec?.mako as any)?.entities ??
      {}) as Record<string, { incremental?: unknown }>;
    const modes = new Set(["native", "client-filter", "created-anchor"]);
    const perEntity: NonNullable<IncrementalCapabilities["perEntity"]> = {};
    for (const name of this.getAvailableEntities()) {
      const mode = declared[name]?.incremental;
      perEntity[name] = {
        mode:
          typeof mode === "string" && modes.has(mode)
            ? (mode as IncrementalCapabilities["mode"])
            : "none",
      };
    }
    const supported = Object.values(perEntity).some(e => e.mode !== "none");
    if (!supported) return { supported: false, mode: "none" };
    return { supported: true, mode: "none", perEntity };
  }

  getMetadata(): {
    name: string;
    version: string;
    description: string;
    author?: string;
    supportedEntities: string[];
  } {
    const mako = (this.loaded?.spec?.mako ?? {}) as {
      name?: string;
      version?: string;
    };
    return {
      name: mako.name ?? this.slug,
      version: mako.version ?? "0.0.0",
      description: `${this.slug} (workspace connector)`,
      supportedEntities: this.getAvailableEntities(),
    };
  }
}
