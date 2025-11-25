import {
  BaseConnector,
  ConnectionTestResult,
  FetchOptions,
  ResumableFetchOptions,
  FetchState,
} from "../base/BaseConnector";
import axios, { AxiosInstance } from "axios";
import crypto from "crypto";

type JsonRecord = Record<string, any>;

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

interface BigQuerySchemaField {
  name: string;
  type: string;
  mode?: string; // NULLABLE | REQUIRED | REPEATED
  fields?: BigQuerySchemaField[]; // for RECORD
}

interface BigQuerySchema {
  fields: BigQuerySchemaField[];
}

export class BigQueryConnector extends BaseConnector {
  private httpClient: AxiosInstance | null = null;
  private accessToken: string | null = null;
  private accessTokenExpiry: number = 0; // epoch seconds

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
            "Paste the full service account JSON. It will be stored encrypted.",
        },
        {
          name: "project_id",
          label: "Project ID",
          type: "string",
          required: true,
        },
        {
          name: "location",
          label: "Location (optional)",
          type: "string",
          required: false,
          placeholder: "US",
        },
        {
          name: "api_base_url",
          label: "API Base URL",
          type: "string",
          required: false,
          default: "https://bigquery.googleapis.com",
        },
        {
          name: "queries",
          label: "SQL Queries",
          type: "object_array",
          required: true,
          itemFields: [
            {
              name: "name",
              label: "Entity Name",
              type: "string",
              required: true,
              placeholder: "events_7d",
              helperText: "Name used as entity and collection name",
            },
            {
              name: "query",
              label: "SQL Query",
              type: "textarea",
              required: true,
              rows: 12,
              placeholder:
                "SELECT * FROM `project.dataset.table` WHERE _PARTITIONTIME > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)",
            },
            {
              name: "use_legacy_sql",
              label: "Use Legacy SQL",
              type: "checkbox",
              required: false,
              default: false,
            },
            {
              name: "batch_size",
              label: "Batch Size (maxResults)",
              type: "number",
              required: false,
              default: 1000,
            },
          ],
        },
      ],
    };
  }

  getMetadata() {
    return {
      name: "BigQuery",
      version: "1.0.0",
      description: "Connector for Google BigQuery (REST API, service account)",
      supportedEntities: this.getAvailableEntities(),
    };
  }

  validateConfig() {
    const base = super.validateConfig();
    const errors = [...base.errors];

    if (!this.dataSource.config.project_id) {
      errors.push("BigQuery project_id is required");
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
      !Array.isArray(this.dataSource.config.queries) ||
      this.dataSource.config.queries.length === 0
    ) {
      errors.push("At least one SQL query must be configured");
    }

    return { valid: errors.length === 0, errors };
  }

  private getServiceAccount(): ServiceAccount {
    const raw = this.dataSource.config.service_account_json;
    const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
    return {
      client_email: obj.client_email,
      private_key: obj.private_key,
      token_uri: obj.token_uri || "https://oauth2.googleapis.com/token",
    };
  }

  private base64url(input: Buffer | string): string {
    const source = Buffer.isBuffer(input) ? input : Buffer.from(input);
    return source
      .toString("base64")
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
  }

  private async getAccessToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.accessToken && now < this.accessTokenExpiry - 60) {
      return this.accessToken;
    }

    const sa = this.getServiceAccount();
    const iat = now;
    const exp = now + 3600;
    const header = { alg: "RS256", typ: "JWT" };
    const scope = "https://www.googleapis.com/auth/bigquery.readonly";
    const aud = sa.token_uri || "https://oauth2.googleapis.com/token";
    const payload = {
      iss: sa.client_email,
      scope,
      aud,
      iat,
      exp,
    } as JsonRecord;

    const encodedHeader = this.base64url(JSON.stringify(header));
    const encodedPayload = this.base64url(JSON.stringify(payload));
    const signingInput = `${encodedHeader}.${encodedPayload}`;

    const signer = crypto.createSign("RSA-SHA256");
    signer.update(signingInput);
    signer.end();
    const signature = signer.sign(sa.private_key);
    const encodedSignature = this.base64url(signature);
    const assertion = `${signingInput}.${encodedSignature}`;

    const tokenRes = await axios.post(
      sa.token_uri || "https://oauth2.googleapis.com/token",
      new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
    );

    this.accessToken = tokenRes.data.access_token;
    this.accessTokenExpiry = now + Number(tokenRes.data.expires_in || 3600);
    return this.accessToken as string;
  }

  private async getHttpClient(): Promise<AxiosInstance> {
    if (!this.httpClient) {
      const rawBase: string = (
        this.dataSource.config.api_base_url || "https://bigquery.googleapis.com"
      )
        .toString()
        .trim();
      let normalizedBase = rawBase;
      if (!/^https?:\/\//i.test(normalizedBase)) {
        normalizedBase = `https://${normalizedBase}`;
      }
      normalizedBase = normalizedBase.replace(/\/+$/, "");
      // BigQuery v2 base path
      const baseURL = `${normalizedBase}/bigquery/v2`;
      this.httpClient = axios.create({ baseURL });
    }

    const token = await this.getAccessToken();
    this.httpClient.defaults.headers.common["Authorization"] =
      `Bearer ${token}`;
    this.httpClient.defaults.headers.common["Content-Type"] =
      "application/json";
    return this.httpClient;
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

      const client = await this.getHttpClient();
      const projectId = this.dataSource.config.project_id as string;
      const location = this.dataSource.config.location as string | undefined;

      const body: JsonRecord = {
        query: "SELECT 1 AS one",
        useLegacySql: false,
        maxResults: 1,
        ...(location ? { location } : {}),
      };

      await client.post(`/projects/${projectId}/queries`, body);
      return { success: true, message: "Successfully connected to BigQuery" };
    } catch (error) {
      return {
        success: false,
        message: "Failed to connect to BigQuery",
        details: axios.isAxiosError(error) ? error.message : String(error),
      };
    }
  }

  getAvailableEntities(): string[] {
    const list = this.dataSource.config.queries || [];
    return list.map((q: any) => q.name);
  }

  supportsResumableFetching(): boolean {
    return true;
  }

  async fetchEntityChunk(options: ResumableFetchOptions): Promise<FetchState> {
    const { entity, onBatch, onProgress, state } = options;
    const maxIterations = options.maxIterations || 10;

    const def = this.getQueryConfig(entity);
    if (!def) throw new Error(`Query configuration '${entity}' not found`);

    const projectId = this.dataSource.config.project_id as string;
    const configuredLocation = this.dataSource.config.location as
      | string
      | undefined;
    const batchSize = Number(
      def.batch_size || options.batchSize || this.getBatchSize(),
    );
    const rateDelay = options.rateLimitDelay || this.getRateLimitDelay();

    const client = await this.getHttpClient();

    let iterations = 0;
    let processed = state?.totalProcessed || 0;
    let hasMore = state?.hasMore !== false;
    let pageToken: string | undefined = state?.cursor;
    let jobId: string | undefined = state?.metadata?.jobId;
    // Track the actual job location from BigQuery response
    let jobLocation: string | undefined =
      state?.metadata?.jobLocation || configuredLocation;
    let schema: BigQuerySchema | undefined = state?.metadata?.schema;
    let totalRows: number | undefined = state?.metadata?.totalRows;

    if (!state && onProgress) onProgress(0, totalRows);

    while (hasMore && iterations < maxIterations) {
      let response: any;
      let data: any;

      if (!jobId) {
        // Start query
        const body: JsonRecord = {
          query: def.query,
          useLegacySql: Boolean(def.use_legacy_sql) || false,
          maxResults: batchSize,
          ...(configuredLocation ? { location: configuredLocation } : {}),
        };
        response = await client.post(`/projects/${projectId}/queries`, body);
        data = response.data || {};
        jobId = data.jobReference?.jobId || jobId;
        // Extract location from job reference - critical for multi-region setups
        jobLocation = data.jobReference?.location || configuredLocation;

        // Wait for job completion if not immediately complete
        // BigQuery may return jobComplete: false for complex/long-running queries
        const maxWaitMs = 5 * 60 * 1000; // 5 minutes max wait
        const pollIntervalMs = 1000; // 1 second between polls
        let waitedMs = 0;

        while (data.jobComplete === false && jobId && waitedMs < maxWaitMs) {
          await this.sleep(pollIntervalMs);
          waitedMs += pollIntervalMs;

          const params: JsonRecord = { maxResults: batchSize };
          // Must use the job's actual location for polling
          if (jobLocation) params.location = jobLocation;
          response = await client.get(
            `/projects/${projectId}/queries/${jobId}`,
            { params },
          );
          data = response.data || {};
        }

        if (data.jobComplete === false) {
          throw new Error(
            `Query timed out after ${maxWaitMs / 1000} seconds. The query may still be running in BigQuery.`,
          );
        }
      } else {
        // Page through existing job results
        const params: JsonRecord = { maxResults: batchSize };
        if (pageToken) params.pageToken = pageToken;
        // Must use the job's actual location for pagination
        if (jobLocation) params.location = jobLocation;
        response = await client.get(`/projects/${projectId}/queries/${jobId}`, {
          params,
        });
        data = response.data || {};
      }

      jobId = data.jobReference?.jobId || jobId;
      schema = (data.schema as BigQuerySchema) || schema;
      if (typeof data.totalRows === "string") {
        totalRows = Number(data.totalRows);
      }

      const rows = Array.isArray(data.rows) ? data.rows : [];
      const mapped = schema ? this.mapRowsToObjects(rows, schema) : rows;
      if (mapped.length > 0) {
        await onBatch(mapped);
        processed += mapped.length;
        if (onProgress) onProgress(processed, totalRows);
      }

      pageToken = data.pageToken;
      hasMore = Boolean(pageToken);
      iterations += 1;
      if (hasMore) await this.sleep(rateDelay);
    }

    return {
      cursor: pageToken,
      totalProcessed: processed,
      hasMore,
      iterationsInChunk: iterations,
      metadata: { jobId, schema, totalRows, jobLocation },
    };
  }

  async fetchEntity(options: FetchOptions): Promise<void> {
    await this.fetchEntityChunk({
      ...options,
      maxIterations: Number.MAX_SAFE_INTEGER,
    });
  }

  // --- Helpers ---
  private getQueryConfig(name: string):
    | {
        name: string;
        query: string;
        use_legacy_sql?: boolean;
        batch_size?: number;
      }
    | undefined {
    const queries = this.dataSource.config.queries || [];
    const found = queries.find((q: any) => q.name === name);
    if (!found) return undefined;
    return {
      name: found.name,
      query: found.query,
      use_legacy_sql: Boolean(
        (found as any)["use_legacy_sql"] || (found as any)["useLegacySql"],
      ),
      batch_size:
        Number((found as any)["batch_size"] || (found as any)["batchSize"]) ||
        undefined,
    };
  }

  private mapRowsToObjects(rows: any[], schema: BigQuerySchema): any[] {
    return rows.map(r => this.mapRow(r, schema.fields));
  }

  private mapRow(row: any, fields: BigQuerySchemaField[]): any {
    const obj: Record<string, any> = {};
    const cells: any[] = Array.isArray(row?.f) ? row.f : [];
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i];
      const cell = cells[i]?.v;
      obj[field.name] = this.parseCellValue(cell, field);
    }
    return obj;
  }

  private parseCellValue(value: any, field: BigQuerySchemaField): any {
    if (value === null || value === undefined) return null;

    // REPEATED mode => array of values
    if ((field.mode || "").toUpperCase() === "REPEATED") {
      const arr: any[] = Array.isArray(value) ? value : [];
      return arr.map(v =>
        this.parseCellValue(v?.v ?? v, { ...field, mode: undefined }),
      );
    }

    switch ((field.type || "").toUpperCase()) {
      case "RECORD":
        // Nested record: value is { f: [...] }
        return this.mapRow(value, field.fields || []);
      case "INTEGER":
      case "INT64":
        return value === "" ? null : Number(value);
      case "FLOAT":
      case "FLOAT64":
      case "NUMERIC":
      case "BIGNUMERIC":
        return value === "" ? null : Number(value);
      case "BOOLEAN":
      case "BOOL":
        return value === true || value === "true";
      case "TIMESTAMP":
      case "DATETIME":
      case "DATE":
      case "TIME":
      case "STRING":
      default:
        return value;
    }
  }
}
