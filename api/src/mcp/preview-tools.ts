/**
 * Headless preview tools — the "verify" leg for external MCP clients.
 *
 * `run_app` is the canonical cross-surface verify capability; the actual
 * pipeline (app lookup, token mint, pooled headless render) lives in
 * api/src/services/app-verify.service.ts and is shared across surfaces —
 * this module only wraps it in the MCP wire format. Also here:
 *
 *   create_preview_token → signed short-TTL URL an agent-driven browser
 *     (e.g. Claude Code's local Playwright) can load and screenshot.
 *   render_app → deprecated alias of run_app, kept for existing clients.
 */
import {
  runAppBaseSchema,
  runAppResultToMcpContent,
  summarizeRunAppResult,
} from "@mako/agent-tools";
import { tool } from "ai";
import { Types } from "mongoose";
import { z } from "zod";

import { MakoApp } from "../database/workspace-schema";
import {
  mintAppPreviewToken,
  DEFAULT_PREVIEW_TTL_SECONDS,
  MAX_PREVIEW_TTL_SECONDS,
} from "../services/app-preview-token.service";
import { isAppRenderEnabled } from "../services/app-render.service";
import {
  clientBaseUrl,
  verifyAppHeadless,
} from "../services/app-verify.service";
import type { MakoMcpContext } from "./mako-mcp-server";

// Shared cross-surface input (width/height render the draft at that viewport
// — e.g. 390x844 for the mobile layout). `rebuild` from the base schema is
// accepted but moot here: a headless render is always a fresh build.
const renderAppSchema = runAppBaseSchema;

type RenderAppInput = z.infer<typeof renderAppSchema>;

/**
 * Shared execute for the headless verify leg. `run_app` is the canonical
 * cross-surface name (Chat iframe / mako-desktop bridge / this renderer);
 * `render_app` remains as a deprecated alias for existing MCP clients.
 */
async function executeHeadlessRender(
  workspaceId: string,
  input: RenderAppInput,
) {
  const result = await verifyAppHeadless(workspaceId, input);
  if (!result.screenshot) {
    return summarizeRunAppResult(result);
  }
  return { mcpContent: runAppResultToMcpContent(result) };
}

/**
 * Headless adapter for the canonical `run_app` capability: external MCP
 * clients get the same tool name Chat and Desktop use, backed by the
 * server-side renderer. Registered in the MCP candidate set; the bridge
 * policy omits it for Desktop ACP (mako-desktop provides `run_app` there).
 */
export function createHeadlessRunAppTool(context: MakoMcpContext) {
  const { workspaceId } = context;
  return {
    run_app: tool({
      description:
        "Verify the app: render its current DRAFT in a server-side headless " +
        "browser and return render status, build/runtime errors, filtered " +
        "console output, and a screenshot. Use after edits to confirm the " +
        "app actually works — no browser needed on your side. " +
        (isAppRenderEnabled()
          ? ""
          : "NOTE: server-side rendering is not configured on this " +
            "deployment; use create_preview_token with your own browser instead."),
      inputSchema: renderAppSchema,
      execute: (input: RenderAppInput) =>
        executeHeadlessRender(workspaceId, input),
    }),
  };
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
        "DEPRECATED alias of run_app — call run_app instead (same inputs, " +
        "same result). Renders the app's current DRAFT in a server-side " +
        "headless browser and returns render status, errors, console " +
        "output, and a screenshot.",
      inputSchema: renderAppSchema,
      execute: (input: RenderAppInput) =>
        executeHeadlessRender(workspaceId, input),
    }),
  };
}
