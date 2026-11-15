/**
 * The Wise (TransferWise) connector. The class is the public entry point;
 * the work lives in sibling modules:
 *
 * - client.ts        base URL, bearer client, API errors, SCA signing
 * - fetchers.ts      per-entity backfill (per profile, resumable)
 * - records.ts       ids, dates, money values, statement rows
 * - webhooks.ts      RSA verification, event mapping, payload extraction
 * - subscriptions.ts profile-level webhook subscription reconcile
 */
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
  type DeleteWebhookSubscriptionOptions,
  type ProvisionWebhookOptions,
  type ProvisionWebhookResult,
  type UpdateWebhookSubscriptionOptions,
} from "../base/BaseConnector";
import type { AxiosInstance } from "axios";
import { resolveWiseEntitySchema } from "./schema";
import { loggers } from "../../logging";
import { createRetryExecutor } from "../base/http-client";
import {
  WISE_DEFAULT_BASE_URL,
  createWiseClient,
  formatWiseApiError,
  isWiseSandboxBaseUrl,
  resolveWiseBaseUrl,
} from "./client";
import {
  fetchWiseActivitiesChunk,
  fetchWiseBalanceStatementsChunk,
  fetchWiseBalancesChunk,
  fetchWiseProfilesChunk,
  fetchWiseRecipientsChunk,
  fetchWiseTransfersChunk,
  type WiseFetchContext,
  type WiseProfile,
} from "./fetchers";
import { wiseRecordTimestamp } from "./records";
import {
  WISE_SUPPORTED_WEBHOOK_EVENTS,
  extractWiseWebhookData,
  verifyWiseWebhook,
  wiseWebhookEventMapping,
  wiseWebhookPublicKeys,
} from "./webhooks";
import {
  deleteWiseProfileSubscriptions,
  reconcileWiseProfileSubscriptions,
  type WiseSubscriptionContext,
} from "./subscriptions";

export { normalizePemKey, publicKeyFingerprint } from "./client";
export { toStatementRecord } from "./records";

const logger = loggers.connector("wise");

const SUPPORTED_ENTITIES = [
  "profiles",
  "balances",
  "balance_updates",
  "transfers",
  "recipients",
  "activities",
  "balance_statements",
] as const;

type SupportedEntity = (typeof SUPPORTED_ENTITIES)[number];

export class WiseConnector extends BaseConnector {
  private wiseApi: AxiosInstance | null = null;
  private cachedProfiles: WiseProfile[] | null = null;

