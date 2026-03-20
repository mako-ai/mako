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
    description: "Fetch paginated records from any REST endpoint",
    category: "api",
    code: `/**
 * REST API Connector
 * Fetches data from a REST API with cursor-based pagination.
 *
 * Secrets: API_KEY, API_BASE_URL
 * Config: endpoint, pageSize, entityName
 */
export async function pull(input: any) {
  const { ctx, config = {}, secrets = {}, state = {} } = input;
  const baseUrl = secrets.API_BASE_URL || config.baseUrl;
  const apiKey = secrets.API_KEY;
  const endpoint = config.endpoint || "/items";

  if (!baseUrl) {
    throw new Error("API_BASE_URL secret or baseUrl config is required");
  }

  const records: any[] = [];

  for await (const page of ctx.paginate({
    initialUrl: baseUrl + endpoint,
    mode: "cursor",
    pageSize: config.pageSize || 100,
    init: {
      headers: apiKey ? { Authorization: \`Bearer \${apiKey}\` } : {},
    },
  })) {
    records.push(...page.items);
    console.log(\`Fetched page \${page.page}: \${page.items.length} records\`);
  }

  return {
    batches: [{
      entity: config.entityName || "records",
      records,
    }],
    state: { ...state, lastRunAt: new Date().toISOString() },
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
export async function pull(input: any) {
  const { ctx, config = {}, secrets = {}, state = {} } = input;
  const apiKey = secrets.STRIPE_API_KEY;
  if (!apiKey) throw new Error("STRIPE_API_KEY secret is required");

  const entities = config.entities || ["customers", "charges", "subscriptions"];
  const batches: any[] = [];

  for (const entity of entities) {
    console.log(\`Syncing Stripe \${entity}\`);
    const records: any[] = [];

    for await (const page of ctx.paginate({
      initialUrl: \`https://api.stripe.com/v1/\${entity}\`,
      mode: "cursor",
      pageSize: 100,
      cursorParam: "starting_after",
      init: {
        headers: { Authorization: \`Bearer \${apiKey}\` },
      },
      getItems: (payload: any) => payload.data || [],
      getNextCursor: (payload: any) => {
        const data = payload.data;
        return data?.length ? data[data.length - 1].id : null;
      },
    })) {
      records.push(...page.items);
    }

    console.log(\`Fetched \${records.length} \${entity}\`);
    batches.push({ entity, records });
  }

  return {
    batches,
    state: { ...state, lastRunAt: new Date().toISOString() },
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
export async function pull(input: any) {
  const { config = {}, state = {} } = input;
  const payload = input.trigger?.payload;

  if (!payload) {
    console.warn("No webhook payload received");
    return { batches: [], state, hasMore: false };
  }

  const entityName = config.entityName || "webhook_events";

  const record = {
    event_id: payload.id || payload.event_id || \`evt_\${Date.now()}\`,
    event_type: payload.type || payload.event_type || "unknown",
    received_at: new Date().toISOString(),
    payload: JSON.stringify(payload),
    ...(payload.data?.object && {
      resource_id: payload.data.object.id,
      resource_type: payload.data.object.object,
    }),
  };

  console.log(\`Processing webhook event: \${record.event_type}\`);

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
      ...state,
      lastEventId: record.event_id,
      eventCount: (state.eventCount || 0) + 1,
    },
    hasMore: false,
  };
}
`,
  },
  {
    id: "graphql-api",
    name: "GraphQL API",
    description: "Query data from any GraphQL endpoint with pagination",
    category: "api",
    code: `/**
 * GraphQL API Connector
 * Fetches data using a GraphQL query with cursor-based pagination.
 *
 * Secrets: API_KEY, GRAPHQL_ENDPOINT
 * Config: query, variables, dataPath, cursorPath, hasMorePath
 */
export async function pull(input: any) {
  const { ctx, config = {}, secrets = {}, state = {} } = input;
  const endpoint = secrets.GRAPHQL_ENDPOINT || config.endpoint;
  const apiKey = secrets.API_KEY;
  if (!endpoint) throw new Error("GRAPHQL_ENDPOINT is required");

  const query = config.query || \`
    query GetData($cursor: String, $limit: Int) {
      data(after: $cursor, first: $limit) {
        nodes { id name createdAt }
        pageInfo { hasNextPage endCursor }
      }
    }
  \`;

  const dataPath = config.dataPath || "data.data.nodes";
  const cursorPath = config.cursorPath || "data.data.pageInfo.endCursor";
  const hasMorePath = config.hasMorePath || "data.data.pageInfo.hasNextPage";

  const getNestedValue = (obj: any, path: string) =>
    path.split(".").reduce((o: any, k: string) => o?.[k], obj);

  const allRecords: any[] = [];
  let cursor: string | null = null;
  let hasMore = true;
  const limit = config.limit || 50;

  while (hasMore) {
    const variables = { ...config.variables, cursor, limit };

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: \`Bearer \${apiKey}\` } : {}),
      },
      body: JSON.stringify({ query, variables }),
    });

    const json = await response.json();
    const data = getNestedValue(json, dataPath);
    if (!Array.isArray(data) || data.length === 0) break;

    allRecords.push(...data);
    cursor = getNestedValue(json, cursorPath);
    hasMore = getNestedValue(json, hasMorePath) === true;

    console.log(\`Fetched \${data.length} records (total: \${allRecords.length})\`);
  }

  return {
    batches: [{
      entity: config.entityName || "graphql_data",
      records: allRecords,
    }],
    state: { ...state, lastRunAt: new Date().toISOString() },
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
 * Config: url, format ("csv" | "json"), delimiter, entityName
 */
export async function pull(input: any) {
  const { config = {}, secrets = {}, state = {} } = input;
  const url = config.url;
  if (!url) throw new Error("url config is required");

  const format = config.format || "json";
  const headers: Record<string, string> = {};
  if (secrets.AUTH_TOKEN) {
    headers.Authorization = \`Bearer \${secrets.AUTH_TOKEN}\`;
  }

  console.log(\`Fetching \${format} data from \${url}\`);

  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(\`HTTP \${response.status}\`);

  let records: any[];

  if (format === "csv") {
    const text = await response.text();
    const delimiter = config.delimiter || ",";
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

  console.log(\`Parsed \${records.length} records\`);

  return {
    batches: [{
      entity: config.entityName || "imported_data",
      records,
    }],
    state: { ...state, lastRunAt: new Date().toISOString(), rowCount: records.length },
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
