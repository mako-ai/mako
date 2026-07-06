import { createRoute, z } from "@hono/zod-openapi";
import fs from "fs";
import path from "path";

import { connectorRegistry } from "../connectors/registry";
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

const ConnectorMetadataSchema = z
  .object({
    type: z.string(),
    name: z.string(),
    version: z.string(),
    description: z.string(),
    author: z.string().optional(),
    supportedEntities: z.array(z.string()),
    webhook: WebhookCapabilitiesSchema,
  })
  .openapi("ConnectorMetadata");

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
  c => {
    try {
      const connectors = connectorRegistry.getAllMetadata();
      return c.json(
        {
          success: true as const,
          data: connectors.map(entry => ({
            type: entry.type,
            ...entry.metadata,
          })),
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
  c => {
    const { type } = c.req.valid("param");
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
