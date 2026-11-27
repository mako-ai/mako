/**
 * Drop the MongoDB collections whose data now lives only in Postgres.
 *
 *   pnpm mongo:drop-migrated                               # DRY RUN (default)
 *   pnpm mongo:drop-migrated --include-dead                # + dead legacy collections
 *   pnpm mongo:drop-migrated --only users,sessions         # a subset
 *   pnpm mongo:drop-migrated --apply --confirm-pg-only \
 *     --archive-dir /backups/mongo-drop-2026-11            # archive, then drop
 *
 * Environment (process only; no .env file is loaded):
 *   DATABASE_URL   Mongo, the database to clean.
 *   POSTGRES_URL   Postgres, read for `migration_domain_state` only.
 *
 * Safety, in the order it is checked:
 *   1. Only names on an explicit allowlist are ever candidates. The 50
 *      `pg_only` collections are always in scope; the dead legacy ones join
 *      only with `--include-dead`.
 *   2. A hard denylist (flows, CDC, webhooks, dbt, notifications, workflow
 *      recordings, config, locks, ...) is refused even if a name somehow
 *      lands on the allowlist. The lists are checked disjoint at load.
 *   3. A `pg_only` collection drops only when Postgres says its domain is
 *      `pg_only` globally AND no workspace override says otherwise. No flag
 *      skips this.
 *   4. A collection with a document created or updated in the last 24h is
 *      refused unless `--force`. A failed check always blocks the drop.
 *   5. Nothing drops without BOTH `--apply` and `--confirm-pg-only`.
 *   6. With `--archive-dir`, each collection is written there as gzipped
 *      Extended JSON first. Archive errors, write-check failures, and writes
 *      detected since the archive started block the drop even with --force.
 *
 * Run after all writers have cut over. Document timestamps can detect recent
 * writes but cannot lock out a writer or date an update that leaves no marker.
 *
 * Output names the database, never the connection string.
 */
