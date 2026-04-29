import { CronExpressionParser } from "cron-parser";

export interface ScheduledConsoleScheduleInput {
  cron?: string | null;
  timezone?: string | null;
}

export interface ScheduledConsoleSchedule {
  cron: string;
  timezone: string;
}

export function normalizeScheduledConsoleSchedule(
  input?: ScheduledConsoleScheduleInput | null,
): ScheduledConsoleSchedule {
  return {
    cron: input?.cron?.trim() || "0 0 * * *",
    timezone: input?.timezone?.trim() || "UTC",
  };
}

export function validateScheduledConsoleSchedule(
  input?: ScheduledConsoleScheduleInput | null,
): ScheduledConsoleSchedule {
  const schedule = normalizeScheduledConsoleSchedule(input);

  if (!schedule.cron) {
    throw new Error("Schedule cron is required");
  }

  CronExpressionParser.parse(schedule.cron, {
    currentDate: new Date(),
    tz: schedule.timezone,
  });

  return schedule;
}

export function getNextScheduledConsoleRunAt(
  schedule: ScheduledConsoleSchedule,
  from = new Date(),
): Date {
  return CronExpressionParser.parse(schedule.cron, {
    currentDate: from,
    tz: schedule.timezone,
  })
    .next()
    .toDate();
}

export function getUpcomingScheduledConsoleRuns(
  schedule: ScheduledConsoleSchedule,
  count: number,
  from = new Date(),
): Date[] {
  const interval = CronExpressionParser.parse(schedule.cron, {
    currentDate: from,
    tz: schedule.timezone,
  });

  return Array.from({ length: count }, () => interval.next().toDate());
}
