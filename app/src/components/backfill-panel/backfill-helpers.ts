export type EventFilterKey =
  "all" | "applied" | "pending" | "failed" | "dropped";

export type StreamState = "idle" | "active" | "paused" | "error";
export type BackfillStatus =
  "idle" | "running" | "paused" | "completed" | "error";

export function formatLag(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "—";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export function camelToSnake(v: string): string {
  return v.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

export function entityLabel(entity: string): string {
  if (!entity.includes(":")) return entity;
  const [parent, sub] = entity.split(":");
  return parent && sub ? `${camelToSnake(sub)}_${parent}` : entity;
}

export function streamChipProps(state: StreamState): {
  label: string;
  color: "success" | "info" | "error" | "warning" | "default";
} {
  switch (state) {
    case "active":
      return { label: "Active", color: "success" };
    case "paused":
      return { label: "Paused", color: "warning" };
    case "error":
      return { label: "Error", color: "error" };
    default:
      return { label: "Idle", color: "default" };
  }
}

export function backfillChipProps(status: BackfillStatus): {
  label: string;
  color: "success" | "info" | "error" | "warning" | "default";
} {
  switch (status) {
    case "running":
      return { label: "Running", color: "info" };
    case "paused":
      return { label: "Paused", color: "warning" };
    case "completed":
      return { label: "Complete", color: "success" };
    case "error":
      return { label: "Error", color: "error" };
    default:
      return { label: "Not started", color: "default" };
  }
}

export function entityStreamChip(
  e: {
    backlogCount: number;
    lastMaterializedAt: string | null;
    backfillDone?: boolean;
  },
  streamState: StreamState,
): { label: string; color: "success" | "info" | "default" } {
  if (e.backlogCount > 0) return { label: "Syncing", color: "info" };
  // A completed backfill means the destination is fully populated — with an
  // active stream the entity is live (waiting for events), not "Pending".
  if (e.lastMaterializedAt || (e.backfillDone && streamState === "active")) {
    return { label: "Live", color: "success" };
  }
  return { label: "Pending", color: "default" };
}

export function entityBackfillChip(e: {
  backlogCount: number;
  backfillDone?: boolean;
}): {
  label: string;
  color: "success" | "info" | "default";
} {
  if (e.backfillDone) return { label: "Done", color: "success" };
  if (e.backlogCount > 0) return { label: "In progress", color: "info" };
  return { label: "Not started", color: "default" };
}

export type LogEntry = {
  timestamp: string;
  level: string;
  message: string;
  metadata?: Record<string, unknown>;
};

export function formatMetadataValue(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : undefined;
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  try {
    const serialized = JSON.stringify(value);
    if (!serialized || serialized === "{}" || serialized === "[]") {
      return undefined;
    }
    return serialized.length > 220
      ? `${serialized.slice(0, 217)}...`
      : serialized;
  } catch {
    return undefined;
  }
}

export function readMetadataValue(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  return formatMetadataValue(metadata?.[key]);
}

export function formatLog(log: LogEntry): string {
  const m = log.metadata;
  const entity = typeof m?.entity === "string" ? m.entity : undefined;
  const totalWritten =
    typeof m?.totalWritten === "number" ? m.totalWritten : undefined;
  const totalFetched =
    typeof m?.totalFetched === "number" ? m.totalFetched : undefined;
  const rows =
    typeof m?.totalProcessed === "number"
      ? m.totalProcessed
      : typeof m?.rowsWritten === "number"
        ? m.rowsWritten
        : undefined;
  const fetchedCount =
    typeof m?.fetchedCount === "number" ? m.fetchedCount : undefined;

  const parts: string[] = [];
  if (entity) {
    parts.push(`[${entityLabel(entity)}]`);
  }
  parts.push(log.message);
  if (totalWritten !== undefined && totalFetched !== undefined) {
    parts.push(
      `(${totalWritten.toLocaleString()} written / ${totalFetched.toLocaleString()} fetched)`,
    );
  } else if (rows !== undefined) {
    parts.push(`(${rows.toLocaleString()} rows)`);
  } else if (fetchedCount !== undefined) {
    parts.push(`(${fetchedCount.toLocaleString()} fetched)`);
  }

  const level = log.level.toLowerCase();
  if ((level === "warn" || level === "error") && m) {
    const details: string[] = [];
    const status = readMetadataValue(m, "status");
    const method = readMetadataValue(m, "method");
    const endpoint = readMetadataValue(m, "endpoint");
    const error = readMetadataValue(m, "error");
    const errorCode = readMetadataValue(m, "errorCode");
    const errorName = readMetadataValue(m, "errorName");
    const requestId = readMetadataValue(m, "requestId");
    const chunkIndex = readMetadataValue(m, "chunkIndex");
    const syncMode = readMetadataValue(m, "syncMode");

    if (status) {
      details.push(`status=${status}`);
    }
    if (method && endpoint) {
      details.push(`${method} ${endpoint}`);
    } else if (endpoint) {
      details.push(endpoint);
    }
    if (error && !log.message.toLowerCase().includes(error.toLowerCase())) {
      details.push(`error=${error}`);
    }
    if (errorCode) {
      details.push(`code=${errorCode}`);
    }
    if (errorName) {
      details.push(`name=${errorName}`);
    }
    if (requestId) {
      details.push(`requestId=${requestId}`);
    }
    if (chunkIndex) {
      details.push(`chunk=${chunkIndex}`);
    }
    if (syncMode) {
      details.push(`mode=${syncMode}`);
    }

    if (details.length > 0) {
      parts.push(`- ${details.join(" | ")}`);
    }
  }

  return parts.join(" ");
}

export interface BackfillRun {
  executionId: string;
  executedAt: string;
  status: string;
  success: boolean;
  error?: string | { message: string; stack?: string; code?: string } | null;
  duration?: number;
}

export type EntityDriftMap = Record<
  string,
  Array<{ column: string; liveType: string; expectedType: string }>
>;

export type EntitySchemaFields = Record<
  string,
  { type: string; nullable?: boolean; required?: boolean }
>;

interface EntityRowFlow {
  entityLayouts?: unknown;
  entityFilter?: unknown;
}

/**
 * Entities the flow is configured for (enabled layouts, else the entity
 * filter), in configuration order.
 */
export function configuredEntityNames(
  flow: EntityRowFlow | undefined,
): string[] {
  const layouts = flow?.entityLayouts as
    Array<{ entity: string; enabled?: boolean }> | undefined;
  if (layouts && layouts.length > 0) {
    return layouts
      .filter(l => l.enabled !== false && l.entity)
      .map(l => l.entity);
  }
  const filter = flow?.entityFilter as string[] | undefined;
  if (filter && filter.length > 0) {
    return filter.filter(e => typeof e === "string" && e.trim().length > 0);
  }
  return [];
}

/**
 * One row per entity — configured ones first, then any the CDC status
 * reports beyond them — merging CDC state, destination counts and the live
 * execution's per-entity stats.
 */
export function buildEntityRows(
  flow: EntityRowFlow | undefined,
  cdcEntities: any[],
  destinationCounts: Record<string, number | null> | null,
  execStats: Record<string, number>,
  execStatus: Record<string, string>,
) {
  const cdcByEntity = new Map(cdcEntities.map((e: any) => [e.entity, e]));
  const allEntityNames = Array.from(
    new Set([
      ...configuredEntityNames(flow),
      ...cdcEntities.map((e: any) => e.entity),
    ]),
  );
  return allEntityNames.map(name => {
    const s = cdcByEntity.get(name);
    return {
      entity: name,
      backlogCount: s?.backlogCount || 0,
      lastIngestSeq: s?.lastIngestSeq || 0,
      lastMaterializedSeq: s?.lastMaterializedSeq || 0,
      lagSeconds: s?.lagSeconds ?? null,
      lastMaterializedAt: s?.lastMaterializedAt || null,
      destinationRowCount:
        destinationCounts?.[name] ??
        (typeof s?.destinationRowCount === "number"
          ? s.destinationRowCount
          : null),
      lifetimeEventsProcessed:
        typeof s?.lifetimeEventsProcessed === "number"
          ? s.lifetimeEventsProcessed
          : 0,
      lifetimeRowsApplied:
        typeof s?.lifetimeRowsApplied === "number" ? s.lifetimeRowsApplied : 0,
      backfillDone: s?.backfillDone === true,
      failedCount: (s as any)?.failedCount || 0,
      repartition: (s as any)?.repartition ?? null,
      execRows: execStats[name] || 0,
      execStatus: execStatus[name] || null,
    };
  });
}

export type EntityRow = ReturnType<typeof buildEntityRows>[number];

/** Panel totals across entity rows. */
export function entityTotals(entities: EntityRow[]) {
  return {
    totalEventsProcessed: entities.reduce(
      (sum, e) => sum + (e.lifetimeEventsProcessed || 0),
      0,
    ),
    totalRowsApplied: entities.reduce(
      (sum, e) => sum + Math.max(e.lifetimeRowsApplied || 0, e.execRows || 0),
      0,
    ),
    totalDestinationRows: entities.reduce(
      (sum, e) => sum + Math.max(e.destinationRowCount || 0, 0),
      0,
    ),
    // Null counts mean the destination has no row-count support — show "—"
    // rather than a misleading 0.
    hasAnyDestinationCount: entities.some(
      e => typeof e.destinationRowCount === "number",
    ),
  };
}