import { mkdir, open, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { createGzip } from "node:zlib";
import { inArray } from "drizzle-orm";
import { BSON, MongoClient, ObjectId, type Db } from "mongodb";

// ── The lists ───────────────────────────────────────────────────────

/** Collections migrated to Postgres, with the domain whose state gates them. */
export const PG_ONLY_COLLECTIONS = {
  // auth
  users: "auth",
  user_attributions: "auth",
  oauthaccounts: "auth",
  sessions: "auth",
  emailverifications: "auth",
  desktopauthcodes: "auth",
  // workspaces_core
  workspaces: "workspaces_core",
  workspacemembers: "workspaces_core",
  workspaceinvites: "workspaces_core",
  workspace_user_handles: "workspaces_core",
  mcpoauthclients: "workspaces_core",
  mcpoauthcodes: "workspaces_core",
  mcpoauthtokens: "workspaces_core",
  acpplangrants: "workspaces_core",
  github_installations: "workspaces_core",
  // connections
  databaseconnections: "connections",
  connectors: "connections",
  connection_access_events: "connections",
  connection_write_events: "connections",
  connectordefinitions: "connections",
  // consoles_charts
  consolefolders: "consoles_charts",
  savedconsoles: "consoles_charts",
  entity_versions: "consoles_charts",
  notebookfolders: "consoles_charts",
  notebookindexes: "consoles_charts",
  favourites: "consoles_charts",
  scheduled_query_runs: "consoles_charts",
  // apps_metadata
  app_projects: "apps_metadata",
  app_index: "apps_metadata",
  app_index_heads: "apps_metadata",
  app_embeddings: "apps_metadata",
  app_lifecycle: "apps_metadata",
  app_deploy_commit_statuses: "apps_metadata",
  app_worktrees: "apps_metadata",
  app_v2_binding_state: "apps_metadata",
  app_binding_drafts: "apps_metadata",
  app_binding_jobs: "apps_metadata",
  // usage_stats
  app_usage_daily: "usage_stats",
  app_usage_events: "usage_stats",
  app_feed_snapshots: "usage_stats",
  skill_usage_daily: "usage_stats",
  llmusages: "usage_stats",
  query_executions: "usage_stats",
  connection_verifications: "usage_stats",
  // mcp
  mcp_servers: "mcp",
  mcp_connection_configs: "mcp",
  mcp_oauth_flows: "mcp",
  mcp_tool_grants: "mcp",
  // chat
  chats: "chat",
  chatattachments: "chat",
} as const;

type MigrationDomain =
  (typeof PG_ONLY_COLLECTIONS)[keyof typeof PG_ONLY_COLLECTIONS];
const domainByCollection = new Map<string, MigrationDomain>(
  Object.entries(PG_ONLY_COLLECTIONS),
);

/** Legacy collections no code reads. In scope only with `--include-dead`. */
export const DEAD_COLLECTIONS: readonly string[] = [
  "dashboards",
  "dashboardfolders",
  "skills_retired_20260904",
  "zz_skip_builtin_close_webhookevents_20261118",
  "zz_skip_builtin_close_cdc_change_events_20261118",
  "databases",
  "datasources",
  "materialization_runs",
  "es_stripe_invoices",
  "es_stripe_subscriptions",
  "es_stripe_customers",
  "ch_close_leads",
  "es_close_leads",
  "realadvisor_graphql_teams",
];

/** Never dropped, whatever the lists or flags say. */
export const DENY_EXACT: readonly string[] = [
  "flows",
  "flow_executions",
  "flow_execution_locks",
  "flow_data_diffs",
  "webhookevents",
  "modelcatalogsnapshots",
  "apps_box_policy",
  "realtime_presence",
  "migrations",
  "worker_locks",
  "v1_artifact_purge_backlog",
];

/** Never dropped: any collection whose name starts with one of these. */
export const DENY_PREFIXES: readonly string[] = [
  "cdc_",
  "backfill_tmp_",
  "poll_tmp_",
  "connector_box",
  "dbt_",
  "notification_",
  "workflow_recorded_",
  "system.",
];

export function isDenied(name: string): boolean {
  return (
    DENY_EXACT.includes(name) || DENY_PREFIXES.some(p => name.startsWith(p))
  );
}

/** Throws if any allowlisted name is denied or listed twice. Runs at load. */
export function assertListsAreSafe(): void {
  const pgOnly = Object.keys(PG_ONLY_COLLECTIONS);
  const all = [...pgOnly, ...DEAD_COLLECTIONS];
  const denied = all.filter(isDenied);
  if (denied.length > 0) {
    throw new Error(`Allowlisted collections are denied: ${denied.join(",")}`);
  }
  const dupes = all.filter((n, i) => all.indexOf(n) !== i);
  if (dupes.length > 0) {
    throw new Error(`Collections listed twice: ${dupes.join(",")}`);
  }
}
assertListsAreSafe();

// ── Arguments ───────────────────────────────────────────────────────

export interface DropOptions {
  apply: boolean;
  includeDead: boolean;
  force: boolean;
  only?: string[];
  archiveDir?: string;
}

export class UsageError extends Error {}

export const USAGE = `Usage: drop-migrated-mongo-collections.ts [--include-dead] [--only a,b] [--force]
                                         [--archive-dir <dir>] [--apply --confirm-pg-only]
  (no flags)          dry run: print what would drop and why not
  --include-dead      also consider the dead legacy collections
  --only a,b          only these collections (still allowlisted and checked)
  --force             allow a known recent write (other guards still apply)
  --archive-dir <dir> write each collection as gzipped Extended JSON first
  --apply --confirm-pg-only
                      actually drop; both flags or nothing drops`;

export function parseDropArgs(argv: string[]): DropOptions {
  const opts: DropOptions = { apply: false, includeDead: false, force: false };
  let apply = false;
  let confirm = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") apply = true;
    else if (arg === "--confirm-pg-only") confirm = true;
    else if (arg === "--include-dead") opts.includeDead = true;
    else if (arg === "--force") opts.force = true;
    else if (arg === "--only") {
      const list = argv[++i];
      if (!list || list.startsWith("--")) {
        throw new UsageError("--only needs a comma-separated list");
      }
      opts.only = list
        .split(",")
        .map(s => s.trim())
        .filter(Boolean);
    } else if (arg === "--archive-dir") {
      const dir = argv[++i];
      if (!dir || dir.startsWith("--")) {
        throw new UsageError("--archive-dir needs a directory");
      }
      opts.archiveDir = dir;
    } else throw new UsageError(`Unknown argument: ${arg}`);
  }
  if (apply !== confirm) {
    throw new UsageError("--apply and --confirm-pg-only go together");
  }
  opts.apply = apply && confirm;
  return opts;
}

// ── Planning (pure) ─────────────────────────────────────────────────

export interface Candidate {
  name: string;
  group: "pg_only" | "dead";
  domain?: MigrationDomain;
}

