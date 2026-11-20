/** Who may join and what leaks out: domain auto-join and link previews. */
import { createRoute } from "@hono/zod-openapi";
import { unifiedAuthMiddleware } from "../../auth/unified-auth.middleware";
import { workspaceService } from "../../services/workspace.service";
import {
  requireWorkspace,
  requireWorkspaceRole,
} from "../../middleware/workspace.middleware";
import {
  Workspace,
  type IWorkspaceAutoJoin,
} from "../../database/workspace-schema";
import { normalizeAutoJoin } from "../../services/auto-join.service";
import { loggers } from "../../logging";
import {
  AUTH_SECURITY,
  OPEN_RESPONSES,
  createRouter,
} from "../../openapi/core";
import {
  AutoJoinBody,
  BigQueryByteCapBody,
  LinkPreviewsBody,
  IdParam,
} from "./schemas";
import { clearWorkspaceByteCapCache } from "../../services/workspace-byte-cap";
import { AGENT_BIGQUERY_MAX_BYTES_BILLED } from "../../config/long-running-queries";
import { fail, failFromThrown } from "../lib/respond";

const logger = loggers.workspace();

export const workspaceAccessSettingsRoutes = createRouter();

function serializeAutoJoin(autoJoin: IWorkspaceAutoJoin | null | undefined) {
  if (!autoJoin || autoJoin.domains.length === 0) return null;
  return { domains: autoJoin.domains, role: autoJoin.role };
}

// Domain auto-join — read
workspaceAccessSettingsRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/auto-join",
    tags: ["Workspaces"],
    summary: "Domain auto-join settings",
    description:
      "Email domains whose signed-in users become members on first contact " +
      "(no invitation), and the access role they get (viewer or member). " +
      "`null` when off. How someone opens a published app's link, signs in, " +
      "and is simply in (apps.md §28).",
    security: AUTH_SECURITY,
    middleware: [
      unifiedAuthMiddleware,
      requireWorkspace,
      requireWorkspaceRole(["owner", "admin"]),
    ] as const,
    request: { params: IdParam },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    const workspace = c.get("workspace");
    if (c.req.param("id") !== workspace._id.toString()) {
      return fail(c, 400, "Workspace ID mismatch");
    }
    const fresh = await workspaceService.getWorkspaceById(
      workspace._id.toString(),
    );
    return c.json({
      success: true,
      data: serializeAutoJoin(fresh?.settings?.autoJoin),
    });
  },
);

// Domain auto-join — write (an empty domain list turns it off)
workspaceAccessSettingsRoutes.openapi(
  createRoute({
    method: "put",
    path: "/{id}/auto-join",
    tags: ["Workspaces"],
    summary: "Set domain auto-join",
    security: AUTH_SECURITY,
    middleware: [
      unifiedAuthMiddleware,
      requireWorkspace,
      requireWorkspaceRole(["owner", "admin"]),
    ] as const,
    request: { params: IdParam, body: AutoJoinBody },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspace = c.get("workspace");
      const workspaceId = c.req.param("id");
      if (workspaceId !== workspace._id.toString()) {
        return fail(c, 400, "Workspace ID mismatch");
      }
      const body = c.req.valid("json");
      const normalized = normalizeAutoJoin(body);
      const rejected = body.domains
        .filter(d => d.trim() !== "")
        .filter(
          d =>
            !normalized?.domains.includes(
              d.trim().toLowerCase().replace(/^@/, ""),
            ),
        );
      if (rejected.length > 0) {
        return fail(c, 400, `Not a domain: ${rejected.join(", ")}`);
      }
      await workspaceService.setAutoJoin(workspaceId, normalized);
      logger.info("Workspace auto-join updated", {
        workspaceId,
        by: c.get("user")?.id,
        domains: normalized?.domains ?? [],
        role: normalized?.role ?? null,
      });
      return c.json({ success: true, data: serializeAutoJoin(normalized) });
    } catch (error) {
      logger.error("Error updating auto-join", { error });
      return failFromThrown(c, error, "Failed to update auto-join");
    }
  },
);

