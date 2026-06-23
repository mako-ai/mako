/**
 * Shared cron schedule presets used by the flow scheduling UIs
 * (`DbFlowForm`, `ScheduledFlowForm`, ...). Keeping a single source of truth
 * means changing a label or cadence only happens once.
 */
export interface SchedulePreset {
  label: string;
  cron: string;
}

export const SCHEDULE_PRESETS: SchedulePreset[] = [
  { label: "Every 5 minutes", cron: "*/5 * * * *" },
  { label: "Every 15 minutes", cron: "*/15 * * * *" },
  { label: "Every 30 minutes", cron: "*/30 * * * *" },
  { label: "Hourly", cron: "0 * * * *" },
  { label: "Every 6 hours", cron: "0 */6 * * *" },
  { label: "Daily at midnight", cron: "0 0 * * *" },
  { label: "Daily at 6 AM", cron: "0 6 * * *" },
  { label: "Weekly on Sunday", cron: "0 0 * * 0" },
  { label: "Monthly on 1st", cron: "0 0 1 * *" },
];
