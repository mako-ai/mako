/**
 * G1 benchmark connector: a synthetic, Close-shaped activity feed.
 *
 * Nothing leaves the box. Records are generated deterministically from the
 * cursor, so a chunk is reproducible and resumable in any box. Record sizes
 * follow RealAdvisor's ES Close tables, measured in BigQuery on 2026-11-16
 * (TO_JSON_STRING byte length, 1% samples):
 *
 *   activities:Email  (entity "email")  mean 32,409 B, p50 18,796 B, p95 107,480 B
 *   activities:Call   (entity "call")   mean  9,524 B, p50  3,176 B, p95  38,620 B
 *
 * Each size is drawn from a lognormal fitted to that median and mean, which
 * reproduces the measured p95 within 3%. `fixed` entities use one size, for
 * isolating per-record cost from size.
 *
 * Config:
 *   pageSize      rows per page (default 100, as the task specifies)
 *   totalRows     rows in the stream (default 1,000,000)
 *   pageDelayMs   optional sleep per page, to model vendor latency (default 0)
 */
import { defineConnector } from "@makoai/connector-sdk";

/** Lognormal parameters from a median and a mean. */
function lognormal(median: number, mean: number) {
  const mu = Math.log(median);
  const sigma = Math.sqrt(2 * Math.log(mean / median));
  return { mu, sigma };
}

const SIZES = {
  email: lognormal(18_796, 32_409),
  call: lognormal(3_176, 9_524),
} as const;

/** mulberry32: a tiny seeded PRNG, so row N is the same in every box. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(next: () => number): number {
  const u = Math.max(next(), 1e-12);
  const v = next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// One block of text, sliced per record: generating bytes is not what we measure.
const LOREM =
  "Hola, le escribo en relacion con la valoracion de su vivienda en Madrid. ".repeat(
    4096,
  );

function body(length: number, offset: number): string {
  const n = Math.max(0, Math.min(length, LOREM.length - 1));
  const start = offset % (LOREM.length - n);
  return LOREM.slice(start, start + n);
}

function emailRecord(i: number, size: number) {
  const created = new Date(Date.UTC(2019, 0, 1) + i * 60_000).toISOString();
  const base = {
    id: `acti_${i.toString(36).padStart(10, "0")}`,
    _type: "Email",
    lead_id: `lead_${(i % 60_814).toString(36)}`,
    contact_id: `cont_${(i % 81_272).toString(36)}`,
    user_id: `user_${i % 338}`,
    organization_id: "orga_bench",
    direction: i % 3 === 0 ? "incoming" : "outgoing",
    status: "sent",
    sender: `agent${i % 338}@example.com`,
    to: [`owner${i}@example.com`],
    cc: [],
    bcc: [],
    subject: `Valoracion ${i}`,
    template_id: null,
    thread_id: `acti_${Math.floor(i / 3).toString(36)}`,
    opens: [],
    attachments: [],
    date_created: created,
    date_updated: created,
    activity_at: created,
  };
  const fixed = JSON.stringify(base).length + 40;
  const text = Math.max(0, size - fixed);
  return { ...base, body_text: body(Math.floor(text / 3), i), body_html: body(text - Math.floor(text / 3), i * 7) };
}

function callRecord(i: number, size: number) {
  const created = new Date(Date.UTC(2019, 0, 1) + i * 60_000).toISOString();
  const base = {
    id: `acti_${i.toString(36).padStart(10, "0")}`,
    _type: "Call",
    lead_id: `lead_${(i % 60_814).toString(36)}`,
    contact_id: `cont_${(i % 81_272).toString(36)}`,
    user_id: `user_${i % 338}`,
    organization_id: "orga_bench",
    direction: i % 2 === 0 ? "outbound" : "inbound",
    status: "completed",
    disposition: "answered",
    duration: (i * 37) % 900,
    phone: `+3460000${(i % 10_000).toString().padStart(4, "0")}`,
    recording_url: null,
    voicemail_url: null,
    date_created: created,
    date_updated: created,
    activity_at: created,
  };
  const fixed = JSON.stringify(base).length + 20;
  return { ...base, note: body(Math.max(0, size - fixed), i) };
}

function makeEntity(name: keyof typeof SIZES | "fixed-1k") {
  return {
    primaryKey: ["id"],
    cursorField: "date_updated",
    schema: {
      id: "string",
      _type: "string",
      lead_id: "string",
      date_created: "timestamp",
      date_updated: "timestamp",
    },
    async *read(ctx: any, state: any) {
      const pageSize = Number(ctx.config.pageSize ?? 100);
      const total = Number(ctx.config.totalRows ?? 1_000_000);
      const delay = Number(ctx.config.pageDelayMs ?? 0);
      let offset = Number(state?.offset ?? 0);
      while (offset < total) {
        if (delay > 0) await new Promise(r => setTimeout(r, delay));
        const end = Math.min(total, offset + pageSize);
        const records = [];
        for (let i = offset; i < end; i++) {
          if (name === "fixed-1k") {
            records.push(callRecord(i, 1_000));
            continue;
          }
          const next = rng(i * 2654435761);
          const { mu, sigma } = SIZES[name];
          const size = Math.round(Math.exp(mu + sigma * gaussian(next)));
          records.push(
            name === "email"
              ? emailRecord(i, Math.min(size, 900_000))
              : callRecord(i, Math.min(size, 900_000)),
          );
        }
        offset = end;
        yield { records, state: { offset }, hasMore: offset < total };
      }
    },
  };
}

export default defineConnector({
  name: "bench-close-shaped",
  version: "1.0.0",
  config: {
    properties: {
      pageSize: { type: "integer", title: "Rows per page" },
      totalRows: { type: "integer", title: "Rows in the stream" },
      pageDelayMs: { type: "integer", title: "Sleep per page (ms)" },
    },
  },
  check: async () => true,
  entities: {
    // Entity names must be slugs, so Close's "activities:Email" is "email".
    email: makeEntity("email"),
    call: makeEntity("call"),
    "fixed-1k": makeEntity("fixed-1k"),
  },
});
