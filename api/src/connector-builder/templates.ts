export interface ConnectorTemplate {
  id: string;
  name: string;
  description: string;
  category: "api" | "webhook" | "analytics";
  code: string;
}

export const CONNECTOR_TEMPLATES: ConnectorTemplate[] = [
  {
    id: "rest-api",
    name: "REST API",
    description: "Fetch paginated records from a REST endpoint",
    category: "api",
    code: `export async function pull(input) {
  const { ctx, config = {}, secrets = {}, state = {} } = input;
  const baseUrl = secrets.API_BASE_URL || config.baseUrl;
  const endpoint = config.endpoint || "/items";
  const apiKey = secrets.API_KEY;

  if (!baseUrl) {
    throw new Error("API_BASE_URL secret or baseUrl config is required");
  }

  const records = [];

  for await (const page of ctx.paginate({
    initialUrl: baseUrl + endpoint,
    mode: "cursor",
    pageSize: config.pageSize || 100,
    init: {
      headers: apiKey ? { Authorization: \`Bearer \${apiKey}\` } : {},
    },
    getItems: payload => payload.data || payload.items || [],
    getNextCursor: payload => payload.nextCursor || payload.next_cursor || null,
  })) {
    records.push(...page.items);
    ctx.log("Fetched page", page.page, "records", page.items.length);
  }

  return {
    hasMore: false,
    state: {
      ...state,
      lastRunAt: new Date().toISOString(),
      rowCount: records.length,
    },
    batches: [
      {
        entity: config.entityName || "records",
        rows: records,
      },
    ],
  };
}
`,
  },
  {
    id: "stripe-lite",
    name: "Stripe Starter",
    description: "Fetch Stripe customers or charges with cursor pagination",
    category: "api",
    code: `export async function pull(input) {
  const { ctx, config = {}, secrets = {}, state = {} } = input;
  const apiKey = secrets.STRIPE_API_KEY;
  const entity = config.entity || "customers";

  if (!apiKey) {
    throw new Error("STRIPE_API_KEY secret is required");
  }

  const rows = [];

  for await (const page of ctx.paginate({
    initialUrl: \`https://api.stripe.com/v1/\${entity}\`,
    mode: "cursor",
    pageSize: 100,
    cursorParam: "starting_after",
    limitParam: "limit",
    init: {
      headers: {
        Authorization: \`Bearer \${apiKey}\`,
      },
    },
    getItems: payload => payload.data || [],
    getNextCursor: payload => {
      const items = payload.data || [];
      if (!payload.has_more || items.length === 0) {
        return null;
      }
      return items[items.length - 1].id;
    },
  })) {
    rows.push(...page.items);
    ctx.log("Stripe page", page.page, "entity", entity, "rows", page.items.length);
  }

  return {
    hasMore: false,
    state: {
      ...state,
      lastEntity: entity,
      lastRunAt: new Date().toISOString(),
    },
    batches: [
      {
        entity,
        rows,
      },
    ],
  };
}
`,
  },
  {
    id: "webhook-handler",
    name: "Webhook Handler",
    description: "Transform inbound webhook payloads into structured rows",
    category: "webhook",
    code: `export async function pull(input) {
  const { trigger = {}, state = {} } = input;
  const payload = trigger.payload || {};

  const row = {
    receivedAt: new Date().toISOString(),
    eventType: payload.type || payload.event_type || "unknown",
    eventId: payload.id || payload.event_id || \`evt_\${Date.now()}\`,
    payload,
  };

  return {
    hasMore: false,
    state: {
      ...state,
      lastEventId: row.eventId,
      eventCount: (state.eventCount || 0) + 1,
    },
    batches: [
      {
        entity: "webhook_events",
        rows: [row],
      },
    ],
    schemas: [
      {
        entity: "webhook_events",
        primaryKey: ["eventId"],
        columns: [
          { name: "receivedAt", type: "datetime" },
          { name: "eventType", type: "string" },
          { name: "eventId", type: "string" },
          { name: "payload", type: "json" },
        ],
      },
    ],
  };
}
`,
  },
];

export function getConnectorTemplate(
  templateId: string,
): ConnectorTemplate | null {
  return (
    CONNECTOR_TEMPLATES.find(template => template.id === templateId) || null
  );
}
