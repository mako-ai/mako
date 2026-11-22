/**
 * A synthetic REST API for the parity cassettes: 8 entities shaped like the
 * ones a generic REST connection runs (page numbers with a total, offsets
 * with a has-more flag, an opaque cursor, a POST search with a body, a bare
 * array, a wrapped `data` array with no data path, a static `updated_after`
 * param), each with its own resolver. Nothing here came from a real API; no
 * credential is involved.
 *
 * The emulator answers a request by finding its route in `ROUTES` and
 * calling that route's `resolve({ query, body })`. `query` is the parsed
 * query string, with `a[]=1&a[]=2` as an array and `a[b]=1` as an object.
 */

const iso = (base, minutes) =>
  new Date(Date.parse(base) + minutes * 60_000).toISOString();

const listings = Array.from({ length: 70 }, (_, i) => ({
  id: i + 1,
  portal: ["immoscout", "homegate", "idealista"][i % 3],
  price: i % 4 === 0 ? null : 250_000 + i * 1_250,
  created_at: iso("2025-11-01T08:00:00.000Z", i * 1_441),
  updated_at: iso("2025-12-01T08:00:00.000Z", i * 997),
}));

const orders = Array.from({ length: 35 }, (_, i) => ({
  id: `ord_${String(i + 1).padStart(3, "0")}`,
  total: 10 + i * 2.5,
  lines: [{ sku: `s${i % 5}`, qty: (i % 3) + 1 }],
  updatedAt: iso("2025-12-15T00:00:00.000Z", i * 1_733),
}));

const events = Array.from({ length: 23 }, (_, i) => ({
  id: `ev_${String(i + 1).padStart(3, "0")}`,
  kind: i % 2 ? "view" : "click",
  updated_at: iso("2026-01-05T00:00:00.000Z", i * 600),
}));

const hits = Array.from({ length: 30 }, (_, i) => ({
  id: 5_000 + i,
  title: `flat ${i}`,
  rooms: 2 + (i % 3),
  // Half of the rows carry no timestamp: the client filter drops them.
  ...(i % 2 === 0
    ? { modified_at: iso("2026-02-01T00:00:00.000Z", i * 1_000) }
    : {}),
}));

const plain = Array.from({ length: 20 }, (_, i) => ({
  id: i + 1,
  name: `plain ${i + 1}`,
  ...(i % 3 === 0
    ? { modifiedAt: iso("2026-03-01T00:00:00.000Z", i * 1_100) }
    : { updated_at: iso("2026-03-02T00:00:00.000Z", i * 900) }),
}));

const wrapped = Array.from({ length: 14 }, (_, i) => ({
  id: `w${i + 1}`,
  updated_at: iso("2026-04-01T00:00:00.000Z", i * 2_000),
}));

const changes = Array.from({ length: 12 }, (_, i) => ({
  id: i + 1,
  note: `change ${i + 1}`,
  updated_at: iso("2025-10-01T00:00:00.000Z", i * 40_000),
}));

const number = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

/** The entities as a connection stores them (`config.entities`). */
export const ENTITIES = [
  {
    name: "listings",
    path: "/v1/listings",
    method: "GET",
    // A JSON string, as the form saves it: arrays and nested objects exercise
    // the query serialiser.
    params: JSON.stringify({
      status: "online",
      tags: ["a", "b c"],
      sort: { by: "id", dir: "asc" },
      empty: null,
    }),
    data_path: "data.items",
    total_count_path: "data.total",
    page_param: "page",
    limit_param: "per_page",
    batch_size: 25,
  },
  {
    // camelCase keys, as older connections hold them; params as an object.
    name: "orders",
    path: "/v1/orders",
    params: { currency: "CHF" },
    dataPath: "results",
    limitParam: "limit",
    offsetParam: "offset",
    hasMorePath: "meta.has_more",
    batchSize: 10,
  },
  {
    name: "events",
    path: "/v1/events",
    method: "get",
    data_path: "data",
    limit_param: "limit",
    cursor_param: "after",
    next_cursor_path: "paging.next",
    batch_size: 7,
  },
  {
    name: "search",
    path: "/v1/search",
    method: "POST",
    body: JSON.stringify({ q: "flat", filters: { rooms: [2, 3] } }),
    data_path: "hits",
    page_param: "page",
    limit_param: "size",
    batch_size: 12,
  },
  {
    // No batch size: the connection's setting, else 100.
    name: "plain",
    path: "/v1/plain",
    limit_param: "limit",
    offset_param: "offset",
  },
  {
    // No data path, no limit param: the answer's `data` array is the rows,
    // and the server pages 6 at a time whatever the client asks.
    name: "wrapped",
    path: "/v1/wrapped",
    offset_param: "skip",
    batch_size: 6,
  },
  {
    // A static `updatedAfter`: the connector does not add its own.
    name: "changes",
    path: "/v1/changes",
    params: { updatedAfter: "2020-01-01T00:00:00.000Z" },
    data_path: "data.rows",
    limit_param: "limit",
    offset_param: "offset",
    batch_size: 10,
  },
];

export const ROUTES = [
  {
    method: "GET",
    path: "/api/v1/listings",
    resolve: ({ query }) => {
      const per = number(query.per_page, 25);
      const page = number(query.page, 1);
      return {
        data: {
          items: listings.slice((page - 1) * per, page * per),
          total: listings.length,
        },
      };
    },
  },
  {
    method: "GET",
    path: "/api/v1/orders",
    resolve: ({ query }) => {
      const limit = number(query.limit, 10);
      const offset = number(query.offset, 0);
      return {
        results: orders.slice(offset, offset + limit),
        meta: { has_more: offset + limit < orders.length },
      };
    },
  },
  {
    method: "GET",
    path: "/api/v1/events",
    resolve: ({ query }) => {
      const limit = number(query.limit, 7);
      const start = query.after
        ? events.findIndex(e => e.id === query.after) + 1
        : 0;
      const page = events.slice(start, start + limit);
      return {
        data: page,
        paging: {
          next: start + limit < events.length ? page[page.length - 1].id : null,
        },
      };
    },
  },
  {
    method: "POST",
    path: "/api/v1/search",
    resolve: ({ query }) => {
      const size = number(query.size, 12);
      const page = number(query.page, 1);
      return {
        hits: hits.slice((page - 1) * size, page * size),
        total: hits.length,
      };
    },
  },
  {
    method: "GET",
    path: "/api/v1/plain",
    resolve: ({ query }) => {
      const limit = number(query.limit, 100);
      const offset = number(query.offset, 0);
      return plain.slice(offset, offset + limit);
    },
  },
  {
    method: "GET",
    path: "/api/v1/wrapped",
    resolve: ({ query }) => {
      const skip = number(query.skip, 0);
      return { data: wrapped.slice(skip, skip + 6), server: "v2" };
    },
  },
  {
    method: "GET",
    path: "/api/v1/changes",
    resolve: ({ query }) => {
      const from = Date.parse(query.updatedAfter ?? "1970-01-01T00:00:00Z");
      const limit = number(query.limit, 10);
      const offset = number(query.offset, 0);
      const rows = changes.filter(row => Date.parse(row.updated_at) > from);
      return { data: { rows: rows.slice(offset, offset + limit) } };
    },
  },
];
