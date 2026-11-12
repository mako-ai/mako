import * as crypto from "crypto";
import type {
  NotificationChannelType,
  NotificationResourceType,
  NotificationTrigger,
} from "../database/workspace-schema";
import type {
  FlowRunTerminalEventData,
  NotificationOutboundPayload,
  RunFailedStep,
} from "./flow-run-notification.types";

export const NOTIFICATION_RESOURCE_TYPES = [
  "scheduled_query",
  "flow",
  "dbt_job",
  "dbt_project",
] as const satisfies readonly NotificationResourceType[];

/** A message carries at most this many failed steps. */
export const MAX_FAILED_STEPS = 10;
/** Characters kept per failed-step message. */
export const MAX_STEP_MESSAGE_LENGTH = 300;
/** Characters kept of the run-level error. */
export const MAX_ERROR_MESSAGE_LENGTH = 500;
/** Characters kept per step or job name. */
const MAX_NAME_LENGTH = 120;
/** Slack caps a section block's text at 3000 characters. */
const MAX_SLACK_TEXT_LENGTH = 2900;

export function isNotificationResourceType(
  value: unknown,
): value is NotificationResourceType {
  return (
    typeof value === "string" &&
    (NOTIFICATION_RESOURCE_TYPES as readonly string[]).includes(value)
  );
}

export function isDbtResourceType(
  resourceType: NotificationResourceType,
): resourceType is "dbt_job" | "dbt_project" {
  return resourceType === "dbt_job" || resourceType === "dbt_project";
}

export function terminalTriggerFromRunEvent(
  event: FlowRunTerminalEventData,
): NotificationTrigger | null {
  if (event.success) return "success";
  return "failure";
}

/**
 * The (resourceType, resourceId) pairs whose rules a run event reaches. A
 * dbt job run reaches the rules on the job and the defaults on its project.
 */
export function ruleTargetsForEvent(
  event: Pick<
    FlowRunTerminalEventData,
    "resourceType" | "resourceId" | "projectId"
  >,
): Array<{ resourceType: NotificationResourceType; resourceId: string }> {
  const targets: Array<{
    resourceType: NotificationResourceType;
    resourceId: string;
  }> = [{ resourceType: event.resourceType, resourceId: event.resourceId }];
  if (event.resourceType === "dbt_job" && event.projectId) {
    targets.push({ resourceType: "dbt_project", resourceId: event.projectId });
  }
  return targets;
}

/**
 * Cadence. Scheduled queries and flows deliver on every matching run. A dbt
 * job run delivers "failure" when the previous run had not failed (or always
 * with `everyFailure`), and "success" only as the recovery after a failure.
 */
export function shouldDeliverForRule(params: {
  event: Pick<FlowRunTerminalEventData, "resourceType" | "previousStatus">;
  trigger: NotificationTrigger;
  rule: { everyFailure?: boolean };
}): boolean {
  if (params.event.resourceType !== "dbt_job") return true;
  const previousFailed = params.event.previousStatus === "error";
  if (params.trigger === "failure") {
    return params.rule.everyFailure === true || !previousFailed;
  }
  return previousFailed;
}

