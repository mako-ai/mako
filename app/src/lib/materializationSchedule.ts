export interface MaterializationScheduleValue {
  enabled: boolean;
  cron: string | null;
  timezone?: string;
  dataFreshnessTtlMs?: number | null;
}

export const MATERIALIZATION_SCHEDULE_PRESETS = [
  { key: "hourly", label: "Every hour", cron: "0 * * * *" },
  { key: "every-6-hours", label: "Every 6 hours", cron: "0 */6 * * *" },
  { key: "daily", label: "Daily", cron: "0 0 * * *" },
  { key: "weekly", label: "Weekly", cron: "0 0 * * 0" },
] as const;

export function defaultMaterializationSchedule(
  enabled = false,
): MaterializationScheduleValue {
  return {
    enabled,
    cron: enabled ? "0 0 * * *" : null,
    timezone: "UTC",
  };
}

export function describeMaterializationSchedule(
  enabled: boolean,
  cron: string | null | undefined,
): string {
  if (!enabled) {
    return "Automatic materialization is disabled. Refresh manually when needed.";
  }

  const preset = MATERIALIZATION_SCHEDULE_PRESETS.find(
    item => item.cron === cron,
  );
  if (preset) {
    return `${preset.label} in UTC.`;
  }

  return cron?.trim()
    ? `Runs on cron "${cron}" in UTC.`
    : "Enter a cron expression in UTC.";
}
