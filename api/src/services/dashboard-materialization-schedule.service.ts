import { CronExpressionParser } from "cron-parser";

export interface DashboardMaterializationScheduleInput {
  enabled?: boolean;
  cron?: string | null;
  timezone?: string | null;
  dataFreshnessTtlMs?: number | null;
}

export interface DashboardMaterializationSchedule {
  enabled: boolean;
  cron: string | null;
  timezone: string;
  dataFreshnessTtlMs?: number | null;
}

export const DEFAULT_DASHBOARD_MATERIALIZATION_SCHEDULE: DashboardMaterializationSchedule =
  {
    enabled: true,
    cron: "0 0 * * *",
    timezone: "UTC",
  };

export function normalizeDashboardMaterializationSchedule(
  input?: DashboardMaterializationScheduleInput | null,
): DashboardMaterializationSchedule {
  return {
    enabled:
      input?.enabled ?? DEFAULT_DASHBOARD_MATERIALIZATION_SCHEDULE.enabled,
    cron:
      input?.cron === undefined
        ? DEFAULT_DASHBOARD_MATERIALIZATION_SCHEDULE.cron
        : input.cron,
    timezone:
      input?.timezone?.trim() ||
      DEFAULT_DASHBOARD_MATERIALIZATION_SCHEDULE.timezone,
    dataFreshnessTtlMs: input?.dataFreshnessTtlMs ?? null,
  };
}

export function validateDashboardMaterializationSchedule(
  input?: DashboardMaterializationScheduleInput | null,
): DashboardMaterializationSchedule {
  const schedule = normalizeDashboardMaterializationSchedule(input);

  if (!schedule.enabled) {
    return {
      ...schedule,
      cron: null,
    };
  }

  const cron = schedule.cron?.trim();
  if (!cron) {
    throw new Error("Materialization schedule cron is required");
  }

  CronExpressionParser.parse(cron, {
    currentDate: new Date(),
    tz: schedule.timezone,
  });

  return {
    ...schedule,
    cron,
  };
}

export function isDashboardMaterializationEnabled(
  input?: DashboardMaterializationScheduleInput | null,
): boolean {
  const schedule = normalizeDashboardMaterializationSchedule(input);
  return schedule.enabled && Boolean(schedule.cron?.trim());
}

export function isDashboardMaterializationDue(input: {
  schedule?: DashboardMaterializationScheduleInput | null;
  lastRefreshedAt?: Date | null;
  now?: Date;
}): boolean {
  const schedule = validateDashboardMaterializationSchedule(input.schedule);
  if (!schedule.enabled || !schedule.cron) {
    return false;
  }

  if (!input.lastRefreshedAt) {
    return true;
  }

  const interval = CronExpressionParser.parse(schedule.cron, {
    currentDate: input.lastRefreshedAt,
    tz: schedule.timezone,
  });
  const nextRunAt = interval.next().toDate();
  return nextRunAt.getTime() <= (input.now ?? new Date()).getTime();
}