export function hashForIdempotencySecret(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

export function buildIdempotencyKey(params: {
  resourceType: NotificationResourceType;
  resourceId: string;
  runId: string;
  trigger: NotificationTrigger;
  channelType: NotificationChannelType;
  ruleId: string;
}): string {
  return [
    params.resourceType,
    params.resourceId,
    params.runId,
    params.trigger,
    params.channelType,
    params.ruleId,
  ].join(":");
}

export function generateWebhookSigningSecret(): string {
  return `whsec_${crypto.randomBytes(32).toString("hex")}`;
}

export function signWebhookBody(secret: string, body: string): string {
  return crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/**
 * dbt error text can quote a connection string or a rendered config. Mask
 * the credential shapes before the text leaves Mako. Best effort: the run
 * log has its own value-based redaction, this covers what a message quotes.
 */
export function scrubSecrets(text: string): string {
  return text
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
      "[redacted key]",
    )
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(
      /\b(password|passwd|pwd|secret|token|api[_-]?key|private[_-]?key|authorization)\b(["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;)]+)/gi,
      "$1$2[redacted]",
    );
}

function cleanMessage(text: string, max: number): string {
  return truncateText(scrubSecrets(text).replace(/\s+/g, " ").trim(), max);
}

export function boundErrorMessage(
  text: string | undefined,
): string | undefined {
  if (!text) return undefined;
  return cleanMessage(text, MAX_ERROR_MESSAGE_LENGTH) || undefined;
}

const FAILED_STEP_STATUSES = new Set(["error", "fail", "runtime error"]);

/** Failed models and tests of a run, bounded in count and message length. */
export function boundFailedSteps(
  steps: ReadonlyArray<{
    name: string;
    resourceType: string;
    status: string;
    message?: string;
  }>,
): { failedSteps: RunFailedStep[]; failedStepCount: number } {
  const failed = steps.filter(step => FAILED_STEP_STATUSES.has(step.status));
  return {
    failedStepCount: failed.length,
    failedSteps: failed.slice(0, MAX_FAILED_STEPS).map(step => {
      const message = step.message
        ? cleanMessage(step.message, MAX_STEP_MESSAGE_LENGTH)
        : "";
      return {
        name: truncateText(step.name, MAX_NAME_LENGTH),
        resourceType: step.resourceType,
        status: step.status,
        ...(message ? { message } : {}),
      };
    }),
  };
}

/** Link to a job run in the app. The job tab selects the run from `run`. */
export function dbtRunDeepLink(params: {
  baseUrl: string;
  projectId: string;
  jobId: string;
  runId?: string;
}): string | undefined {
  if (!params.baseUrl) return undefined;
  const base = params.baseUrl.replace(/\/+$/, "");
  const run = params.runId ? `?run=${encodeURIComponent(params.runId)}` : "";
  return `${base}/x/${params.projectId}/job/${params.jobId}${run}`;
}

export function formatDurationShort(ms: number | undefined): string {
  if (ms === undefined || ms === null || Number.isNaN(ms)) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds} s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds ? `${minutes} min ${seconds} s` : `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
}

export function runTriggerLabel(
  triggerType: NotificationOutboundPayload["triggerType"],
): string {
  if (triggerType === "schedule") return "Scheduled run";
  if (triggerType === "manual") return "Manual run";
  if (triggerType === "agent") return "Agent run";
  return "Run";
}

/** "failed", "recovered" or "succeeded" for a dbt job payload. */
export function dbtOutcomeWord(
  payload: Pick<NotificationOutboundPayload, "trigger" | "recovered">,
): string {
  if (payload.trigger === "failure") return "failed";
  return payload.recovered ? "recovered" : "succeeded";
}

/** One line under the headline: what failed, how it ran, how long. */
export function dbtSummaryLine(payload: NotificationOutboundPayload): string {
  const parts: string[] = [];
  if (payload.trigger === "failure") {
    const count = payload.failedStepCount ?? 0;
    if (count > 0) {
      parts.push(`${count} ${count === 1 ? "step" : "steps"} failed`);
    }
    parts.push(runTriggerLabel(payload.triggerType));
  } else {
    parts.push(
      payload.recovered
        ? `${runTriggerLabel(payload.triggerType)} succeeded after a failed run`
        : `${runTriggerLabel(payload.triggerType)} succeeded`,
    );
  }
  const duration = formatDurationShort(payload.durationMs);
  if (duration) parts.push(duration);
  return parts.join(" · ");
}

export function failedStepLabel(step: RunFailedStep): string {
  return `${step.name} (${step.resourceType}, ${step.status})`;
}

/** Steps cut from the list, so the reader knows the list is partial. */
export function hiddenFailedStepCount(
  payload: Pick<NotificationOutboundPayload, "failedSteps" | "failedStepCount">,
): number {
  return Math.max(
    0,
    (payload.failedStepCount ?? 0) - (payload.failedSteps?.length ?? 0),
  );
}

/** Slack reads &, < and > as control characters in mrkdwn. */
export function escapeSlackText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Slack mrkdwn for a dbt job run: outcome first, then the failing steps. */
export function buildDbtSlackText(
  payload: NotificationOutboundPayload,
): string {
  const environment = payload.environment
    ? ` (${escapeSlackText(payload.environment)})`
    : "";
  const lines: string[] = [
    `*dbt job ${dbtOutcomeWord(payload)}: ${escapeSlackText(payload.resourceName)}*${environment}`,
    escapeSlackText(dbtSummaryLine(payload)),
  ];
  if (payload.trigger === "failure") {
    for (const step of payload.failedSteps ?? []) {
      const message = step.message ? `: ${escapeSlackText(step.message)}` : "";
      lines.push(`• \`${escapeSlackText(failedStepLabel(step))}\`${message}`);
    }
    const hidden = hiddenFailedStepCount(payload);
    if (hidden > 0) lines.push(`…and ${hidden} more`);
    if (payload.errorMessage && (payload.failedSteps?.length ?? 0) === 0) {
      lines.push(`Error: ${escapeSlackText(payload.errorMessage)}`);
    }
  }
  const link = payload.deepLink
    ? `<${payload.deepLink}|Open the run in Mako>`
    : "";
  const body = truncateText(
    lines.join("\n"),
    MAX_SLACK_TEXT_LENGTH - link.length - 1,
  );
  return link ? `${body}\n${link}` : body;
}
