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
        "in a browser without any login — use it to screenshot or visually " +
        "inspect the app you are building (e.g. drive it with a local " +
        "headless browser). The page can only read this one app and run its " +
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
      execute: async ({ appId, width, height, timeoutMs }) => {
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

        // Short-lived token minted per render; never returned to the caller.
        const { token } = mintAppPreviewToken({
          appId,
          workspaceId,
          ttlSeconds: 300,
        });
        const result = await renderAppPreview({
          url: `${clientBaseUrl()}/preview/${token}`,
          width,
          height,
          timeoutMs,
        });

        const summary = {
          success: result.success,
          status: result.status,
          errors: result.errors,
          consoleLogs: result.consoleLogs,
          ...(result.error ? { error: result.error } : {}),
        };
        if (!result.screenshotBase64) {
          return summary;
        }
        return {
          mcpContent: [
            { type: "text", text: JSON.stringify(summary, null, 2) },
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
