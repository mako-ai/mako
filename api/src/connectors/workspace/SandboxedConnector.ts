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
  type ProvisionWebhookOptions,
  type ProvisionWebhookResult,
  type ResumableFetchOptions,
  type UpdateWebhookSubscriptionOptions,
  type WebhookCapabilities,
  type WebhookHandlerOptions,
  type WebhookVerificationResult,
} from "../base/BaseConnector";
import { createHash, randomBytes } from "node:crypto";
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
import { connectorRegistryEnabled } from "./registry/flag";
import { isTwinCodeAllowed, twinCodeRefusal } from "../boxed-runtime/twin-code";

type BoxedPin = { connectionType: string; sourceSha?: string };
import { prepareRegistryConnector } from "./registry/registry.service";
import {
  connectorRuntimeId,
  ensureConnectorRuntime,
  loadConnectorDefinition,
  readConnectorFolder,
  type LoadedConnector,
} from "./resolver";
import { connectorBoxLeasesEnabled } from "./boxes/config";
import { getBoxScheduler } from "./boxes/scheduler";
import { connectorSessionReadsEnabled } from "./session-config";
import { connectorWebhookBatchesEnabled } from "./webhook-config";
import {
  hasWebhookProvisioner,
  webhookProvisionerFor,
} from "./webhook-provisioners";
import {
  declaredWebhookVerification,
  verifyDeclaredWebhook,
} from "./webhook-verification";
import {
  boxSessionTransport,
  sessionReadsSupported,
  type ReadSessionTransport,
  type SessionHandle,
} from "./session-read";

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

/**
 * Where a read session is: its id, its box, the last batch this read applied
 * (`seq`) and the fingerprint of what it reads with. The next chunk pulls
 * `seq + 1`, and a retry of this chunk pulls `seq` again, never a later one.
 * `unsupported` means the runner cannot do sessions, so the rest of the read
 * goes chunk by chunk.
 *
 * It lives in `FetchState.readSession`, beside the metadata, never in it:
 * the metadata is the connector's own STATE, and a connector that could
 * write this pointer could aim the next chunk at another read's session, to
 * close it or to take its batches. Only this file writes `readSession`, and
 * only from the session the API itself started. It names the connection
 * and the entity it belongs to, and a pointer for any other is ignored.
 */
type SessionPointer = {
  id: string;
  box?: string;
  seq: number;
  entity: string;
  connection: string;
  fp?: string;
};
type SessionMeta = SessionPointer | { unsupported: true };

/**
 * The key the first sessions kept in the metadata. A connector's STATE may
 * still carry it; it is stripped and never read.
 */
export const MAKO_SESSION_KEY = "makoSession";

function sessionMeta(
  state: FetchState | undefined,
  connection: string,
): SessionMeta | undefined {
  const value = state?.readSession;
  if (!value || typeof value !== "object") return undefined;
  const meta = value as Record<string, unknown>;
  if (meta.unsupported === true) return { unsupported: true };
  if (
    typeof meta.id === "string" &&
    /^[a-f0-9]{16}$/.test(meta.id) &&
    typeof meta.entity === "string" &&
    meta.connection === connection &&
    Number.isSafeInteger(meta.seq) &&
    (meta.seq as number) >= 1
  ) {
    return {
      id: meta.id,
      box: typeof meta.box === "string" ? meta.box : undefined,
      seq: meta.seq as number,
      entity: meta.entity,
      connection,
      fp: typeof meta.fp === "string" ? meta.fp : undefined,
    };
  }
  return undefined;
}

