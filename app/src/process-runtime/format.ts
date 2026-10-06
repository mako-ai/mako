/**
 * Formatting helpers for the Processes UI (kept out of component files so
 * fast refresh keeps working).
 */
import type { TriggerSpec, WaitingOn } from "../store/processStore";

export { formatDuration } from "../utils/format";

export function waitingLabel(waitingOn: WaitingOn | null | undefined): string {
  if (!waitingOn) return "Waiting";
  switch (waitingOn.kind) {
    case "approval":
      return "Waiting for approval";
    case "task":
      return "Waiting for input";
    case "sleep":
      return "Sleeping";
    case "event":
      return `Waiting for ${waitingOn.event ?? "event"}`;
  }
}

export function formatTime(iso?: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? date.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : date.toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}

export function timeAgo(iso?: string | null): string {
  if (!iso) return "never";
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function triggerLabel(trigger: TriggerSpec): string {
  switch (trigger.type) {
    case "manual":
      return "Manual / API";
    case "event":
      return `Event: ${trigger.event}`;
    case "schedule":
      return `Schedule: ${trigger.cron}${trigger.timezone ? ` (${trigger.timezone})` : ""}`;
  }
}
