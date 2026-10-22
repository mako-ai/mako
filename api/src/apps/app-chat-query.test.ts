/**
 * "Chat with app" SQL: the agent's query sees the app's binding tables and
 * nothing else on the host.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  describeAppData,
  gcsSecretSql,
  inferAppChatParquetMode,
  queryAppData,
  redactDuckDbError,
  scrubRemoteSources,
  systemCaCertFile,
  type AppDataTable,
} from "./app-chat-query";
import {
  bakeExtensions,
  DUCKDB_EXTENSION_DIR_ENV,
  loadBakedExtension,
} from "./duckdb-extensions";

let dir: string;
let tables: AppDataTable[];
let secret: string;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "app-chat-query-"));
  const orders = path.join(dir, "orders.parquet");
  const regions = path.join(dir, "regions.parquet");
  secret = path.join(dir, "secret.csv");
  fs.writeFileSync(secret, "token\nshh\n");
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  await connection.run(
    `COPY (SELECT range AS id, range % 3 AS region_id, range * 10 AS amount FROM range(500)) TO '${orders}' (FORMAT parquet)`,
  );
  await connection.run(
    `COPY (SELECT * FROM (VALUES (0, 'EU'), (1, 'US'), (2, 'APAC')) t(id, name)) TO '${regions}' (FORMAT parquet)`,
  );
  connection.closeSync();
  instance.closeSync();
  tables = [
    { name: "orders", file: orders },
    { name: "sales-regions", file: regions },
  ];
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("queryAppData", () => {
  it("queries bindings as tables, including hyphenated names", async () => {
    const result = await queryAppData(
      tables,
      `SELECT r.name, sum(o.amount)::BIGINT AS total
         FROM orders o JOIN "sales-regions" r ON r.id = o.region_id
        GROUP BY 1 ORDER BY 1`,
    );
    expect(result.columns.map(c => c.name)).toEqual(["name", "total"]);
    expect(result.rows).toHaveLength(3);
    expect(result.truncated).toBe(false);
  });

  it("caps rows and says so", async () => {
    const result = await queryAppData(tables, "SELECT * FROM orders", {
      maxRows: 10,
    });
    expect(result.rows).toHaveLength(10);
    expect(result.truncated).toBe(true);
  });

  it.each([
    ["read another file", () => `SELECT * FROM read_csv('${secret}')`],
    ["read a system file", () => "SELECT * FROM read_text('/etc/passwd')"],
    ["write a file", () => `COPY orders TO '${path.join(dir, "out.csv")}'`],
    ["attach a database", () => `ATTACH '${path.join(dir, "x.db")}'`],
    ["re-enable file access", () => "SET enable_external_access = true"],
    ["install an extension", () => "INSTALL httpfs"],
  ])("refuses to %s", async (_label, sql) => {
    await expect(queryAppData(tables, sql())).rejects.toThrow();
    expect(fs.existsSync(path.join(dir, "out.csv"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "x.db"))).toBe(false);
  });

  it("gets a fresh database per query, so a DROP touches nothing", async () => {
    await queryAppData(tables, "DROP VIEW orders");
    const result = await queryAppData(
      tables,
      "SELECT count(*) AS n FROM orders",
    );
    expect(result.rows[0]).toEqual({ n: "500" });
  });

  it("times out a runaway query", async () => {
    await expect(
      queryAppData(tables, "SELECT count(*) FROM range(100000000000) a", {
        timeoutMs: 200,
      }),
    ).rejects.toThrow(/timed out/);
  });
});

describe("describeAppData", () => {
  it("returns columns, row counts and samples", async () => {
    const [orders, regions] = await describeAppData(tables, 2);
    expect(orders.rowCount).toBe(500);
    expect(orders.columns.map(c => c.name)).toEqual([
      "id",
      "region_id",
      "amount",
    ]);
    expect(orders.sampleRows).toHaveLength(2);
    expect(regions.name).toBe("sales-regions");
    expect(regions.rowCount).toBe(3);
  });
});

describe("direct httpfs mode", () => {
  let server: http.Server;
  let allowedUrl: string;
  let forbiddenUrl: string;
  let remoteTables: AppDataTable[];
  let extensionDir: string;
  const originalExtensionDir = process.env[DUCKDB_EXTENSION_DIR_ENV];

  beforeAll(async () => {
    // Same path as the Docker build: bake httpfs once, runtime only LOADs.
    extensionDir = fs.mkdtempSync(path.join(os.tmpdir(), "duckdb-ext-"));
    await bakeExtensions(extensionDir);
    process.env[DUCKDB_EXTENSION_DIR_ENV] = extensionDir;
    const secretParquet = tables[1]?.file;
    const ordersParquet = tables[0]?.file;
    if (!secretParquet || !ordersParquet) {
      throw new Error("expected local parquet fixtures");
    }
    server = http.createServer((req, res) => {
      const file =
        req.url && req.url.startsWith("/secret")
          ? secretParquet
          : ordersParquet;
      const buf = fs.readFileSync(file);
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": buf.length,
        "accept-ranges": "bytes",
      });
      res.end(buf);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (!addr || typeof addr === "string") {
      throw new Error("httpfs test server has no port");
    }
    const base = `http://127.0.0.1:${addr.port}`;
    allowedUrl = `${base}/orders.parquet`;
    forbiddenUrl = `${base}/secret.parquet`;
    remoteTables = [{ name: "orders", file: allowedUrl }];
  });

  afterAll(() => {
    server.close();
    if (originalExtensionDir === undefined) {
      delete process.env[DUCKDB_EXTENSION_DIR_ENV];
    } else {
      process.env[DUCKDB_EXTENSION_DIR_ENV] = originalExtensionDir;
    }
    fs.rmSync(extensionDir, { recursive: true, force: true });
  });

  it("fails loudly when httpfs is not baked, without downloading", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "duckdb-ext-empty-"));
    process.env[DUCKDB_EXTENSION_DIR_ENV] = empty;
    try {
      await expect(
        queryAppData(remoteTables, "SELECT 1", { mode: "direct" }),
      ).rejects.toThrow(/"httpfs" is not installed in .*duckdb-ext-empty-/);
      expect(fs.readdirSync(empty)).toEqual([]);
    } finally {
      process.env[DUCKDB_EXTENSION_DIR_ENV] = extensionDir;
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it("scrubs remote source URLs from results and errors", async () => {
    const views = await queryAppData(
      remoteTables,
      "SELECT sql, current_setting('allowed_paths')::varchar AS paths FROM duckdb_views() WHERE NOT internal",
      { mode: "direct" },
    );
    const text = JSON.stringify(views.rows);
    expect(text).not.toContain(allowedUrl);
    expect(text).toContain("__data/orders.parquet");
    await expect(
      queryAppData(remoteTables, "SELECT nope FROM orders", {
        mode: "direct",
      }),
    ).rejects.not.toThrow(allowedUrl);
    const signed =
      "https://storage.googleapis.com/b/k.parquet?X-Goog-Algorithm=GOOG4&X-Goog-Credential=sa%40p&X-Goog-Signature=abc123";
    const scrubbed = scrubRemoteSources(
      `HTTP 403 for ${signed} and ${signed.slice(0, 120)}`,
      [{ name: "orders", file: signed }],
    );
    expect(scrubbed).not.toMatch(/abc123|sa%40p/);
    expect(scrubbed).toContain("__data/orders.parquet");
  });

  it("infers direct mode from remote URLs", () => {
    expect(inferAppChatParquetMode(tables)).toBe("copy");
    expect(inferAppChatParquetMode(remoteTables)).toBe("direct");
  });

  it("queries parquet over httpfs when the URL is allow-listed", async () => {
    const result = await queryAppData(
      remoteTables,
      "SELECT count(*) AS n FROM orders",
      { mode: "direct" },
    );
    expect(result.rows[0]).toEqual({ n: "500" });
  });

  it("refuses other URLs and local paths in direct mode", async () => {
    await expect(
      queryAppData(
        remoteTables,
        `SELECT * FROM read_parquet('${forbiddenUrl.replace(/'/g, "''")}')`,
        { mode: "direct" },
      ),
    ).rejects.toThrow(/Permission Error|Cannot access/i);
    await expect(
      queryAppData(remoteTables, "SELECT * FROM read_text('/etc/passwd')", {
        mode: "direct",
      }),
    ).rejects.toThrow(/Permission Error|Cannot access/i);
    await expect(
      queryAppData(remoteTables, "INSTALL json", { mode: "direct" }),
    ).rejects.toThrow();
    await expect(
      queryAppData(remoteTables, "SET enable_external_access = true", {
        mode: "direct",
      }),
    ).rejects.toThrow(/locked|enable_external_access/i);
  });

  it("refuses COPY to the allow-listed HTTP URL", async () => {
    await expect(
      queryAppData(
        remoteTables,
        `COPY orders TO '${allowedUrl.replace(/'/g, "''")}' (FORMAT parquet)`,
        { mode: "direct" },
      ),
    ).rejects.toThrow(/not implemented|Permission Error|Cannot access/i);
  });

  it("throws when local and remote parquet sources are mixed", async () => {
    await expect(
      queryAppData([...tables, ...remoteTables], "SELECT 1", {
        mode: "direct",
      }),
    ).rejects.toThrow(/all local or all remote/i);
  });

  it("binds a GCS HMAC secret in DuckDB scoped to the object URL", async () => {
    const instance = await DuckDBInstance.create(":memory:");
    const connection = await instance.connect();
    try {
      await loadBakedExtension(connection, "httpfs");
      await connection.run("SET allow_persistent_secrets = false");
      const gs = "gs://artifacts/apps/bindings/hash.parquet";
      await connection.run(
        gcsSecretSql(
          { kind: "hmac", keyId: "GOOG1ID", secret: "hmac-secret" },
          [gs],
        ),
      );
      const secrets = await connection.runAndReadAll(
        "SELECT name, type FROM duckdb_secrets()",
      );
      expect(secrets.getRowObjectsJson()).toEqual([
        { name: "__mako_gcs", type: "gcs" },
      ]);
    } finally {
      connection.closeSync();
      instance.closeSync();
    }
  });

  it("binds a GCS OAuth bearer secret in DuckDB", async () => {
    const instance = await DuckDBInstance.create(":memory:");
    const connection = await instance.connect();
    try {
      await loadBakedExtension(connection, "httpfs");
      await connection.run("SET allow_persistent_secrets = false");
      await connection.run(
        gcsSecretSql({ kind: "bearer", token: "ya29.token" }, [
          "gs://artifacts/apps/bindings/hash.parquet",
        ]),
      );
      const secrets = await connection.runAndReadAll(
        "SELECT name, type FROM duckdb_secrets()",
      );
      expect(secrets.getRowObjectsJson()).toEqual([
        { name: "__mako_gcs", type: "gcs" },
      ]);
    } finally {
      connection.closeSync();
      instance.closeSync();
    }
  });

  it("redacts CREATE SECRET literals from DuckDB errors", () => {
    const err = redactDuckDbError(
      new Error(
        "Binder Error: CREATE SECRET __mako_gcs (TYPE gcs, KEY_ID 'GOOG1ID', SECRET 'hmac-secret', BEARER_TOKEN 'ya29.token')",
      ),
    );
    expect(err.message).not.toMatch(/hmac-secret|ya29\.token|GOOG1ID/);
    expect(err.message).toMatch(/KEY_ID '\[redacted\]'/);
    expect(err.message).toMatch(/SECRET '\[redacted\]'/);
    expect(err.message).toMatch(/BEARER_TOKEN '\[redacted\]'/);
  });

  it("requires GCS auth before opening a gs:// parquet source", async () => {
    await expect(
      queryAppData(
        [{ name: "orders", file: "gs://artifacts/apps/bindings/hash.parquet" }],
        "SELECT 1",
        { mode: "direct" },
      ),
    ).rejects.toThrow(/HMAC keys or an OAuth bearer/i);
  });

  it("does not allow reading local files other than the CA bundle", async () => {
    const ca = systemCaCertFile();
    await expect(
      queryAppData(remoteTables, "SELECT * FROM read_text('/etc/passwd')", {
        mode: "direct",
      }),
    ).rejects.toThrow(/Permission Error|Cannot access/i);
    if (ca) {
      const result = await queryAppData(
        remoteTables,
        `SELECT count(*) AS n FROM read_text('${ca.replace(/'/g, "''")}')`,
        { mode: "direct" },
      );
      expect(Number(result.rows[0]?.n)).toBeGreaterThan(0);
    }
  });
});