export interface Plan {
  candidates: Candidate[];
  /** Asked for (`--only`) or allowlisted, and not a candidate. */
  skipped: Array<{ name: string; reason: string }>;
}

/** Which existing collections are candidates. Denied names never are. */
export function planCandidates(
  existing: readonly string[],
  opts: Pick<DropOptions, "includeDead" | "only">,
): Plan {
  const present = new Set(existing);
  const wanted = opts.only ?? [
    ...Object.keys(PG_ONLY_COLLECTIONS),
    ...(opts.includeDead ? DEAD_COLLECTIONS : []),
  ];
  const candidates: Candidate[] = [];
  const skipped: Plan["skipped"] = [];
  for (const name of new Set(wanted)) {
    if (isDenied(name)) {
      skipped.push({ name, reason: "denylisted" });
      continue;
    }
    const domain = domainByCollection.get(name);
    const dead = DEAD_COLLECTIONS.includes(name);
    if (!domain && !dead) {
      skipped.push({ name, reason: "not allowlisted" });
      continue;
    }
    if (dead && !opts.includeDead) {
      skipped.push({ name, reason: "dead: needs --include-dead" });
      continue;
    }
    if (!present.has(name)) {
      skipped.push({ name, reason: "absent" });
      continue;
    }
    candidates.push(
      domain ? { name, group: "pg_only", domain } : { name, group: "dead" },
    );
  }
  return { candidates, skipped };
}

export interface CollectionFacts {
  /** true: a write in the last 24h. "unknown": the check failed. */
  recentWrite: boolean | "unknown";
  /** For pg_only: is the domain pg_only everywhere? "unknown": PG unread. */
  domainPgOnly?: boolean | "unknown";
}

/** The final gate for one candidate. Pure. */
export function decideDrop(
  candidate: Candidate,
  facts: CollectionFacts,
  opts: Pick<DropOptions, "force">,
): { drop: boolean; reason: string } {
  if (isDenied(candidate.name)) return { drop: false, reason: "denylisted" };
  if (candidate.group === "pg_only") {
    if (facts.domainPgOnly === "unknown" || facts.domainPgOnly === undefined) {
      return { drop: false, reason: `${candidate.domain}: state unknown` };
    }
    if (!facts.domainPgOnly) {
      return { drop: false, reason: `${candidate.domain}: not pg_only` };
    }
  }
  if (facts.recentWrite === "unknown") {
    return { drop: false, reason: "recent-write check failed" };
  }
  if (facts.recentWrite === true && !opts.force) {
    return { drop: false, reason: "written in last 24h (--force)" };
  }
  return { drop: true, reason: "ok" };
}

// ── Mongo / Postgres reads ──────────────────────────────────────────

export const RECENT_WRITE_WINDOW_MS = 24 * 60 * 60 * 1000;
const TIMESTAMP_FIELDS = ["updatedAt", "createdAt", "updated_at", "created_at"];
// These collections record the event or rollup time instead of updatedAt.
const ACTIVITY_FIELDS: Readonly<Record<string, readonly string[]>> = {
  app_usage_daily: ["lastAt"],
  skill_usage_daily: ["lastAt"],
  app_usage_events: ["at"],
  user_attributions: ["capturedAt"],
  connection_access_events: ["at"],
  connection_write_events: ["at"],
  query_executions: ["executedAt"],
  scheduled_query_runs: ["triggeredAt", "startedAt", "completedAt"],
  connection_verifications: ["verifiedAt"],
  ch_close_leads: ["date_created", "date_updated"],
  es_close_leads: ["date_created", "date_updated"],
  es_stripe_customers: ["created", "updated"],
  es_stripe_invoices: ["created", "updated"],
  es_stripe_subscriptions: ["created", "updated"],
};

