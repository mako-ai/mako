export interface DashboardLogEntry {
  timestamp: number;
  level: "info" | "warn" | "error";
  message: string;
  metadata?: Record<string, unknown>;
}

export const DASHBOARD_EVENT_LOG_LIMIT = 100;
