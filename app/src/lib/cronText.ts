/**
 * A workflow schedule in plain words, and when it next fires. Covers the
 * shapes schedules take (every N minutes, set times on some days); anything
 * else (a day of the month, a month) keeps its cron.
 */
import { CronExpressionParser } from "cron-parser";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MAX_TIMES = 6;

const pad = (n: number) => String(n).padStart(2, "0");

function daysText(days: number[]): string {
  const set = [...new Set(days.map(d => d % 7))].sort((a, b) => a - b);
  if (set.length === 7) return "Every day";
  if (set.join() === "1,2,3,4,5") return "Weekdays";
  if (set.join() === "0,6") return "Weekends";
  return set.map(d => DAYS[d]).join(", ");
}

/** "Weekdays at 06:10, 09:10, 12:10 UTC", or the cron when it is unusual. */
export function describeCron(cron: string): string {
  let fields;
  try {
    fields = CronExpressionParser.parse(cron, { tz: "UTC" }).fields;
  } catch {
    return cron;
  }
  const [, , dayOfMonth, month] = cron.trim().split(/\s+/);
  if (dayOfMonth !== "*" || month !== "*") return `${cron} (UTC)`;
  const days = daysText([...fields.dayOfWeek.values].map(Number));
  const hours = [...fields.hour.values].map(Number);
  const minutes = [...fields.minute.values].map(Number);
  if (hours.length === 24 && minutes.length > 1) {
    const step = minutes[1] - minutes[0];
    const even = minutes.every((m, i) => m === minutes[0] + i * step);
    if (even && 60 % step === 0) {
      return `${days}, every ${step} minutes`;
    }
  }
  if (hours.length === 24 && minutes.length === 1) {
    return `${days}, every hour at :${pad(minutes[0])}`;
  }
  const times = hours.flatMap(h => minutes.map(m => `${pad(h)}:${pad(m)}`));
  if (times.length > MAX_TIMES) {
    return `${days}, ${times.length} times a day (${times[0]} to ${times.at(-1)} UTC)`;
  }
  return `${days} at ${times.join(", ")} UTC`;
}

/** When the schedule next fires, or null when the cron does not parse. */
export function nextRunOf(cron: string, from = new Date()): Date | null {
  try {
    return CronExpressionParser.parse(cron, { tz: "UTC", currentDate: from })
      .next()
      .toDate();
  } catch {
    return null;
  }
}

/** How far away a future time is: "in 45m", "in 2h 14m", "in 3d". */
export function inTime(when: Date, now = new Date()): string {
  const minutes = Math.max(
    1,
    Math.round((when.getTime() - now.getTime()) / 60000),
  );
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `in ${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
  }
  return `in ${Math.round(hours / 24)}d`;
}