/** Look for dated activity at or after an inclusive cutoff on the primary. */
export async function hasWriteSince(
  db: Db,
  name: string,
  cutoff: Date,
): Promise<boolean | "unknown"> {
  const millis = cutoff.getTime();
  const seconds = Math.floor(millis / 1000);
  // An ISO timestamp with a timezone offset can have the preceding calendar
  // date. Bound the index scan, then compare instants for string values only.
  const earliestIsoDate = new Date(millis - 86_400_000)
    .toISOString()
    .slice(0, 10);
  const fields = [...TIMESTAMP_FIELDS, ...(ACTIVITY_FIELDS[name] ?? [])];
  try {
    const hit = await db.collection(name).findOne(
      {
        $or: [
          { _id: { $gte: ObjectId.createFromTime(seconds) } },
          ...fields.flatMap(field => [
            { [field]: { $gte: cutoff } },
            { [field]: { $gte: seconds, $lt: 100_000_000_000 } },
            { [field]: { $gte: millis } },
            {
              [field]: { $gte: earliestIsoDate, $lt: ":" },
              $expr: {
                $gte: [
                  {
                    $convert: {
                      input: `$${field}`,
                      to: "date",
                      onNull: null,
                      onError: null,
                    },
                  },
                  cutoff,
                ],
              },
            },
          ]),
        ],
      },
      // Some legacy fields have no index. Let the scan finish; an actual
      // driver/server error is still an unknown result and blocks a drop.
      { projection: { _id: 1 } },
    );
    return hit !== null;
  } catch {
    return "unknown";
  }
}

async function storageMb(db: Db, name: string): Promise<number | null> {
  try {
    const stats = await db
      .collection(name)
      .aggregate<{
        storageStats?: { storageSize?: number; totalIndexSize?: number };
      }>([{ $collStats: { storageStats: {} } }])
      .toArray();
    let bytes = 0;
    for (const { storageStats } of stats) {
      if (storageStats?.storageSize == null) return null;
      bytes += storageStats.storageSize + (storageStats.totalIndexSize ?? 0);
    }
    return stats.length ? bytes / 1024 / 1024 : null;
  } catch {
    return null;
  }
}

/** domain -> pg_only everywhere? Reads `migration_domain_state`. */
export type DomainStateReader = (
  domains: MigrationDomain[],
) => Promise<Map<MigrationDomain, boolean>>;

/** The real reader: the global row must be pg_only, and every override too. */
export const pgDomainStateReader: DomainStateReader = async domains => {
  const { getPgDb } = await import("../database/pg/client");
  const { migrationDomainState } =
    await import("../database/pg/schema/control-plane");
  const rows = await getPgDb()
    .select({
      domain: migrationDomainState.domain,
      scopeKey: migrationDomainState.scopeKey,
      mode: migrationDomainState.mode,
    })
    .from(migrationDomainState)
    .where(inArray(migrationDomainState.domain, domains));
  return summarizeDomainState(domains, rows);
};

/** Require a recorded global cutover, even after the runtime router is retired. */
export function summarizeDomainState(
  domains: readonly MigrationDomain[],
  rows: ReadonlyArray<{ domain: string; scopeKey: string; mode: string }>,
): Map<MigrationDomain, boolean> {
  const out = new Map<MigrationDomain, boolean>();
  for (const domain of domains) {
    const mine = rows.filter(r => r.domain === domain);
    const global = mine.find(r => r.scopeKey === "global");
    out.set(
      domain,
      global?.mode === "pg_only" && mine.every(r => r.mode === "pg_only"),
    );
  }
  return out;
}

