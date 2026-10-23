/**
 * The writers list as the Access tab reads and changes it, for both kinds of
 * connection: database connections (writes are SQL, `where` is a schema or
 * table) and source connections (writes go through the proxy, `where` is a
 * path). Who wrote lately comes from the shared write log.
 */
import { Types } from "mongoose";
import type { IConnectionWriter } from "../database/workspace-schema";
import { ConnectionWriteEvent } from "./connection-write-event";

/** A principal that can be put on a writers list. */
export const LISTABLE_PRINCIPAL =
  /^(user:[A-Za-z0-9_-]+|workflow:[A-Za-z0-9][A-Za-z0-9_-]{0,99})$/;

export const RECENT_WRITES_DAYS = 30;

export interface RecentWriter {
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
 * workflow cannot be.
 */
export async function recentWriters(
  connectionId: string,
  covered: (principal: string, target: string) => boolean,
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
  return recent
    .filter(r => LISTABLE_PRINCIPAL.test(r._id))
    .map(r => {
      const targets = r.targets.filter((t): t is string => !!t);
      return {
        principal: r._id,
        count: r.count,
        lastAt: r.lastAt,
        targets: targets.slice(0, 5),
        // Against the list as it is now, not as it was then.
        uncovered: targets.filter(t => !covered(r._id, t)).slice(0, 5),
      };
    });
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
