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
import { loggers } from "../../logging";
import {
  failureMessage,
  firstOfType,
  materializeConnector,
  runConnectorCommand,
  syncBoxContext,
  type ProtocolMessage,
} from "./sync-box";
import { jsonSchemaToEntitySchema } from "./spec-translation";
import {
  ensureConnectorRuntime,
  loadConnectorDefinition,
  readConnectorFolder,
  type LoadedConnector,
} from "./resolver";

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
  private catalogCache: ProtocolMessage | null = null;

  private get slug(): string {
    return slugFromType(this.dataSource.type);
  }

  private get workspaceId(): string {
    const id = (this.dataSource as { workspaceId?: unknown }).workspaceId;
    if (!id) {
      throw new Error(
        `Workspace connector "${this.dataSource.type}" needs a workspaceId on its data source; ` +
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
    entry: string;
    ctx: ReturnType<typeof syncBoxContext>;
  }> {
    const definition = await this.definition();
    const ctx = syncBoxContext(this.workspaceId);
    if (!this.materializedDir) {
      await ensureConnectorRuntime(ctx);
      const files = await readConnectorFolder(
        this.workspaceId,
        definition.slug,
        definition.sha,
      );
      this.materializedDir = await materializeConnector({
        ctx,
        slug: definition.slug,
        sourceSha: definition.sourceSha,
        files,
      });
    }
    return { dir: this.materializedDir, entry: definition.entry, ctx };
  }

  private config(): Record<string, unknown> {
    return (this.dataSource.config ?? {}) as Record<string, unknown>;
  }

  async testConnection(): Promise<ConnectionTestResult> {
    try {
      const { dir, entry, ctx } = await this.ready();
      const result = await runConnectorCommand({
        ctx,
        connectorDir: dir,
        command: "check",
        entry,
        config: this.config(),
      });
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

  private async catalog(): Promise<ProtocolMessage | null> {
    if (this.catalogCache) return this.catalogCache;
    const { dir, entry, ctx } = await this.ready();
    const result = await runConnectorCommand({
      ctx,
      connectorDir: dir,
      command: "discover",
      entry,
      config: this.config(),
    });
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
    const { dir, entry, ctx } = await this.ready();

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

    const result = await runConnectorCommand({
      ctx,
      connectorDir: dir,
      command: "read",
      entry,
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
      type: this.dataSource.type,
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
