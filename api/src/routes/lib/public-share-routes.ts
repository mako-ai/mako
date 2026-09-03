/**
 * Public-link sharing management routes (dashboards + apps).
 *
 * Mounted on existing workspace-scoped routers (auth enforced upstream):
 *
 *   POST   /:id/public-share — enable { password? } (owner/admin)
 *   PATCH  /:id/public-share — { password?: string|null, rotateToken?: bool }
 *   DELETE /:id/public-share — disable + invalidate the link
 *
 * The anonymous consumption side lives in routes/public-share.ts.
 */

import crypto from "node:crypto";
import bcrypt from "bcrypt";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { loggers } from "../../logging";
import type { AuthenticatedContext } from "../../middleware/workspace.middleware";
import { canManageSharing } from "../../utils/resource-acl";
import {
  encrypt,
  decrypt,
  Dashboard,
  AppProject,
  type IPublicShare,
} from "../../database/workspace-schema";
import type { ShareableDocument } from "./collaborator-routes";
import {
  AUTH_SECURITY,
  OPEN_RESPONSES,
  pathParam,
  type AuthEnv,
} from "../../openapi/core";

const logger = loggers.api("public-share");

const ShareIdParam = z.object({
  workspaceId: pathParam("workspaceId"),
  id: pathParam("id"),
});
const EnableShareBody = {
  required: false,
  content: {
    "application/json": {
      schema: z.object({ password: z.string().optional() }),
    },
  },
};
const UpdateShareBody = {
  required: false,
  content: {
    "application/json": {
      schema: z.object({
        password: z.string().nullable().optional(),
        rotateToken: z.boolean().optional(),
        token: z.string().optional(),
        allowLiveQueries: z.boolean().optional(),
      }),
    },
  },
};

export type PublicShareDocument = ShareableDocument & {
  publicShare?: IPublicShare;
};

export interface PublicShareRouteOptions {
  resourceName: string;
  load: (c: AuthenticatedContext) => Promise<PublicShareDocument | null>;
  /** Resource display name used to build a readable share slug. */
  getTitle?: (doc: PublicShareDocument) => string | undefined;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
}

/** Tokens are resolved globally, so check both shareable collections. */
async function isShareTokenTaken(
  token: string,
  excludeId?: unknown,
): Promise<boolean> {
  const filter = { "publicShare.token": token, _id: { $ne: excludeId } };
  const [dashboard, app] = await Promise.all([
    Dashboard.exists(filter),
    AppProject.exists(filter),
  ]);
  return !!(dashboard || app);
}

/**
 * Readable share token: the plain title slug when free, with a short random
 * suffix only on conflict. Rotation always forces a suffix so the old link
 * actually stops working even when the title is unchanged.
 */
async function generateShareToken(
  title: string | undefined,
  options: { forceSuffix?: boolean; excludeId?: unknown } = {},
): Promise<string> {
  const slug = title ? slugify(title) : "";
  if (!slug) return crypto.randomBytes(8).toString("hex");
  if (
    !options.forceSuffix &&
    !(await isShareTokenTaken(slug, options.excludeId))
  ) {
    return slug;
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = `${slug}-${crypto.randomBytes(2).toString("hex")}`;
    if (!(await isShareTokenTaken(candidate, options.excludeId))) {
      return candidate;
    }
  }
  return `${slug}-${crypto.randomBytes(8).toString("hex")}`;
}

async function hashSharePassword(password: string): Promise<string> {
  const rounds = parseInt(process.env.BCRYPT_ROUNDS || "10");
  return bcrypt.hash(password, rounds);
}

export function serializePublicShare(publicShare?: IPublicShare) {
  if (!publicShare?.enabled || !publicShare.token) {
    return { enabled: false as const };
  }
  return {
    enabled: true as const,
    token: publicShare.token,
    hasPassword: !!publicShare.passwordHash,
    createdAt: publicShare.createdAt,
    allowLiveQueries: !!publicShare.allowLiveQueries,
  };
}