export async function archiveCollection(
  db: Db,
  name: string,
  dir: string,
): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${db.databaseName}.${name}.ejson.gz`);
  const handle = await open(file, "wx", 0o600);
  try {
    const cursor = db
      .collection(name)
      .find({}, { promoteValues: false, bsonRegExp: true });
    async function* documents() {
      for await (const doc of cursor) {
        yield `${BSON.EJSON.stringify(doc, { relaxed: false })}\n`;
      }
    }
    await pipeline(
      Readable.from(documents()),
      createGzip(),
      handle.createWriteStream(),
    );
  } catch (error) {
    await rm(file, { force: true });
    throw error;
  } finally {
    await handle.close();
  }
  return file;
}

// ── Run ─────────────────────────────────────────────────────────────

export interface DropIO {
  out(line: string): void;
  err(line: string): void;
}

export interface DropRow {
  name: string;
  group: Candidate["group"];
  domain: string;
  docs: number;
  storageMb: number | null;
  recentWrite: boolean | "unknown";
  decision: string;
  dropped: boolean;
}

export async function runDrop(
  db: Db,
  opts: DropOptions,
  io: DropIO,
  readDomainState: DomainStateReader = pgDomainStateReader,
  now: Date = new Date(),
  archive = archiveCollection,
): Promise<{ rows: DropRow[]; skipped: Plan["skipped"] }> {
  const existing = (
    await db.listCollections({}, { nameOnly: true }).toArray()
  ).map(c => c.name);
  const plan = planCandidates(existing, opts);

  const domains = [
    ...new Set(
      plan.candidates
        .map(c => c.domain)
        .filter((d): d is MigrationDomain => d !== undefined),
    ),
  ];
  let domainState: Map<MigrationDomain, boolean> | null = null;
  if (domains.length > 0) {
    try {
      domainState = await readDomainState(domains);
    } catch {
      io.err("Could not read migration_domain_state; pg_only drops refused.");
    }
  }

  const cutoff = new Date(now.getTime() - RECENT_WRITE_WINDOW_MS);
  const rows: DropRow[] = [];
  for (const c of plan.candidates) {
    const recentWrite = await hasWriteSince(db, c.name, cutoff);
    const facts: CollectionFacts = {
      recentWrite,
      domainPgOnly:
        c.domain === undefined
          ? undefined
          : domainState === null
            ? "unknown"
            : (domainState.get(c.domain) ?? false),
    };
    const verdict = decideDrop(c, facts, opts);
    rows.push({
      name: c.name,
      group: c.group,
      domain: c.domain ?? "",
      docs: await db.collection(c.name).estimatedDocumentCount(),
      storageMb: await storageMb(db, c.name),
      recentWrite,
      decision: verdict.drop
        ? opts.apply
          ? "drop"
          : "would drop"
        : verdict.reason,
      dropped: false,
    });
    if (!verdict.drop || !opts.apply) continue;
    const row = rows[rows.length - 1];
    if (opts.archiveDir) {
      const archiveStart = new Date();
      try {
        const file = await archive(db, c.name, opts.archiveDir);
        io.err(`archived ${c.name} -> ${file}`);
      } catch (error) {
        row.decision = `archive failed: ${error instanceof Error ? error.name : "Error"}`;
        continue;
      }
      // --force only waives the preflight 24h window. The archive must
      // still represent the collection at the time we decide to drop it.
      const duringArchive = await hasWriteSince(db, c.name, archiveStart);
      if (duringArchive !== false) {
        row.recentWrite = duringArchive;
        row.decision =
          duringArchive === true
            ? "written during archive"
            : "post-archive write check failed";
        continue;
      }
    }
    try {
      await db.collection(c.name).drop();
      row.dropped = true;
      row.decision = "dropped";
    } catch (error) {
      row.decision = `drop failed: ${error instanceof Error ? error.name : "Error"}`;
    }
  }

  io.out(
    [
      "collection",
      "group",
      "domain",
      "docs",
      "storageMb",
      "recent24h",
      "decision",
    ].join("\t"),
  );
  for (const r of rows) {
    io.out(
      [
        r.name,
        r.group,
        r.domain,
        String(r.docs),
        r.storageMb === null ? "" : r.storageMb.toFixed(1),
        String(r.recentWrite),
        r.decision,
      ].join("\t"),
    );
  }
  for (const s of plan.skipped) {
    if (s.reason !== "absent" || opts.only) {
      io.err(`skipped ${s.name}: ${s.reason}`);
    }
  }
  const eligible = rows.filter(r => r.decision === "would drop" || r.dropped);
  const mb = eligible.reduce((sum, r) => sum + (r.storageMb ?? 0), 0);
  io.err(
    `${opts.apply ? "APPLIED" : "DRY RUN (nothing dropped)"}: ` +
      `${db.databaseName}: ${rows.length} candidates, ` +
      `${eligible.length} ${opts.apply ? "dropped" : "would drop"} (${mb.toFixed(1)} MB).`,
  );
  return { rows, skipped: plan.skipped };
}

/** The command line. Returns the exit code; 2 means usage, nothing ran. */
export async function cli(
  argv: string[],
  io: DropIO,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  let opts: DropOptions;
  try {
    opts = parseDropArgs(argv);
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    io.err(USAGE);
    return 2;
  }
  const url = env.DATABASE_URL?.trim();
  if (!url) throw new Error("DATABASE_URL is not set");
  const client = new MongoClient(url, { readPreference: "primary" });
  await client.connect();
  try {
    const { rows, skipped } = await runDrop(client.db(), opts, io);
    const incomplete =
      rows.some(row => !row.dropped) ||
      skipped.some(s => s.reason !== "absent");
    return opts.apply && incomplete ? 1 : 0;
  } finally {
    await client.close();
    const { closePgConnections } = await import("../database/pg/client");
    await closePgConnections();
  }
}
