import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import fs from "fs";
import path from "path";
import { Types } from "mongoose";

import { connectorRegistry } from "../connectors/registry";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { workspaceService } from "../services/workspace.service";
import { isWorkspaceConnectorType } from "../connectors/workspace/SandboxedConnector";
import {
  listWorkspaceConnectors,
  workspaceConnectorForm,
} from "../connectors/workspace/catalog";
import {
  loadConnectorDefinition,
  readConnectorFolder,
} from "../connectors/workspace/resolver";
import {
  createRouter,
  errorJson,
  jsonContent,
  successEnvelope,
} from "../openapi/core";

/**
 * Connector catalog (code) endpoints. Intentionally public (no authentication)
 * — they expose only static metadata and config-field schemas for the BUILT-IN
 * connectors, which are the same for every tenant. OpenAPI tag: "Connectors".
 *
 * A workspace's own connectors are not that. Their slugs, entity names,
 * credential field names and `blockedReason` (which carries the workspace's
 * own stderr) belong to one tenant, so they are served only to a caller who
 * has authenticated AND is a member — see `memberWorkspaceId`.
 *
 * Source *connections* (credentials) live on
 * `/api/workspaces/:workspaceId/connections/sources`.
 */
export const connectorRoutes = createRouter();

/**
 * The workspace whose own connectors this caller may see, or null.
 *
 * `x-workspace-id` is a header, which means it is whatever the caller typed.
 * On an authenticated router the auth middleware settles that; here there is
 * none, so the check is done explicitly: authenticate the request the same
 * way every other route does, then require membership. A caller who fails
 * either gets the built-in catalog — the routes stay genuinely public — but
 * never another tenant's connectors.
 */
async function memberWorkspaceId(
  c: Context,
  requested = c.req.header("x-workspace-id"),
): Promise<string | null> {
  if (!requested || !Types.ObjectId.isValid(requested)) return null;

  // The middleware answers with a 401/redirect for an anonymous caller. That
  // response is deliberately discarded: this route is public, so "not signed
  // in" means "built-ins only", not "unauthorized".
  let authenticated = false;
  try {
    await unifiedAuthMiddleware(c, async () => {
      authenticated = true;
    });
  } catch {
    return null;
  }
  if (!authenticated) return null;

  // An API key is scoped to one workspace; a session is scoped to whichever
  // workspaces the user is a member of.
  const workspace = c.get("workspace") as {
    _id: { toString(): string };
  } | null;
  if (workspace) {
    return workspace._id.toString() === requested ? requested : null;
  }
  const user = c.get("user") as { id: string } | undefined;
  if (!user) return null;
  return (await workspaceService.hasAccess(requested, user.id))
    ? requested
    : null;
}

const WebhookCapabilitiesSchema = z.object({
  supported: z.boolean(),
  provisioning: z.object({
    supported: z.boolean(),
    providerLabel: z.string(),
    storesSecretAutomatically: z.boolean(),
    actionHint: z.string().optional(),
  }),
  secretHelpText: z.string().optional(),
});

const IncrementalModeSchema = z.enum([
  "native",
  "client-filter",
  "created-anchor",
  "none",
]);

const IncrementalCapabilitiesSchema = z.object({
  supported: z.boolean(),
  mode: IncrementalModeSchema,
  anchorField: z.string().optional(),
  perEntity: z
    .record(
      z.string(),
      z.object({
        mode: IncrementalModeSchema,
        anchorField: z.string().optional(),
      }),
    )
    .optional(),
  warning: z.string().optional(),
});

const ConnectorMetadataSchema = z
  .object({
    type: z.string(),
    name: z.string(),
    version: z.string(),
    description: z.string(),
    author: z.string().optional(),
    supportedEntities: z.array(z.string()),
    webhook: WebhookCapabilitiesSchema,
    incremental: IncrementalCapabilitiesSchema,
  })
  .openapi("ConnectorMetadata");

