import { createHash } from "crypto";
import { Storage, type Bucket, type File } from "@google-cloud/storage";
import {
  BaseConnector,
  ConnectionTestResult,
  FetchOptions,
  ResumableFetchOptions,
  FetchState,
  EntityMetadata,
  type ConnectorEntitySchema,
  type IncrementalCapabilities,
} from "../base/BaseConnector";
import { loggers } from "../../logging";
import { fileMatchesGlob, parseCsvStream } from "./csv";
import { resolveGcsEntitySchema } from "./schema";

const logger = loggers.connector("gcs");

interface GcsFolderQuery {
  name: string;
  prefix?: string;
  glob?: string;
  delimiter?: string;
  has_header?: boolean;
  primary_key?: string;
  batch_size?: number;
}

interface PendingObject {
  name: string;
  generation?: string;
  updated?: string;
  size?: number;
}

interface GcsFetchMetadata {
  pending?: PendingObject[];
  current?: PendingObject | null;
  rowOffset?: number;
  listed?: boolean;
  initialCount?: number;
}

function stripGsPrefix(bucket: string): string {
  return bucket.replace(/^gs:\/\//i, "").replace(/\/+$/, "");
}

/** Resolve a user-entered folder prefix to a GCS object prefix. */
export function resolveObjectPrefix(
  prefix: string | undefined,
  bucketName: string,
): string {
  if (!prefix) return "";
  let p = prefix.trim();
  if (/^gs:\/\//i.test(p)) {
    p = p.replace(/^gs:\/\//i, "");
    if (p === bucketName) return "";
    if (p.startsWith(`${bucketName}/`)) {
      return p.slice(bucketName.length + 1);
    }
    const slash = p.indexOf("/");
    return slash >= 0 ? p.slice(slash + 1) : "";
  }
  if (p.startsWith(`${bucketName}/`)) {
    return p.slice(bucketName.length + 1);
  }
  return p.replace(/^\/+/, "");
}

export class GcsConnector extends BaseConnector {
  private storage: Storage | null = null;

  static getConfigSchema() {
    return {
      fields: [
        {
          name: "service_account_json",
          label: "Google Service Account JSON",
          type: "textarea",
          required: true,
          rows: 10,
          encrypted: true,
          placeholder: `{
  "type": "service_account",
  "project_id": "your-project",
  "private_key_id": "...",
  "private_key": "-----BEGIN PRIVATE KEY-----\\n...\\n-----END PRIVATE KEY-----\\n",
  "client_email": "svc@project.iam.gserviceaccount.com",
  "token_uri": "https://oauth2.googleapis.com/token"
}`,
          helperText:
            "Service account with roles/storage.objectViewer on the bucket. Stored encrypted.",
        },
        {
          name: "bucket",
          label: "Bucket",
          type: "string",
          required: true,
          placeholder: "realadvisor-sway",
          helperText: "Bucket name (with or without gs:// prefix)",
        },
        {
          name: "project_id",
          label: "Project ID (optional)",
          type: "string",
          required: false,
          helperText:
            "Defaults to project_id from the service account JSON when omitted",
        },
      ],
      // Folders / datasets are configured at the Flow level
      transferQueries: {
        label: "Folders",
        required: true,
        fields: [
          {
            name: "name",
            label: "Entity Name",
            type: "string",
            required: true,
            placeholder: "daily_exports",
            helperText: "Destination entity / table name for this folder",
          },
          {
            name: "prefix",
            label: "Folder Prefix",
            type: "string",
            required: false,
            placeholder: "exports/daily/",
            helperText:
              "Object prefix inside the bucket. Leave empty for the bucket root.",
          },
          {
            name: "glob",
            label: "File Pattern",
            type: "string",
            required: false,
            default: "*.csv",
            placeholder: "*.csv",
            helperText: "Simple glob against the file name (e.g. *.csv)",
          },
          {
            name: "delimiter",
            label: "CSV Delimiter",
            type: "string",
            required: false,
            default: ",",
            placeholder: ",",
          },
          {
            name: "has_header",
            label: "Has Header Row",
            type: "checkbox",
            required: false,
            default: true,
          },
          {
            name: "primary_key",
            label: "Primary Key Column",
            type: "string",
            required: false,
            placeholder: "id",
            helperText:
              "CSV column used as record id. If empty, a hash of (file + row index) is used.",
          },
          {
            name: "batch_size",
            label: "Batch Size",
            type: "number",
            required: false,
            default: 1000,
            helperText: "Rows per onBatch callback",
          },
        ],
      },
    };
  }

  getMetadata() {
    return {
      name: "Google Cloud Storage",
      version: "1.0.0",
      description:
        "Import CSV files from a GCS bucket. Discovers new/changed objects under a folder prefix.",
      supportedEntities: this.getAvailableEntities(),
    };
  }

  validateConfig() {
    const base = super.validateConfig();
    const errors = [...base.errors];

    if (!this.dataSource.config.bucket) {
      errors.push("Bucket is required");
    }

    if (!this.dataSource.config.service_account_json) {
      errors.push("Service account JSON is required");
    } else if (
      typeof this.dataSource.config.service_account_json === "string"
    ) {
      try {
        const sa = JSON.parse(this.dataSource.config.service_account_json);
        if (!sa.client_email || !sa.private_key) {
          errors.push(
            "Service account JSON must include client_email and private_key",
          );
        }
      } catch {
        errors.push("Service account JSON must be valid JSON");
      }
    }

    if (
      this.dataSource.config.queries &&
      Array.isArray(this.dataSource.config.queries)
    ) {
      this.dataSource.config.queries.forEach(
        (query: GcsFolderQuery, index: number) => {
          if (!query?.name) {
            errors.push(`Folder #${index + 1}: entity name is required`);
          }
        },
      );
    }

    return { valid: errors.length === 0, errors };
  }

  private getCredentials(): {
    credentials: Record<string, unknown>;
    projectId?: string;
  } {
    const raw = this.dataSource.config.service_account_json;
    const credentials = typeof raw === "string" ? JSON.parse(raw) : raw;
    const projectId =
      this.dataSource.config.project_id ||
      (credentials.project_id as string | undefined);
    return { credentials, projectId };
  }

  private getBucketName(): string {
    return stripGsPrefix(String(this.dataSource.config.bucket || ""));
  }

  private getStorage(): Storage {
    if (!this.storage) {
      const { credentials, projectId } = this.getCredentials();
      this.storage = new Storage({
        credentials,
        projectId,
      });
    }
    return this.storage;
  }

  private getBucket(): Bucket {
    return this.getStorage().bucket(this.getBucketName());
  }

  private getFolderConfig(entity: string): GcsFolderQuery | undefined {
    const queries = this.dataSource.config.queries as
      | GcsFolderQuery[]
      | undefined;
    if (!queries) return undefined;
    return queries.find(q => q.name === entity);
  }

  getAvailableEntities(): string[] {
    const queries = this.dataSource.config.queries as
      | GcsFolderQuery[]
      | undefined;
    if (!queries) return [];
    return queries.map(q => q.name).filter(Boolean);
  }

  getEntityMetadata(): EntityMetadata[] {
    return this.getAvailableEntities().map(entity => ({
      name: entity,
      label: entity,
      description: "CSV files from a GCS folder prefix",
      layoutSuggestion: {
        partitionField: "_source_updated_at",
        partitionGranularity: "day",
        clusterFields: ["_dataSourceId", "_source_key"],
      },
    }));
  }

  async resolveSchema(entity: string): Promise<ConnectorEntitySchema | null> {
    if (!this.getAvailableEntities().includes(entity)) return null;
    return resolveGcsEntitySchema(entity);
  }

  supportsResumableFetching(): boolean {
    return true;
  }

  getIncrementalCapabilities(): IncrementalCapabilities {
    // GCS object listing has no server-side time filter, so a poll lists the
    // prefix and drops objects whose `updated` is at or before `since`
    // (listNewObjects). That is client-filter, not native: the listing cost
    // still scales with the folder, only the download and parse are saved.
    //
    // The unit is the OBJECT, not the row — a file that changed at all is
    // re-imported whole, and its rows upsert on the entity's `id` key. An
    // object with no `updated` metadata is kept rather than skipped, so the
    // failure direction is re-importing, never silently missing a change.
    return { supported: true, mode: "client-filter", anchorField: "updated" };
  }

  async testConnection(): Promise<ConnectionTestResult> {
    try {
      const validation = this.validateConfig();
      if (!validation.valid) {
        return {
          success: false,
          message: "Invalid configuration",
          details: validation.errors,
        };
      }

      const bucket = this.getBucket();
      const [exists] = await bucket.exists();
      if (!exists) {
        return {
          success: false,
          message: `Bucket gs://${this.getBucketName()} not found or not accessible`,
        };
      }

      // Lightweight list to prove objectViewer (exists() alone can pass with
      // weaker permissions on some setups).
      const [files] = await bucket.getFiles({
        maxResults: 1,
        autoPaginate: false,
      });

      return {
        success: true,
        message: `Connected to gs://${this.getBucketName()}`,
        details: {
          bucket: this.getBucketName(),
          sampleObject: files[0]?.name ?? null,
        },
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown GCS error";
      logger.error("GCS connection test failed", { error: message });
      return {
        success: false,
        message: `Failed to connect to GCS: ${message}`,
      };
    }
  }

  /**
   * List CSV objects under the folder prefix that are new/changed since `since`.
   * Sorted by updated ascending so incremental runs are deterministic.
   */
  private async listNewObjects(
    folder: GcsFolderQuery,
    since?: Date,
  ): Promise<PendingObject[]> {
    const bucket = this.getBucket();
    const effectivePrefix = resolveObjectPrefix(
      folder.prefix,
      this.getBucketName(),
    );

    const pending: PendingObject[] = [];
    const glob = folder.glob || "*.csv";

    let pageToken: string | undefined;
    do {
      const [files, , apiResponse] = await bucket.getFiles({
        prefix: effectivePrefix || undefined,
        autoPaginate: false,
        pageToken,
        maxResults: 1000,
      });

      for (const file of files) {
        if (!fileMatchesGlob(file.name, glob)) continue;
        // Skip "folder" placeholder objects
        if (file.name.endsWith("/")) continue;

        const updated = file.metadata?.updated
          ? new Date(file.metadata.updated)
          : file.metadata?.timeCreated
            ? new Date(file.metadata.timeCreated)
            : undefined;

        if (since && updated && updated <= since) continue;

        pending.push({
          name: file.name,
          generation: file.metadata?.generation
            ? String(file.metadata.generation)
            : undefined,
          updated: updated?.toISOString(),
          size: file.metadata?.size ? Number(file.metadata.size) : undefined,
        });
      }

      pageToken = (apiResponse as { nextPageToken?: string } | undefined)
        ?.nextPageToken;
    } while (pageToken);

    pending.sort((a, b) => {
      const at = a.updated ? Date.parse(a.updated) : 0;
      const bt = b.updated ? Date.parse(b.updated) : 0;
      if (at !== bt) return at - bt;
      return a.name.localeCompare(b.name);
    });

    return pending;
  }

  private async processObject(
    file: File,
    object: PendingObject,
    folder: GcsFolderQuery,
    rowOffset: number,
    onBatch: FetchOptions["onBatch"],
  ): Promise<{ rowsRead: number; rowsEmitted: number }> {
    const readStream = file.createReadStream();
    return parseCsvStream(
      readStream,
      {
        delimiter: folder.delimiter || ",",
        hasHeader: folder.has_header !== false,
        batchSize: Number(folder.batch_size || 1000),
        skipRows: rowOffset,
        sourceKey: object.name,
        sourceGeneration: object.generation,
        sourceUpdatedAt: object.updated,
        primaryKey: folder.primary_key,
      },
      onBatch,
    );
  }

  async fetchEntityChunk(options: ResumableFetchOptions): Promise<FetchState> {
    const { entity, onBatch, onProgress, since, state } = options;
    const maxIterations = options.maxIterations ?? 5;

    const folder = this.getFolderConfig(entity);
    if (!folder) {
      throw new Error(
        `Folder configuration '${entity}' not found. Add it under Flow → Folders.`,
      );
    }

    const meta = (state?.metadata || {}) as GcsFetchMetadata;
    let pending = meta.pending ? [...meta.pending] : [];
    let current = meta.current ?? null;
    let rowOffset = meta.rowOffset ?? 0;
    let totalProcessed = state?.totalProcessed ?? 0;
    let iterations = 0;
    let initialCount = meta.initialCount ?? 0;

    if (!meta.listed) {
      pending = await this.listNewObjects(folder, since);
      initialCount = pending.length;
      logger.info("Listed new GCS objects", {
        entity,
        bucket: this.getBucketName(),
        prefix: folder.prefix || "",
        count: pending.length,
        since: since?.toISOString() ?? null,
      });
      onProgress?.(0, initialCount);
    }

    const bucket = this.getBucket();

    while (iterations < maxIterations && (current || pending.length > 0)) {
      if (!current) {
        current = pending.shift() || null;
        rowOffset = 0;
      }
      if (!current) break;

      logger.info("Processing GCS object", {
        entity,
        object: current.name,
        rowOffset,
        remaining: pending.length,
      });

      const gcsFile = bucket.file(
        current.name,
        current.generation ? { generation: current.generation } : undefined,
      );
      // Hold the name: `current` is cleared on success inside the try, so the
      // catch cannot rely on it still being set.
      const objectName = current.name;
      const inFlight = current;

      try {
        const { rowsRead, rowsEmitted } = await this.processObject(
          gcsFile,
          inFlight,
          folder,
          rowOffset,
          onBatch,
        );
        totalProcessed += rowsEmitted;
        logger.info("Finished GCS object", {
          entity,
          object: objectName,
          rowsRead,
          rowsEmitted,
        });
        current = null;
        rowOffset = 0;
        iterations++;
        onProgress?.(initialCount - pending.length, initialCount);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "CSV parse failed";
        logger.error("Failed processing GCS object", {
          entity,
          object: objectName,
          rowOffset,
          error: message,
        });
        throw error;
      }
    }

    const hasMore = Boolean(current) || pending.length > 0;

    return {
      totalProcessed,
      hasMore,
      iterationsInChunk: iterations,
      metadata: {
        listed: true,
        pending,
        current,
        rowOffset,
        initialCount,
        discoveryHash: createHash("sha256")
          .update(
            JSON.stringify({
              bucket: this.getBucketName(),
              prefix: folder.prefix || "",
              since: since?.toISOString() ?? null,
            }),
          )
          .digest("hex")
          .slice(0, 12),
      } satisfies GcsFetchMetadata & {
        initialCount: number;
        discoveryHash: string;
      },
    };
  }

  async fetchEntity(options: FetchOptions): Promise<void> {
    let state: FetchState | undefined;
    do {
      state = await this.fetchEntityChunk({
        ...options,
        maxIterations: options.batchSize ? 10 : 5,
        state,
      });
    } while (state.hasMore);
  }
}
