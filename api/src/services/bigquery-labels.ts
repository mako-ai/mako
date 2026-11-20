/**
 * Labels on every BigQuery job Mako starts, so warehouse cost can be
 * attributed per app, console, flow and source.
 *
 * Every Mako path (bindings, consoles, agents, CDC, dbt) runs as one service
 * account, so INFORMATION_SCHEMA.JOBS cannot tell an app's refresh from a CDC
 * MERGE by user. Labels can: `mako_source` says which subsystem started the
 * job, and the other `mako_*` keys say which app/console/flow it served.
 *
 * Entry points set labels with `withQueryLabels(labels, fn)`. The context is
 * an AsyncLocalStorage, so it reaches the request builders in
 * database-connection.service.ts without threading a parameter through every
 * layer. Nested contexts merge; the inner one wins a key. An explicit
 * `labels` option on a query wins over both.
 *
 * BigQuery rules (https://cloud.google.com/bigquery/docs/labels-intro):
 * at most 64 labels; keys and values at most 63 characters of lowercase
 * letters, digits, `_` and `-`; keys start with a lowercase letter.
 * `sanitizeBigQueryLabels` enforces them so a label can never fail a query.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

/** Values may be absent: empty ones are dropped, never sent. */
export type QueryLabels = Record<string, string | null | undefined>;

/** Which subsystem started a job: the `mako_source` label. */
export type MakoQuerySource =
  | "app_binding"
  | "console"
  | "adhoc"
  | "export"
  | "scheduled_query"
  | "agent"
  | "notebook"
  | "workflow"
  | "cdc"
  | "flow"
  | "metadata"
  | "connection_test"
  | "other";

const storage = new AsyncLocalStorage<Record<string, string>>();

const MAX_LABELS = 64;
const MAX_LENGTH = 63;

function compact(labels: QueryLabels): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels)) {
    if (value === null || value === undefined) continue;
    const text = String(value);
    if (text) out[key] = text;
  }
  return out;
}

/** The labels set by every enclosing `withQueryLabels`, merged. */
export function currentQueryLabels(): Record<string, string> {
  return { ...(storage.getStore() ?? {}) };
}

/**
 * Run `fn` with these labels on every BigQuery job it starts. Merges with
 * any enclosing context; these labels win a shared key.
 */
export function withQueryLabels<T>(labels: QueryLabels, fn: () => T): T {
  return storage.run({ ...currentQueryLabels(), ...compact(labels) }, fn);
}

/**
 * Like `withQueryLabels`, but an enclosing context wins a shared key. For a
 * shared layer that knows a fallback (a binding build guessing its trigger
 * from the actor id) while its caller knows better.
 */
export function withDefaultQueryLabels<T>(labels: QueryLabels, fn: () => T): T {
  return storage.run({ ...compact(labels), ...currentQueryLabels() }, fn);
}

function sanitizePart(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_")
    .slice(0, MAX_LENGTH);
}

/**
 * Make labels valid for BigQuery: lowercase, invalid characters to `_`,
 * truncated to 63, keys forced to start with a letter, empties dropped,
 * at most 64 kept.
 */
export function sanitizeBigQueryLabels(
  labels: QueryLabels,
): Record<string, string> {
  const out: Record<string, string> = {};
  let count = 0;
  for (const [rawKey, rawValue] of Object.entries(compact(labels))) {
    let key = sanitizePart(rawKey);
    if (!key) continue;
    if (!/^[a-z]/.test(key)) key = `l_${key}`.slice(0, MAX_LENGTH);
    const value = sanitizePart(rawValue);
    if (!value) continue;
    if (!(key in out)) {
      if (count >= MAX_LABELS) continue;
      count++;
    }
    out[key] = value;
  }
  return out;
}

/**
 * The `labels` map for one BigQuery job: the enclosing context, then the
 * query's explicit labels on top. Always carries `mako_source` ("other" when
 * no entry point set one, so unlabelled paths are findable) and
 * `mako_workspace` when the connection's workspace is known.
 */