// BigQuery byte cap — read
workspaceAccessSettingsRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/bigquery-byte-cap",
    tags: ["Workspaces"],
    summary: "Byte cap on interactive BigQuery queries",
    description:
      "The most GiB one interactive BigQuery query (agent, MCP, console, notebook, binding preview) may bill. `gb` is null when unset: agent and MCP queries then carry the platform default (`defaultGb`) and consoles, notebooks and previews are uncapped; 0 means no cap. Sync, flows, dbt and published apps are never capped.",
    security: AUTH_SECURITY,
    middleware: [unifiedAuthMiddleware, requireWorkspace] as const,
    request: { params: IdParam },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    const workspace = c.get("workspace");
    if (c.req.param("id") !== workspace._id.toString()) {
      return fail(c, 400, "Workspace ID mismatch");
    }
    const fresh = await Workspace.findById(workspace._id)
      .select("settings.bigqueryMaxBytesBilledGb")
      .lean();
    return c.json({
      success: true,
      data: {
        gb: fresh?.settings?.bigqueryMaxBytesBilledGb ?? null,
        defaultGb: AGENT_BIGQUERY_MAX_BYTES_BILLED / 1024 ** 3,
      },
    });
  },
);

// BigQuery byte cap — write (owners and admins)
workspaceAccessSettingsRoutes.openapi(
  createRoute({
    method: "put",
    path: "/{id}/bigquery-byte-cap",
    tags: ["Workspaces"],
    summary: "Set the byte cap on interactive BigQuery queries",
    description:
      "gb in GiB. null clears it (the default applies). 0 turns the cap off. A connection's own agent_max_bytes_billed_gb wins over this.",
    security: AUTH_SECURITY,
    middleware: [
      unifiedAuthMiddleware,
      requireWorkspace,
      requireWorkspaceRole(["owner", "admin"]),
    ] as const,
    request: { params: IdParam, body: BigQueryByteCapBody },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    const workspace = c.get("workspace");
    if (c.req.param("id") !== workspace._id.toString()) {
      return fail(c, 400, "Workspace ID mismatch");
    }
    const { gb } = c.req.valid("json");
    await Workspace.updateOne(
      { _id: workspace._id },
      gb === null
        ? { $unset: { "settings.bigqueryMaxBytesBilledGb": "" } }
        : { $set: { "settings.bigqueryMaxBytesBilledGb": gb } },
    );
    clearWorkspaceByteCapCache(workspace._id.toString());
    logger.info("Workspace BigQuery byte cap updated", {
      workspaceId: workspace._id.toString(),
      by: c.get("user")?.id,
      gb,
    });
    return c.json({ success: true, data: { gb } });
  },
);

// In-app link previews — read
workspaceAccessSettingsRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/link-previews",
    tags: ["Workspaces"],
    summary: "In-app link previews setting",
    description:
      "Whether in-app app links (/view/<workspace>/<app>) unfurl in chat apps with the app's title, description and thumbnail. Only workspace-tree apps visible to every member ever do; default on.",
    security: AUTH_SECURITY,
    middleware: [unifiedAuthMiddleware, requireWorkspace] as const,
    request: { params: IdParam },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    const workspace = c.get("workspace");
    if (c.req.param("id") !== workspace._id.toString()) {
      return fail(c, 400, "Workspace ID mismatch");
    }
    const fresh = await Workspace.findById(workspace._id)
      .select("settings.linkPreviews")
      .lean();
    return c.json({
      success: true,
      data: { enabled: fresh?.settings?.linkPreviews !== false },
    });
  },
);

// In-app link previews — write (owners and admins)
workspaceAccessSettingsRoutes.openapi(
  createRoute({
    method: "put",
    path: "/{id}/link-previews",
    tags: ["Workspaces"],
    summary: "Turn in-app link previews on or off",
    security: AUTH_SECURITY,
    middleware: [
      unifiedAuthMiddleware,
      requireWorkspace,
      requireWorkspaceRole(["owner", "admin"]),
    ] as const,
    request: { params: IdParam, body: LinkPreviewsBody },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    const workspace = c.get("workspace");
    if (c.req.param("id") !== workspace._id.toString()) {
      return fail(c, 400, "Workspace ID mismatch");
    }
    const { enabled } = c.req.valid("json");
    await Workspace.updateOne(
      { _id: workspace._id },
      { $set: { "settings.linkPreviews": enabled } },
    );
    logger.info("Workspace link previews updated", {
      workspaceId: workspace._id.toString(),
      by: c.get("user")?.id,
      enabled,
    });
    return c.json({ success: true, data: { enabled } });
  },
);