/** The chunk metadata without the session's own key: the read's state. */
function withoutSession(metadata: unknown): unknown {
  if (!metadata || typeof metadata !== "object") return metadata;
  if (!(MAKO_SESSION_KEY in (metadata as Record<string, unknown>))) {
    return metadata;
  }
  const { [MAKO_SESSION_KEY]: _session, ...rest } = metadata as Record<
    string,
    unknown
  >;
  return rest;
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
      const loaded = await loadConnectorDefinition(this.workspaceId, this.slug);
      // A built-in connection read by its folder twin carries the code its
      // approval allows (connectors/boxed-runtime). Checked on the very
      // definition this instance runs, so a push after the runtime check
      // cannot hand the key to other code.
      const pin = (this.sourceConnection as { boxedPin?: BoxedPin }).boxedPin;
      if (pin && !isTwinCodeAllowed(loaded, pin, pin.connectionType)) {
        throw new NonRetriableError(twinCodeRefusal(this.slug));
      }
      this.loaded = loaded;
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
      if (definition.registry) {
        // Installed by reference: the folder holds no code. Run the registry
        // version the push resolved, never whatever is newest now.
        if (!connectorRegistryEnabled()) {
          throw new Error(
            `The connector "${definition.slug}" is installed by reference (${definition.registry.ref}), ` +
              `and install by reference is off on this Mako (CONNECTOR_REGISTRY_ENABLED).`,
          );
        }
        const installed = await prepareRegistryConnector({
          ctx,
          runtimeId,
          registry: definition.registry,
        });
        this.materializedDir = installed.dir;
        this.runEntry = installed.entry;
        this.runtimeId = runtimeId;
        return { dir: installed.dir, runtimeId, entry: installed.entry, ctx };
      }
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

  /** The connection a read session pointer belongs to. */
  private sessionOwner(): string {
    return (
      this.connectionId() ??
      String((this.sourceConnection as { id?: unknown }).id ?? "")
    );
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
      batch?: Record<string, unknown>;
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
        // Checked once per box incarnation, not per chunk: on a warm box the
        // runtime and the connector are known to be there (BoxLease.memo).
        const { dir, runtimeId, entry } = await lease.memo(
          `bundle:${await connectorRuntimeId()}:${definition.sourceSha}`,
          () =>
            ensureBundle({
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
            }),
        );
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
        // A connector that failed may have failed on a missing file: check
        // the installs again next time instead of trusting the memo.
        if (result.exitCode !== 0) lease.forgetMemo();
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
   *
   * With CONNECTOR_SESSION_READS, a chunk is one batch of a read session
   * instead: one process reads the whole entity, chunk after chunk, and each
   * call here takes the next batch (`fetchViaSession`). The batches are the
   * chunks a chunk process would have read, so rows and states are the same.
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
    const session = sessionMeta(previous, this.sessionOwner());
    let maxIterations = options.maxIterations ?? 10;
    let sessionUnsupported = session !== undefined && "unsupported" in session;

    // A probe reads one chunk and drops its state: a session would stay
    // open, reading ahead, until its idle timeout.
    if (!sessionUnsupported && !options.singleChunk) {
      const transport = await this.sessionTransport();
      if (transport) {
        const viaSession = await this.fetchViaSession(
          transport,
          options,
          session && "id" in session ? session : undefined,
        );
        if ("state" in viaSession) return viaSession.state;
        if (viaSession.fallback === "unsupported") sessionUnsupported = true;
        if (viaSession.fallback === "too-large") {
          // As the chunk path's own retry below: one page this time.
          maxIterations = 1;
          options.onLog?.(
            "warn",
            `A batch of "${options.entity}" was over the protocol cap; reading this chunk with one page.`,
          );
        }
      }
    }

    const base = withoutSession(previous?.metadata);
    const maxBytes = CHUNK_BYTE_BUDGET;
    const read = () =>
      this.run("read", {
        config: this.readConfig(options),
        catalog: this.readCatalog(options.entity),
        state: readState(options.entity, base, options.since),
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
    const state = await this.applyRead(result, options, maxIterations);
    if (sessionUnsupported) state.readSession = { unsupported: true };
    return state;
  }

  /** The catalog of a one-entity read. */
  private readCatalog(entity: string): Record<string, unknown> {
    return {
      streams: [{ stream: { name: entity }, sync_mode: "incremental" }],
    };
  }

  /**
   * One chunk's messages -> the engine's batches and its next state. The
   * same for a chunk process and a session batch, so the two cannot drift.
   */
  private async applyRead(
    result: RunResult,
    options: ResumableFetchOptions,
    maxIterations: number,
  ): Promise<FetchState> {
    const previous = options.state;
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
      // The connector's STATE, never with a session pointer in it: it may
      // carry one, and the engine's own lives in `readSession`.
      metadata: withSince(
        withoutSession(stateMessage?.state ?? previous?.metadata),
        chunkSince(options.since, previous?.metadata),
      ),
    };
  }

  /**
   * The read session this chunk reads through, or null for chunk processes.
   *
   * Sessions need CONNECTOR_SESSION_READS, a box with real Unix users, and
   * the workspace's sync box (CONNECTOR_BOX_LEASES off). A lease holds a box
   * for one command and is released when it ends; a session needs its box
   * for the whole read, across Inngest steps, which leases do not offer yet.
   *
   * The seam tests replace.
   */
  protected async sessionTransport(): Promise<ReadSessionTransport | null> {
    if (!connectorSessionReadsEnabled()) return null;
    if (connectorBoxLeasesEnabled() || !sessionReadsSupported()) return null;
    const { dir, runtimeId, entry, ctx } = await this.ready();
    return boxSessionTransport({
      ctx,
      runtimeId,
      connectorDir: dir,
      entry,
      onCleanupFailure: async reason => {
        // The box may hold a credential or a live thread of the run: kill
        // it, and make the next command rebuild a fresh one.
        this.materializedDir = null;
        this.runtimeId = null;
        await retireSyncBox(this.workspaceId, reason);
      },
    });
  }

  /**
   * One chunk through a read session: batch `seq + 1` of the session the
   * metadata names, or batch 1 of a new one started from the last applied
   * state. Returns the chunk's state, or says why this chunk must be read
   * as a chunk process instead.
   *
   * - A retry of a chunk carries the same metadata, so it asks for the same
   *   batch, which is still there: it was not acknowledged. A batch is
   *   acknowledged only by the pull of the next one.
   * - A session that is gone (its box replaced or killed, reaped after the
   *   API stopped asking, past its deadline) is started again from the last
   *   applied state, which is exactly where a chunk process would resume.
   * - A read that fails closes its session; the retry starts a new one.
   */
  private async fetchViaSession(
    transport: ReadSessionTransport,
    options: ResumableFetchOptions,
    meta: SessionPointer | undefined,
  ): Promise<
    { state: FetchState } | { fallback: "unsupported" | "too-large" }
  > {
    const previous = options.state;
    const maxIterations = options.maxIterations ?? 10;
    let handle: SessionHandle | undefined;
    let seq = 1;
    let outcome: Awaited<ReturnType<ReadSessionTransport["pull"]>> | undefined;
    let fresh = false;
    const config = this.readConfig(options);
    // What a session was started with: the config Mako would send now and
    // the code it would run. A chunk process re-reads both every chunk; a
    // session that no longer matches is replaced, from the applied state.
    const fp = await this.sessionFingerprint(config, options);

    if (meta && meta.entity === options.entity && meta.fp !== fp) {
      logger.info(
        "Read session started with other config or code; replacing it",
        {
          type: this.sourceConnection.type,
          entity: options.entity,
          sessionId: meta.id,
        },
      );
      await transport.close({ id: meta.id, box: meta.box });
    } else if (meta && meta.entity === options.entity) {
      handle = { id: meta.id, box: meta.box };
      seq = meta.seq + 1;
      outcome = await transport.pull(handle, seq);
      if (outcome.kind === "lost") {
        logger.info("Read session lost; resuming from the last applied state", {
          type: this.sourceConnection.type,
          entity: options.entity,
          sessionId: meta.id,
          reason: outcome.reason,
        });
        outcome = undefined;
      }
    }
    if (!outcome) {
      fresh = true;
      const started = await transport.start({
        config,
        catalog: this.readCatalog(options.entity),
        state: readState(
          options.entity,
          withoutSession(previous?.metadata),
          options.since,
        ),
        maxIterations,
        maxBytes: CHUNK_BYTE_BUDGET,
        since: chunkSince(options.since, previous?.metadata),
      });
      handle = started.handle;
      seq = 1;
      outcome = started.outcome;
    }
    const current = handle as SessionHandle;
    if (outcome.kind === "lost") {
      // Only a fresh session gets here: a lost one was started again above.
      await transport.close(current);
      throw new Error(
        `read failed for "${options.entity}": its session ended before its first batch (${outcome.reason}).`,
      );
    }

    if (outcome.kind !== "batch") {
      await transport.close(current);
      return { fallback: outcome.kind };
    }
    if (outcome.seq !== seq) {
      await transport.close(current);
      throw new Error(
        `read session for "${options.entity}" returned batch ${outcome.seq} for ${seq}.`,
      );
    }
    const failure = failureMessage(outcome.result);
    if (failure) {
      await transport.close(current);
      throw new Error(`read failed for "${options.entity}": ${failure}`);
    }
    // A failed write leaves a resumed session as it is: the retry asks for
    // this same batch, which stays until the next one is pulled. A session
    // started by this call is known to nobody else, so it is closed: the
    // retry starts its own from the same applied state.
    let state: FetchState;
    try {
      state = await this.applyRead(outcome.result, options, maxIterations);
    } catch (error) {
      if (fresh) await transport.close(current).catch(() => undefined);
      throw error;
    }
    if (!state.hasMore) {
      await transport.close(current);
      return { state };
    }
    const pointer: SessionPointer = {
      id: current.id,
      ...(current.box ? { box: current.box } : {}),
      seq,
      entity: options.entity,
      connection: this.sessionOwner(),
      fp,
    };
    state.readSession = pointer;
    return { state };
  }

  /**
   * A short hash of what a session reads with: its config (credential
   * included), the connector's source, the SDK runtime and the page budget.
   * An API deploy that ships another SDK replaces a session, never reuses
   * it. Salted with the workspace id and kept to 16 hex characters: it tells two configs apart
   * and says nothing about either.
   */
  private async sessionFingerprint(
    config: Record<string, unknown>,
    options: ResumableFetchOptions,
  ): Promise<string> {
    const definition = await this.definition();
    return createHash("sha256")
      .update(this.workspaceId)
      .update("\0")
      .update(JSON.stringify(config))
      .update("\0")
      .update(definition.sourceSha)
      .update("\0")
      .update(await this.sessionRuntimeId())
      .update("\0")
      .update(String(options.maxIterations ?? 10))
      .digest("hex")
      .slice(0, 16);
  }

  /** The SDK runtime a session would run on now. The seam tests replace. */
  protected async sessionRuntimeId(): Promise<string> {
    return connectorRuntimeId();
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

  /**
   * Webhooks, with CONNECTOR_WEBHOOK_BATCHES on. The route then verifies
   * every delivery here, in the API, against the scheme the connector
   * declared; one that declares none is refused (`verifyWebhook`). Off:
   * exactly the old path.
   */
  supportsWebhooks(): boolean {
    return connectorWebhookBatchesEnabled();
  }

  webhookDelivery(): "inline" | "box" {
    return connectorWebhookBatchesEnabled() ? "box" : "inline";
  }

  getSupportedWebhookEvents(): string[] {
    const events = (this.loaded?.spec?.mako as any)?.webhooks?.events;
    return Array.isArray(events)
      ? events.filter((e: unknown): e is string => typeof e === "string")
      : [];
  }

  /**
   * The signature check, in the API, with the flow's secret. The secret is
   * used here and nowhere else: no box, and no connector code, sees it. The
   * scheme comes from the spec indexed at push time, never from a run.
   */
  async verifyWebhook(
    options: WebhookHandlerOptions,
  ): Promise<WebhookVerificationResult> {
    if (!connectorWebhookBatchesEnabled()) {
      return { valid: false, error: "Webhook batches are off" };
    }
    const declaration = declaredWebhookVerification(
      (await this.definition()).spec,
    );
    if (!declaration) {
      return {
        valid: false,
        error: `The connector "${this.slug}" declares no webhook verification Mako can run.`,
      };
    }
    return verifyDeclaredWebhook(declaration, {
      payload:
        typeof options.payload === "string"
          ? options.payload
          : JSON.stringify(options.payload),
      headers: options.headers,
      secret: options.secret,
    });
  }

  /**
   * Provider subscriptions, made by the API with the connection's key
   * (webhook-provisioners.ts), for a folder whose vendor Mako knows. The
   * signing secret the vendor returns goes onto the flow, never to a box.
   * Both "update" and "create" adopt a subscription already on the URL, so
   * provisioning on save never makes a duplicate.
   */
  supportsWebhookProvisioning(): boolean {
    return connectorWebhookBatchesEnabled() && hasWebhookProvisioner(this.slug);
  }

  supportsWebhookSubscriptionUpdate(): boolean {
    return this.supportsWebhookProvisioning();
  }

  getWebhookCapabilities(): WebhookCapabilities {
    const provisioning = this.supportsWebhookProvisioning();
    return {
      supported: this.supportsWebhooks(),
      provisioning: {
        supported: provisioning,
        providerLabel: this.getMetadata().name,
        storesSecretAutomatically: provisioning,
      },
      secretHelpText: "Enter the webhook signing secret from your provider",
    };
  }

  async createWebhookSubscription(
    options: ProvisionWebhookOptions,
  ): Promise<ProvisionWebhookResult> {
    return (await this.webhookProvisioner()).create(options);
  }

  async updateWebhookSubscription(
    options: UpdateWebhookSubscriptionOptions,
  ): Promise<ProvisionWebhookResult | null> {
    return (await this.webhookProvisioner()).update(options);
  }

  /** Refused unless the flag is on and the folder declares a scheme Mako runs. */
  private async webhookProvisioner() {
    if (!this.supportsWebhookProvisioning()) {
      throw new Error(
        `The connector "${this.slug}" cannot provision webhooks here.`,
      );
    }
    if (!declaredWebhookVerification((await this.definition()).spec)) {
      throw new Error(
        `The connector "${this.slug}" declares no webhook verification Mako can run.`,
      );
    }
    return webhookProvisionerFor(this.slug, this.config());
  }

  /** The entities the indexed connector declares, once loaded. */
  async declaredEntities(): Promise<string[]> {
    return (await this.definition()).entities ?? [];
  }

  /**
   * One webhook batch in the box: `mako-connector webhook --config --batch`.
   * The config is the connection's, as a read gets it; the batch holds the
   * stored events and nothing else. Its answer is checked by the caller
   * (webhook-batch.ts), which trusts nothing in it.
   */
  async runWebhookBatch(
    batch: { events: Array<Record<string, unknown>> },
    options: { timeoutMs: number },
  ): Promise<RunResult> {
    await this.definition();
    return this.run("webhook", {
      config: this.readConfig({} as ResumableFetchOptions),
      batch,
      timeoutMs: options.timeoutMs,
    });
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
      description: this.loaded?.registry
        ? `${this.slug} (${this.loaded.registry.ref}, version ${this.loaded.registry.version})`
        : `${this.slug} (workspace connector)`,
      supportedEntities: this.getAvailableEntities(),
    };
  }
}
