/**
 * Who may write through a connection (rfcs/data-source-access.md).
 *
 * Everyone may read. Writing is for the principals on the connection's
 * `writers` list, each anywhere or only to one schema or table. Work no
 * person or workflow started (syncs, flows, CDC, dbt) is not concerned.
 *
 * An empty or absent list means no one writes. A statement is classified in
 * memory, with no lookup: the writers list comes with the connection.
 *
 * Text cannot see a write hidden in a function (`SELECT f()`), so a read by
 * anyone not allowed to write anywhere runs in a read-only transaction where
 * the engine has one, and the database refuses what the text missed (on
 * Postgres sent with the query in one round trip).
 */
import { Types } from "mongoose";
import {
  WorkspaceMember,
  type IConnectionWriter,
  type IDatabaseConnection,
} from "../database/workspace-schema";
import { getRequestContext, requestContextStorage } from "../logging/context";
import { loggers } from "../logging";
import {
  checkPreviewQuerySafety,
  stripLeadingSqlComments,
} from "../services/query-pagination.service";
import { countTopLevelSemicolons } from "../services/sql-query-utils";
import { ConnectionWriteEvent } from "./connection-write-event";

const logger = loggers.db();

// ---------------------------------------------------------------------------
// Is it a write? (in memory, every query)
// ---------------------------------------------------------------------------

/** Statements that only look: they never change anything. */
const LOOKING =
  /^(SHOW|DESCRIBE|DESC|EXPLAIN(?!\s+ANALY[SZ]E)|USE|VALUES|PRAGMA\s+(table_info|index_list|foreign_key_list))\b/i;

