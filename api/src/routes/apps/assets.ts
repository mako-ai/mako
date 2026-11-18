/**
 * Stored images of an app: app_browse screenshots, its thumbnail and icon.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { eyesShotKey } from "../../apps/eyes.service";
import {
  resolveAppRef,
  resolveIndexedAppRef,
} from "../../apps/app-index.service";
import { getThumbnailVariant } from "../../apps/thumbnail-variants.service";
import { readThumbnailBlob, thumbnailResponse } from "../../apps/app-thumbnail";
import { boundRepoDirIfExists } from "../../apps/workspace-repo-required";
import { Readable } from "node:stream";
import { getArtifactStore } from "../../services/artifact-store.service";
import {
  AUTH_SECURITY,
  OPEN_RESPONSES,
  createRouter,
} from "../../openapi/core";
import { timed } from "../../middleware/server-timing";
import { ProjectParam, handleError, loadProject } from "./shared";
import { fail } from "../lib/respond";

export const appsAssetRoutes = createRouter();

appsAssetRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/eyes-shots/{shot}",
    tags: ["Apps"],
    summary: "A stored app_browse screenshot",
    description:
      "Screenshots the agent's browse tool captured are stored as bucket objects (never as base64 in chat history, \u00a713.26); this streams one back to anyone who can read the app.",
    security: AUTH_SECURITY,
    request: {
      params: ProjectParam.extend({
        shot: z
          .string()
          .regex(/^[a-z0-9]+\.jpg$/)
          .openapi({ param: { name: "shot", in: "path" } }),
      }),
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const loaded = await loadProject(c, { write: false });
      if ("errorResponse" in loaded) return loaded.errorResponse;
      const { shot } = c.req.valid("param");
      const key = eyesShotKey(loaded.project._id.toString(), shot);
      const store = getArtifactStore();
      const stream = await store.openReadStream(key);
      if (!stream) {
        return fail(c, 404, "Screenshot not found");
      }
      const size = await store.getSize(key);
      return new Response(
        Readable.toWeb(stream as Readable) as ReadableStream,
        {
          status: 200,
          headers: {
            "Content-Type": "image/jpeg",
            ...(size !== null ? { "Content-Length": String(size) } : {}),
            "Cache-Control": "private, max-age=31536000, immutable",
          },
        },
      );
    } catch (error) {
      return handleError(c, error);
    }
  },
);

appsAssetRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/thumbnail",
    tags: ["Apps"],
    summary: "The app's own thumbnail image",
    description:
      "The image the app ships at its root (thumbnail.png, or .webp/.jpg/.jpeg/.svg) as of main; /apps/discovery says which apps have one (and its oid, the cache version). With `w`, a raster thumbnail comes back as a WebP at most that wide (snapped to 320/480/640/960/1200, never upscaled); SVG is always the original. Private caching: immutable for a year when `v` names the current blob, revalidate (ETag by oid and width) otherwise. 404 when the app ships none. SVG is served with a script-free, sandboxed CSP.",
    security: AUTH_SECURITY,
    request: {
      params: ProjectParam,
      query: z.object({
        v: z.string().optional().openapi({
          description: "The thumbnail's blob oid (cache version).",
        }),
        w: z.string().optional().openapi({
          description:
            "Desired width in px; snapped to the nearest of 320, 480, 640, 960, 1200. Omit for the original.",
        }),
      }),
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const loaded = await loadProject(c, { write: false });
      if ("errorResponse" in loaded) return loaded.errorResponse;
      const workspaceId = loaded.project.workspaceId.toString();
      const appId = loaded.project._id.toString();
      // The persisted index first: a fresh instance must not clone the
      // mirror just to learn a blob oid the store already has a variant of.
      const row = await timed(
        "app.lookup",
        async () =>
          (await resolveIndexedAppRef(workspaceId, appId)) ??
          (await resolveAppRef(workspaceId, appId)),
      );
      const thumbnail = row?.thumbnail;
      const { v, w } = c.req.valid("query");
      const res = thumbnail
        ? await thumbnailResponse({
            thumbnail,
            v,
            w,
            ifNoneMatch: c.req.header("if-none-match"),
            read: async () => {
              const repoDir = await boundRepoDirIfExists(workspaceId);
              return repoDir ? readThumbnailBlob(repoDir, thumbnail) : null;
            },
            variant: width =>
              getThumbnailVariant(workspaceId, thumbnail, {
                kind: "width",
                width,
              }),
          })
        : null;
      if (!res) {
        return fail(c, 404, "This app has no thumbnail");
      }
      return res;
    } catch (error) {
      return handleError(c, error);
    }
  },
);

appsAssetRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/icon",
    tags: ["Apps"],
    summary: "The app's own icon (favicon)",
    description:
      "The square icon the app ships at its root (icon.svg, or icon.png) as of main: its favicon and its mark in the Apps explorer. GET /apps says which apps have one (and its oid, the cache version). Always the original bytes. Private caching: immutable for a year when `v` names the current blob, revalidate (ETag by oid) otherwise. 404 when the app ships none. SVG is served with a script-free, sandboxed CSP.",
    security: AUTH_SECURITY,
    request: {
      params: ProjectParam,
      query: z.object({
        v: z.string().optional().openapi({
          description: "The icon's blob oid (cache version).",
        }),
      }),
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const loaded = await loadProject(c, { write: false });
      if ("errorResponse" in loaded) return loaded.errorResponse;
      const workspaceId = loaded.project.workspaceId.toString();
      const appId = loaded.project._id.toString();
      const row = await timed(
        "app.lookup",
        async () =>
          (await resolveIndexedAppRef(workspaceId, appId)) ??
          (await resolveAppRef(workspaceId, appId)),
      );
      const icon = row?.icon;
      const { v } = c.req.valid("query");
      // Same serving as a thumbnail (immutable by oid, inert SVG), minus the
      // resizing: an icon is a few hundred bytes.
      const res = icon
        ? await thumbnailResponse({
            thumbnail: icon,
            v,
            ifNoneMatch: c.req.header("if-none-match"),
            read: async () => {
              const repoDir = await boundRepoDirIfExists(workspaceId);
              return repoDir ? readThumbnailBlob(repoDir, icon) : null;
            },
          })
        : null;
      if (!res) {
        return fail(c, 404, "This app has no icon");
      }
      return res;
    } catch (error) {
      return handleError(c, error);
    }
  },
);
