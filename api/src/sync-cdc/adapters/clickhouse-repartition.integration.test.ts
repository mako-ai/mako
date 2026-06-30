import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  clickHousePartitionClause,
  buildClickHouseRepartitionStatements,
} from "./clickhouse";
import { buildCdcEntityLayout } from "./registry";

/**
 * Gated integration test for the ClickHouse in-place repartition (copy + swap).
 * Executes the SAME SQL the adapter runs (`buildClickHouseRepartitionStatements`)
 * against a real ClickHouse and asserts the partition key changes while the
 * existing rows are preserved — i.e. the layout is rewritten WITHOUT re-fetching
 * from the source.
 *
 * Skipped unless RUN_DB_INTEGRATION=1. Uses an external server when
 * CLICKHOUSE_TEST_HTTP is set (e.g. http://localhost:8123), otherwise spins one
 * up via testcontainers (requires Docker). Runs in the nightly CI job.
 */
const RUN =
  process.env.RUN_DB_INTEGRATION === "1" ||
  process.env.RUN_DB_INTEGRATION === "true";

describe.skipIf(!RUN)("ClickHouse in-place repartition", () => {
  let container: { stop: () => Promise<unknown> } | undefined;
  let baseUrl = "";

  beforeAll(async () => {
    const external = process.env.CLICKHOUSE_TEST_HTTP;
    if (external) {
      baseUrl = external.replace(/\/$/, "");
      return;
    }
    // Import lazily so the offline suite never loads testcontainers.
    const { GenericContainer } = await import("testcontainers");
    const started = await new GenericContainer(
      "clickhouse/clickhouse-server:24-alpine",
    )
      .withExposedPorts(8123)
      .start();
    container = started;
    baseUrl = `http://${started.getHost()}:${started.getMappedPort(8123)}`;
  }, 180_000);

  afterAll(async () => {
    if (container) await container.stop();
  });

  const ch = async (sql: string): Promise<Array<Record<string, string>>> => {
    const isSelect = /^\s*select/i.test(sql);
    const url = isSelect
      ? `${baseUrl}/?default_format=JSONEachRow`
      : `${baseUrl}/`;
    const res = await fetch(url, { method: "POST", body: sql });
    const text = await res.text();
    if (!res.ok) throw new Error(`CH failed: ${sql} :: ${text}`);
    if (!isSelect || !text.trim()) return [];
    return text
      .trim()
      .split("\n")
      .map(line => JSON.parse(line));
  };

  const partitionKey = async (db: string, table: string): Promise<string> => {
    const rows = await ch(
      `SELECT partition_key FROM system.tables WHERE database = '${db}' AND name = '${table}'`,
    );
    return String(rows[0]?.partition_key ?? "");
  };

  it("changes the partition key while preserving rows (copy + EXCHANGE)", async () => {
    const db = "default";
    const live = `repart_it_${Date.now().toString(36)}`;
    const tmp = `${live}__repart_tmp`;
    const fullLive = `\`${db}\`.\`${live}\``;
    const fullTmp = `\`${db}\`.\`${tmp}\``;

    // Seed a table with the OLD layout (partitioned by date_created).
    await ch(
      `CREATE TABLE ${fullLive} (
         id String, _syncedAt DateTime64(3),
         date_created DateTime64(3), _mako_source_ts DateTime64(3)
       ) ENGINE = ReplacingMergeTree(_mako_source_ts)
       PARTITION BY toYYYYMMDD(date_created) ORDER BY (id)`,
    );
    await ch(
      `INSERT INTO ${fullLive} VALUES
        ('a','2026-06-30 10:00:00','2026-01-01 00:00:00','2026-06-30 10:00:00'),
        ('b','2026-06-30 11:00:00','2026-02-01 00:00:00','2026-06-30 11:00:00'),
        ('c','2026-06-30 12:00:00','2026-03-01 00:00:00','2026-06-30 12:00:00')`,
    );

    expect(await partitionKey(db, live)).toBe("toYYYYMMDD(date_created)");

    // NEW desired layout: partition by _syncedAt — the exact SQL the adapter runs.
    const layout = buildCdcEntityLayout({
      entity: "leads",
      tableName: live,
      keyColumns: ["id"],
      partitioning: { type: "time", field: "_syncedAt", granularity: "day" },
    });
    const stmts = buildClickHouseRepartitionStatements({
      fullLive,
      fullTmp,
      partitionClause: clickHousePartitionClause(layout),
      orderByColumns: layout.keyColumns,
    });
    await ch(`DROP TABLE IF EXISTS ${fullTmp}`);
    await ch(stmts.createTmp);
    await ch(stmts.copy);
    await ch(stmts.exchange);
    await ch(`DROP TABLE IF EXISTS ${fullTmp}`);

    // Partition key changed; rows preserved exactly (no re-fetch).
    expect(await partitionKey(db, live)).toBe("toYYYYMMDD(_syncedAt)");
    const ids = (await ch(`SELECT id FROM ${fullLive} ORDER BY id`)).map(
      r => r.id,
    );
    expect(ids).toEqual(["a", "b", "c"]);

    await ch(`DROP TABLE IF EXISTS ${fullLive}`);
  }, 120_000);
});
