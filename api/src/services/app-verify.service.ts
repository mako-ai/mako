/**
 * Headless verification of an app draft — the server-side leg of the
 * cross-surface `run_app` capability.
 *
 * Extracted from api/src/mcp/preview-tools.ts so every surface can share it:
 * external MCP formats the result as MCP content there, and the in-product
 * chat agent can call it for clients with no live preview iframe (mobile,
 * detached chats). This module owns the whole verify pipeline — app lookup,
 * frontend base-URL probe, short-TTL preview-token mint, pooled headless
 * render — and returns the shared RunAppResult envelope; adapters own only
 * their wire format.
 *
 * URL construction stays in here (callers pass an appId, never a URL), so
 * the render pool cannot be steered at arbitrary targets (no SSRF surface).
 */
import type { RunAppBaseInput, RunAppResult } from "@mako/agent-tools";
import { Types } from "mongoose";

import { MakoApp } from "../database/workspace-schema";
import { mintAppPreviewToken } from "./app-preview-token.service";
import { renderAppPreview, isAppRenderEnabled } from "./app-render.service";

/** Base URL the preview page is served from (the app frontend). */
export function clientBaseUrl(): string {
  return (
    process.env.CLIENT_URL?.replace(/\/$/, "") ||
    process.env.PUBLIC_URL?.replace(/\/$/, "") ||
    "http://localhost:5173"
  );
}

/**
 * Fail fast when the frontend base URL is misconfigured. Without this a bad
 * CLIENT_URL surfaces as an opaque render timeout (or a wall of 5xx resource
 * errors) and the calling agent burns many turns diagnosing it.
 */
async function previewBaseUnreachableError(
  baseUrl: string,
): Promise<string | null> {
  try {
    const response = await fetch(baseUrl, {
      redirect: "follow",
      signal: AbortSignal.timeout(5_000),
    });
    if (response.status >= 500) {
      return (
        `Preview base URL ${baseUrl} responded with HTTP ${response.status}. ` +
        "Check the CLIENT_URL / PUBLIC_URL configuration on the API server — " +
        "the headless render loads the app frontend from there."
      );
    }
    return null;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return (
      `Preview base URL ${baseUrl} is unreachable from the API server ` +
      `(${detail}). Check the CLIENT_URL / PUBLIC_URL configuration on the ` +
      "API server — the headless render loads the app frontend from there."
    );
  }
}

function failedResult(error: string): RunAppResult {
  return {
    success: false,
    status: "error",
    errors: [],
    consoleLogs: [],
    source: "headless",
    error,
  };
}

/**
 * Render the app's current DRAFT in the pooled headless browser and report
 * status, build/runtime errors, filtered console output, and (unless
 * `includeScreenshot: false`) a JPEG screenshot. `rebuild` from the base
 * schema is accepted but moot: a headless render is always a fresh build.
 */
export async function verifyAppHeadless(
  workspaceId: string,
  { appId, width, height, timeoutMs, includeScreenshot }: RunAppBaseInput,
): Promise<RunAppResult> {
  if (!Types.ObjectId.isValid(appId)) {
    return failedResult(`Invalid app ID: ${appId}`);
  }
  const app = await MakoApp.findOne({
    _id: new Types.ObjectId(appId),
    workspaceId: new Types.ObjectId(workspaceId),
  })
    .select({ _id: 1 })
    .lean();
  if (!app) {
    return failedResult(
      `App ${appId} not found. Use list_open_apps to see available apps.`,
    );
  }

  const baseUrl = clientBaseUrl();
  if (isAppRenderEnabled()) {
    // Probe only when we will actually render (renderAppPreview reports its
    // own "rendering disabled" message otherwise).
    const unreachable = await previewBaseUnreachableError(baseUrl);
    if (unreachable) {
      return failedResult(unreachable);
    }
  }

  // Short-lived token minted per render; never returned to the caller.
  const { token } = mintAppPreviewToken({
    appId,
    workspaceId,
    ttlSeconds: 300,
  });
  const rendered = await renderAppPreview({
    url: `${baseUrl}/preview/${token}`,
    width,
    height,
    timeoutMs,
    screenshot: includeScreenshot !== false,
  });

  return {
    success: rendered.success,
    status: rendered.status,
    errors: rendered.errors,
    consoleLogs: rendered.consoleLogs,
    source: "headless",
    ...(rendered.screenshotBase64
      ? {
          screenshot: {
            mimeType: "image/jpeg",
            base64: rendered.screenshotBase64,
          },
        }
      : includeScreenshot !== false
        ? {
            screenshotUnavailableReason: isAppRenderEnabled()
              ? "The headless render did not produce a screenshot."
              : "Server-side rendering is not configured " +
                "(RENDER_APP_BROWSER_PATH is unset).",
          }
        : {}),
    ...(rendered.error ? { error: rendered.error } : {}),
  };
}