export function bigQueryJobLabels(input: {
  workspaceId?: unknown;
  explicit?: QueryLabels;
}): Record<string, string> {
  const merged: Record<string, string> = {
    ...currentQueryLabels(),
    ...compact(input.explicit ?? {}),
  };
  if (!merged.mako_source) merged.mako_source = "other";
  if (!merged.mako_workspace && input.workspaceId) {
    merged.mako_workspace = String(input.workspaceId);
  }
  // mako_user is a user id; an email there becomes a hash.
  if (merged.mako_user?.includes("@")) {
    merged.mako_user = callerHandle(merged.mako_user);
  }
  // Who asked: an entry point's own caller labels win.
  const caller = callerLabels(merged);
  for (const [key, value] of Object.entries(caller)) {
    if (!merged[key]) merged[key] = value;
  }
  return sanitizeBigQueryLabels(merged);
}

const SYSTEM_SOURCES = new Set([
  "cdc",
  "flow",
  "scheduled_query",
  "metadata",
  "connection_test",
  "export",
]);
const SYSTEM_TRIGGERS = new Set(["scheduler", "publish"]);
const BINDING_TRIGGERS = new Set([
  "preview",
  "dev",
  "manual",
  "viewer",
  "live",
  "public",
]);

/**
 * A label-safe stand-in for a caller id. A value that looks like an email
 * becomes a short hash, so an address never reaches BigQuery's job history.
 */
export function callerHandle(raw: string): string {
  const text = raw.trim();
  if (text.includes("@")) {
    return `h_${createHash("sha256").update(text.toLowerCase()).digest("hex").slice(0, 12)}`;
  }
  return sanitizePart(text);
}

/**
 * `mako_caller_kind` (user | agent | api_key | system), `mako_caller` (the
 * user id or agent id, never an email) and `mako_surface` (console | mcp |
 * agent | notebook | binding | system | other), derived from the labels the
 * entry points already set.
 */
export function callerLabels(
  labels: Record<string, string>,
): Record<string, string> {
  const { mako_source: source = "", mako_trigger: trigger = "" } = labels;
  const user = labels.mako_user ? callerHandle(labels.mako_user) : "";

  let surface = "other";
  if (trigger === "mcp" || trigger === "desktop") surface = "mcp";
  else if (source === "agent" || labels.mako_tool) surface = "agent";
  else if (source === "console" || source === "adhoc") surface = "console";
  else if (source === "notebook") surface = "notebook";
  else if (source === "app_binding" || BINDING_TRIGGERS.has(trigger)) {
    surface = "binding";
  } else if (SYSTEM_SOURCES.has(source) || SYSTEM_TRIGGERS.has(trigger)) {
    surface = "system";
  }

  let kind = "system";
  let caller = source || "other";
  if (trigger === "api" || trigger === "api_key") {
    kind = "api_key";
    caller = user || "api_key";
  } else if (SYSTEM_SOURCES.has(source) || SYSTEM_TRIGGERS.has(trigger)) {
    kind = "system";
  } else if (surface === "mcp" || surface === "agent") {
    kind = "agent";
    caller =
      user ||
      (labels.mako_chat ? callerHandle(labels.mako_chat) : "") ||
      "agent";
  } else if (user) {
    kind = "user";
    caller = user;
  }
  return {
    mako_caller_kind: kind,
    mako_caller: caller,
    mako_surface: surface,
  };
}

/**
 * Who asked for a binding build, from the actor id the apps layer passes
 * around: the scheduler, a publish, an API key, an anonymous reader, or a
 * person (whose id becomes `mako_user`).
 */
export function bindingActorLabels(actorId: string): QueryLabels {
  switch (actorId) {
    case "scheduler":
      return { mako_trigger: "scheduler" };
    case "publish":
      return { mako_trigger: "publish" };
    case "api-key":
      return { mako_trigger: "api_key" };
    case "":
      return { mako_trigger: "public" };
    default:
      return { mako_trigger: "user", mako_user: actorId };
  }
}

/** A user id label value from an "user:<id>" actor or a bare id. */
export function userLabel(id: unknown): string | undefined {
  if (id === null || id === undefined) return undefined;
  const text = String(id);
  return text.startsWith("user:") ? text.slice(5) : text || undefined;
}
