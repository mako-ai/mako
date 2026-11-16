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
  type ConnectionTestResult,
  type ConnectorEntitySchema,
  type EntityMetadata,
  type FetchOptions,
  type FetchState,
  type IncrementalCapabilities,
  type ResumableFetchOptions,
} from "../base/BaseConnector";
import { randomBytes } from "node:crypto";
import { loggers } from "../../logging";
import {
  ensureBundle,
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

export class SandboxedConnector extends BaseConnector {
  private loaded: LoadedConnector | null = null;
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
  private async definition(): Promise<LoadedConnector> {
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
   */
  private async run(
    command: ConnectorCommand,
    options: {
      config?: Record<string, unknown>;
      catalog?: Record<string, unknown>;
      state?: Record<string, unknown> | unknown[];
      maxIterations?: number;
      timeoutMs?: number;
    },
  ): Promise<RunResult> {
    if (!connectorBoxLeasesEnabled()) {
      const { dir, runtimeId, entry, ctx } = await this.ready();
      let cleanupFailure: string | null = null;
      const result = await runConnectorCommand({
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
    // Flag off keeps the old order: the box is readied before the entity
    // check. With leases the box is taken only for the command itself.
    if (connectorBoxLeasesEnabled()) await this.definition();
    else await this.ready();

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

    const maxIterations = options.maxIterations ?? 10;
    const previous = options.state;

    const result = await this.run("read", {
      config: this.config(),
      catalog: {
        streams: [
          { stream: { name: options.entity }, sync_mode: "incremental" },
        ],
      },
      state: previous?.metadata ? [previous.metadata] : undefined,
      maxIterations,
    });

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
      metadata: stateMessage?.state ?? previous?.metadata,
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
    // Honest by default. A workspace connector declares an incremental cursor
    // per stream in `discover`, which is not knowable synchronously here, and
    // claiming "supported" without knowing would let the UI offer an
    // incremental sync that silently re-reads everything.
    return { supported: false, mode: "none" };
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
