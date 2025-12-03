import { Hono } from "hono";
import fs from "fs";
import path from "path";
import { databaseRegistry } from "../databases/registry";

export const databaseSchemaRoutes = new Hono();

// In a larger system, these could be moved to separate files or loaded dynamically
// Each database type exposes a simple schema describing the connection fields

type FieldType =
  | "string"
  | "number"
  | "boolean"
  | "password"
  | "textarea"
  | "select";

interface FieldSchema {
  name: string;
  label: string;
  type: FieldType;
  required?: boolean;
  default?: any;
  helperText?: string;
  placeholder?: string;
  rows?: number;
  options?: Array<{ label: string; value: any }>;
}

interface DatabaseSchemaResponse {
  fields: FieldSchema[];
}

const DATABASE_SCHEMAS: Record<string, DatabaseSchemaResponse> = {
  mongodb: {
    fields: [
      {
        name: "use_connection_string",
        label: "Use Connection String",
        type: "boolean",
        default: true,
      },
      {
        name: "connectionString",
        label: "Connection String",
        type: "textarea",
        required: false,
        rows: 2,
        placeholder:
          "mongodb+srv://username:password@cluster.mongodb.net/database",
        helperText: "Recommended for MongoDB Atlas or replica sets",
      },
      {
        name: "host",
        label: "Host",
        type: "string",
        required: false,
        placeholder: "localhost",
      },
      {
        name: "port",
        label: "Port",
        type: "number",
        required: false,
        default: 27017,
      },
      {
        name: "database",
        label: "Database",
        type: "string",
        required: false,
        placeholder: "myapp",
      },
      { name: "username", label: "Username", type: "string", required: false },
      {
        name: "password",
        label: "Password",
        type: "password",
        required: false,
      },
      { name: "ssl", label: "Use SSL/TLS", type: "boolean", default: false },
      {
        name: "authSource",
        label: "Auth Source",
        type: "string",
        required: false,
        placeholder: "admin",
      },
      {
        name: "replicaSet",
        label: "Replica Set",
        type: "string",
        required: false,
        placeholder: "rs0",
      },
    ],
  },
  postgresql: {
    fields: [
      {
        name: "host",
        label: "Host",
        type: "string",
        required: true,
        placeholder: "localhost",
      },
      {
        name: "port",
        label: "Port",
        type: "number",
        required: true,
        default: 5432,
      },
      {
        name: "database",
        label: "Database",
        type: "string",
        required: true,
        placeholder: "mydb",
      },
      { name: "username", label: "Username", type: "string", required: true },
      { name: "password", label: "Password", type: "password", required: true },
      { name: "ssl", label: "Use SSL/TLS", type: "boolean", default: false },
    ],
  },
  "cloudsql-postgres": {
    fields: [
      {
        name: "instanceConnectionName",
        label: "Instance Connection Name",
        type: "string",
        required: false,
        placeholder: "my-project:region:my-instance",
        helperText:
          "Provide either Instance Connection Name or Domain Name (DNS failover).",
      },
      {
        name: "domainName",
        label: "Domain Name (optional)",
        type: "string",
        required: false,
        placeholder: "prod-db.mycompany.example.com",
        helperText: "Use DNS-based instance mapping with automatic failover.",
      },
      {
        name: "database",
        label: "Database",
        type: "string",
        required: false,
        placeholder: "mydb",
        helperText: "Leave empty to list all databases (Cluster Mode)",
      },
      {
        name: "authType",
        label: "Auth Type",
        type: "select",
        required: false,
        default: "password",
        options: [
          { label: "Password", value: "password" },
          { label: "IAM", value: "IAM" },
        ],
        helperText:
          "Choose IAM to authenticate via Cloud SQL IAM Database Auth.",
      },
      {
        name: "username",
        label: "Username",
        type: "string",
        required: false,
        helperText:
          "For Password auth: postgres username. For IAM auth: leave empty (will use service-account@project.iam format automatically)",
      },
      {
        name: "password",
        label: "Password",
        type: "password",
        required: false,
      },
      {
        name: "ipType",
        label: "IP Type",
        type: "select",
        required: false,
        default: "PUBLIC",
        options: [
          { label: "Public", value: "PUBLIC" },
          { label: "Private", value: "PRIVATE" },
        ],
      },
      {
        name: "service_account_json",
        label: "Service Account JSON",
        type: "textarea",
        required: false,
        rows: 6,
        placeholder: '{\n  "type": "service_account",\n  ...\n}',
        helperText:
          "Paste the full service account JSON key. It will be stored encrypted. Required for IAM authentication.",
      },
    ],
  },
  mysql: {
    fields: [
      {
        name: "host",
        label: "Host",
        type: "string",
        required: true,
        placeholder: "localhost",
      },
      {
        name: "port",
        label: "Port",
        type: "number",
        required: true,
        default: 3306,
      },
      {
        name: "database",
        label: "Database",
        type: "string",
        required: true,
        placeholder: "mydb",
      },
      { name: "username", label: "Username", type: "string", required: true },
      { name: "password", label: "Password", type: "password", required: true },
      { name: "ssl", label: "Use SSL/TLS", type: "boolean", default: false },
    ],
  },
  sqlite: {
    fields: [
      {
        name: "database",
        label: "Database File Path",
        type: "string",
        required: true,
        placeholder: "/path/to/database.db",
      },
    ],
  },
  mssql: {
    fields: [
      {
        name: "host",
        label: "Host",
        type: "string",
        required: true,
        placeholder: "localhost",
      },
      {
        name: "port",
        label: "Port",
        type: "number",
        required: true,
        default: 1433,
      },
      {
        name: "database",
        label: "Database",
        type: "string",
        required: true,
        placeholder: "mydb",
      },
      { name: "username", label: "Username", type: "string", required: true },
      { name: "password", label: "Password", type: "password", required: true },
      { name: "ssl", label: "Use SSL/TLS", type: "boolean", default: false },
    ],
  },
  bigquery: {
    fields: [
      {
        name: "project_id",
        label: "Project ID",
        type: "string",
        required: true,
        placeholder: "my-gcp-project",
      },
      {
        name: "service_account_json",
        label: "Service Account JSON",
        type: "textarea",
        required: true,
        rows: 8,
        placeholder: '{\n  "type": "service_account",\n  ...\n}',
        helperText:
          "Paste the full service account JSON; it will be stored encrypted",
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
        label: "API Base URL (optional)",
        type: "string",
        required: false,
        default: "https://bigquery.googleapis.com",
      },
    ],
  },
  "cloudflare-d1": {
    fields: [
      {
        name: "account_id",
        label: "Account ID",
        type: "string",
        required: true,
        placeholder: "023e105f4ecef8ad9ca31a8372d0c353",
        helperText:
          "Your Cloudflare account ID (found in the URL when logged into the dashboard)",
      },
      {
        name: "api_token",
        label: "API Token",
        type: "password",
        required: true,
        placeholder: "Your Cloudflare API token",
        helperText:
          "Create an API token with D1 Edit permissions at https://dash.cloudflare.com/profile/api-tokens",
      },
      {
        name: "database_id",
        label: "Database ID (optional)",
        type: "string",
        required: false,
        placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
        helperText:
          "Leave empty to list all D1 databases in your account, or specify a database UUID to connect directly",
      },
    ],
  },
  "cloudflare-kv": {
    fields: [
      {
        name: "account_id",
        label: "Account ID",
        type: "string",
        required: true,
        placeholder: "023e105f4ecef8ad9ca31a8372d0c353",
        helperText:
          "Your Cloudflare account ID (found in the URL when logged into the dashboard)",
      },
      {
        name: "api_token",
        label: "API Token",
        type: "password",
        required: true,
        placeholder: "Your Cloudflare API token",
        helperText:
          "Create an API token with Workers KV Storage permissions at https://dash.cloudflare.com/profile/api-tokens",
      },
      {
        name: "namespace_id",
        label: "Namespace ID (optional)",
        type: "string",
        required: false,
        placeholder: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        helperText:
          "Leave empty to list all KV namespaces in your account, or specify a namespace ID to connect directly",
      },
    ],
  },
};

