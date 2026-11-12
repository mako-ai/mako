import type {
  NotificationChannelType,
  NotificationResourceType,
  NotificationTrigger,
} from "../database/workspace-schema";

export type RunTriggerType = "schedule" | "manual" | "agent";

/** One failed dbt model or test, bounded for transport. */
export interface RunFailedStep {
  name: string;
  /** dbt resource type: model, test, seed, snapshot. */
  resourceType: string;
  /** dbt status: error, fail, runtime error. */
  status: string;
  message?: string;
}

/** Persisted run terminal event emitted after DB commit */
export interface FlowRunTerminalEventData {
  workspaceId: string;
  resourceType: NotificationResourceType;
  resourceId: string;
  runId: string;
  /** Raw terminal status from ScheduledQueryRun, FlowExecution or DbtRun */
  status: string;
  success: boolean;
  triggerType?: RunTriggerType;
  completedAt: string;
  durationMs?: number;
  rowCount?: number;
  errorMessage?: string;
  /** dbt job runs: resolved by the emitter so fan-out needs no lookup. */
  resourceName?: string;
  /** dbt job runs: the project, so `dbt_project` rules match too. */
  projectId?: string;
  /** dbt job runs: environment name the run built into. */
  environment?: string;
  /**
   * dbt job runs: status of the previous terminal run of the same job,
   * cancelled runs ignored. Unset when this is the job's first run.
   */
  previousStatus?: "success" | "error";
  /** dbt job runs: the first failed steps, bounded in count and length. */
  failedSteps?: RunFailedStep[];
  /** dbt job runs: every failed step, including those cut from the list. */
  failedStepCount?: number;
  /** dbt job runs: link to the run in the app. */
  deepLink?: string;
  /**
   * dbt job runs: set on the one extra event sent when this failed run
   * auto-disabled its job. Failure rules get it whatever their cadence.
   */
  jobDisabled?: DbtJobDisabledInfo;
}

/** Why a dbt job stopped running on its schedule. */
export interface DbtJobDisabledInfo {
  /** Failed runs in a row, the last one included. */
  consecutiveFailures: number;
}

/** Fan-out sends one delivery job per matching rule */
export interface NotificationDeliverJobData {
  workspaceId: string;
  ruleId: string;
  resourceType: NotificationResourceType;
  resourceId: string;
  runId: string;
  trigger: NotificationTrigger;
  channelType: NotificationChannelType;
  idempotencyKey: string;
  /** Serialized snapshot for delivery (no secrets) */
  payload: NotificationOutboundPayload;
}

export interface NotificationOutboundPayload {
  version: 1;
  event: "flow.run.terminal";
  trigger: NotificationTrigger;
  resourceType: NotificationResourceType;
  resourceId: string;
  resourceName: string;
  runId: string;
  completedAt: string;
  durationMs?: number;
  rowCount?: number;
  errorMessage?: string;
  triggerType?: RunTriggerType;
  workspaceId: string;
  deepLink?: string;
  /** dbt job runs only, from here down. */
  projectId?: string;
  environment?: string;
  /** True when this success follows a failed run of the same job. */
  recovered?: boolean;
  failedSteps?: RunFailedStep[];
  failedStepCount?: number;
  /** Set when this message announces that the job was auto-disabled. */
  jobDisabled?: DbtJobDisabledInfo;
}
