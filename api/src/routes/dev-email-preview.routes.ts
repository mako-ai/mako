/**
 * Dev-only HTML previews for transactional emails (no auth).
 * Mounted from index.ts when NODE_ENV !== "production".
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { RunNotificationTemplate } from "../emails/RunNotificationEmail";
import type { NotificationOutboundPayload } from "../services/flow-run-notification.types";
import { renderEmail } from "../emails/render";

const devEmailPreviewRoutes = new Hono();

/**
 * Resolve the local PNG that the prod email URL points at, so the browser
 * preview shows the real logo even before the asset is deployed to
 * `app.mako.ai`. Falls back to leaving the URL untouched if the file isn't
 * found (e.g. running the API outside the monorepo layout).
 */
function inlineLogoForPreview(html: string): string {
  const candidates = [
    join(process.cwd(), "app", "public", "email", "mako-logo.png"),
    join(process.cwd(), "..", "app", "public", "email", "mako-logo.png"),
    join(process.cwd(), "public", "email", "mako-logo.png"),
  ];
  const localPath = candidates.find(p => existsSync(p));
  if (!localPath) return html;
  const dataUri = `data:image/png;base64,${readFileSync(localPath).toString("base64")}`;
  return html.replaceAll("https://app.mako.ai/email/mako-logo.png", dataUri);
}

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
      trigger === "failure" ? "connection timeout after 8000ms" : undefined,
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
  return c.html(inlineLogoForPreview(html));
});

export { devEmailPreviewRoutes };
