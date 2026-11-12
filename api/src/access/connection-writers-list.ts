/**
 * The writers list as the Access tab reads and changes it, for both kinds of
 * connection: database connections (writes are SQL, `where` is a schema or
 * table) and source connections (writes go through the proxy; a writer
 * writes anywhere, a stored `where` is ignored). Who wrote lately comes from
 * the shared write log.
 */
import { Types } from "mongoose";
import type { IConnectionWriter } from "../database/workspace-schema";
import { ConnectionWriteEvent } from "./connection-write-event";
import {
  principalsOutsideWorkspace,
  viewerPrincipals,
} from "./connection-writes";

/** A principal that can be put on a writers list. */
export const LISTABLE_PRINCIPAL =
  /^(user:[A-Za-z0-9_-]+|workflow:[A-Za-z0-9][A-Za-z0-9_-]{0,99})$/;

/**
 * Every deployed workflow, on a source connection's writers list. Deployed
 * workflows share one identity today (the worker's key), so the workflow name
 * a request sends cannot be trusted to tell one from another: a source
 * connection lists them all at once or none.
 */
export const ALL_WORKFLOWS = "workflow:*";

/** A principal a source connection's writers list takes. */
export const SOURCE_LISTABLE_PRINCIPAL =
  /^(user:[A-Za-z0-9_-]+|workflow:\*|workflow:[A-Za-z0-9][A-Za-z0-9_-]{0,99})$/;

/** A source writer's principal: any `workflow:<name>` is every workflow. */
export const sourceWriterPrincipal = (principal: string): string =>
  principal.startsWith("workflow:") ? ALL_WORKFLOWS : principal;

const RECENT_WRITES_DAYS = 30;

interface RecentWriter {
  principal: string;
  count: number;
  lastAt: Date;
  targets: string[];
  /** Targets written lately that the list, as it is now, does not cover. */
  uncovered: string[];
}

/**
 * Who wrote or tried to write through `connectionId` lately, from the write
 * log, and what the list does not cover (what it refuses), to allow in one
 * click. Only principals that can be listed: the worker writing as no
 * workflow cannot be, nor an agent's refused attempt (`agent:<principal>`).
 */
export async function recentWriters(
  connectionId: string,
  covered: (principal: string, target: string) => boolean,
  /** Source connections: every workflow's attempts, offered as one. */
  { allWorkflows = false }: { allWorkflows?: boolean } = {},
): Promise<RecentWriter[]> {
  const since = new Date(Date.now() - RECENT_WRITES_DAYS * 86_400_000);
  const recent = await ConnectionWriteEvent.aggregate<{
    _id: string;
    count: number;
    lastAt: Date;
    targets: (string | null)[];
  }>([
    {
      $match: {
        connectionId: new Types.ObjectId(connectionId),
        at: { $gte: since },
      },
    },
    {
      $group: {
        _id: "$principal",
        count: { $sum: 1 },
        lastAt: { $max: "$at" },
        targets: { $addToSet: "$target" },
      },
    },
    { $sort: { count: -1 } },
    { $limit: 50 },
  ]);
  const merged = new Map<
    string,
    { count: number; lastAt: Date; targets: string[]; uncovered: string[] }
  >();
  for (const r of recent.filter(r => LISTABLE_PRINCIPAL.test(r._id))) {
    const principal = allWorkflows ? sourceWriterPrincipal(r._id) : r._id;
    // The name a workflow sent stays visible: it is all Mako knows of it.
    const label = (t: string) =>
      principal === r._id
        ? t
        : `${t} (the workflow sent the name ${r._id.slice("workflow:".length)})`;
    const targets = r.targets.filter((t): t is string => !!t);
    const into = merged.get(principal) ?? {
      count: 0,
      lastAt: r.lastAt,
      targets: [],
      uncovered: [],
    };
    into.count += r.count;
    if (r.lastAt > into.lastAt) into.lastAt = r.lastAt;
    into.targets.push(...targets.map(label));
    // Against the list as it is now, not as it was then.
    into.uncovered.push(
      ...targets.filter(t => !covered(principal, t)).map(label),
    );
    merged.set(principal, into);
  }
  return [...merged].map(([principal, r]) => ({
    principal,
    count: r.count,
    lastAt: r.lastAt,
    targets: r.targets.slice(0, 5),
    uncovered: r.uncovered.slice(0, 5),
  }));
}

/** The list as the Access tab shows it. */
export function publicWriters(writers: IConnectionWriter[] | undefined) {
  return (writers ?? []).map(w => ({
    principal: w.principal,
    where: w.where ?? null,
    addedBy: w.addedBy ?? null,
    addedAt: w.addedAt ?? null,
  }));
}

/**
 * The new list: one entry per principal and place, keeping who added an
 * entry first and when.
 */
export function nextWriters(
  previous: IConnectionWriter[] | undefined,
  incoming: { principal: string; where?: string }[],
  userId: string,
): IConnectionWriter[] {
  const now = new Date();
  const before = new Map(
    (previous ?? []).map(w => [`${w.principal} ${w.where ?? ""}`, w]),
  );
  const next = new Map<string, { principal: string; where?: string }>();
  for (const w of incoming) next.set(`${w.principal} ${w.where ?? ""}`, w);
  return [...next].map(([key, w]) => ({
    principal: w.principal,
    ...(w.where ? { where: w.where } : {}),
    addedBy: before.get(key)?.addedBy ?? userId,
    addedAt: before.get(key)?.addedAt ?? now,
  }));
}

/**
 * People decide who writes, in the app: never an API key, MCP client or
 * agent, whatever it is asked.
 */
export const WRITERS_IN_APP_ONLY = "Writers can only be changed in the app";

/** The person who may change a writers list (signed in to the app), or null. */
export function writersEditor(
  authType: unknown,
  user: { id?: string } | undefined,
): string | null {
  return authType === "session" && user?.id ? user.id : null;
}

/**
 * Why `writers` cannot be listed, or null. Only principals new to the list
 * (not in `stored`) are checked: each is a listable principal (an agent's
 * attempt never is) and a workspace member who is not a viewer. One already
 * stored passes, so an unrelated change still saves. A stored writer who
 * became a viewer is refused when writing, and one who left the workspace
 * is refused any request, read or write (connections/proxy.service.ts).
 */
export async function writersOutsideRefusal(
  workspaceId: string,
  writers: { principal: string }[],
  stored: { principal: string }[] = [],
  /** A live readers list: same checks, and viewers may be on it. */
  { readers = false }: { readers?: boolean } = {},
): Promise<string | null> {
  const known = new Set(stored.map(w => w.principal));
  const principals = writers.map(w => w.principal).filter(p => !known.has(p));
  const unlistable = principals.filter(p => !SOURCE_LISTABLE_PRINCIPAL.test(p));
  if (unlistable.length > 0) {
    return `${unlistable.join(", ")} cannot be on a ${readers ? "live readers" : "writers"} list`;
  }
  const strangers = await principalsOutsideWorkspace(workspaceId, principals);
  if (strangers.length > 0) {
    return `${strangers.join(", ")} is not a member of this workspace`;
  }
  if (readers) return null;
  const viewers = await viewerPrincipals(workspaceId, principals);
  return viewers.length > 0
    ? `Viewers can't write through a connection (${viewers.join(", ")}).`
    : null;
}
