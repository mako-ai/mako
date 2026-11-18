/**
 * Caps on BigQuery jobs started for an agent or the MCP server.
 *
 * On 2026-11-18 four agent queries (7-18M slot-ms each) held a 50-slot
 * reservation for 30 minutes and starved every other reader on it. Mako's own
 * poll timeout did not help: the job kept its slots after Mako stopped
 * waiting. So every agent job now carries two caps BigQuery enforces itself:
 *
 * - `jobTimeoutMs`: BigQuery cancels the job after this long.
 * - `maximumBytesBilled`: BigQuery refuses a read that would bill more,
 *   before it runs and at no charge.
 *
 * A job is an agent job when its labels say so (bigquery-labels.ts): an agent
 * tool or an MCP call sets `mako_tool`, `mako_source=agent` or
 * `mako_trigger=mcp`, and those keys survive into a console or an app binding
 * preview the tool runs. Sync and CDC writes, scheduled and published binding
 * builds, scheduled queries and dbt runs are never capped.
 *
 * Each connection may override both defaults (`agent_job_timeout_ms`,
 * `agent_max_bytes_billed_gb`; `0` turns a cap off). The defaults live in
 * config/long-running-queries.ts and are env-overridable.
 */
import {
  AGENT_BIGQUERY_JOB_TIMEOUT_MS,
  AGENT_BIGQUERY_MAX_BYTES_BILLED,
} from "../../../config/long-running-queries";

/** The connection settings that override the agent caps. */
export const AGENT_JOB_TIMEOUT_SETTING = "agent_job_timeout_ms";
export const AGENT_MAX_BYTES_SETTING = "agent_max_bytes_billed_gb";

const GIB = 1024 ** 3;

/** Sources whose jobs are never agent jobs, whatever context they ran in. */
const UNCAPPED_SOURCES = new Set(["cdc", "flow", "scheduled_query"]);
/** Triggers that run unattended: scheduled and published binding builds. */
const UNCAPPED_TRIGGERS = new Set(["scheduler", "publish"]);
/** Triggers that mean an MCP client asked. */
const MCP_TRIGGERS = new Set(["mcp", "desktop"]);

export interface AgentJobCaps {
  /** BigQuery `jobTimeoutMs`; undefined: none. */
  jobTimeoutMs?: number;
  /** BigQuery `maximumBytesBilled`; undefined: none. */
  maximumBytesBilled?: number;
}

/** Whether a job with these (final, sanitized) labels serves an agent. */
export function isAgentJob(
  labels: Record<string, string> | undefined,
): boolean {
  if (!labels) return false;
  if (UNCAPPED_SOURCES.has(labels.mako_source ?? "")) return false;
  if (UNCAPPED_TRIGGERS.has(labels.mako_trigger ?? "")) return false;
  return (
    labels.mako_source === "agent" ||
    MCP_TRIGGERS.has(labels.mako_trigger ?? "") ||
    Boolean(labels.mako_tool)
  );
}

/**
 * A non-negative number from a connection field (forms may store numbers as
 * strings); undefined when unset or invalid, so the default applies.
 */
function setting(raw: unknown): number | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw === "string" && raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * The caps for one job. `explicitBytes` is the caller's own
 * `maximumBytesBilled`: a positive number wins, `0` means no byte cap (an
 * agent write by someone allowed to write), undefined takes the default.
 */
export function resolveAgentJobCaps(input: {
  connection: Record<string, unknown> | undefined;
  labels: Record<string, string> | undefined;
  explicitBytes?: number;
}): AgentJobCaps {
  const caps: AgentJobCaps = {};
  const explicit = input.explicitBytes;
  if (typeof explicit === "number" && explicit > 0) {
    caps.maximumBytesBilled = Math.floor(explicit);
  }
  if (!isAgentJob(input.labels)) return caps;

  const timeout =
    setting(input.connection?.[AGENT_JOB_TIMEOUT_SETTING]) ??
    AGENT_BIGQUERY_JOB_TIMEOUT_MS;
  // BigQuery refuses a jobTimeoutMs under 1 s.
  if (timeout > 0) caps.jobTimeoutMs = Math.max(1000, Math.floor(timeout));

  if (explicit === undefined) {
    const gb = setting(input.connection?.[AGENT_MAX_BYTES_SETTING]);
    const bytes =
      gb !== undefined ? Math.floor(gb * GIB) : AGENT_BIGQUERY_MAX_BYTES_BILLED;
    if (bytes > 0) caps.maximumBytesBilled = bytes;
  }
  return caps;
}

/** Put the caps on a jobs.query request body (int64 travels as a string). */
export function applyAgentJobCaps(
  body: Record<string, unknown>,
  caps: AgentJobCaps,
): void {
  if (caps.maximumBytesBilled) {
    body.maximumBytesBilled = String(caps.maximumBytesBilled);
  }
  if (caps.jobTimeoutMs) body.jobTimeoutMs = String(caps.jobTimeoutMs);
}
