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
  clickhouse: {
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
          "jdbc:clickhouse://host:8443?user=default&password=xxx&ssl=true",
        helperText: "JDBC URL format or ClickHouse Cloud connection string",
      },
      {
        name: "host",
        label: "Host",
        type: "string",
        required: false,
        placeholder: "localhost",
        helperText: "ClickHouse server URL (e.g. http://localhost:8123)",
      },
      {
        name: "port",
        label: "Port",
        type: "number",
        required: false,
        default: 8123,
      },
      {
        name: "database",
        label: "Database",
        type: "string",
        required: false,
        placeholder: "default",
      },
      {
        name: "username",
        label: "Username",
        type: "string",
        required: false,
        default: "default",
      },
      {
        name: "password",
        label: "Password",
        type: "password",
        required: false,
      },
      { name: "ssl", label: "Use SSL/TLS", type: "boolean", default: false },
    ],
  },
  postgresql: {
    fields: [
      {
        name: "use_connection_string",
        label: "Use Connection String",
        type: "boolean",
        default: false,
      },
      {
        name: "connectionString",
        label: "Connection String",
        type: "password",
        required: false,
        placeholder:
          "postgresql://user:password@host:5432/database?sslmode=require",
        helperText:
          "Full PostgreSQL connection URI. Editing this will update the fields below.",
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
        default: 5432,
      },
      {
        name: "database",
        label: "Database",
        type: "string",
        required: false,
        placeholder: "mydb",
        helperText: "Leave empty to see all available databases (cluster mode)",
      },
      { name: "username", label: "Username", type: "string", required: false },
      {
        name: "password",
        label: "Password",
        type: "password",
        required: false,
      },
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
        name: "use_connection_string",
        label: "Use Connection String",
        type: "boolean",
        default: false,
      },
      {
        name: "connectionString",
        label: "Connection String",
        type: "password",
        required: false,
        placeholder: "mysql://user:password@host:3306/database?ssl=true",
        helperText:
          "Full MySQL connection URI. Editing this will update the fields below.",
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
        default: 3306,
      },
      {
        name: "database",
        label: "Database",
        type: "string",
        required: false,
        placeholder: "mydb",
      },
      {
        name: "username",
        label: "Username",
        type: "string",
        required: false,
      },
      {
        name: "password",
        label: "Password",
        type: "password",
        required: false,
      },
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
    if (t === "clickhouse") return "sql";
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
        : t === "clickhouse"
          ? "SELECT * FROM {table} LIMIT 500;"
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

  // Generic database fallback when no icon.svg exists in driver folder
  const svg = `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><rect x="3" y="4" width="18" height="4" rx="2" fill="#90a4ae"/><rect x="3" y="10" width="18" height="4" rx="2" fill="#b0bec5"/><rect x="3" y="16" width="18" height="4" rx="2" fill="#cfd8dc"/></svg>`;

  return c.body(Buffer.from(svg, "utf8"), {
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "public, max-age=86400",
    },
  });
});
