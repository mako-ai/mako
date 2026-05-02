/**
 * Dev-only HTML previews for transactional emails (no auth).
 * Mounted from index.ts when NODE_ENV !== "production".
 */

import { Hono } from "hono";
import { RunNotificationTemplate } from "../emails/RunNotificationEmail";
import type { NotificationOutboundPayload } from "../services/flow-run-notification.types";
import { renderEmail } from "../emails/render";

const devEmailPreviewRoutes = new Hono();

function sampleRunNotificationPayload(
  trigger: "success" | "failure",
): NotificationOutboundPayload {
  const base = process.env.CLIENT_URL?.replace(/\/$/, "") || "";
  const deepLink = base
    ? `${base}/workspace/demo-workspace/console/demo-console-id`
    : undefined;

  return {
    version: 1,
    event: "flow.run.terminal",
    trigger,
    resourceType: "scheduled_query",
    resourceId: "507f1f77bcf86cd799439011",
    resourceName: "Daily revenue rollup",
    runId: "run_preview_abc123",
    completedAt: new Date().toISOString(),
    durationMs: trigger === "failure" ? 8420 : 12540,
    rowCount: trigger === "failure" ? undefined : 12840,
    errorMessage:
      trigger === "failure"
        ? "connection timeout after 8000ms"
        : undefined,
    triggerType: "schedule",
    workspaceId: "demo-workspace",
    deepLink,
  };
}

devEmailPreviewRoutes.get("/run-notification", async c => {
  const raw = c.req.query("trigger") ?? "success";
  const trigger = raw === "failure" ? "failure" : "success";
  const payload = sampleRunNotificationPayload(trigger);
  const { html } = await renderEmail(RunNotificationTemplate, payload);
  return c.html(html);
});

export { devEmailPreviewRoutes };
