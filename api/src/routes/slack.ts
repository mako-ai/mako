/**
 * Slack OAuth for workspace notifications (bot + optional incoming-webhook install).
 * Authenticated + workspace-scoped; admin for install / disconnect / channels / token exchange.
 */
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { Types } from "mongoose";
import { generateState } from "arctic";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { SlackConnection, decrypt, type ISlackConnection } from "../database/workspace-schema";
import { enrichContextWithWorkspace, loggers } from "../logging";
import { requireWorkspaceAdmin } from "../middleware/workspace-admin.middleware";
import { AuthenticatedContext } from "../middleware/workspace.middleware";
import { workspaceService } from "../services/workspace.service";
import {
  buildSlackAuthorizeUrl,
  encodeSlackOAuthState,
  signSlackInstallTicket,
  slackOAuthConfigured,
  verifySlackInstallTicket,
  verifySlackWebhookClaim,
  type SlackInstallType,
} from "../auth/slack";
import {
  getProductionUrl,
  getRequestOrigin,
  isAllowedOrigin,
  isProduction,
} from "../auth/oauth-proxy";

const logger = loggers.api("slack");

export const slackRoutes = new Hono();

slackRoutes.get("/webhook-receive", async c => {
  try {
    const workspaceId = c.req.param("workspaceId");
    if (!workspaceId || !Types.ObjectId.isValid(workspaceId)) {
      return c.json({ success: false, error: "Invalid workspace" }, 400);
    }
    const token = c.req.query("token");
    if (!token) {
      return c.json({ success: false, error: "Missing token" }, 400);
    }
    const claim = verifySlackWebhookClaim(token);
    if (!claim || claim.workspaceId !== workspaceId) {
      return c.json({ success: false, error: "Invalid or expired token" }, 400);
    }
    const clientUrl = process.env.CLIENT_URL?.replace(/\/$/, "") || "";
    if (!clientUrl) {
      return c.json({ success: false, error: "CLIENT_URL not configured" }, 500);
    }
    const redirect = new URL(`${clientUrl}/workspace/${workspaceId}/slack-webhook-complete`);
    redirect.searchParams.set("token", token);
    return c.redirect(redirect.toString());
  } catch (error) {
    logger.error("Slack webhook-receive failed", { error });
    return c.json({ success: false, error: "Webhook receive failed" }, 500);
  }
});

slackRoutes.use("*", unifiedAuthMiddleware);

slackRoutes.use("*", async (c: AuthenticatedContext, next) => {
  const workspaceId = c.req.param("workspaceId");
  const user = c.get("user");
  const workspace = c.get("workspace");

  if (!workspaceId || !Types.ObjectId.isValid(workspaceId)) {
    return c.json({ success: false, error: "Invalid workspace ID format" }, 400);
  }

  if (!user && !workspace) {
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }

  if (workspace) {
    if (workspace._id.toString() !== workspaceId) {
      return c.json(
        { success: false, error: "API key not authorized for this workspace" },
        403,
      );
    }
  } else if (user) {
    if (!(await workspaceService.hasAccess(workspaceId, user.id))) {
      return c.json({ success: false, error: "Access denied to workspace" }, 403);
    }
  } else {
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }

  enrichContextWithWorkspace(workspaceId);
  await next();
});

function normalizeReturnTo(raw: string | undefined): string {
  if (!raw || typeof raw !== "string") return "/";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw.slice(0, 2048);
}