  /** Shared policy: backoff with jitter, Retry-After, 429/5xx/network. */
  private readonly executeWithRetry = createRetryExecutor({
    label: "Wise",
    logger,
    sleep: ms => this.sleep(ms),
    formatError: formatWiseApiError,
  });

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
          name: "sca_private_key",
          label: "SCA Private Key",
          type: "textarea",
          rows: 6,
          encrypted: true,
          required: false,
          helperText:
            "Optional. PEM private key whose public key is registered in Wise (Settings → API tokens → Manage public keys). Wise asks for it (strong customer authentication) before it serves balance statements on some profiles.",
        },
        {
          name: "api_base_url",
          label: "API Base URL",
          type: "string",
          required: false,
          default: WISE_DEFAULT_BASE_URL,
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
        "Connector for Wise (TransferWise): profiles, balances, balance statements, transfers, recipients, and activities. CDC via Wise webhooks (RSA-SHA256).",
      supportedEntities: [...SUPPORTED_ENTITIES],
    };
  }

  validateConfig() {
    const base = super.validateConfig();
    const errors = [...base.errors];

    if (!this.sourceConnection.config.api_key) {
      errors.push("Wise API token is required");
    }

    const profileId = this.sourceConnection.config.profile_id;
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
    return resolveWiseBaseUrl(this.sourceConnection.config.api_base_url);
  }

  private isSandboxBaseUrl(): boolean {
    return isWiseSandboxBaseUrl(this.getBaseUrl());
  }

  /**
   * Ordered public keys used for RSA-SHA256 webhook verification.
   * Prefer sandbox when `api_base_url` is sandbox (or flow secret is
   * literally "sandbox"); always fall back to the other environment so a
   * misconfigured base URL does not hard-fail delivery.
   */
  private getWebhookPublicKeys(secret?: string): string[] {
    return wiseWebhookPublicKeys(this.isSandboxBaseUrl(), secret);
  }

  private getClient(): AxiosInstance {
    if (!this.wiseApi) {
      if (!this.sourceConnection.config.api_key) {
        throw new Error("Wise API token not configured");
      }
      this.wiseApi = createWiseClient(
        this.getBaseUrl(),
        this.sourceConnection.config.api_key,
      );
    }
    return this.wiseApi;
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
    const configured = this.sourceConnection.config.profile_id;
    if (configured != null && String(configured).trim().length > 0) {
      return [String(configured).trim()];
    }

    const profiles = await this.listProfiles();
    return profiles
      .map(profile => String(profile.id))
      .filter(id => id.length > 0);
  }

  /** What the fetch and subscription modules read, always late-bound. */
  private context(): WiseFetchContext & WiseSubscriptionContext {
    return {
      api: () => this.getClient(),
      execute: (fn, maxRetries) => this.executeWithRetry(fn, maxRetries),
      sleep: ms => this.sleep(ms),
      batchSize: () => this.getBatchSize(),
      rateLimitDelay: () => this.getRateLimitDelay(),
      configuredProfileId: () => this.sourceConnection.config.profile_id,
      scaPrivateKey: () => this.sourceConnection.config.sca_private_key,
      listProfiles: () => this.listProfiles(),
      resolveProfileIds: () => this.resolveProfileIds(),
      webhookKeySet: () => this.webhookKeySet(),
      supportedEvents: () => this.getSupportedWebhookEvents(),
      eventsForEntities: entities => this.getWebhookEventsForEntities(entities),
    };
  }

  async resolveSchema(entity: string): Promise<ConnectorEntitySchema | null> {
    return resolveWiseEntitySchema(entity);
  }

  protected resolveRecordTimestamp(payload?: Record<string, unknown>): Date {
    return (
      wiseRecordTimestamp(payload) ?? super.resolveRecordTimestamp(payload)
    );
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
      {
        name: "balance_statements",
        label: "Balance Statements",
        description:
          "Every transaction of every balance (all currencies) from Wise's balance statement, with fees and the running balance after it",
        layoutSuggestion: layout("date"),
      },
    ];
  }

  supportsResumableFetching(): boolean {
    return true;
  }

  async fetchEntityChunk(options: ResumableFetchOptions): Promise<FetchState> {
    const { entity } = options;
    const ctx = this.context();

    switch (entity as SupportedEntity) {
      case "profiles":
        return fetchWiseProfilesChunk(ctx, options);
      case "balances":
        return fetchWiseBalancesChunk(ctx, options);
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
        return fetchWiseTransfersChunk(ctx, options);
      case "recipients":
        return fetchWiseRecipientsChunk(ctx, options);
      case "activities":
        return fetchWiseActivitiesChunk(ctx, options);
      case "balance_statements":
        return fetchWiseBalanceStatementsChunk(ctx, options);
      default:
        throw new Error(`Unsupported entity for Wise connector: ${entity}`);
    }
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
    // Profile-level subscriptions through `/v3/profiles/{id}/subscriptions`.
    // Wise only lets a token allowed to manage the profile's webhooks do it;
    // a refusal is explained by subscriptions.ts.
    return true;
  }

  getWebhookCapabilities(): WebhookCapabilities {
    return {
      supported: true,
      provisioning: {
        supported: true,
        providerLabel: "Wise",
        // Wise signs with its own RSA keys: "provisioning stores the secret"
        // means it records which key set verifies (production or sandbox).
        storesSecretAutomatically: true,
        actionHint:
          "on every profile this connection syncs and records which Wise signing key verifies it",
      },
      secretHelpText:
        'Wise signs webhooks with its RSA public keys, not a shared secret: this field only names the key set — "production" (or blank) or "sandbox". Creating the webhook in Wise fills it in.',
    };
  }

  /**
   * The value stored as the flow's webhook "secret": which Wise public key
   * set verifies deliveries (see `getWebhookPublicKeys`).
   */
  private webhookKeySet(): string {
    return this.isSandboxBaseUrl() ? "sandbox" : "production";
  }

  /**
   * Subscribe `endpointUrl` to the flow's events on every profile the
   * connection syncs (`profile_id`, or every profile the token sees).
   * Idempotent: an existing subscription with the same URL and event is
   * reused, so clicking "Create in Wise" twice creates nothing new.
   */
  async createWebhookSubscription(
    options: ProvisionWebhookOptions,
  ): Promise<ProvisionWebhookResult> {
    const result = await reconcileWiseProfileSubscriptions(
      this.context(),
      options,
      true,
    );
    if (!result) {
      throw new Error("Wise webhook subscriptions could not be created");
    }
    return { ...result, signingSecret: this.webhookKeySet() };
  }

  supportsWebhookSubscriptionUpdate(): boolean {
    return true;
  }

  /**
   * Retarget the subscriptions on `endpointUrl` to the flow's current
   * events. `null` when no profile has one yet (the caller creates them).
   */
  async updateWebhookSubscription(
    options: UpdateWebhookSubscriptionOptions,
  ): Promise<ProvisionWebhookResult | null> {
    const result = await reconcileWiseProfileSubscriptions(
      this.context(),
      options,
      false,
    );
    // Wise signs with its public keys: the "secret" is only the key set, the
    // same whether the subscription is new or adopted.
    return result ? { ...result, signingSecret: this.webhookKeySet() } : null;
  }

  supportsWebhookSubscriptionDelete(): boolean {
    return true;
  }

  /** Remove every subscription delivering to `endpointUrl`, on every profile. */
  async deleteWebhookSubscription(
    options: DeleteWebhookSubscriptionOptions,
  ): Promise<number> {
    return deleteWiseProfileSubscriptions(this.context(), options.endpointUrl);
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
        // Statements take a date interval: incremental pulls start at
        // `since` less a few days of overlap.
        balance_statements: {
          mode: "native",
          anchorField: "intervalStart",
        },
      },
      warning:
        "Wise transfer polls only see newly created transfers; status updates on existing transfers (and all balance/recipient changes) require the webhook trigger or a periodic full reconcile.",
    };
  }

  async verifyWebhook(
    options: WebhookHandlerOptions,
  ): Promise<WebhookVerificationResult> {
    return verifyWiseWebhook(options, () =>
      this.getWebhookPublicKeys(options.secret),
    );
  }

  getWebhookEventMapping(eventType: string): WebhookEventMapping | null {
    return wiseWebhookEventMapping(eventType);
  }

  getSupportedWebhookEvents(): string[] {
    return [...WISE_SUPPORTED_WEBHOOK_EVENTS];
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
    return extractWiseWebhookData(event);
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
