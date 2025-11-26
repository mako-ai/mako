import { Hono } from "hono";
import { connectorRegistry } from "../connectors/registry";
import fs from "fs";
import path from "path";

export const connectorRoutes = new Hono();

// GET /api/connectors/types - list all available connector types
connectorRoutes.get("/types", async c => {
  try {
    const connectors = connectorRegistry.getAllMetadata();

    return c.json({
      success: true,
      data: connectors.map(c => ({
        type: c.type,
        ...c.metadata,
      })),
    });
  } catch (error) {
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// GET /api/connectors/:type/schema - returns JSON schema for connector config fields
connectorRoutes.get("/:type/schema", async c => {
  const type = c.req.param("type");
  if (!type) {
    return c.json({ success: false, error: "Connector type is required" }, 400);
  }

  const metadata = connectorRegistry.getMetadata(type);
  if (!metadata) {
    return c.json({ success: false, error: "Connector not found" }, 404);
  }

  // Expect connector class to expose static getConfigSchema()
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  const schema = metadata.connector.getConfigSchema?.();
  if (!schema) {
    return c.json(
      { success: false, error: "Schema not defined for connector" },
      404,
    );
  }

  return c.json({ success: true, data: schema });
});

// GET /api/connectors/:type/icon.svg - return SVG icon for connector type
connectorRoutes.get("/:type/icon.svg", async c => {
  const type = c.req.param("type");

  if (!type) {
    return c.text("Connector type is required", 400);
  }

  // Try to resolve icon path relative to this file's directory first (handles compiled dist as well)
  let iconPath = path.resolve(__dirname, "..", "connectors", type, "icon.svg");

  // If not found, fallback to project root structure (when running from monorepo root)
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
    return c.text("Icon not found", 404);
  }

  const stat = fs.statSync(iconPath);
  const etag = `"${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}"`;

  // Check If-None-Match for conditional requests
  const ifNoneMatch = c.req.header("If-None-Match");
  if (ifNoneMatch === etag) {
    return c.body(null, { status: 304 });
  }

  const svgBuffer = fs.readFileSync(iconPath);
  const isDev = process.env.NODE_ENV !== "production";
  return c.body(svgBuffer, {
    headers: {
      "Content-Type": "image/svg+xml",
      ETag: etag,
      // In dev: always revalidate. In prod: cache for 1 day but allow revalidation.
      "Cache-Control": isDev
        ? "no-cache"
        : "public, max-age=86400, must-revalidate",
    },
  });
});