slackRoutes.get("/install", requireWorkspaceAdmin, async (c: AuthenticatedContext) => {
  try {
    if (!slackOAuthConfigured()) {
      return c.json(
        { success: false, error: "Slack integration is not configured" },
        503,
      );
    }

    const workspaceId = c.req.param("workspaceId");
    const sessionUser = c.get("user");

    const installRaw = c.req.query("installType");
    let installType: SlackInstallType =
      installRaw === "webhook" ? "webhook" : "bot";
    let returnTo = normalizeReturnTo(c.req.query("returnTo"));

    const productionUrl = getProductionUrl();
    if (!productionUrl) {
      return c.json(
        { success: false, error: "PRODUCTION_URL or BASE_URL must be set" },
        500,
      );
    }

    if (!isProduction(c)) {
      if (!sessionUser?.id) {
        return c.json({ success: false, error: "Unauthorized" }, 401);
      }
      const callerOrigin = getRequestOrigin(c);
      if (!isAllowedOrigin(callerOrigin)) {
        return c.json({ success: false, error: "Invalid request origin" }, 400);
      }
      const ticket = signSlackInstallTicket({
        workspaceId,
        userId: sessionUser.id,
        installType,
        returnTo,
        callerOrigin,
      });
      const target = new URL(
        `${productionUrl}/api/workspaces/${workspaceId}/slack/install`,
      );
      target.searchParams.set("ticket", ticket);
      logger.info("Slack OAuth proxy: redirecting to production with ticket", {
        workspaceId,
        installType,
      });
      return c.redirect(target.toString());
    }

    const ticketParam = c.req.query("ticket");
    let actingUserId: string;
    let callerOrigin: string;

    if (ticketParam) {
      const ticket = verifySlackInstallTicket(ticketParam);
      if (!ticket || ticket.workspaceId !== workspaceId) {
        return c.json({ success: false, error: "Invalid or expired ticket" }, 400);
      }
      if (!isAllowedOrigin(ticket.callerOrigin)) {
        return c.json({ success: false, error: "Invalid ticket origin" }, 400);
      }
      actingUserId = ticket.userId;
      callerOrigin = ticket.callerOrigin;
      installType = ticket.installType;
      returnTo = normalizeReturnTo(ticket.returnTo);
    } else {
      if (!sessionUser?.id) {
        return c.json({ success: false, error: "Unauthorized" }, 401);
      }
      actingUserId = sessionUser.id;
      const rawOrigin = c.req.query("origin");
      if (rawOrigin && !isAllowedOrigin(rawOrigin)) {
        logger.warn("Slack install: rejected untrusted origin", {
          origin: rawOrigin,
        });
        return c.json({ success: false, error: "Invalid redirect origin" }, 400);
      }
      callerOrigin =
        rawOrigin || productionUrl || getRequestOrigin(c);
      if (!isAllowedOrigin(callerOrigin)) {
        return c.json({ success: false, error: "Invalid redirect origin" }, 400);
      }
    }

    const isAdmin = await workspaceService.hasRole(workspaceId, actingUserId, [
      "owner",
      "admin",
    ]);
    if (!isAdmin) {
      return c.json({ success: false, error: "Admin access required" }, 403);
    }

    const nonce = generateState();
    const state = encodeSlackOAuthState({
      nonce,
      origin: callerOrigin,
      workspaceId,
      installType,
      returnTo,
      userId: actingUserId,
    });

    setCookie(c, "slack_oauth_nonce", nonce, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      maxAge: 60 * 10,
      sameSite: "Lax",
      path: "/",
    });

    const url = buildSlackAuthorizeUrl({ state, installType });
    return c.redirect(url);
  } catch (error) {
    logger.error("Slack install failed", { error });
    return c.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to start Slack OAuth",
      },
      500,
    );
  }
});

slackRoutes.get("/connection", async (c: AuthenticatedContext) => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const doc = await SlackConnection.findOne({
      workspaceId: new Types.ObjectId(workspaceId),
      revokedAt: { $exists: false },
    }).lean();

    if (!doc) {
      return c.json({ success: false, error: "No Slack connection" }, 404);
    }

    return c.json({
      success: true,
      connection: slackConnectionPublic(doc),
    });
  } catch (error) {
    logger.error("Slack connection GET failed", { error });
    return c.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to load connection",
      },
      500,
    );
  }
});

const channelsCache = new Map<
  string,
  { expiresAt: number; channels: SlackChannelRow[] }
>();
const CHANNELS_TTL_MS = 60_000;

export interface SlackChannelRow {
  id: string;
  name: string;
  isPrivate: boolean;
}

