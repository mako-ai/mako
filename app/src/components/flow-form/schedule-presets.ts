/** Common cron cadences offered by the flow forms' schedule pickers. */
export const SCHEDULE_PRESETS = [
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

/** The preset matching `cron`, or "__custom__" when none does. */
export function cronPresetValue(cron: string | undefined): string {
  return SCHEDULE_PRESETS.some(p => p.cron === cron)
    ? (cron as string)
    : "__custom__";
}
