/**
 * A synthetic GraphQL API for the cassettes: 5 queries shaped like
 * the ones RealAdvisor's flows run (Hasura aggregates with an integer or a
 * timestamptz cursor, an offset list with `$since`, a Relay connection and
 * an Expo Observe time series), each with its own resolver. Nothing here
 * came from a real API; no credential is involved.
 *
 * The emulator answers a request by finding its query text in `QUERIES` and
 * calling that query's `resolve(variables)`.
 */

const iso = (base, minutes) =>
  new Date(Date.parse(base) + minutes * 60_000).toISOString();

const listings = Array.from({ length: 70 }, (_, i) => ({
  id: i + 1,
  portal: ["immoscout", "homegate", "idealista"][i % 3],
  url: `https://example.test/listing/${i + 1}`,
  sale_price: i % 4 === 0 ? null : 250_000 + i * 1_250,
  created_at: iso("2025-11-01T08:00:00.000Z", i * 1_441),
  updated_at: iso("2025-12-01T08:00:00.000Z", i * 997),
}));

const enquiries = Array.from({ length: 30 }, (_, i) => ({
  id: `enq_${String(i + 1).padStart(3, "0")}`,
  created_at: iso("2025-12-20T10:00:00.000Z", i * 2_017),
  merged_listing_id: (i * 7) % 70,
  portal: i % 2 ? "homegate" : "immoscout",
}));

const items = Array.from({ length: 35 }, (_, i) => ({
  id: i + 101,
  name: `item ${i + 101}`,
  updated_at: iso("2025-12-15T00:00:00.000Z", i * 1_733),
  nested: { score: i / 4, flags: [i % 2 === 0, i % 3 === 0] },
  tags: i % 5 === 0 ? [] : [`t${i % 3}`, `t${i % 7}`],
}));

const things = Array.from({ length: 23 }, (_, i) => ({
  cursor: `c${String(i + 1).padStart(3, "0")}`,
  node: {
    name: `thing ${i + 1}`,
    updatedAt: iso("2026-01-05T00:00:00.000Z", i * 600),
  },
}));

const buckets = Array.from({ length: 14 }, (_, i) => {
  const bucket = iso("2026-10-01T00:00:00.000Z", i * 1_440);
  return {
    id: bucket,
    bucket,
    count: 100 + i * 3,
    median: 812.5 - i,
    p90: 1_900 + i * 11,
  };
});

const aggregate = count => ({ aggregate: { count } });

export const QUERIES = [
  {
    name: "online_listings",
    query: `query GetOnlineListings($first: Int!, $after: Int!) {
  total: online_listings_aggregate { aggregate { count } }
  cursor: online_listings_aggregate(order_by: { id: asc_nulls_last }, where: { id: { _gt: $after } }, limit: $first) { aggregate { max { id } } }
  has_more: online_listings_aggregate(where: { id: { _gt: $after } }) { aggregate { count } }
  online_listings(order_by: { id: asc_nulls_last }, where: { id: { _gt: $after } }, limit: $first) { id portal url sale_price created_at updated_at }
}
`,
    data_path: "data.online_listings",
    has_next_page_path: "data.has_more.aggregate.count",
    cursor_path: "data.cursor.aggregate.max.id",
    total_count_path: "data.total.aggregate.count",
    batch_size: 25,
    resolve: ({ first, after }) => {
      const rest = listings.filter(row => row.id > after);
      const page = rest.slice(0, first);
      return {
        data: {
          total: aggregate(listings.length),
          cursor: {
            aggregate: {
              max: { id: page.length ? page[page.length - 1].id : null },
            },
          },
          has_more: aggregate(rest.length),
          online_listings: page,
        },
      };
    },
  },
  {
    name: "enquiries",
    query: `query GetEnquiries($first: Int!, $after: timestamptz = "1970-01-01") {
  cursor: agg_enquiries_aggregate(order_by: { created_at: asc_nulls_last }, where: { created_at: { _gt: $after } }, limit: $first) { aggregate { max { created_at } } }
  has_more: agg_enquiries_aggregate(where: { created_at: { _gt: $after } }) { aggregate { count } }
  agg_enquiries(order_by: { created_at: asc_nulls_last }, where: { created_at: { _gt: $after } }, limit: $first) { id created_at merged_listing_id portal }
}
`,
    dataPath: "data.agg_enquiries",
    hasNextPagePath: "data.has_more.aggregate.count",
    cursorPath: "data.cursor.aggregate.max.created_at",
    batchSize: 12,
    resolve: ({ first, after }) => {
      const from = Date.parse(after);
      const rest = enquiries.filter(row => Date.parse(row.created_at) > from);
      const page = rest.slice(0, first);
      return {
        data: {
          cursor: {
            aggregate: {
              max: {
                created_at: page.length
                  ? page[page.length - 1].created_at
                  : null,
              },
            },
          },
          has_more: aggregate(rest.length),
          agg_enquiries: page,
        },
      };
    },
  },
  {
    name: "items",
    query: `query Items($limit: Int!, $offset: Int!, $since: timestamptz = "1970-01-01T00:00:00Z") {
  items_aggregate(where: { updated_at: { _gt: $since } }) { aggregate { count } }
  items(order_by: { id: asc }, where: { updated_at: { _gt: $since } }, limit: $limit, offset: $offset) { id name updated_at nested tags }
}
`,
    variables: { tenant: "parity" },
    data_path: "data.items",
    total_count_path: "data.items_aggregate.aggregate.count",
    batch_size: 10,
    resolve: ({ limit, offset, since }) => {
      const from = Date.parse(since ?? "1970-01-01T00:00:00Z");
      const rows = items.filter(row => Date.parse(row.updated_at) > from);
      return {
        data: {
          items_aggregate: aggregate(rows.length),
          items: rows.slice(offset, offset + limit),
        },
      };
    },
  },
  {
    name: "things",
    query: `query Things($first: Int!, $after: String) {
  things(first: $first, after: $after) { pageInfo { hasNextPage endCursor } edges { id: cursor cursor node { name updatedAt } } }
}
`,
    data_path: "data.things.edges",
    has_next_page_path: "data.things.pageInfo.hasNextPage",
    cursor_path: "data.things.pageInfo.endCursor",
    resolve: ({ first, after }) => {
      const start =
        after === "1970-01-01"
          ? 0
          : things.findIndex(edge => edge.cursor === after) + 1;
      const page = things
        .slice(start, start + first)
        .map(edge => ({ id: edge.cursor, ...edge }));
      return {
        data: {
          things: {
            pageInfo: {
              hasNextPage: start + first < things.length,
              endCursor: page.length ? page[page.length - 1].cursor : null,
            },
            edges: page,
          },
        },
      };
    },
  },
  {
    name: "startup_tti_ios",
    query: `{
  app {
    byId(appId: "00000000-0000-4000-8000-000000000001") {
      observe { metrics { timeSeries(input: { startTime: "2026-10-01T00:00:00.000Z", endTime: "2030-01-01T00:00:00.000Z", name: "expo.app_startup.tti", platforms: [IOS], bucketIntervalMinutes: 1440 }) { buckets { id: bucket bucket count median p90 } } } }
    }
  }
}
`,
    data_path: "data.app.byId.observe.metrics.timeSeries.buckets",
    batch_size: 1000,
    resolve: () => ({
      data: {
        app: {
          byId: { observe: { metrics: { timeSeries: { buckets } } } },
        },
      },
    }),
  },
];

/** The flow's query list as Mako stores it: everything but the resolver. */
export const FLOW_QUERIES = QUERIES.map(
  ({ resolve: _resolve, ...query }) => query,
);
