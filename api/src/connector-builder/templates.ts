/**
 * Pre-built connector templates that users can start from.
 */

export interface ConnectorTemplate {
  id: string;
  name: string;
  description: string;
  category: "api" | "webhook" | "database" | "analytics";
  code: string;
}

export const CONNECTOR_TEMPLATES: ConnectorTemplate[] = [
  {
    id: "rest-api",
    name: "REST API",
    description: "Fetch data from any REST API with pagination support",
    category: "api",
    code: `/**
 * REST API Connector
 * Fetches data from a REST API with cursor-based pagination.
 *
 * Secrets: API_KEY, API_BASE_URL
 * Config: endpoint, dataPath, cursorPath
 */
export async function pull(ctx: any) {
  const baseUrl = ctx.secrets.API_BASE_URL || ctx.config.baseUrl;
  const apiKey = ctx.secrets.API_KEY;
  const endpoint = ctx.config.endpoint || "/data";
  const dataPath = ctx.config.dataPath || "data";
  const cursorPath = ctx.config.cursorPath || "next_cursor";

  if (!baseUrl) {
    throw new Error("API_BASE_URL secret or baseUrl config is required");
  }

  const allRecords: any[] = [];

  for await (const page of ctx.paginate({
    url: baseUrl + endpoint,
    headers: apiKey ? { Authorization: \`Bearer \${apiKey}\` } : {},
    strategy: "cursor",
    dataPath,
    cursorPath,
    limit: 100,
  })) {
    allRecords.push(...page);
    ctx.log.info(\`Fetched \${page.length} records (total: \${allRecords.length})\`);
  }

  return {
    batches: [{
      entity: ctx.config.entityName || "records",
      records: allRecords,
    }],
    state: { lastRunAt: new Date().toISOString() },
    hasMore: false,
  };
}
`,
  },
  {
    id: "stripe",
    name: "Stripe",
    description: "Sync customers, charges, and subscriptions from Stripe",
    category: "api",
    code: `/**
 * Stripe Connector
 * Syncs customers, charges, and subscriptions.
 *
 * Secrets: STRIPE_API_KEY
 * Config: entities (array of entity names to sync)
 */
export async function pull(ctx: any) {
  const apiKey = ctx.secrets.STRIPE_API_KEY;
  if (!apiKey) throw new Error("STRIPE_API_KEY secret is required");

  const entities = ctx.config.entities || ["customers", "charges", "subscriptions"];
  const batches: any[] = [];

  for (const entity of entities) {
    ctx.log.info(\`Syncing Stripe \${entity}\`);
    const records: any[] = [];

    for await (const page of ctx.paginate({
      url: \`https://api.stripe.com/v1/\${entity}\`,
      headers: { Authorization: \`Bearer \${apiKey}\` },
      strategy: "cursor",
      cursorParam: "starting_after",
      cursorPath: "data.-1.id", // Last item's ID
      dataPath: "data",
      limitParam: "limit",
      limit: 100,
    })) {
      records.push(...page);
    }

    ctx.log.info(\`Fetched \${records.length} \${entity}\`);
    batches.push({ entity, records });
  }

  return {
    batches,
    state: { lastRunAt: new Date().toISOString() },
    hasMore: false,
  };
}
`,
  },
  {
    id: "webhook-handler",
    name: "Webhook Handler",
    description: "Process incoming webhook events and transform payloads",
    category: "webhook",
    code: `/**
 * Webhook Handler Connector
 * Processes webhook payloads and transforms them for storage.
 *
 * Triggered by: webhook events
 * Config: entityName
 */
export async function pull(ctx: any) {
  const payload = ctx.trigger.payload;

  if (!payload) {
    ctx.log.warn("No webhook payload received");
    return { batches: [], state: ctx.state, hasMore: false };
  }

  const entityName = ctx.config.entityName || "webhook_events";

  // Transform the webhook payload into a record
  const record = {
    event_id: payload.id || payload.event_id || \`evt_\${Date.now()}\`,
    event_type: payload.type || payload.event_type || "unknown",
    received_at: new Date().toISOString(),
    payload: JSON.stringify(payload),
    // Extract common fields if present
    ...(payload.data?.object && {
      resource_id: payload.data.object.id,
      resource_type: payload.data.object.object,
    }),
  };

  ctx.log.info(\`Processing webhook event: \${record.event_type}\`);

  return {
    batches: [{
      entity: entityName,
      records: [record],
      schema: {
        name: entityName,
        columns: [
          { name: "event_id", type: "string", primaryKey: true },
          { name: "event_type", type: "string" },
          { name: "received_at", type: "datetime" },
          { name: "payload", type: "json" },
          { name: "resource_id", type: "string", nullable: true },
          { name: "resource_type", type: "string", nullable: true },
        ],
      },
    }],
    state: {
      lastEventId: record.event_id,
      lastEventAt: record.received_at,
      eventCount: (ctx.state.eventCount || 0) + 1,
    },
    hasMore: false,
  };
}
`,
  },
  {
    id: "graphql-api",
    name: "GraphQL API",
    description: "Query data from any GraphQL endpoint",
    category: "api",
    code: `/**
 * GraphQL API Connector
 * Fetches data using a GraphQL query with cursor-based pagination.
 *
 * Secrets: API_KEY, GRAPHQL_ENDPOINT
 * Config: query, variables, dataPath, cursorPath
 */
export async function pull(ctx: any) {
  const endpoint = ctx.secrets.GRAPHQL_ENDPOINT || ctx.config.endpoint;
  const apiKey = ctx.secrets.API_KEY;
  if (!endpoint) throw new Error("GRAPHQL_ENDPOINT is required");

  const query = ctx.config.query || \`
    query GetData($cursor: String, $limit: Int) {
      data(after: $cursor, first: $limit) {
        nodes { id name createdAt }
        pageInfo { hasNextPage endCursor }
      }
    }
  \`;

  const dataPath = ctx.config.dataPath || "data.data.nodes";
  const cursorPath = ctx.config.cursorPath || "data.data.pageInfo.endCursor";
  const hasMorePath = ctx.config.hasMorePath || "data.data.pageInfo.hasNextPage";

  const allRecords: any[] = [];
  let cursor: string | null = null;
  let hasMore = true;
  const limit = ctx.config.limit || 50;

  while (hasMore) {
    const variables = { ...ctx.config.variables, cursor, limit };

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: \`Bearer \${apiKey}\` } : {}),
      },
      body: JSON.stringify({ query, variables }),
    });

    const json = await response.json();

    const getNestedValue = (obj: any, path: string) =>
      path.split(".").reduce((o: any, k: string) => o?.[k], obj);

    const data = getNestedValue(json, dataPath);
    if (!Array.isArray(data) || data.length === 0) break;

    allRecords.push(...data);
    cursor = getNestedValue(json, cursorPath);
    hasMore = getNestedValue(json, hasMorePath) === true;

    ctx.log.info(\`Fetched \${data.length} records (total: \${allRecords.length})\`);
  }

  return {
    batches: [{
      entity: ctx.config.entityName || "graphql_data",
      records: allRecords,
    }],
    state: { lastRunAt: new Date().toISOString() },
    hasMore: false,
  };
}
`,
  },
  {
    id: "csv-import",
    name: "CSV/File Import",
    description: "Fetch and parse CSV or JSON files from URLs",
    category: "database",
    code: `/**
 * CSV/File Import Connector
 * Fetches CSV or JSON data from a URL.
 *
 * Secrets: AUTH_TOKEN (optional)
 * Config: url, format ("csv" | "json"), delimiter
 */
export async function pull(ctx: any) {
  const url = ctx.config.url;
  if (!url) throw new Error("url config is required");

  const format = ctx.config.format || "json";
  const headers: Record<string, string> = {};
  if (ctx.secrets.AUTH_TOKEN) {
    headers.Authorization = \`Bearer \${ctx.secrets.AUTH_TOKEN}\`;
  }

  ctx.log.info(\`Fetching \${format} data from \${url}\`);

  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(\`HTTP \${response.status}\`);

  let records: any[];

  if (format === "csv") {
    const text = await response.text();
    const delimiter = ctx.config.delimiter || ",";
    const lines = text.split("\\n").filter((l: string) => l.trim());
    const headerLine = lines[0].split(delimiter).map((h: string) => h.trim().replace(/^"|"$/g, ""));
    records = lines.slice(1).map((line: string) => {
      const values = line.split(delimiter).map((v: string) => v.trim().replace(/^"|"$/g, ""));
      const obj: Record<string, string> = {};
      headerLine.forEach((h: string, i: number) => { obj[h] = values[i] || ""; });
      return obj;
    });
  } else {
    const data = await response.json();
    records = Array.isArray(data) ? data : data.data || data.results || [data];
  }

  ctx.log.info(\`Parsed \${records.length} records\`);

  return {
    batches: [{
      entity: ctx.config.entityName || "imported_data",
      records,
    }],
    state: { lastRunAt: new Date().toISOString(), rowCount: records.length },
    hasMore: false,
  };
}
`,
  },
];

export function getTemplateById(id: string): ConnectorTemplate | undefined {
  return CONNECTOR_TEMPLATES.find(t => t.id === id);
}

export function getTemplatesByCategory(category: string): ConnectorTemplate[] {
  return CONNECTOR_TEMPLATES.filter(t => t.category === category);
}