export function registerPublicShareRoutes(
  app: OpenAPIHono<AuthEnv>,
  options: PublicShareRouteOptions,
): void {
  const { resourceName, load, getTitle } = options;
  const tag = `${resourceName}s`;

  const guard = async (c: AuthenticatedContext) => {
    const userId = c.get("user")?.id;
    if (!userId) {
      return {
        error: c.json({ success: false, error: "Unauthorized" }, 401),
      };
    }
    const doc = await load(c);
    if (!doc) {
      return {
        error: c.json(
          { success: false, error: `${resourceName} not found` },
          404,
        ),
      };
    }
    if (!canManageSharing(doc, userId, c.get("memberRole"))) {
      return {
        error: c.json(
          {
            success: false,
            error: "Only the owner or an admin can manage public sharing",
          },
          403,
        ),
      };
    }
    return { doc, userId };
  };

  // Enable public sharing (idempotent — keeps the existing token).
  app.openapi(
    createRoute({
      method: "post",
      path: "/{id}/public-share",
      tags: [tag],
      summary: `Enable ${resourceName} public sharing`,
      security: AUTH_SECURITY,
      request: { params: ShareIdParam, body: EnableShareBody },
      responses: { ...OPEN_RESPONSES },
    }),
    async c => {
      try {
        const result = await guard(c as AuthenticatedContext);
        if (result.error) return result.error;
        const { doc, userId } = result;

        const body = await c.req.json().catch(() => ({}));
        const password =
          typeof body?.password === "string" && body.password.length > 0
            ? body.password
            : undefined;

        const existing = doc.publicShare;
        doc.publicShare = {
          enabled: true,
          token:
            existing?.token ||
            (await generateShareToken(getTitle?.(doc), {
              excludeId: doc._id,
            })),
          passwordHash: password
            ? await hashSharePassword(password)
            : (existing?.passwordHash ?? null),
          passwordEncrypted: password
            ? encrypt(password)
            : (existing?.passwordEncrypted ?? null),
          createdAt: existing?.createdAt || new Date(),
          createdBy: existing?.createdBy || userId,
          lastPublicRefreshAt: existing?.lastPublicRefreshAt,
          allowLiveQueries: existing?.allowLiveQueries ?? false,
        };
        doc.markModified("publicShare");
        await doc.save();

        return c.json({
          success: true,
          data: serializePublicShare(doc.publicShare),
        });
      } catch (error) {
        logger.error(`Error enabling public share for ${resourceName}`, {
          error,
        });
        return c.json(
          { success: false, error: "Failed to enable public sharing" },
          500,
        );
      }
    },
  );

  // Reveal the current password (owner/admin only).
  app.openapi(
    createRoute({
      method: "get",
      path: "/{id}/public-share/password",
      tags: [tag],
      summary: `Reveal ${resourceName} public-share password`,
      security: AUTH_SECURITY,
      request: { params: ShareIdParam },
      responses: { ...OPEN_RESPONSES },
    }),
    async c => {
      try {
        const result = await guard(c as AuthenticatedContext);
        if (result.error) return result.error;
        const { doc } = result;

        const encrypted = doc.publicShare?.passwordEncrypted;
        if (!doc.publicShare?.enabled || !encrypted) {
          // Includes passwords set before reveal support existed (hash only).
          return c.json({ success: true, data: { password: null } });
        }
        return c.json({
          success: true,
          data: { password: decrypt(encrypted) },
        });
      } catch (error) {
        logger.error(
          `Error revealing public share password for ${resourceName}`,
          {
            error,
          },
        );
        return c.json(
          { success: false, error: "Failed to retrieve password" },
          500,
        );
      }
    },
  );

  // Update password / rotate token.
  app.openapi(
    createRoute({
      method: "patch",
      path: "/{id}/public-share",
      tags: [tag],
      summary: `Update ${resourceName} public sharing`,
      security: AUTH_SECURITY,
      request: { params: ShareIdParam, body: UpdateShareBody },
      responses: { ...OPEN_RESPONSES },
    }),
    async c => {
      try {
        const result = await guard(c as AuthenticatedContext);
        if (result.error) return result.error;
        const { doc } = result;

        if (!doc.publicShare?.enabled) {
          return c.json(
            { success: false, error: "Public sharing is not enabled" },
            400,
          );
        }

        const body = await c.req.json().catch(() => ({}));

        if (body?.rotateToken === true) {
          doc.publicShare.token = await generateShareToken(getTitle?.(doc), {
            forceSuffix: true,
            excludeId: doc._id,
          });
        } else if (typeof body?.token === "string") {
          // Custom link name, slugified server-side.
          const requested = slugify(body.token);
          if (!requested || requested.length < 3) {
            return c.json(
              {
                success: false,
                error: "Link name must contain at least 3 letters or digits",
              },
              400,
            );
          }
          if (requested !== doc.publicShare.token) {
            if (await isShareTokenTaken(requested, doc._id)) {
              return c.json(
                { success: false, error: "This link name is already in use" },
                409,
              );
            }
            doc.publicShare.token = requested;
          }
        }
        if (typeof body?.allowLiveQueries === "boolean") {
          doc.publicShare.allowLiveQueries = body.allowLiveQueries;
        }
        // password: string sets a new password; null removes it; undefined keeps.
        if (typeof body?.password === "string" && body.password.length > 0) {
          doc.publicShare.passwordHash = await hashSharePassword(body.password);
          doc.publicShare.passwordEncrypted = encrypt(body.password);
        } else if (body?.password === null) {
          doc.publicShare.passwordHash = null;
          doc.publicShare.passwordEncrypted = null;
        }

        doc.markModified("publicShare");
        await doc.save();

        return c.json({
          success: true,
          data: serializePublicShare(doc.publicShare),
        });
      } catch (error) {
        logger.error(`Error updating public share for ${resourceName}`, {
          error,
        });
        return c.json(
          { success: false, error: "Failed to update public sharing" },
          500,
        );
      }
    },
  );

  // Disable and invalidate the link.
  app.openapi(
    createRoute({
      method: "delete",
      path: "/{id}/public-share",
      tags: [tag],
      summary: `Disable ${resourceName} public sharing`,
      security: AUTH_SECURITY,
      request: { params: ShareIdParam },
      responses: { ...OPEN_RESPONSES },
    }),
    async c => {
      try {
        const result = await guard(c as AuthenticatedContext);
        if (result.error) return result.error;
        const { doc } = result;

        doc.publicShare = undefined;
        doc.markModified("publicShare");
        await doc.save();

        return c.json({ success: true, data: { enabled: false } });
      } catch (error) {
        logger.error(`Error disabling public share for ${resourceName}`, {
          error,
        });
        return c.json(
          { success: false, error: "Failed to disable public sharing" },
          500,
        );
      }
    },
  );
}
