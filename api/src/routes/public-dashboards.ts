/**
 * Intentionally public routes — no auth middleware.
 * Mounted at /api/public/dashboards
 */
import fs, { promises as fsPromises } from "fs";
import { Hono } from "hono";
import { loggers } from "../logging";
import { Dashboard } from "../database/workspace-schema";
import {
  embedPayloadFromPublishedSnapshot,
  hashDashboardShareToken,
  type DashboardPublishedSnapshotDoc,
} from "../services/dashboard-publish.service";
import {
  getDashboardArtifactStore,
  getDashboardArtifactStoreType,
  getFilesystemArtifactPath,
} from "../services/dashboard-artifact-store.service";

const logger = loggers.api("public-dashboards");
const app = new Hono();

function nodeStreamToWeb(
  nodeStream: NodeJS.ReadableStream,
): ReadableStream<Uint8Array> {
  let closed = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      nodeStream.on("data", (chunk: Buffer) => {
        if (!closed) {
          controller.enqueue(new Uint8Array(chunk));
          if (controller.desiredSize !== null && controller.desiredSize <= 0) {
            (
              nodeStream as NodeJS.ReadableStream & { pause?: () => void }
            ).pause?.();
          }
        }
      });
      nodeStream.on("end", () => {
        if (!closed) {
          closed = true;
          controller.close();
        }
      });
      nodeStream.on("error", (err: Error) => {
        if (!closed) {
          closed = true;
          controller.error(err);
        }
      });
    },
    pull() {
      (
        nodeStream as NodeJS.ReadableStream & { resume?: () => void }
      ).resume?.();
    },
    cancel() {
      closed = true;
      if ("destroy" in nodeStream && typeof nodeStream.destroy === "function") {
        (
          nodeStream as NodeJS.ReadableStream & { destroy?: () => void }
        ).destroy?.();
      }
    },
  });
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

async function findPublishedDashboardByToken(token: string) {
  const tokenHash = hashDashboardShareToken(token);
  return Dashboard.findOne({
    "published.enabled": true,
    "published.tokenHash": tokenHash,
  }).lean();
}

app.get("/:token", async c => {
  try {
    const token = c.req.param("token");
    const doc = await findPublishedDashboardByToken(token);
    if (!doc?.published?.snapshot) {
      return c.json({ success: false, error: "Dashboard not found" }, 404);
    }
    const snapshot = doc.published
      .snapshot as unknown as DashboardPublishedSnapshotDoc;
    const data = embedPayloadFromPublishedSnapshot(snapshot, token);
    return c.json({ success: true, data });
  } catch (error) {
    logger.error("Failed to load public dashboard", { error });
    return c.json(
      {
        success: false,
        error: "Dashboard not found",
      },
      404,
    );
  }
});

app.get("/:token/artifacts/:dataSourceId", async c => {
  try {
    const token = c.req.param("token");
    const dataSourceId = c.req.param("dataSourceId");
    const doc = await findPublishedDashboardByToken(token);
    if (!doc?.published?.snapshot) {
      return c.json({ success: false, error: "Dashboard not found" }, 404);
    }
    const snapshot = doc.published
      .snapshot as unknown as DashboardPublishedSnapshotDoc;
    const artifact = snapshot.artifacts?.find(
      a => a.dataSourceId === dataSourceId,
    );
    if (!artifact?.artifactKey) {
      return c.json({ success: false, error: "Dashboard not found" }, 404);
    }

    const requestRevision = c.req.query("rev");
    const isRevisionedRequest =
      !!requestRevision &&
      !!artifact.artifactRevision &&
      requestRevision === artifact.artifactRevision;

    const store = getDashboardArtifactStore();

    if (getDashboardArtifactStoreType() === "filesystem") {
      const filePath = getFilesystemArtifactPath(artifact.artifactKey);
      let stat;
      try {
        stat = await fsPromises.stat(filePath);
      } catch {
        return c.json({ success: false, error: "Dashboard not found" }, 404);
      }

      const rangeHeader = c.req.header("range");
      const cacheControl = isRevisionedRequest
        ? "public, max-age=86400, immutable"
        : "public, no-store";
      const headers: Record<string, string> = {
        "Content-Type": "application/vnd.apache.parquet",
        "Accept-Ranges": "bytes",
        "Cache-Control": cacheControl,
      };

      if (!rangeHeader) {
        headers["Content-Length"] = String(stat.size);
        headers["X-Row-Count"] = String(artifact.rowCount ?? "");
        const nodeStream =
          (await store.openReadStream(artifact.artifactKey)) ||
          fs.createReadStream(filePath);
        return c.body(nodeStreamToWeb(nodeStream), 200, headers);
      }

      const range = parseRangeHeader(rangeHeader, stat.size);
      if (!range) {
        return c.text("Invalid range", 416);
      }

      headers["Content-Range"] =
        `bytes ${range.start}-${range.end}/${stat.size}`;
      headers["Content-Length"] = String(range.end - range.start + 1);
      headers["X-Row-Count"] = String(artifact.rowCount ?? "");
      return c.body(
        nodeStreamToWeb(
          fs.createReadStream(filePath, {
            start: range.start,
            end: range.end,
          }),
        ),
        206,
        headers,
      );
    }

    const stream = await store.openReadStream(artifact.artifactKey);
    if (stream) {
      const cacheControl = isRevisionedRequest
        ? "public, max-age=86400, immutable"
        : "public, no-store";
      const headers: Record<string, string> = {
        "Content-Type": "application/vnd.apache.parquet",
        "Cache-Control": cacheControl,
        "X-Row-Count": String(artifact.rowCount ?? ""),
      };

      const size =
        artifact.byteSize ?? (await store.getSize(artifact.artifactKey));
      if (size) {
        headers["Content-Length"] = String(size);
      }

      return c.body(nodeStreamToWeb(stream), 200, headers);
    }

    return c.json({ success: false, error: "Dashboard not found" }, 404);
  } catch (error) {
    logger.error("Failed to stream public dashboard artifact", { error });
    return c.json(
      {
        success: false,
        error: "Dashboard not found",
      },
      404,
    );
  }
});

export const publicDashboardRoutes = app;
