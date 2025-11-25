import { Hono } from "hono";
import fs from "fs";
import path from "path";

// Router to serve connector icon SVGs
export const connectorIconRoutes = new Hono();

// GET /api/connectors/:type/icon.svg - return SVG icon for connector type
connectorIconRoutes.get("/:type/icon.svg", async c => {
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
