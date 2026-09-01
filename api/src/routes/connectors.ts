import { createRoute, z } from "@hono/zod-openapi";
import fs from "fs";
import path from "path";

import { connectorRegistry } from "../connectors/registry";
import { isWorkspaceConnectorType } from "../connectors/workspace/SandboxedConnector";
import {
  listWorkspaceConnectors,
  workspaceConnectorForm,
} from "../connectors/workspace/catalog";
import {
  createRouter,
  errorJson,
  jsonContent,
  successEnvelope,
} from "../openapi/core";

/**
 * Connector catalog endpoints. Intentionally public (no authentication) — they
 * expose only static metadata and config-field schemas for available connectors.
 */
export const connectorRoutes = createRouter();

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
      "Returns metadata for every available connector type. Public — no authentication required.",
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

      // A workspace's own connectors are appended when the caller identifies
      // one. The route is public and unauthenticated, so an absent or unknown
      // workspace simply yields the built-in list rather than an error: this
      // must never become a way to enumerate another tenant's connectors.
      const workspaceId = c.req.header("x-workspace-id");
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
      const workspaceId = c.req.header("x-workspace-id");
      if (!workspaceId) {
        return c.json(
          {
            success: false,
            error: "A workspace connector needs a workspace context",
          },
          404,
        );
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
  c => {
    const { type } = c.req.valid("param");

    // An `<img>` carries no workspace header, so a workspace connector's own
    // icon cannot be fetched from its repo here without putting a tenant id
    // in a public URL. It gets a generated monogram instead: derived purely
    // from the slug, so it exposes nothing and still gives the picker a
    // stable, distinguishable mark per connector.
    if (isWorkspaceConnectorType(type)) {
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
