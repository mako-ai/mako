import crypto from "node:crypto";
import axios, { AxiosError, AxiosInstance } from "axios";
import {
  BaseConnector,
  ConnectionTestResult,
  FetchOptions,
  ResumableFetchOptions,
  FetchState,
  WebhookVerificationResult,
  WebhookHandlerOptions,
  WebhookEventMapping,
  EntityMetadata,
  NormalizedCdcRecord,
  type WebhookCapabilities,
  type IncrementalCapabilities,
  type ConnectorEntitySchema,
} from "../base/BaseConnector";
import { resolveWiseEntitySchema } from "./schema";
import { loggers } from "../../logging";

const logger = loggers.connector("wise");

const DEFAULT_BASE_URL = "https://api.wise.com";
const SANDBOX_HOST_MARKERS = [
  "sandbox.transferwise.tech",
  "api.sandbox.transferwise",
  "sandbox.wise.com",
];
const TRANSFER_PAGE_LIMIT = 100;
const RECIPIENT_PAGE_LIMIT = 100;
const ACTIVITY_PAGE_LIMIT = 50;

// Wise signs webhooks with RSA-SHA256 (not a shared HMAC secret).
// https://docs.wise.com/guides/developer/webhooks/event-handling
const WISE_PRODUCTION_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvO8vXV+JksBzZAY6GhSO
XdoTCfhXaaiZ+qAbtaDBiu2AGkGVpmEygFmWP4Li9m5+Ni85BhVvZOodM9epgW3F
bA5Q1SexvAF1PPjX4JpMstak/QhAgl1qMSqEevL8cmUeTgcMuVWCJmlge9h7B1CS
D4rtlimGZozG39rUBDg6Qt2K+P4wBfLblL0k4C4YUdLnpGYEDIth+i8XsRpFlogx
CAFyH9+knYsDbR43UJ9shtc42Ybd40Afihj8KnYKXzchyQ42aC8aZ/h5hyZ28yVy
Oj3Vos0VdBIs/gAyJ/4yyQFCXYte64I7ssrlbGRaco4nKF3HmaNhxwyKyJafz19e
HwIDAQAB
-----END PUBLIC KEY-----`;

const WISE_SANDBOX_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwpb91cEYuyJNQepZAVfP
ZIlPZfNUefH+n6w9SW3fykqKu938cR7WadQv87oF2VuT+fDt7kqeRziTmPSUhqPU
ys/V2Q1rlfJuXbE+Gga37t7zwd0egQ+KyOEHQOpcTwKmtZ81ieGHynAQzsn1We3j
wt760MsCPJ7GMT141ByQM+yW1Bx+4SG3IGjXWyqOWrcXsxAvIXkpUD/jK/L958Cg
nZEgz0BSEh0QxYLITnW1lLokSx/dTianWPFEhMC9BgijempgNXHNfcVirg1lPSyg
z7KqoKUN0oHqWLr2U1A+7kqrl6O2nx3CKs1bj1hToT1+p4kcMoHXA7kA+VBLUpEs
VwIDAQAB
-----END PUBLIC KEY-----`;

const SUPPORTED_ENTITIES = [
  "profiles",
  "balances",
  "balance_updates",
  "transfers",
  "recipients",
  "activities",
] as const;

type SupportedEntity = (typeof SUPPORTED_ENTITIES)[number];

const SUPPORTED_WEBHOOK_EVENTS = [
  "transfers#state-change",
  "transfers#refund",
  "transfers#payout-failure",
  "transfers#active-cases",
  "balances#update",
  "balances#account-state-change",
  "profiles#state-change",
  "recipients#state-change",
] as const;

type WiseProfile = {
  id: number | string;
  [key: string]: unknown;
};

type MultiProfileState = {
  profileIds: string[];
  profileIndex: number;
};

function formatWiseApiError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const data = error.response?.data as
      | {
          error?: string;
          error_description?: string;
          message?: string;
          errors?: Array<{ code?: string; message?: string }>;
        }
      | string
      | undefined;

    const direct =
      typeof data === "string"
        ? data
        : typeof data?.error_description === "string"
          ? data.error_description
          : typeof data?.message === "string"
            ? data.message
            : typeof data?.error === "string"
              ? data.error
              : undefined;

    const nested = Array.isArray((data as { errors?: unknown[] })?.errors)
      ? (data as { errors: Array<{ code?: string; message?: string }> }).errors
          .map(e => `${e.code ?? "?"}: ${e.message ?? "?"}`)
          .join("; ")
      : undefined;

    const detail = [direct, nested].filter(Boolean).join(" — ");
    return status
      ? `HTTP ${status}: ${detail || error.message}`
      : detail || error.message;
  }

  return error instanceof Error ? error.message : String(error);
}

