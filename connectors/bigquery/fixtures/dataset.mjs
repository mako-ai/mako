/**
 * A synthetic BigQuery project for the parity cassettes: 4 SQL queries with
 * their result schemas and rows, in the REST API's `f`/`v` cell form. They
 * cover every type the connector maps (INTEGER, FLOAT, NUMERIC, BOOLEAN,
 * TIMESTAMP, DATE, DATETIME, RECORD, REPEATED and NULL), a job that is not
 * complete at first, legacy SQL and an empty result. Nothing here came from
 * BigQuery; no credential is involved.
 */

const cell = v => ({ v });
const ts = (iso, i) => String((Date.parse(iso) + i * 3_600_000) / 1000);

const EVENTS_SCHEMA = {
  fields: [
    { name: "id", type: "STRING", mode: "REQUIRED" },
    { name: "created_at", type: "TIMESTAMP", mode: "NULLABLE" },
    { name: "n", type: "INTEGER", mode: "NULLABLE" },
    { name: "score", type: "FLOAT", mode: "NULLABLE" },
    { name: "amount", type: "NUMERIC", mode: "NULLABLE" },
    { name: "flag", type: "BOOLEAN", mode: "NULLABLE" },
    { name: "day", type: "DATE", mode: "NULLABLE" },
    {
      name: "meta",
      type: "RECORD",
      mode: "NULLABLE",
      fields: [
        { name: "source", type: "STRING" },
        { name: "tags", type: "STRING", mode: "REPEATED" },
      ],
    },
    { name: "nums", type: "INT64", mode: "REPEATED" },
  ],
};

const events = Array.from({ length: 25 }, (_, i) => ({
  f: [
    cell(`evt_${String(i + 1).padStart(3, "0")}`),
    cell(i % 6 === 5 ? null : ts("2026-01-05T10:00:00Z", i * 7)),
    cell(String(i * 13)),
    cell(i % 4 === 0 ? null : String(i / 8)),
    cell(String((i * 1234.5).toFixed(2))),
    cell(i % 2 === 0 ? "true" : "false"),
    cell(`2026-01-${String((i % 28) + 1).padStart(2, "0")}`),
    cell(
      i % 5 === 0
        ? null
        : {
            f: [cell(i % 2 ? "web" : "app"), cell([cell("a"), cell(`t${i}`)])],
          },
    ),
    cell(i % 3 === 0 ? [] : [cell(String(i)), cell(String(i * 2))]),
  ],
}));

const SLOW_SCHEMA = {
  fields: [
    { name: "id", type: "INTEGER" },
    { name: "updated_at", type: "DATETIME" },
    { name: "ratio", type: "FLOAT64" },
    { name: "active", type: "BOOL" },
  ],
};

const slow = Array.from({ length: 5 }, (_, i) => ({
  f: [
    cell(String(1000 + i)),
    cell(`2026-02-0${i + 1}T08:30:00`),
    cell(String(0.5 + i)),
    cell(i === 2 ? null : String(i % 2 === 0)),
  ],
}));

const LEGACY_SCHEMA = {
  fields: [
    { name: "id", type: "STRING" },
    { name: "country", type: "STRING" },
    { name: "sessions", type: "INTEGER" },
  ],
};

const legacy = Array.from({ length: 7 }, (_, i) => ({
  f: [
    cell(`sess_${i + 1}`),
    cell(["CH", "FR", "ES", "IT"][i % 4]),
    cell(String(100 * (i + 1))),
  ],
}));

export const QUERIES = [
  {
    name: "events",
    query:
      "SELECT id, created_at, n, score, amount, flag, day, meta, nums FROM `parity-project.analytics.events` ORDER BY id",
    batch_size: 10,
    schema: EVENTS_SCHEMA,
    rows: events,
  },
  {
    name: "slow_job",
    query:
      "SELECT id, updated_at, ratio, active FROM `parity-project.ops.backlog` ORDER BY id",
    schema: SLOW_SCHEMA,
    rows: slow,
    slow: true,
  },
  {
    name: "legacy_sessions",
    query:
      "SELECT id, country, sessions FROM [parity-project:web.sessions] ORDER BY id",
    use_legacy_sql: true,
    batchSize: "3",
    schema: LEGACY_SCHEMA,
    rows: legacy,
  },
  {
    name: "empty",
    query: "SELECT id FROM `parity-project.analytics.events` WHERE FALSE",
    schema: { fields: [{ name: "id", type: "STRING" }] },
    rows: [],
  },
];

/** The connection's query list as Mako stores it: no schema, no rows. */
export const CONNECTION_QUERIES = QUERIES.map(
  ({ schema: _s, rows: _r, slow: _slow, ...query }) => query,
);
