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
import type { MakoMcpContext } from "./mako-mcp-server";

function clientBaseUrl(): string {
  return (
    process.env.CLIENT_URL?.replace(/\/$/, "") ||
    process.env.PUBLIC_URL?.replace(/\/$/, "") ||
    "http://localhost:5173"
  );
}

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
  };
}
