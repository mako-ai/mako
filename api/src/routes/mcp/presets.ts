/**
 * Mounted at `/api/mcp`: the public preset catalog (static metadata that
 * drives the "Add MCP server" form, and its icons) and the OAuth callback
 * the browser lands on after consenting at the provider.
 */
import { createRoute, z } from "@hono/zod-openapi";
import fs from "node:fs";
import path from "node:path";
import { loggers } from "../../logging";
import { unifiedAuthMiddleware } from "../../auth/unified-auth.middleware";
import { AuthenticatedContext } from "../../middleware/workspace.middleware";
import { OPEN_RESPONSES, createRouter, errorJson } from "../../openapi/core";
import { MCP_PRESETS, mcpPresetEnvOAuthClient } from "../../mcp/presets";
import {
  completeMcpOAuthFlow,
  findMcpOAuthFlowServerId,
  mcpOAuthCallbackUrl,
} from "../../services/mcp-oauth.service";
import { fail } from "../lib/respond";

const logger = loggers.api("mcp");

// ---------------------------------------------------------------------------
// Preset catalog (public: static metadata, like /api/connectors/types) and
// the OAuth callback (session-authed browser redirect target).
// ---------------------------------------------------------------------------

export const mcpPresetRoutes = createRouter();

mcpPresetRoutes.openapi(
  createRoute({
    method: "get",
    path: "/presets",
    tags: ["MCP"],
    summary: "List MCP connector presets",
    responses: { ...OPEN_RESPONSES },
  }),
  c => {
    // Annotate OAuth presets with whether a deployment-wide client exists,
    // so the UI can offer one-click connect without a per-workspace app.
    const presets = Object.values(MCP_PRESETS).map(preset => ({
      ...preset,
      ...(preset.oauth
        ? {
            oauth: {
              ...preset.oauth,
              envClientConfigured: Boolean(mcpPresetEnvOAuthClient(preset)),
            },
          }
        : {}),
    }));
    // Same URL the OAuth provider must whitelist — do not derive from the
    // browser origin (preview/proxy hosts can diverge from CLIENT_URL).
    return c.json({
      success: true,
      presets,
      oauthCallbackUrl: mcpOAuthCallbackUrl(),
    });
  },
);

// Preset icons (public, static assets — same pattern as connector icons).
mcpPresetRoutes.openapi(
  createRoute({
    method: "get",
    path: "/presets/{type}/icon.svg",
    tags: ["MCP"],
    summary: "Get MCP preset icon",
    security: [],
    request: {
      params: z.object({
        type: z.string().openapi({ param: { name: "type", in: "path" } }),
      }),
    },
    responses: {
      200: {
        description: "SVG icon.",
        content: { "image/svg+xml": { schema: z.string() } },
      },
      404: errorJson("Icon not found"),
    },
  }),
  c => {
    const { type } = c.req.valid("param");
    // Only registered presets are servable — never a path traversal vector.
    if (!MCP_PRESETS[type]) {
      return fail(c, 404, "Icon not found");
    }
    // src/routes/mcp -> src/mcp/icons, and dist/routes/mcp -> dist/mcp/icons
    // (copy-build-assets.mjs copies every .svg there).
    const iconPath = path.resolve(
      __dirname,
      "..",
      "..",
      "mcp",
      "icons",
      `${type}.svg`,
    );
    if (!fs.existsSync(iconPath)) {
      return fail(c, 404, "Icon not found");
    }
    return c.body(fs.readFileSync(iconPath), 200, {
      "Content-Type": "image/svg+xml",
      "Cache-Control":
        process.env.NODE_ENV !== "production"
          ? "no-cache"
          : "public, max-age=86400, must-revalidate",
    });
  },
);

// OAuth callback — the browser lands here after consenting at the provider.
// Session-authed (cookies ride the redirect); the flow is looked up by the
// unguessable `state` and must belong to the session user.
mcpPresetRoutes.use("/oauth/callback", unifiedAuthMiddleware);
mcpPresetRoutes.openapi(
  createRoute({
    method: "get",
    path: "/oauth/callback",
    tags: ["MCP"],
    summary: "MCP OAuth authorization callback",
    request: {
      query: z.object({
        code: z.string().optional(),
        state: z.string().optional(),
        error: z.string().optional(),
        error_description: z.string().optional(),
      }),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    const { code, state, error, error_description } = c.req.query();
    const settingsUrl = "/settings/mcp";
    // Carry the server id back so the UI can reopen that server's modal and
    // auto-run discovery. Best-effort on errors (the flow may be gone).
    const redirectWith = (params: Record<string, string>) => {
      const query = new URLSearchParams(params).toString();
      return c.redirect(`${settingsUrl}?${query}`);
    };
    const flowServerId = state
      ? await findMcpOAuthFlowServerId(state).catch(() => null)
      : null;
    const serverParam: Record<string, string> = flowServerId
      ? { oauth_server: flowServerId }
      : {};
    if (error) {
      logger.warn("MCP OAuth callback returned an error", {
        error,
        error_description,
      });
      return redirectWith({
        oauth_error: error_description || error,
        ...serverParam,
      });
    }
    if (!code || !state) {
      return redirectWith({ oauth_error: "Missing code or state" });
    }
    const user = (c as AuthenticatedContext).get("user");
    if (!user) {
      return fail(c, 401, "Unauthorized");
    }
    try {
      const { serverId } = await completeMcpOAuthFlow({
        state,
        code,
        sessionUserId: user.id,
      });
      return redirectWith({ oauth_connected: "1", oauth_server: serverId });
    } catch (err) {
      logger.error("MCP OAuth callback failed", { error: err });
      const message =
        err instanceof Error ? err.message : "OAuth connection failed";
      return redirectWith({ oauth_error: message, ...serverParam });
    }
  },
);