databaseSchemaRoutes.get("/types", c => {
  // Registered driver metadata (preferred)
  const registeredMeta = new Map(
    databaseRegistry.getAllMetadata().map(m => [m.type, m]),
  );

  // Union of schema-defined types and registered driver types
  const typeKeys = Array.from(
    new Set<string>([
      ...Object.keys(DATABASE_SCHEMAS),
      ...registeredMeta.keys(),
    ]),
  ).sort();

  const toDisplayName = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

  const toConsoleLanguage = (t: string): string => {
    // Default sensible mapping; drivers may override
    if (t === "mongodb") return "mongodb";
    if (t === "bigquery") return "sql";
    if (t === "cloudflare-d1") return "sql";
    if (t === "cloudflare-kv") return "javascript";
    return "sql";
  };

  const types = typeKeys.map(t => {
    const meta = registeredMeta.get(t);
    const displayName = meta?.displayName || toDisplayName(t);
    const consoleLanguage = meta?.consoleLanguage || toConsoleLanguage(t);
    const iconUrl = `/api/databases/${t}/icon.svg`;
    // Provide a stable default console template pattern per type
    // Use placeholder tokens to be filled by the client: {collection}, {project}, {dataset}, {table}
    const defaultTemplate =
      t === "mongodb"
        ? 'db.getCollection("{collection}").find({}).limit(500)'
        : t === "bigquery"
          ? "SELECT * FROM `{project}.{dataset}.{table}` LIMIT 500;"
          : t === "cloudflare-d1"
            ? "SELECT * FROM {table} LIMIT 500;"
            : t === "cloudflare-kv"
              ? "kv.list({ limit: 100 })"
              : "SELECT * FROM {table} LIMIT 500;";
    return { type: t, displayName, consoleLanguage, iconUrl, defaultTemplate };
  });

  return c.json({ success: true, data: types });
});

