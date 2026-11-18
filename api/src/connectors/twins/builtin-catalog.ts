/**
 * What the deleted in-process connectors told the rest of Mako about
 * themselves, frozen on 2026-11-18 when their code left the API.
 *
 * GENERATED from the built-ins' own getMetadata(), getWebhookCapabilities(),
 * getIncrementalCapabilities() and static getConfigSchema() at the commit
 * before their deletion. Do not edit by hand: the config schema is what the
 * stored credentials were encrypted by, so changing a field name or its
 * secret flag would stop decrypting existing connections.
 */
import type {
  IncrementalCapabilities,
  WebhookCapabilities,
} from "../base/BaseConnector";

export interface BuiltinTwinEntry {
  /** The deleted class, for logs and docs. */
  className: string;
  metadata: {
    name: string;
    version: string;
    description: string;
    author?: string;
    supportedEntities: string[];
  };
  webhook: WebhookCapabilities;
  incremental: IncrementalCapabilities;
  /** The static getConfigSchema() the credentials were stored by. */
  configSchema: Record<string, unknown>;
}

export const BUILTIN_TWIN_CATALOG = {
  close: {
    className: "CloseConnector",
    metadata: {
      name: "Close",
      version: "1.0.0",
      description: "Connector for Close CRM",
      supportedEntities: [
        "leads",
        "opportunities",
        "activities",
        "contacts",
        "users",
        "custom_fields",
      ],
    },
    webhook: {
      supported: true,
      provisioning: {
        supported: true,
        providerLabel: "Close",
        storesSecretAutomatically: true,
        actionHint: "and stores its signing secret",
      },
      secretHelpText: "Enter the webhook signing secret from your provider",
    },
    incremental: {
      supported: true,
      mode: "native",
      perEntity: {
        users: {
          mode: "native",
          anchorField: "date_updated__gte",
        },
        custom_fields: {
          mode: "native",
          anchorField: "date_updated__gte",
        },
        leads: {
          mode: "native",
          anchorField: "date_updated",
        },
        contacts: {
          mode: "native",
          anchorField: "date_updated",
        },
        opportunities: {
          mode: "native",
          anchorField: "date_updated",
        },
        groups: {
          mode: "none",
        },
        lead_statuses: {
          mode: "none",
        },
        opportunity_statuses: {
          mode: "none",
        },
        outcomes: {
          mode: "none",
        },
        custom_activity_types: {
          mode: "none",
        },
        custom_object_types: {
          mode: "none",
        },
        custom_objects: {
          mode: "none",
        },
      },
    },
    configSchema: {
      fields: [
        {
          name: "api_key",
          label: "API Key",
          type: "password",
          required: true,
          helperText: "Close API Key (generate in Close settings)",
        },
      ],
    },
  },
  stripe: {
    className: "StripeConnector",
    metadata: {
      name: "Stripe",
      version: "1.0.0",
      description: "Connector for Stripe payment platform",
      supportedEntities: [
        "customers",
        "subscriptions",
        "disputes",
        "charges",
        "invoices",
        "products",
        "plans",
        "prices",
        "payment_intents",
        "balance_transactions",
        "payouts",
        "payout_balance_transactions",
        "refunds",
        "credit_notes",
        "customer_balance_transactions",
        "invoice_items",
        "subscription_schedules",
        "coupons",
        "promotion_codes",
        "checkout_sessions",
        "setup_intents",
        "early_fraud_warnings",
      ],
    },
    webhook: {
      supported: true,
      provisioning: {
        supported: true,
        providerLabel: "Stripe",
        storesSecretAutomatically: true,
        actionHint: "and stores its signing secret",
      },
      secretHelpText:
        "Get this from Stripe Dashboard > Webhooks > Your endpoint > Signing secret",
    },
    incremental: {
      supported: true,
      mode: "created-anchor",
      perEntity: {
        customer_balance_transactions: {
          mode: "none",
        },
      },
      warning:
        "Stripe only reports newly created records to polls; updates to existing records require the webhook trigger.",
    },
    configSchema: {
      fields: [
        {
          name: "api_key",
          label: "API Key",
          type: "password",
          required: true,
          helperText: "Your Stripe secret API key",
        },
        {
          name: "api_base_url",
          label: "API Base URL",
          type: "string",
          required: false,
          default: "https://api.stripe.com",
        },
      ],
    },
  },
  pandadoc: {
    className: "PandaDocConnector",
    metadata: {
      name: "PandaDoc",
      version: "1.0.0",
      description:
        "Connector for PandaDoc documents, templates, contacts, and members. Real-time document + template webhooks (CDC); scheduled backfill covers contacts and members.",
      supportedEntities: ["documents", "templates", "contacts", "members"],
    },
    webhook: {
      supported: true,
      provisioning: {
        supported: true,
        providerLabel: "PandaDoc",
        storesSecretAutomatically: true,
      },
      secretHelpText:
        "Enter the webhook subscription Shared Key from the PandaDoc Developer Dashboard (used to verify the HMAC signature).",
    },
    incremental: {
      supported: true,
      mode: "none",
      perEntity: {
        documents: {
          mode: "native",
          anchorField: "modified_from",
        },
        templates: {
          mode: "client-filter",
        },
        members: {
          mode: "client-filter",
        },
      },
    },
    configSchema: {
      fields: [
        {
          name: "api_key",
          label: "API Key",
          type: "password",
          required: true,
          helperText:
            "PandaDoc API Key (generate in the Developer Dashboard). Used as `Authorization: API-Key <key>`.",
        },
        {
          name: "api_base_url",
          label: "API Base URL",
          type: "string",
          required: false,
          default: "https://api.pandadoc.com",
        },
        {
          name: "fetch_document_details",
          label: "Fetch full document details",
          type: "boolean",
          required: false,
          default: true,
          helperText:
            "Hydrate each document with its full detail (fields, tokens, metadata, pricing, products, recipients) during backfill. The document list endpoint omits these. Disable to reduce API calls if you hit rate limits.",
        },
      ],
    },
  },
  claap: {
    className: "ClaapConnector",
    metadata: {
      name: "Claap",
      version: "1.1.0",
      description:
        "Connector for Claap meeting recordings, their transcripts, workspace metadata, and webhooks",
      supportedEntities: ["recordings", "recording_transcripts", "workspace"],
    },
    webhook: {
      supported: true,
      provisioning: {
        supported: true,
        providerLabel: "Claap",
        storesSecretAutomatically: false,
        actionHint: "(copy the secret into this form if Claap shows it once)",
      },
      secretHelpText:
        "Enter the X-Claap-Webhook-Secret from your Claap webhook settings",
    },
    incremental: {
      supported: true,
      mode: "none",
      perEntity: {
        recordings: {
          mode: "created-anchor",
          anchorField: "createdAfter",
        },
        recording_transcripts: {
          mode: "created-anchor",
          anchorField: "createdAfter",
        },
      },
      warning:
        "Claap recordings are matched by creation date only; edits to recordings older than the re-read window (recordings_lookback_days) require the webhook trigger or a full backfill.",
    },
    configSchema: {
      fields: [
        {
          name: "api_key",
          label: "API Key",
          type: "password",
          required: true,
          helperText:
            "Claap workspace API key (X-Claap-Key). Generate in Claap settings.",
        },
        {
          name: "api_base_url",
          label: "API Base URL",
          type: "string",
          required: false,
          default: "https://api.claap.io",
        },
        {
          name: "recordings_lookback_days",
          label: "Recordings re-read window (days)",
          type: "number",
          required: false,
          default: 0,
          placeholder: "0",
          helperText:
            "Incremental runs re-read recordings created this many days before the last sync, picking up AI fields Claap generates later. 0 reads only new recordings, max 7. Every poll re-reads the whole window at one API call per recording, so the cost is window × polls per day.",
        },
      ],
    },
  },
  posthog: {
    className: "PosthogConnector",
    metadata: {
      name: "PostHog",
      version: "1.2.0",
      description:
        "Connector for PostHog REST entities (surveys, feature flags, experiments, annotations) and HogQL Query API (each query is an entity)",
      supportedEntities: [
        "surveys",
        "survey_responses",
        "feature_flags",
        "experiments",
        "annotations",
      ],
    },
    webhook: {
      supported: false,
      provisioning: {
        supported: false,
        providerLabel: "PostHog",
        storesSecretAutomatically: false,
      },
      secretHelpText: "Enter the webhook signing secret from your provider",
    },
    incremental: {
      supported: true,
      mode: "native",
      anchorField: "$since",
      perEntity: {
        surveys: {
          mode: "created-anchor",
          anchorField: "created_at",
        },
        feature_flags: {
          mode: "created-anchor",
          anchorField: "created_at",
        },
        experiments: {
          mode: "created-anchor",
          anchorField: "created_at",
        },
        annotations: {
          mode: "created-anchor",
          anchorField: "created_at",
        },
        survey_responses: {
          mode: "native",
          anchorField: "since",
        },
      },
      warning:
        "Incremental substitutes $since/{{since}} in your HogQL. Queries without that placeholder still full-repull every poll — add the placeholder or use Full Refresh. Surveys, feature flags, experiments, and annotations only filter by created_at (edits need a full reconcile).",
    },
    configSchema: {
      fields: [
        {
          name: "api_base_url",
          label: "API Base URL",
          type: "string",
          required: false,
          default: "https://app.posthog.com",
          helperText:
            "Base URL for PostHog API (e.g. https://us.posthog.com or https://eu.posthog.com)",
        },
        {
          name: "project_id",
          label: "Project ID",
          type: "string",
          required: true,
          helperText: "PostHog Project ID (numeric)",
        },
        {
          name: "api_key",
          label: "API Key",
          type: "password",
          required: true,
          helperText:
            "Personal API key (recommended) or Project API key depending on Auth Type",
        },
        {
          name: "auth_type",
          label: "Auth Type",
          type: "select",
          required: false,
          default: "personal_api_key",
          options: [
            {
              label: "Personal API Key (Bearer)",
              value: "personal_api_key",
            },
            {
              label: "Project API Key (POSTHOG-API-TOKEN)",
              value: "project_api_key",
            },
          ],
        },
      ],
      transferQueries: {
        label: "HogQL Queries",
        required: false,
        fields: [
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
            label: "HogQL Query",
            type: "textarea",
            required: true,
            rows: 8,
            placeholder:
              "SELECT event, count() AS cnt FROM events WHERE timestamp > now() - interval 7 day GROUP BY event ORDER BY cnt DESC",
            helperText:
              "Optional placeholders: $limit, $offset, and $since / {{since}}. If limit/offset are omitted, pagination will be appended automatically.",
          },
          {
            name: "batch_size",
            label: "Batch Size",
            type: "number",
            required: false,
            default: 100,
            placeholder: "100",
            helperText: "Number of records per request",
          },
        ],
      },
    },
  },
  wise: {
    className: "WiseConnector",
    metadata: {
      name: "Wise",
      version: "1.0.0",
      description:
        "Connector for Wise (TransferWise): profiles, balances, balance statements, transfers, recipients, and activities. CDC via Wise webhooks (RSA-SHA256).",
      supportedEntities: [
        "profiles",
        "balances",
        "balance_updates",
        "transfers",
        "recipients",
        "activities",
        "balance_statements",
      ],
    },
    webhook: {
      supported: true,
      provisioning: {
        supported: true,
        providerLabel: "Wise",
        storesSecretAutomatically: true,
        actionHint:
          "on every profile this connection syncs and records which Wise signing key verifies it",
      },
      secretHelpText:
        'Wise signs webhooks with its RSA public keys, not a shared secret: this field only names the key set — "production" (or blank) or "sandbox". Creating the webhook in Wise fills it in.',
    },
    incremental: {
      supported: true,
      mode: "none",
      perEntity: {
        transfers: {
          mode: "created-anchor",
          anchorField: "createdDateStart",
        },
        activities: {
          mode: "native",
          anchorField: "since",
        },
        balance_statements: {
          mode: "native",
          anchorField: "intervalStart",
        },
      },
      warning:
        "Wise transfer polls only see newly created transfers; status updates on existing transfers (and all balance/recipient changes) require the webhook trigger or a periodic full reconcile.",
    },
    configSchema: {
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
          default: "https://api.wise.com",
          helperText:
            "Production: https://api.wise.com. Sandbox: https://api.sandbox.transferwise.tech",
        },
      ],
    },
  },
  calendly: {
    className: "CalendlyConnector",
    metadata: {
      name: "Calendly",
      version: "1.0.0",
      description:
        "Connector for Calendly scheduling: organizations, users, groups, event_types, scheduled_events, invitees, contacts. Real-time invitee + event_type webhooks; scheduled backfill picks up everything else.",
      supportedEntities: [
        "organizations",
        "users",
        "groups",
        "event_types",
        "scheduled_events",
        "invitees",
        "contacts",
      ],
    },
    webhook: {
      supported: true,
      provisioning: {
        supported: true,
        providerLabel: "Calendly",
        storesSecretAutomatically: true,
      },
      secretHelpText: "Enter the webhook signing secret from your provider",
    },
    incremental: {
      supported: true,
      mode: "none",
      perEntity: {
        scheduled_events: {
          mode: "created-anchor",
          anchorField: "min_start_time",
        },
        groups: {
          mode: "client-filter",
          anchorField: "updated_at",
        },
        event_types: {
          mode: "client-filter",
          anchorField: "updated_at",
        },
        contacts: {
          mode: "client-filter",
          anchorField: "updated_at",
        },
        users: {
          mode: "client-filter",
          anchorField: "updated_at",
        },
      },
      warning:
        "Calendly events are matched by scheduled start time, not last edit; changes to already-scheduled events require the webhook trigger.",
    },
    configSchema: {
      fields: [
        {
          name: "access_token",
          label: "Personal Access Token",
          type: "password",
          required: true,
          helperText:
            "Calendly PAT or OAuth bearer token. Required scopes: organizations:read, users:read, groups:read, event_types:read, scheduled_events:read, contacts:read. For auto-provisioned webhooks also: webhooks:read and webhooks:write.",
        },
        {
          name: "api_base_url",
          label: "API Base URL",
          type: "string",
          required: false,
          default: "https://api.calendly.com",
        },
      ],
    },
  },
} satisfies Record<string, BuiltinTwinEntry>;
