/**
 * MCP-only preview tools — the "render" leg of the headless iteration loop.
 *
 * These are not part of the in-product agent's toolset (the in-product
 * agent has a live browser tab via run_app); they exist for external MCP
 * clients that need to see a draft render without a human tab open:
 *
 *   create_preview_token → signed short-TTL URL an agent-driven browser
 *     (e.g. Claude Code's local Playwright) can load and screenshot.
 */
import { tool } from "ai";
import { Types } from "mongoose";
import { z } from "zod";

import { MakoApp } from "../database/workspace-schema";
import {
  mintAppPreviewToken,
  DEFAULT_PREVIEW_TTL_SECONDS,
  MAX_PREVIEW_TTL_SECONDS,
} from "../services/app-preview-token.service";
import {
  renderAppPreview,
  isAppRenderEnabled,
} from "../services/app-render.service";
import type { MakoMcpContext } from "./mako-mcp-server";

function clientBaseUrl(): string {
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
        "render_app loads the app frontend from there."
      );
    }
    return null;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return (
      `Preview base URL ${baseUrl} is unreachable from the API server ` +
      `(${detail}). Check the CLIENT_URL / PUBLIC_URL configuration on the ` +
      "API server — render_app loads the app frontend from there."
    );
  }
}

const renderAppSchema = z.object({
  appId: z.string().describe("The app whose DRAFT should be rendered"),
  width: z.number().int().min(320).max(1920).optional(),
  height: z.number().int().min(320).max(1920).optional(),
  timeoutMs: z
    .number()
    .int()
    .min(5_000)
    .max(45_000)
    .optional()
    .describe("How long to wait for the app to finish rendering (ms)"),
  includeScreenshot: z
    .boolean()
    .optional()
    .describe(
      "Default true. Pass false to get status/errors/console only — much " +
        "cheaper when you just need to know whether the render succeeded.",
    ),
});

const createPreviewTokenSchema = z.object({
  appId: z.string().describe("The app whose DRAFT should be previewable"),
  ttlSeconds: z
    .number()
    .int()
    .min(60)
    .max(MAX_PREVIEW_TTL_SECONDS)
    .optional()
    .describe(
      `Token lifetime in seconds (default ${DEFAULT_PREVIEW_TTL_SECONDS}, max ${MAX_PREVIEW_TTL_SECONDS})`,
    ),
});

export function createMcpPreviewTools(context: MakoMcpContext) {
  const { workspaceId } = context;

  return {
    create_preview_token: tool({
      description:
        "Mint a signed, short-lived URL that renders the app's current DRAFT " +
        "in a browser without any login — for HEADLESS agents only (no Mako " +
        "Desktop/Chat UI). If the user is already in Mako Desktop Chat, do " +
        "NOT call this: the Desktop app tab shows the live preview after " +
        "create_app / app_write_file. Never paste preview URLs into Chat for " +
        "Desktop users. The page can only read this one app and run its " +
        "stored data bindings; it cannot modify anything. Never share the " +
        "URL: anyone holding it sees the draft and its data until expiry.",
      inputSchema: createPreviewTokenSchema,
      execute: async ({ appId, ttlSeconds }) => {
        if (!Types.ObjectId.isValid(appId)) {
          return { success: false, error: `Invalid app ID: ${appId}` };
        }
        const app = await MakoApp.findOne({
          _id: new Types.ObjectId(appId),
          workspaceId: new Types.ObjectId(workspaceId),
        })
          .select({ _id: 1, title: 1 })
          .lean();
        if (!app) {
          return {
            success: false,
            error: `App ${appId} not found. Use list_open_apps to see available apps.`,
          };
        }
        const { token, expiresAt } = mintAppPreviewToken({
          appId,
          workspaceId,
          ttlSeconds,
        });
        return {
          success: true,
          url: `${clientBaseUrl()}/preview/${token}`,
          expiresAt: expiresAt.toISOString(),
          note:
            "Open this URL in a browser to render the draft. Console lines " +
            "prefixed [mako-preview-error] carry render/build errors as JSON.",
        };
      },
    }),

    render_app: tool({
      description:
        "Render the app's current DRAFT in a server-side headless browser " +
        "and return its render status, any build/runtime errors, filtered " +
        "console output, and a screenshot. Use this after edits to verify " +
        "the app actually works — it needs no browser on your side. " +
        (isAppRenderEnabled()
          ? ""
          : "NOTE: server-side rendering is not configured on this " +
            "deployment; use create_preview_token with your own browser instead."),
      inputSchema: renderAppSchema,
      execute: async ({
        appId,
        width,
        height,
        timeoutMs,
        includeScreenshot,
      }) => {
        if (!Types.ObjectId.isValid(appId)) {
          return { success: false, error: `Invalid app ID: ${appId}` };
        }
        const app = await MakoApp.findOne({
          _id: new Types.ObjectId(appId),
          workspaceId: new Types.ObjectId(workspaceId),
        })
          .select({ _id: 1 })
          .lean();
        if (!app) {
          return {
            success: false,
            error: `App ${appId} not found. Use list_open_apps to see available apps.`,
          };
        }

        const baseUrl = clientBaseUrl();
        if (isAppRenderEnabled()) {
          // Probe only when we will actually render (renderAppPreview
          // reports its own "rendering disabled" message otherwise).
          const unreachable = await previewBaseUnreachableError(baseUrl);
          if (unreachable) {
            return { success: false, error: unreachable };
          }
        }

        // Short-lived token minted per render; never returned to the caller.
        const { token } = mintAppPreviewToken({
          appId,
          workspaceId,
          ttlSeconds: 300,
        });
        const result = await renderAppPreview({
          url: `${baseUrl}/preview/${token}`,
          width,
          height,
          timeoutMs,
          screenshot: includeScreenshot !== false,
        });

        const summary = {
          success: result.success,
          status: result.status,
          errors: result.errors,
          consoleLogs: result.consoleLogs,
          ...(result.error ? { error: result.error } : {}),
        };
        if (includeScreenshot === false || !result.screenshotBase64) {
          return summary;
        }
        return {
          mcpContent: [
            { type: "text", text: JSON.stringify(summary) },
            {
              type: "image",
              data: result.screenshotBase64,
              mimeType: "image/jpeg",
            },
          ],
        };
      },
    }),
  };
}