databaseSchemaRoutes.get("/:type/schema", c => {
  const type = c.req.param("type");
  const schema = DATABASE_SCHEMAS[type];
  if (!schema) {
    return c.json({ success: false, error: "Database type not found" }, 404);
  }
  return c.json({ success: true, data: schema });
});

// GET /api/databases/:type/icon.svg - return SVG icon for database type
databaseSchemaRoutes.get("/:type/icon.svg", c => {
  const type = c.req.param("type");
  if (!type) return c.text("Database type is required", 400);

  // Try filesystem icon under src/databases/icons/{type}.svg
  const tryPaths = [
    // New per-driver folder convention (compiled path first)
    path.resolve(__dirname, "..", "databases", "drivers", type, "icon.svg"),
    // When running from monorepo root in dev (ts-node/ts-node-dev)
    path.resolve(
      process.cwd(),
      "src",
      "databases",
      "drivers",
      type,
      "icon.svg",
    ),
    // When process.cwd() is the monorepo root and API code lives under api/src
    path.resolve(
      process.cwd(),
      "api",
      "src",
      "databases",
      "drivers",
      type,
      "icon.svg",
    ),
  ];

  for (const p of tryPaths) {
    if (fs.existsSync(p)) {
      const stat = fs.statSync(p);
      const etag = `"${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}"`;

      // Check If-None-Match for conditional requests
      const ifNoneMatch = c.req.header("If-None-Match");
      if (ifNoneMatch === etag) {
        return c.body(null, { status: 304 });
      }

      const svgBuffer = fs.readFileSync(p);
      const isDev = process.env.NODE_ENV !== "production";
      return c.body(svgBuffer, {
        headers: {
          "Content-Type": "image/svg+xml",
          ETag: etag,
          // In dev: always revalidate. In prod: cache for 1 day but allow revalidation.
          "Cache-Control": isDev
            ? "no-cache"
            : "public, max-age=86400, must-revalidate",
        },
      });
    }
  }

  // Built-in fallbacks for known types to avoid frontend hardcoding
  const builtin: Record<string, string> = {
    mongodb: `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="8.738 -5.03622834 17.45992422 39.40619484"><path d="m15.9.087.854 1.604c.192.296.4.558.645.802a22.406 22.406 0 0 1 2.004 2.266c1.447 1.9 2.423 4.01 3.12 6.292.418 1.394.645 2.824.662 4.27.07 4.323-1.412 8.035-4.4 11.12a12.7 12.7 0 0 1 -1.57 1.342c-.296 0-.436-.227-.558-.436a3.589 3.589 0 0 1 -.436-1.255c-.105-.523-.174-1.046-.14-1.586v-.244c-.024-.052-.285-24.052-.181-24.175z" fill="#599636"/><path d="m15.9.034c-.035-.07-.07-.017-.105.017.017.35-.105.662-.296.96-.21.296-.488.523-.767.767-1.55 1.342-2.77 2.963-3.747 4.776-1.3 2.44-1.97 5.055-2.16 7.808-.087.993.314 4.497.627 5.508.854 2.684 2.388 4.933 4.375 6.885.488.47 1.01.906 1.55 1.325.157 0 .174-.14.21-.244a4.78 4.78 0 0 0 .157-.68l.35-2.614z" fill="#6cac48"/><path d="m16.754 28.845c.035-.4.227-.732.436-1.063-.21-.087-.366-.26-.488-.453a3.235 3.235 0 0 1 -.26-.575c-.244-.732-.296-1.5-.366-2.248v-.453c-.087.07-.105.662-.105.75a17.37 17.37 0 0 1 -.314 2.353c-.052.314-.087.627-.28.906 0 .035 0 .07.017.122.314.924.4 1.865.453 2.824v.35c0 .418-.017.33.33.47.14.052.296.07.436.174.105 0 .122-.087.122-.157l-.052-.575v-1.604c-.017-.28.035-.558.07-.82z" fill="#c2bfbf"/></svg>`,
    bigquery: `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M17.74 16.32l-1.42 1.42a.42.42 0 0 0 0 .6l3.54 3.54a.42.42 0 0 0 .59 0l1.43-1.43a.42.42 0 0 0 0-.59l-3.54-3.54a.42.42 0 0 0-.6 0" fill="#4285f4"/><path d="M11 2a9 9 0 1 0 9 9 9 9 0 0 0-9-9m0 15.69A6.68 6.68 0 1 1 17.69 11 6.68 6.68 0 0 1 11 17.69" fill="#669df6"/></svg>`,
    "cloudflare-d1": `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><path fill="#F38020" d="M89.3 62.1c-.5-1.9-1.8-3-3.6-3.2l-42.3-.6c-.2 0-.4-.1-.5-.2-.1-.2-.1-.4 0-.6.1-.2.3-.4.6-.4l42.4-.6c4.8-.2 10-4.2 11.5-9l3.8-12c.1-.4.2-.8.2-1.2 0-.5-.1-1-.3-1.4-4.5-12.6-16.4-21.6-30.5-21.6-14.3 0-26.4 9.2-30.8 22-.5-.1-1.1-.1-1.6-.1-8.3 0-15.1 6.4-15.8 14.6-9.8.8-17.5 8.9-17.5 18.9 0 1.1.1 2.1.3 3.2.1.4.4.7.8.7h82.4c.3 0 .7-.3.8-.6l.6-3.6c.1-1.6-.2-3.4-.5-4.3z"/><path fill="#FAAD3F" d="M101.3 47.4c-.6 0-1.1 0-1.7.1-.2 0-.4.2-.5.4l-1.8 6.3c-.5 1.9-1.8 3-3.6 3.2l-42.3.6c-.2 0-.4.1-.5.2-.1.2-.1.4 0 .6.1.2.3.4.6.4l42.7.6c4.8.2 10 4.2 11.5 9l1.7 5.1c.1.3.4.5.7.4 8.6-2.5 14.9-10.5 14.9-19.9 0-3.9-1.1-7.6-2.9-10.7-2.7 2.2-6.2 3.5-9.9 3.7h-8.9z"/></svg>`,
  };

  const svg =
    builtin[type] ||
    `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><rect x="3" y="4" width="18" height="4" rx="2" fill="#90a4ae"/><rect x="3" y="10" width="18" height="4" rx="2" fill="#b0bec5"/><rect x="3" y="16" width="18" height="4" rx="2" fill="#cfd8dc"/></svg>`;

  return c.body(Buffer.from(svg, "utf8"), {
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "public, max-age=86400",
    },
  });
});
