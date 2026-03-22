import fs, { promises as fsPromises } from "fs";
import { Hono } from "hono";
import { Types } from "mongoose";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { AuthenticatedContext } from "../middleware/workspace.middleware";
import { workspaceService } from "../services/workspace.service";
import {
  getDashboardArtifactStoreType,
  getFilesystemArtifactPath,
} from "../services/dashboard-artifact-store.service";

const app = new Hono();

function extractWorkspaceIdFromArtifactKey(key: string): string | null {
  const match = key.match(/\/workspaces\/([^/]+)\//);
  return match?.[1] || null;
}

function parseRangeHeader(rangeHeader: string, size: number) {
  const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
  if (!match) return null;
  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || end < start || end >= size) return null;
  return { start, end };
}

app.use("*", unifiedAuthMiddleware);

app.get("/:encodedKey", async (c: AuthenticatedContext) => {
  if (getDashboardArtifactStoreType() !== "filesystem") {
    return c.json({ success: false, error: "Artifact route unavailable" }, 404);
  }

  const encodedKey = c.req.param("encodedKey");
  const artifactKey = decodeURIComponent(encodedKey);
  const workspaceId = extractWorkspaceIdFromArtifactKey(artifactKey);
  if (!workspaceId || !Types.ObjectId.isValid(workspaceId)) {
    return c.json({ success: false, error: "Invalid artifact key" }, 400);
  }

  const workspace = c.get("workspace");
  const user = c.get("user");
  if (workspace) {
    if (workspace._id.toString() !== workspaceId) {
      return c.json(
        { success: false, error: "API key not authorized for this artifact" },
        403,
      );
    }
  } else if (user) {
    const hasAccess = await workspaceService.hasAccess(workspaceId, user.id);
    if (!hasAccess) {
      return c.json({ success: false, error: "Access denied" }, 403);
    }
  } else {
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }

  const filePath = getFilesystemArtifactPath(artifactKey);
  let stat;
  try {
    stat = await fsPromises.stat(filePath);
  } catch {
    return c.json({ success: false, error: "Artifact not found" }, 404);
  }

  const rangeHeader = c.req.header("range");
  const headers: Record<string, string> = {
    "Content-Type": "application/vnd.apache.parquet",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=300",
  };

  if (!rangeHeader) {
    headers["Content-Length"] = String(stat.size);
    return c.body(fs.createReadStream(filePath) as any, 200, headers);
  }

  const range = parseRangeHeader(rangeHeader, stat.size);
  if (!range) {
    return c.text("Invalid range", 416);
  }

  headers["Content-Range"] = `bytes ${range.start}-${range.end}/${stat.size}`;
  headers["Content-Length"] = String(range.end - range.start + 1);

  return c.body(
    fs.createReadStream(filePath, {
      start: range.start,
      end: range.end,
    }) as any,
    206,
    headers,
  );
});

export const dashboardArtifactRoutes = app;