/**
 * What a workspace connector claims it can do, today.
 *
 * Both false on purpose. Webhooks are not part of this iteration, and an
 * incremental cursor is declared per stream in `discover`, which is not known
 * without a credential. Claiming either would let the flow form offer a sync
 * mode the connector cannot honour.
 */
const DEFAULT_WORKSPACE_WEBHOOK = {
  supported: false,
  provisioning: {
    supported: false,
    providerLabel: "Provider",
    storesSecretAutomatically: false,
  },
};

const DEFAULT_WORKSPACE_INCREMENTAL = {
  supported: false,
  mode: "none" as const,
};

/**
 * A letter mark for a connector that ships no icon.
 *
 * Deterministic from the slug: the same connector is the same colour in every
 * session and on every machine, which is what makes it usable as an
 * identifier in a list rather than decoration.
 */
function monogramSvg(slug: string): string {
  let hash = 0;
  for (const char of slug) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  const initial = (slug[0] ?? "?").toUpperCase();
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="40" height="40">`,
    `<rect width="40" height="40" rx="8" fill="hsl(${hash} 52% 46%)"/>`,
    `<text x="20" y="27" text-anchor="middle" font-family="system-ui,sans-serif"`,
    ` font-size="20" font-weight="600" fill="#fff">${initial.replace(/[<>&"]/g, "")}</text>`,
    `</svg>`,
  ].join("");
}

const TypeParam = z.object({
  type: z.string().openapi({ param: { name: "type", in: "path" } }),
});

connectorRoutes.openapi(
  createRoute({
    method: "get",
    path: "/types",
    tags: ["Connectors"],
    summary: "List connector types",
    description:
      "Returns metadata for every available connector type (code, not a credential). Public — no authentication required.",
    security: [],
    responses: {
      200: jsonContent(
        successEnvelope(z.array(ConnectorMetadataSchema)),
        "Connector type metadata.",
      ),
      500: errorJson("Internal server error"),
    },
  }),
  async c => {
    try {
      const connectors = connectorRegistry.getAllMetadata();
      const built = connectors.map(entry => ({
        type: entry.type,
        ...entry.metadata,
      }));

      // A workspace's own connectors are appended only for a member of that
      // workspace. Anyone else — anonymous, or signed in elsewhere — gets the
      // built-in list rather than an error, so the route stays public without
      // becoming a way to enumerate another tenant's connectors.
      const workspaceId = await memberWorkspaceId(c);
      const own = workspaceId
        ? await listWorkspaceConnectors(workspaceId).catch(() => [])
        : [];

      return c.json(
        {
          success: true as const,
          data: [
            ...built,
            ...own.map(entry => ({
              type: entry.type,
              name: entry.name,
              version: entry.version,
              description: entry.description,
              supportedEntities: entry.supportedEntities,
              webhook: DEFAULT_WORKSPACE_WEBHOOK,
              incremental: DEFAULT_WORKSPACE_INCREMENTAL,
            })),
          ],
        },
        200,
      );
    } catch (error) {
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        500,
      );
    }
  },
);

connectorRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{type}/schema",
    tags: ["Connectors"],
    summary: "Get connector config schema",
    description:
      "Returns the JSON schema describing a connector's configuration fields.",
    security: [],
    request: { params: TypeParam },
    responses: {
      200: jsonContent(
        successEnvelope(z.record(z.string(), z.unknown())),
        "Connector configuration schema.",
      ),
      404: errorJson("Connector or schema not found"),
    },
  }),
  async c => {
    const { type } = c.req.valid("param");

    // A workspace connector has no class to call a static method on: its form
    // is derived from the `spec` captured when it was pushed, so this stays a
    // single Mongo read and never boots a sandbox.
    if (isWorkspaceConnectorType(type)) {
      // Field names, titles and descriptions of a tenant's credential form:
      // members only. A non-member gets the same 404 as a type that does not
      // exist, so the route cannot be used to probe which workspaces have a
      // connector by a given name.
      const workspaceId = await memberWorkspaceId(c);
      if (!workspaceId) {
        return c.json({ success: false, error: "Connector not found" }, 404);
      }
      try {
        const form = await workspaceConnectorForm(workspaceId, type);
        return c.json(
          {
            success: true as const,
            data: form as unknown as Record<string, unknown>,
          },
          200,
        );
      } catch (error) {
        return c.json(
          {
            success: false,
            error:
              error instanceof Error ? error.message : "Connector not found",
          },
          404,
        );
      }
    }

    const metadata = connectorRegistry.getMetadata(type);
    if (!metadata) {
      return c.json({ success: false, error: "Connector not found" }, 404);
    }

    const connectorClass = metadata.connector as {
      getConfigSchema?: () => unknown;
    };
    const schema = connectorClass.getConfigSchema?.();
    if (!schema) {
      return c.json(
        { success: false, error: "Schema not defined for connector" },
        404,
      );
    }

    return c.json(
      { success: true as const, data: schema as Record<string, unknown> },
      200,
    );
  },
);

connectorRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{type}/icon.svg",
    tags: ["Connectors"],
    summary: "Get connector icon",
    description: "Returns the SVG icon for a connector type.",
    security: [],
    request: { params: TypeParam },
    responses: {
      200: {
        description: "SVG icon.",
        content: { "image/svg+xml": { schema: z.string() } },
      },
      304: { description: "Not modified (matched `If-None-Match`)." },
      404: errorJson("Icon not found"),
    },
  }),
  async c => {
    const { type } = c.req.valid("param");

    // `<img>` cannot send the workspace header used by catalog requests. The
    // UI therefore includes the active workspace as a query parameter; it is
    // only a selector, never authorization. Authenticate the same-origin
    // session and prove membership before reading the tenant's repo. Callers
    // without that proof retain the non-sensitive generated monogram.
    if (isWorkspaceConnectorType(type)) {
      const requested = c.req.query("workspaceId");
      const workspaceId = requested
        ? await memberWorkspaceId(c, requested)
        : null;
      if (workspaceId) {
        try {
          const slug = type.slice(3);
          const definition = await loadConnectorDefinition(workspaceId, slug);
          const files = await readConnectorFolder(
            workspaceId,
            slug,
            definition.sha,
          );
          const icon = files.get("icon.svg");
          if (icon) {
            return c.body(icon, 200, {
              "Content-Type": "image/svg+xml",
              "Cache-Control": "private, no-store",
              "Content-Security-Policy":
                "default-src 'none'; style-src 'unsafe-inline'; sandbox",
            });
          }
        } catch {
          // A missing/stale icon must not break every place that renders a
          // connector. Reconciliation will surface connector failures; the
          // image endpoint keeps the stable fallback.
        }
      }
      return c.body(monogramSvg(type.slice(3)), 200, {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "public, max-age=3600",
      });
    }

    // The type becomes a path segment, so it has to be a plain directory
    // name. Without this, `..%2f..%2fsomething` reads an icon.svg from
    // anywhere on the filesystem the process can reach.
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(type)) {
      return c.json({ success: false, error: "Icon not found" }, 404);
    }

    let iconPath = path.resolve(
      __dirname,
      "..",
      "connectors",
      type,
      "icon.svg",
    );
    if (!fs.existsSync(iconPath)) {
      iconPath = path.resolve(
        process.cwd(),
        "src",
        "connectors",
        type,
        "icon.svg",
      );
    }

    if (!fs.existsSync(iconPath)) {
      return c.json({ success: false, error: "Icon not found" }, 404);
    }

    const stat = fs.statSync(iconPath);
    const etag = `"${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}"`;

    if (c.req.header("If-None-Match") === etag) {
      return c.body(null, 304);
    }

    const svgBuffer = fs.readFileSync(iconPath);
    const isDev = process.env.NODE_ENV !== "production";
    return c.body(svgBuffer, 200, {
      "Content-Type": "image/svg+xml",
      ETag: etag,
      "Cache-Control": isDev
        ? "no-cache"
        : "public, max-age=86400, must-revalidate",
    });
  },
);