/** Coerce Wise numeric ids onto a string `id` key column. */
function withStringId(
  record: Record<string, unknown>,
  preferredKeys: string[] = ["id"],
): Record<string, unknown> {
  if (record == null) return record;
  for (const key of preferredKeys) {
    const value = record[key];
    if (value != null && String(value).length > 0) {
      return { ...record, id: String(value) };
    }
  }
  return record;
}

function parseWiseDate(value: unknown): Date | null {
  if (value == null) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value !== "string" || value.trim().length === 0) return null;

  const trimmed = value.trim();
  // Transfers use "YYYY-MM-DD HH:mm:ss" without a timezone — treat as UTC.
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(trimmed)
    ? `${trimmed.replace(" ", "T")}Z`
    : trimmed;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDateParam(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export class WiseConnector extends BaseConnector {
  private wiseApi: AxiosInstance | null = null;
  private cachedProfiles: WiseProfile[] | null = null;

  static getConfigSchema() {
    return {
      fields: [
        {
          name: "api_key",
          label: "API Token",
          type: "password",
          required: true,
          helperText:
            "Wise personal API token or OAuth access token. Used as `Authorization: Bearer <token>`.",
        },
        {
          name: "profile_id",
          label: "Profile ID",
          type: "string",
          required: false,
          helperText:
            "Optional. Restrict sync to one Wise profile. Leave blank to sync every profile the token can access.",
        },
        {
          name: "api_base_url",
          label: "API Base URL",
          type: "string",
          required: false,
          default: DEFAULT_BASE_URL,
          helperText:
            "Production: https://api.wise.com. Sandbox: https://api.sandbox.transferwise.tech",
        },
      ],
    };
  }

  getMetadata() {
    return {
      name: "Wise",
      version: "1.0.0",
      description:
        "Connector for Wise (TransferWise): profiles, balances, transfers, recipients, and activities. CDC via Wise webhooks (RSA-SHA256).",
      supportedEntities: [...SUPPORTED_ENTITIES],
    };
  }

  validateConfig() {
    const base = super.validateConfig();
    const errors = [...base.errors];

    if (!this.dataSource.config.api_key) {
      errors.push("Wise API token is required");
    }

    const profileId = this.dataSource.config.profile_id;
    if (
      profileId != null &&
      profileId !== "" &&
      !/^\d+$/.test(String(profileId).trim())
    ) {
      errors.push("Wise profile_id must be a numeric profile id");
    }

    return { valid: errors.length === 0, errors };
  }

  private getBaseUrl(): string {
    const configured = this.dataSource.config.api_base_url;
    if (typeof configured === "string" && configured.trim().length > 0) {
      return configured.trim().replace(/\/+$/, "");
    }
    return DEFAULT_BASE_URL;
  }

  private isSandboxBaseUrl(): boolean {
    const base = this.getBaseUrl().toLowerCase();
    return SANDBOX_HOST_MARKERS.some(marker => base.includes(marker));
  }

  /**
   * Ordered public keys used for RSA-SHA256 webhook verification.
   * Prefer sandbox when `api_base_url` is sandbox (or flow secret is
   * literally "sandbox"); always fall back to the other environment so a
   * misconfigured base URL does not hard-fail delivery.
   */
  private getWebhookPublicKeys(secret?: string): string[] {
    const preferSandbox =
      this.isSandboxBaseUrl() ||
      (typeof secret === "string" && secret.trim().toLowerCase() === "sandbox");
    return preferSandbox
      ? [WISE_SANDBOX_PUBLIC_KEY, WISE_PRODUCTION_PUBLIC_KEY]
      : [WISE_PRODUCTION_PUBLIC_KEY, WISE_SANDBOX_PUBLIC_KEY];
  }

  private getClient(): AxiosInstance {
    if (!this.wiseApi) {
      if (!this.dataSource.config.api_key) {
        throw new Error("Wise API token not configured");
      }

      this.wiseApi = axios.create({
        baseURL: this.getBaseUrl(),
        headers: {
          Authorization: `Bearer ${this.dataSource.config.api_key}`,
          "Content-Type": "application/json",
        },
      });
    }
    return this.wiseApi;
  }

  private headerValue(
    headers: Record<string, string | string[] | undefined>,
    name: string,
  ): string | undefined {
    const lower = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() !== lower) continue;
      return Array.isArray(value) ? value[0] : value;
    }
    return undefined;
  }

  private async executeWithRetry<T>(
    fn: () => Promise<T>,
    maxRetries = 5,
  ): Promise<T> {
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        return await fn();
      } catch (error) {
        const axiosError = error as AxiosError;
        const status = axiosError.response?.status;
        const retryable =
          status === 429 ||
          (status !== undefined && status >= 500 && status < 600);

        if (!retryable || attempt >= maxRetries) {
          if (axios.isAxiosError(error)) {
            error.message = formatWiseApiError(error);
          }
          throw error;
        }

        const retryAfterHeader = axiosError.response?.headers?.["retry-after"];
        const retryAfterSeconds = parseInt(String(retryAfterHeader ?? "1"), 10);
        const delayMs = Number.isFinite(retryAfterSeconds)
          ? retryAfterSeconds * 1000
          : Math.min(1000 * 2 ** attempt, 60_000);

        logger.warn("Wise API rate limited or server error, retrying", {
          status,
          attempt: attempt + 1,
          delayMs,
        });
        await this.sleep(delayMs);
        attempt++;
      }
    }
  }

  private resolvePageSize(batchSize: number | undefined, max: number): number {
    const requested =
      typeof batchSize === "number" && batchSize > 0
        ? batchSize
        : this.getBatchSize();
    return Math.min(Math.max(requested, 1), max);
  }

  private async listProfiles(): Promise<WiseProfile[]> {
    if (this.cachedProfiles) {
      return this.cachedProfiles;
    }

    const api = this.getClient();
    const response = await this.executeWithRetry(() => api.get("/v2/profiles"));
    const profiles = Array.isArray(response.data)
      ? (response.data as WiseProfile[])
      : [];
    this.cachedProfiles = profiles;
    return profiles;
  }

  private async resolveProfileIds(): Promise<string[]> {
    const configured = this.dataSource.config.profile_id;
    if (configured != null && String(configured).trim().length > 0) {
      return [String(configured).trim()];
    }

    const profiles = await this.listProfiles();
    return profiles
      .map(profile => String(profile.id))
      .filter(id => id.length > 0);
  }

  private async initMultiProfileState(
    state: FetchState | undefined,
  ): Promise<MultiProfileState> {
    const existingIds = state?.metadata?.profileIds;
    if (Array.isArray(existingIds) && existingIds.length > 0) {
      return {
        profileIds: existingIds.map(String),
        profileIndex:
          typeof state?.metadata?.profileIndex === "number"
            ? state.metadata.profileIndex
            : 0,
      };
    }

    const profileIds = await this.resolveProfileIds();
    return { profileIds, profileIndex: 0 };
  }

  async resolveSchema(entity: string): Promise<ConnectorEntitySchema | null> {
    return resolveWiseEntitySchema(entity);
  }

  protected resolveRecordTimestamp(payload?: Record<string, unknown>): Date {
    const candidates = [
      payload?.occurred_at,
      payload?.modificationTime,
      payload?.updatedOn,
      payload?.updatedAt,
      payload?.updated_at,
      payload?.createdOn,
      payload?.createdAt,
      payload?.created_at,
      payload?.creationTime,
      payload?.created,
      payload?.sent_at,
    ];

    for (const candidate of candidates) {
      const date = parseWiseDate(candidate);
      if (date) return date;
    }

    return super.resolveRecordTimestamp(payload);
  }

  normalizeBackfillRecord(
    entity: string,
    record: Record<string, unknown>,
  ): NormalizedCdcRecord | null {
    const normalized = super.normalizeBackfillRecord(entity, record);
    if (!normalized) {
      return null;
    }

    return {
      ...normalized,
      recordId: String(record.id ?? normalized.recordId),
      sourceTs: this.resolveRecordTimestamp(record),
    };
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

      const api = this.getClient();
      const me = await this.executeWithRetry(() => api.get("/v1/me"));
      const profiles = await this.resolveProfileIds();

      return {
        success: true,
        message: "Successfully connected to Wise API",
        details: {
          userId: me.data?.id,
          email: me.data?.email,
          profileCount: profiles.length,
          profileIds: profiles,
          baseUrl: this.getBaseUrl(),
        },
      };
    } catch (error) {
      return {
        success: false,
        message: "Failed to connect to Wise API",
        details: formatWiseApiError(error),
      };
    }
  }

  getAvailableEntities(): string[] {
    return [...SUPPORTED_ENTITIES];
  }

  getEntityMetadata(): EntityMetadata[] {
    const layout = (partitionField: string) => ({
      partitionField,
      partitionGranularity: "day" as const,
      clusterFields: ["_dataSourceId", "id"],
    });

    return [
      {
        name: "profiles",
        label: "Profiles",
        description: "Personal and business profiles accessible to the token",
        layoutSuggestion: layout("createdAt"),
      },
      {
        name: "balances",
        label: "Balances",
        description: "Multi-currency balance accounts (current snapshot)",
        layoutSuggestion: layout("modificationTime"),
      },
      {
        name: "balance_updates",
        label: "Balance Updates",
        description:
          "Credit/debit ledger from balances#update webhooks (webhook-only; no REST backfill)",
        layoutSuggestion: layout("occurred_at"),
      },
      {
        name: "transfers",
        label: "Transfers",
        description: "Outbound and related transfers",
        layoutSuggestion: layout("created"),
      },
      {
        name: "recipients",
        label: "Recipients",
        description: "Beneficiary / recipient accounts",
        layoutSuggestion: layout("_syncedAt"),
      },
      {
        name: "activities",
        label: "Activities",
        description: "Profile activity feed (card payments, transfers, etc.)",
        layoutSuggestion: layout("createdOn"),
      },
    ];
  }

  supportsResumableFetching(): boolean {
    return true;
  }

  async fetchEntityChunk(options: ResumableFetchOptions): Promise<FetchState> {
    const { entity } = options;

    switch (entity as SupportedEntity) {
      case "profiles":
        return this.fetchProfilesChunk(options);
      case "balances":
        return this.fetchBalancesChunk(options);
      case "balance_updates":
        // Wise has no list endpoint for balance movements; CDC is webhook-only.
        logger.warn(
          "Skipping balance_updates backfill — entity is webhook-only (balances#update)",
        );
        return {
          totalProcessed: options.state?.totalProcessed ?? 0,
          hasMore: false,
          iterationsInChunk: 0,
        };
      case "transfers":
        return this.fetchTransfersChunk(options);
      case "recipients":
        return this.fetchRecipientsChunk(options);
      case "activities":
        return this.fetchActivitiesChunk(options);
      default:
        throw new Error(`Unsupported entity for Wise connector: ${entity}`);
    }
  }

  private async fetchProfilesChunk(
    options: ResumableFetchOptions,
  ): Promise<FetchState> {
    const { onBatch, onProgress, state } = options;
    if (state && state.totalProcessed > 0) {
      return {
        totalProcessed: state.totalProcessed,
        hasMore: false,
        iterationsInChunk: 0,
      };
    }

    const configured = this.dataSource.config.profile_id;
    let profiles = await this.listProfiles();
    if (configured != null && String(configured).trim().length > 0) {
      const wanted = String(configured).trim();
      profiles = profiles.filter(profile => String(profile.id) === wanted);
    }

    const records = profiles.map(profile =>
      withStringId(profile as Record<string, unknown>),
    );

    if (records.length > 0) {
      await onBatch(records);
      onProgress?.(records.length, records.length);
    }

    return {
      totalProcessed: records.length,
      hasMore: false,
      iterationsInChunk: 1,
    };
  }

  private async fetchBalancesChunk(
    options: ResumableFetchOptions,
  ): Promise<FetchState> {
    const { onBatch, onProgress, state } = options;
    const maxIterations = options.maxIterations ?? 10;
    const multi = await this.initMultiProfileState(state);
    let profileIndex = multi.profileIndex;
    let recordCount = state?.totalProcessed ?? 0;
    let iterations = 0;

    const api = this.getClient();

    while (
      profileIndex < multi.profileIds.length &&
      iterations < maxIterations
    ) {
      const profileId = multi.profileIds[profileIndex];
      const response = await this.executeWithRetry(() =>
        api.get(`/v4/profiles/${encodeURIComponent(profileId)}/balances`, {
          params: { types: "STANDARD" },
        }),
      );

      const balances = Array.isArray(response.data)
        ? (response.data as Array<Record<string, unknown>>)
        : [];
      const records = balances.map(balance =>
        withStringId({ ...balance, profileId: String(profileId) }),
      );

      if (records.length > 0) {
        await onBatch(records);
        recordCount += records.length;
        onProgress?.(recordCount, undefined);
      }

      profileIndex++;
      iterations++;
      await this.sleep(options.rateLimitDelay ?? this.getRateLimitDelay());
    }

    return {
      totalProcessed: recordCount,
      hasMore: profileIndex < multi.profileIds.length,
      iterationsInChunk: iterations,
      metadata: {
        profileIds: multi.profileIds,
        profileIndex,
      },
    };
  }

  private async fetchTransfersChunk(
    options: ResumableFetchOptions,
  ): Promise<FetchState> {
    const { onBatch, onProgress, since, state, batchSize } = options;
    const maxIterations = options.maxIterations ?? 10;
    const multi = await this.initMultiProfileState(state);
    let profileIndex = multi.profileIndex;
    let offset =
      typeof state?.metadata?.offset === "number" ? state.metadata.offset : 0;
    let recordCount = state?.totalProcessed ?? 0;
    let iterations = 0;
    const limit = this.resolvePageSize(batchSize, TRANSFER_PAGE_LIMIT);

    const api = this.getClient();

    while (
      profileIndex < multi.profileIds.length &&
      iterations < maxIterations
    ) {
      const profileId = multi.profileIds[profileIndex];
      const params: Record<string, string | number> = {
        profile: profileId,
        limit,
        offset,
      };
      if (since instanceof Date) {
        params.createdDateStart = formatDateParam(since);
      }

      const response = await this.executeWithRetry(() =>
        api.get("/v1/transfers", { params }),
      );
      const page = Array.isArray(response.data)
        ? (response.data as Array<Record<string, unknown>>)
        : [];
      const records = page.map(transfer =>
        withStringId({
          ...transfer,
          profile_id:
            transfer.business ?? transfer.profile_id ?? Number(profileId),
        }),
      );

      if (records.length > 0) {
        await onBatch(records);
        recordCount += records.length;
        onProgress?.(recordCount, undefined);
      }

      iterations++;

      if (page.length < limit) {
        profileIndex++;
        offset = 0;
      } else {
        offset += page.length;
      }

      if (
        profileIndex < multi.profileIds.length ||
        (page.length >= limit && profileIndex < multi.profileIds.length + 1)
      ) {
        await this.sleep(options.rateLimitDelay ?? this.getRateLimitDelay());
      }

      if (iterations >= maxIterations) break;
    }

    return {
      totalProcessed: recordCount,
      hasMore: profileIndex < multi.profileIds.length,
      iterationsInChunk: iterations,
      metadata: {
        profileIds: multi.profileIds,
        profileIndex,
        offset,
      },
    };
  }

  private async fetchRecipientsChunk(
    options: ResumableFetchOptions,
  ): Promise<FetchState> {
    const { onBatch, onProgress, state, batchSize } = options;
    const maxIterations = options.maxIterations ?? 10;
    const multi = await this.initMultiProfileState(state);
    let profileIndex = multi.profileIndex;
    let seekPosition =
      typeof state?.metadata?.seekPosition === "number" ||
      typeof state?.metadata?.seekPosition === "string"
        ? state.metadata.seekPosition
        : undefined;
    let recordCount = state?.totalProcessed ?? 0;
    let iterations = 0;
    const size = this.resolvePageSize(batchSize, RECIPIENT_PAGE_LIMIT);

    const api = this.getClient();

    while (
      profileIndex < multi.profileIds.length &&
      iterations < maxIterations
    ) {
      const profileId = multi.profileIds[profileIndex];
      const params: Record<string, string | number> = {
        profile: profileId,
        size,
      };
      if (seekPosition != null) {
        params.seekPosition = seekPosition as string | number;
      }

      const response = await this.executeWithRetry(() =>
        api.get("/v2/accounts", { params }),
      );
      const body = response.data as {
        content?: Array<Record<string, unknown>>;
        seekPositionForNext?: number | string | null;
      };
      const page = Array.isArray(body.content) ? body.content : [];
      const records = page.map(account => withStringId(account));

      if (records.length > 0) {
        await onBatch(records);
        recordCount += records.length;
        onProgress?.(recordCount, undefined);
      }

      iterations++;
      const nextSeek = body.seekPositionForNext;

      // End of profile when: empty page, missing next seek, or Wise echoes
      // the same seekPositionForNext (no forward progress).
      // Do NOT treat short pages as terminal — Wise caps `size` (often at 20)
      // below our requested page size while still returning seekPositionForNext.
      if (
        page.length === 0 ||
        nextSeek == null ||
        String(nextSeek) === String(seekPosition)
      ) {
        profileIndex++;
        seekPosition = undefined;
      } else {
        seekPosition = nextSeek;
      }

      if (profileIndex < multi.profileIds.length || seekPosition != null) {
        await this.sleep(options.rateLimitDelay ?? this.getRateLimitDelay());
      }

      if (iterations >= maxIterations) break;
    }

    return {
      totalProcessed: recordCount,
      hasMore: profileIndex < multi.profileIds.length,
      iterationsInChunk: iterations,
      metadata: {
        profileIds: multi.profileIds,
        profileIndex,
        seekPosition: seekPosition ?? null,
      },
    };
  }

  private async fetchActivitiesChunk(
    options: ResumableFetchOptions,
  ): Promise<FetchState> {
    const { onBatch, onProgress, since, state, batchSize } = options;
    const maxIterations = options.maxIterations ?? 10;
    const multi = await this.initMultiProfileState(state);
    let profileIndex = multi.profileIndex;
    let cursor =
      typeof state?.metadata?.cursor === "string"
        ? state.metadata.cursor
        : undefined;
    let recordCount = state?.totalProcessed ?? 0;
    let iterations = 0;
    const size = this.resolvePageSize(batchSize, ACTIVITY_PAGE_LIMIT);

    const api = this.getClient();

    while (
      profileIndex < multi.profileIds.length &&
      iterations < maxIterations
    ) {
      const profileId = multi.profileIds[profileIndex];
      // Wise paginates with response `cursor` → next request `nextCursor`
      // (not `cursor`). Sending the wrong param ignores pagination and
      // re-fetches page 1 forever.
      const params: Record<string, string | number> = { size };
      if (cursor) {
        params.nextCursor = cursor;
      }
      // Native server-side filter (ISO 8601). Prefer this over client-side
      // scanning of the newest-first feed.
      if (since instanceof Date) {
        params.since = since.toISOString();
      }

      const response = await this.executeWithRetry(() =>
        api.get(`/v1/profiles/${encodeURIComponent(profileId)}/activities`, {
          params,
        }),
      );
      const body = response.data as {
        activities?: Array<Record<string, unknown>>;
        cursor?: string | null;
      };
      const page = Array.isArray(body.activities) ? body.activities : [];

      const records = page.map(activity =>
        withStringId({ ...activity, profileId: String(profileId) }),
      );

      if (records.length > 0) {
        await onBatch(records);
        recordCount += records.length;
        onProgress?.(recordCount, undefined);
      }

      iterations++;
      const nextCursor =
        typeof body.cursor === "string" && body.cursor.length > 0
          ? body.cursor
          : null;

      // End of profile when: empty page, missing next cursor, or Wise echoes
      // the same cursor (no forward progress — otherwise backfill never ends).
      if (
        page.length === 0 ||
        !nextCursor ||
        (cursor != null && nextCursor === cursor)
      ) {
        profileIndex++;
        cursor = undefined;
      } else {
        cursor = nextCursor;
      }

      if (profileIndex < multi.profileIds.length || cursor) {
        await this.sleep(options.rateLimitDelay ?? this.getRateLimitDelay());
      }

      if (iterations >= maxIterations) break;
    }

    return {
      totalProcessed: recordCount,
      hasMore: profileIndex < multi.profileIds.length,
      iterationsInChunk: iterations,
      metadata: {
        profileIds: multi.profileIds,
        profileIndex,
        cursor: cursor ?? null,
      },
    };
  }

  async fetchEntity(options: FetchOptions): Promise<void> {
    let state: FetchState | undefined;
    do {
      state = await this.fetchEntityChunk({
        ...options,
        maxIterations: options.maxRetries ?? 50,
        state,
      });
    } while (state.hasMore);
  }

  supportsWebhooks(): boolean {
    return true;
  }

  supportsWebhookProvisioning(): boolean {
    // Personal API tokens cannot create subscriptions (403). Users must
    // register the Mako webhook URL in the Wise Developer Hub manually.
    return false;
  }

  getWebhookCapabilities(): WebhookCapabilities {
    return {
      supported: true,
      provisioning: {
        supported: false,
        providerLabel: "Wise",
        storesSecretAutomatically: false,
        actionHint:
          "Subscribe manually in Wise Developer Hub (profile-level webhooks)",
      },
      secretHelpText:
        'Optional. Wise verifies webhooks with RSA public keys (not a shared secret). Leave blank for production, or set to "sandbox" when using the sandbox API.',
    };
  }

  getIncrementalCapabilities(): IncrementalCapabilities {
    return {
      supported: true,
      // profiles / balances / recipients / balance_updates ignore `since`
      // entirely (full snapshot or webhook-only).
      mode: "none",
      perEntity: {
        // Wise list transfers only exposes createdDateStart/End — status
        // changes on older transfers are invisible to polls.
        transfers: {
          mode: "created-anchor",
          anchorField: "createdDateStart",
        },
        // Activities list accepts a native ISO `since` query param.
        activities: {
          mode: "native",
          anchorField: "since",
        },
      },
      warning:
        "Wise transfer polls only see newly created transfers; status updates on existing transfers (and all balance/recipient changes) require the webhook trigger or a periodic full reconcile.",
    };
  }

  async verifyWebhook(
    options: WebhookHandlerOptions,
  ): Promise<WebhookVerificationResult> {
    const { payload, headers, secret } = options;

    const signature = this.headerValue(headers, "X-Signature-SHA256");
    if (!signature) {
      return {
        valid: false,
        error: "Missing X-Signature-SHA256 header",
      };
    }

    const rawBody =
      typeof payload === "string" ? payload : JSON.stringify(payload);

    const keysToTry = this.getWebhookPublicKeys(secret);

    let verified = false;
    for (const publicKey of keysToTry) {
      try {
        const verifier = crypto.createVerify("RSA-SHA256");
        verifier.update(rawBody);
        verifier.end();
        if (verifier.verify(publicKey, signature, "base64")) {
          verified = true;
          break;
        }
      } catch (error) {
        logger.warn("Wise webhook signature verify attempt failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Test notifications sent during subscription setup may arrive without a
    // usable signature in some environments — still require a valid signature
    // when present; reject when verification fails.
    if (!verified) {
      return { valid: false, error: "Invalid Wise webhook signature" };
    }

    try {
      const parsed =
        typeof payload === "string" ? JSON.parse(payload) : payload;
      const eventType =
        typeof parsed?.event_type === "string"
          ? parsed.event_type
          : typeof parsed?.type === "string"
            ? parsed.type
            : undefined;

      const deliveryId = this.headerValue(headers, "X-Delivery-Id");
      const data = (parsed?.data ?? {}) as Record<string, unknown>;
      const resource = (data.resource ?? {}) as Record<string, unknown>;
      const resourceId =
        resource.id != null
          ? String(resource.id)
          : data.balance_id != null
            ? String(data.balance_id)
            : undefined;
      const occurredAt =
        typeof data.occurred_at === "string" ? data.occurred_at : "";
      const stepId = data.step_id != null ? String(data.step_id) : "";

      const eventId =
        deliveryId ||
        (eventType && resourceId
          ? `${eventType}:${resourceId}:${occurredAt || stepId || parsed?.sent_at || ""}`
          : parsed?.subscription_id);

      return {
        valid: true,
        event: {
          ...parsed,
          type: eventType,
          event_type: eventType,
          id: eventId,
        },
      };
    } catch (err) {
      return {
        valid: false,
        error: err instanceof Error ? err.message : "Failed to parse webhook",
      };
    }
  }

  getWebhookEventMapping(eventType: string): WebhookEventMapping | null {
    const mappings: Record<string, WebhookEventMapping> = {
      "transfers#state-change": { entity: "transfers", operation: "upsert" },
      "transfers#refund": { entity: "transfers", operation: "upsert" },
      "transfers#payout-failure": { entity: "transfers", operation: "upsert" },
      "transfers#active-cases": { entity: "transfers", operation: "upsert" },
      "balances#update": { entity: "balance_updates", operation: "upsert" },
      "balances#account-state-change": {
        entity: "balances",
        operation: "upsert",
      },
      "profiles#state-change": { entity: "profiles", operation: "upsert" },
      "recipients#state-change": { entity: "recipients", operation: "upsert" },
    };
    return mappings[eventType] ?? null;
  }

  getSupportedWebhookEvents(): string[] {
    return [...SUPPORTED_WEBHOOK_EVENTS];
  }

  getWebhookEventsForEntities(entities: string[]): string[] {
    if (entities.length === 0) {
      return this.getSupportedWebhookEvents();
    }

    const entitySet = new Set(entities.map(e => e.toLowerCase()));
    return this.getSupportedWebhookEvents().filter(eventType => {
      const mapping = this.getWebhookEventMapping(eventType);
      return mapping ? entitySet.has(mapping.entity.toLowerCase()) : false;
    });
  }

  extractWebhookData(
    event: any,
  ): { id: string; data: Record<string, unknown> } | null {
    if (!event || typeof event !== "object") {
      return null;
    }

    const eventType =
      typeof event.event_type === "string"
        ? event.event_type
        : typeof event.type === "string"
          ? event.type
          : undefined;
    const data = (event.data ?? {}) as Record<string, unknown>;
    const resource = (data.resource ?? {}) as Record<string, unknown>;

    if (eventType === "balances#update") {
      const balanceId = data.balance_id ?? resource.id;
      const stepId = data.step_id;
      const occurredAt = data.occurred_at;
      if (balanceId == null) return null;

      const id = String(
        stepId != null
          ? `${balanceId}:${stepId}`
          : `${balanceId}:${occurredAt ?? event.sent_at ?? event.id ?? ""}`,
      );

      return {
        id,
        data: withStringId({
          id,
          balance_id:
            typeof data.balance_id === "number"
              ? data.balance_id
              : Number(data.balance_id),
          profile_id: resource.profile_id ?? null,
          resource_id: resource.id ?? null,
          resource_type: resource.type ?? null,
          amount: data.amount ?? null,
          currency: data.currency ?? null,
          channel_name: data.channel_name ?? null,
          transaction_type: data.transaction_type ?? null,
          transfer_reference: data.transfer_reference ?? null,
          post_transaction_balance_amount:
            data.post_transaction_balance_amount ?? null,
          step_id: data.step_id ?? null,
          occurred_at: data.occurred_at ?? null,
          subscription_id: event.subscription_id ?? null,
          event_type: eventType,
          schema_version: event.schema_version ?? null,
          sent_at: event.sent_at ?? null,
        }),
      };
    }

    if (
      eventType === "transfers#state-change" ||
      eventType === "transfers#refund" ||
      eventType === "transfers#payout-failure" ||
      eventType === "transfers#active-cases"
    ) {
      if (resource.id == null) return null;
      const id = String(resource.id);
      return {
        id,
        data: withStringId({
          id,
          profile_id: resource.profile_id ?? null,
          account_id: resource.account_id ?? null,
          status: data.current_state ?? data.status ?? null,
          current_state: data.current_state ?? null,
          previous_state: data.previous_state ?? null,
          occurred_at: data.occurred_at ?? null,
          failure_reason_code:
            data.failure_reason_code ?? data.failureReasonCode ?? null,
          failure_description:
            data.failure_description ?? data.failureDescription ?? null,
          refund_amount: data.amount ?? data.refund_amount ?? null,
          refund_currency: data.currency ?? data.refund_currency ?? null,
          hasActiveIssues:
            data.has_active_issues ?? data.hasActiveIssues ?? null,
          details: data.details ?? data.active_cases ?? null,
        }),
      };
    }

    if (eventType === "balances#account-state-change") {
      const balanceId = resource.id ?? data.balance_id ?? data.id;
      if (balanceId == null) return null;
      return {
        id: String(balanceId),
        data: withStringId({
          id: String(balanceId),
          profileId:
            resource.profile_id != null ? String(resource.profile_id) : null,
          current_state: data.current_state ?? null,
          previous_state: data.previous_state ?? null,
          occurred_at: data.occurred_at ?? null,
          ...data,
        }),
      };
    }

    if (eventType === "profiles#state-change") {
      const profileId = resource.id ?? data.profile_id ?? data.id;
      if (profileId == null) return null;
      return {
        id: String(profileId),
        data: withStringId({
          id: String(profileId),
          currentState: data.current_state ?? data.currentState ?? null,
          previous_state: data.previous_state ?? null,
          occurred_at: data.occurred_at ?? null,
          ...data,
        }),
      };
    }

    if (eventType === "recipients#state-change") {
      const recipientId = resource.id ?? data.account_id ?? data.id;
      if (recipientId == null) return null;
      return {
        id: String(recipientId),
        data: withStringId({
          id: String(recipientId),
          profileId: resource.profile_id ?? data.profile_id ?? null,
          current_state: data.current_state ?? null,
          previous_state: data.previous_state ?? null,
          occurred_at: data.occurred_at ?? null,
          ...data,
        }),
      };
    }

    // Generic fallback
    const fallbackId = resource.id ?? data.id;
    if (fallbackId == null) return null;
    return {
      id: String(fallbackId),
      data: withStringId({ id: String(fallbackId), ...data }),
    };
  }

  extractWebhookCdcRecords(
    event: any,
    eventType?: string,
  ): NormalizedCdcRecord[] {
    const resolvedEventType =
      eventType || event?.type || event?.event_type || event?.action;
    if (!resolvedEventType) {
      return [];
    }

    const mapping = this.getWebhookEventMapping(resolvedEventType);
    if (!mapping) {
      return [];
    }

    const extracted = this.extractWebhookData(event);
    if (!extracted) {
      return [];
    }

    const sourceTs = this.resolveRecordTimestamp(extracted.data);
    return [
      {
        entity: mapping.entity,
        recordId: extracted.id,
        operation: mapping.operation,
        payload: extracted.data,
        sourceTs,
        source: "webhook",
        changeId:
          event?.id ||
          event?.event_id ||
          `${resolvedEventType}:${extracted.id}:${sourceTs.toISOString()}`,
      },
    ];
  }
}