slackRoutes.get("/channels", requireWorkspaceAdmin, async (c: AuthenticatedContext) => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const cursor = c.req.query("cursor") || undefined;

    const cached = channelsCache.get(workspaceId);
    if (cached && Date.now() < cached.expiresAt && !cursor) {
      return c.json({
        success: true,
        channels: cached.channels,
        nextCursor: null as string | null,
      });
    }

    const conn = await SlackConnection.findOne({
      workspaceId: new Types.ObjectId(workspaceId),
      revokedAt: { $exists: false },
    }).lean();
    if (!conn) {
      return c.json(
        { success: false, error: "Connect Slack workspace first" },
        400,
      );
    }

    const token = decrypt(conn.botTokenEncrypted);

    const params = new URLSearchParams({
      types: "public_channel,private_channel",
      exclude_archived: "true",
      limit: "200",
    });
    if (cursor) params.set("cursor", cursor);

    const res = await fetch(
      `https://slack.com/api/conversations.list?${params.toString()}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    const body = (await res.json()) as {
      ok: boolean;
      channels?: Array<{
        id: string;
        name?: string;
        is_private?: boolean;
      }>;
      response_metadata?: { next_cursor?: string };
      error?: string;
    };

    if (!body.ok) {
      throw new Error(body.error || "conversations.list failed");
    }

    const rows: SlackChannelRow[] = (body.channels || [])
      .filter(ch => ch.id && ch.name)
      .map(ch => ({
        id: ch.id,
        name: ch.name as string,
        isPrivate: Boolean(ch.is_private),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    if (!cursor) {
      channelsCache.set(workspaceId, {
        expiresAt: Date.now() + CHANNELS_TTL_MS,
        channels: rows,
      });
    }

    return c.json({
      success: true,
      channels: rows,
      nextCursor: body.response_metadata?.next_cursor || null,
    });
  } catch (error) {
    logger.error("Slack channels list failed", { error });
    return c.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to list channels",
      },
      500,
    );
  }
});

slackRoutes.delete("/connection", requireWorkspaceAdmin, async (c: AuthenticatedContext) => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const doc = await SlackConnection.findOne({
      workspaceId: new Types.ObjectId(workspaceId),
      revokedAt: { $exists: false },
    });

    if (!doc) {
      return c.json({ success: false, error: "No Slack connection" }, 404);
    }

    const token = decrypt(doc.botTokenEncrypted);

    const revokeRes = await fetch("https://slack.com/api/auth.revoke", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Bearer ${token}`,
      },
      body: new URLSearchParams({ token }).toString(),
    });
    const revokeJson = (await revokeRes.json()) as { ok?: boolean };
    if (!revokeJson.ok) {
      logger.warn("Slack auth.revoke returned not ok", { workspaceId });
    }

    await SlackConnection.deleteOne({ _id: doc._id });
    channelsCache.delete(workspaceId);

    return c.json({ success: true });
  } catch (error) {
    logger.error("Slack disconnect failed", { error });
    return c.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to disconnect Slack",
      },
      500,
    );
  }
});

slackRoutes.post(
  "/exchange-webhook-token",
  requireWorkspaceAdmin,
  async (c: AuthenticatedContext) => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const body = (await c.req.json()) as { token?: string };
      const token = typeof body.token === "string" ? body.token.trim() : "";
      if (!token) {
        return c.json({ success: false, error: "token required" }, 400);
      }

      const claim = verifySlackWebhookClaim(token);
      if (!claim || claim.workspaceId !== workspaceId) {
        return c.json({ success: false, error: "Invalid or expired token" }, 400);
      }

      return c.json({
        success: true,
        slackWebhookUrl: claim.webhookUrl,
        displayLabel: claim.channelLabel,
      });
    } catch (error) {
      logger.error("Slack webhook token exchange failed", { error });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to exchange webhook token",
        },
        500,
      );
    }
  },
);

function slackConnectionPublic(doc: ISlackConnection & { _id: Types.ObjectId }) {
  return {
    id: doc._id.toString(),
    workspaceId: doc.workspaceId.toString(),
    teamId: doc.teamId,
    teamName: doc.teamName,
    botUserId: doc.botUserId,
    scopes: doc.scopes,
    installedByUserId: doc.installedByUserId,
    installedAt: doc.installedAt,
  };
}