/** MongoDB shell methods that change data or structure, or may: commands. */
const MONGO_WRITE =
  /\.(runCommand|adminCommand|eval|insert|insertOne|insertMany|update|updateOne|updateMany|replaceOne|delete|deleteOne|deleteMany|remove|drop|dropDatabase|dropIndex|dropIndexes|createCollection|createIndex|createIndexes|renameCollection|bulkWrite|findOneAndUpdate|findOneAndReplace|findOneAndDelete|findAndModify)\s*\(|\$out\b|\$merge\b/;

const MONGO_READ_OPERATIONS = new Set([
  "find",
  "findOne",
  "aggregate",
  "count",
  "countDocuments",
  "distinct",
]);

/**
 * Run `work` as Mako itself, unchecked, like a sync: a flow creating or
 * resetting its own destination from a route a person called, or an Inngest
 * function. Within a request, a write is refused unless someone is
 * identified or the work is marked as Mako's this way.
 */
export function asSystem<T>(work: () => Promise<T>): Promise<T> {
  const context = getRequestContext();
  if (!context) return work();
  return requestContextStorage.run(
    {
      ...context,
      userId: undefined,
      workflow: undefined,
      workflowWorker: undefined,
      system: true,
    },
    work,
  );
}

/**
 * Whether the current work is Mako's own: marked so (`asSystem`), or not
 * serving any request at all (a script, a task at startup).
 */
function isSystemWork(): boolean {
  const context = getRequestContext();
  return !context || context.system === true;
}

/** Whether `query` would change something, judged without asking the database. */
export function isWrite(type: string, query: unknown): boolean {
  if (typeof query !== "string") {
    // A structured MongoDB request names its operation.
    const request = query as {
      operation?: string;
      pipeline?: unknown[];
    } | null;
    if (!request || typeof request !== "object") return false;
    if (request.operation && !MONGO_READ_OPERATIONS.has(request.operation)) {
      return true;
    }
    return MONGO_WRITE.test(JSON.stringify(request.pipeline ?? []));
  }
  if (type === "mongodb") return MONGO_WRITE.test(query);
  if (type === "cloudflare-kv") return /^\s*(put|set|delete)\b/i.test(query);
  const statement = stripLeadingSqlComments(query.trim());
  if (LOOKING.test(statement) && singleStatement(statement)) return false;
  return !checkPreviewQuerySafety(query).safe;
}

function singleStatement(sql: string): boolean {
  const { count, lastIndex } = countTopLevelSemicolons(sql);
  return count === 0 || (count === 1 && lastIndex === sql.trimEnd().length - 1);
}

// ---------------------------------------------------------------------------
// Where does it write? (only for writers limited to a schema or table)
// ---------------------------------------------------------------------------

/** One part of a name: quoted with backticks, double quotes, brackets, or bare. */
const PART = String.raw`(?:\x60[^\x60]+\x60|"[^"]+"|\[[^\]]+\]|[A-Za-z0-9_$-]+)`;
const TARGET = new RegExp(
  String.raw`^(?:INSERT\s+(?:OVERWRITE\s+)?(?:INTO\s+)?|LOAD\s+DATA\s+(?:OVERWRITE\s+|INTO\s+)|UPDATE\s+|DELETE\s+(?:FROM\s+)?|MERGE\s+(?:INTO\s+)?|TRUNCATE\s+(?:TABLE\s+)?|DROP\s+(?:TABLE|VIEW|MATERIALIZED\s+VIEW)\s+(?:IF\s+EXISTS\s+)?|ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?|CREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+)?(?:TABLE|VIEW|MATERIALIZED\s+VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?)(${PART}(?:\s*\.\s*${PART}){0,2})`,
  "i",
);

export interface WriteTarget {
  schema?: string;
  table: string;
}

/**
 * The table one write statement changes, read from the statement itself: a
 * write names its target, unlike a read. Null when there is no single,
 * named target (several statements, a script, a procedure, a write inside a
 * CTE): a writer limited to one place is then refused, never guessed for.
 */
export function writeTarget(query: string): WriteTarget | null {
  const statement = stripLeadingSqlComments(query.trim());
  if (!singleStatement(statement)) return null;
  const name = statement.match(TARGET)?.[1];
  if (!name) return null;
  // `project.dataset.table` may be one backticked part: split it too.
  const parts = (name.match(new RegExp(PART, "g")) ?? [])
    .flatMap(part => unquote(part).split("."))
    .filter(Boolean);
  const table = parts.at(-1);
  if (!table) return null;
  return { table, schema: parts.at(-2) };
}

function unquote(part: string): string {
  const p = part.trim();
  if (/^[\x60"[]/.test(p)) return p.slice(1, -1);
  return p;
}

function sameName(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

function fits(where: string, target: WriteTarget): boolean {
  const [schema, table] = where.split(".");
  if (!sameName(schema, target.schema)) return false;
  return table ? sameName(table, target.table) : true;
}

// ---------------------------------------------------------------------------
// Who is writing, and may they?
// ---------------------------------------------------------------------------

/** The principal of the workflow worker when it names no deployed workflow. */
export const WORKFLOW_WORKER = "worker:workflows";

/**
 * Who is acting: given explicitly (a scheduled console runs as its owner),
 * or the workflow or person of the request being served. Nobody for work
 * no request started: the system's, never checked.
 */
export function actingPrincipal(explicit?: string): string | undefined {
  if (explicit) return explicit;
  const context = getRequestContext();
  if (context?.workflow) return `workflow:${context.workflow}`;
  // The worker's key naming no deployed workflow: never on a writers list.
  if (context?.workflowWorker) return WORKFLOW_WORKER;
  if (context?.userId) return `user:${context.userId}`;
  return undefined;
}

export type WriteDecision =
  | { allowed: true; target?: WriteTarget }
  | {
      allowed: false;
      why: "not-a-writer" | "no-target" | "elsewhere";
      places: string[];
      target?: WriteTarget;
    };

/** Whether `principal` may run the write `query`, given the writers list. */
export function decideWrite(
  writers: IConnectionWriter[] | undefined,
  principal: string,
  query: unknown,
): WriteDecision {
  const mine = (writers ?? []).filter(w => w.principal === principal);
  if (mine.length === 0) {
    return { allowed: false, why: "not-a-writer", places: [] };
  }
  if (mine.some(w => !w.where)) return { allowed: true };
  const places = mine.map(w => w.where as string);
  const target = typeof query === "string" ? writeTarget(query) : null;
  if (!target) return { allowed: false, why: "no-target", places };
  if (places.some(where => fits(where, target))) {
    return { allowed: true, target };
  }
  return { allowed: false, why: "elsewhere", places, target };
}

export function refusal(
  decision: WriteDecision,
  connectionName: string,
): string {
  if (decision.allowed) return "";
  const places = decision.places.join(", ");
  switch (decision.why) {
    case "not-a-writer":
      return `Everyone can read ${connectionName}, but only the people and workflows an admin allowed can write to it. Ask an admin to add you in the connection's Access tab.`;
    case "no-target":
      return `You can write only to ${places} on ${connectionName}. Write one statement that names its table as schema.table.`;
    case "elsewhere":
      return `You can write only to ${places} on ${connectionName}, not to ${[decision.target?.schema, decision.target?.table].filter(Boolean).join(".")}.`;
  }
}

/**
 * Whether `principal` may write to `target` ("schema.table" or "table")
 * under `writers` as they are now; null target means "somewhere unknown".
 */
export function covers(
  writers: IConnectionWriter[] | undefined,
  principal: string,
  target: string | null,
): boolean {
  const mine = (writers ?? []).filter(w => w.principal === principal);
  if (mine.some(w => !w.where)) return true;
  if (!target) return false;
  const parts = target.split(".");
  const named: WriteTarget = {
    table: parts.at(-1) as string,
    schema: parts.at(-2),
  };
  return mine.some(w => fits(w.where as string, named));
}

/** The `user:` principals among `principals` who are not workspace members. */
export async function principalsOutsideWorkspace(
  workspaceId: string,
  principals: string[],
): Promise<string[]> {
  const people = principals.filter(p => p.startsWith("user:"));
  if (people.length === 0) return [];
  const members = await WorkspaceMember.find({
    workspaceId: new Types.ObjectId(workspaceId),
    userId: { $in: people.map(p => p.slice("user:".length)) },
  })
    .select("userId")
    .lean();
  const known = new Set(members.map(m => `user:${String(m.userId)}`));
  return people.filter(p => !known.has(p));
}

/**
 * `query` inside a read-only transaction, sent as one string so it costs no
 * extra round trip (Postgres simple protocol). The newlines keep a trailing
 * `-- comment` from swallowing the COMMIT.
 */
export function inReadOnlyTransaction(query: string): string {
  return `BEGIN TRANSACTION READ ONLY;\n${query}\n;COMMIT`;
}

/** The query's own result among those of `inReadOnlyTransaction`. */
export function ownResult<T>(results: T | T[]): T {
  return Array.isArray(results) ? results[results.length - 2] : results;
}

// ---------------------------------------------------------------------------
// The check executeQuery runs
// ---------------------------------------------------------------------------

/** Engines whose reads can run in a read-only transaction (or setting). */
const READ_ONLY_TRANSACTION = new Set([
  "postgresql",
  "redshift",
  "cloudsql-postgres",
  "mysql",
  "clickhouse",
]);

export interface WriteCheck {
  /** Why the query may not run. */
  refused?: string;
  /** Run this read in a read-only transaction. */
  readOnlyTransaction?: boolean;
}

/**
 * Whether the query may run, and how. A write is recorded (who, which
 * connection, where, and whether it was allowed) and refused unless the
 * writers list allows it. A read is never recorded; it runs read-only unless
 * its principal may write anywhere.
 */
export async function checkConnectionWrite(
  database: Pick<
    IDatabaseConnection,
    "_id" | "workspaceId" | "name" | "type" | "writers"
  >,
  query: unknown,
  options: { readOnly?: boolean; actor?: string; writeChecked?: boolean } = {},
): Promise<WriteCheck> {
  if (options.readOnly || options.writeChecked) return {};
  if (!database._id || !database.workspaceId) return {}; // a connection being tested
  const principal = actingPrincipal(options.actor);
  const write = isWrite(database.type, query);
  if (!principal) {
    // A request that identifies no one writes nothing, unless the code
    // serving it marked the work as Mako's own (asSystem).
    if (!write || isSystemWork()) return {};
    logger.warn("Refused a write by no identified person or workflow", {
      connectionId: String(database._id),
      path: getRequestContext()?.path,
    });
    return {
      refused: `Mako could not tell who is writing to ${database.name}, so the write was refused. Writes need a signed-in person, an API key, or a workflow on the connection's writers list.`,
    };
  }
  if (!write) {
    if (!READ_ONLY_TRANSACTION.has(database.type)) return {};
    if (covers(database.writers, principal, null)) return {};
    return { readOnlyTransaction: true };
  }

  const decision = decideWrite(database.writers, principal, query);
  recordWrite(database, principal, query, decision.allowed, decision.target);
  if (decision.allowed) return {};
  return { refused: refusal(decision, database.name) };
}

/**
 * Record a write by `principal` (who, which connection, where, allowed), so
 * the Access tab lists it with Allow. Not awaited: the query does not wait.
 */
export function recordWrite(
  database: Pick<IDatabaseConnection, "_id" | "workspaceId">,
  principal: string,
  query: unknown,
  allowed: boolean,
  known?: WriteTarget,
): void {
  if (!database._id || !database.workspaceId) return;
  // Where it wrote, for whoever reviews the log: worked out for writes only.
  const target =
    known ?? (typeof query === "string" ? writeTarget(query) : null);
  void ConnectionWriteEvent.create({
    workspaceId: new Types.ObjectId(String(database.workspaceId)),
    connectionId: new Types.ObjectId(String(database._id)),
    principal,
    target: target
      ? [target.schema, target.table].filter(Boolean).join(".")
      : undefined,
    allowed,
  }).catch(error =>
    logger.warn("Could not record a connection write", { error }),
  );
}

/**
 * Why `principal` may not write through an API key with the query:write
 * scope: it is not on the connection's writers list. Names the identity
 * Mako saw, since that is what an admin allows.
 */
export function notAWriterRefusal(
  principal: string | undefined,
  connectionName: string,
): string {
  if (!principal) {
    return `This request has no person or workflow Mako can allow to write to ${connectionName}; everyone can read it.`;
  }
  return `${principal} is not allowed to write to ${connectionName}; everyone can read it. An admin can allow ${principal} on the connection's Access tab.`;
}
