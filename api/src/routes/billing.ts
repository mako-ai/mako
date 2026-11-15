/**
 * Billing Routes
 *
 * Workspace-scoped endpoints for subscription management.
 * Mounted at /api/workspaces/:workspaceId/billing
 *
 * When BILLING_ENABLED is false, all endpoints return a "billing disabled" response.
 */

import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { workspaceService } from "../services/workspace.service";
import { Workspace } from "../database/workspace-schema";
import { User } from "../database/schema";
import { isBillingEnabled } from "../billing/config";
import {
  createCheckoutSession,
  createPortalSession,
  getBillingStatus,
  PortalUnavailableError,
} from "../billing/billing.service";
import { loggers } from "../logging";
import {
  AUTH_SECURITY,
  OPEN_RESPONSES,
  STD_ERRORS,
  createRouter,
  jsonContent,
  pathParam,
  type AuthEnv,
} from "../openapi/core";
import { fail } from "./lib/respond";
import { requireWorkspaceAccess } from "./lib/workspace-access";

const logger = loggers.api("billing");

export const billingRoutes = createRouter();

const WorkspaceParam = z.object({ workspaceId: pathParam("workspaceId") });
const RedirectUrlBody = {
  required: false,
  content: {
    "application/json": {
      schema: z.object({
        successUrl: z.string().url().optional(),
        cancelUrl: z.string().url().optional(),
        returnUrl: z.string().url().optional(),
      }),
    },
  },
};
const StripeUrlResponse = jsonContent(
  z.object({ url: z.string().url() }),
  "Stripe-hosted URL to redirect the user to.",
);

billingRoutes.use("*", unifiedAuthMiddleware);

billingRoutes.use(
  "*",
  requireWorkspaceAccess({
    whenMissing: "reject",
    deniedMessage: "Access denied",
  }),
);

async function assertOwnerOrAdminBillingAccess(
  c: Context<AuthEnv>,
  workspaceId: string,
) {
  const user = c.get("user");
  if (!user) {
    return fail(c, 401, "Session auth required for billing management");
  }

  const isOwnerOrAdmin = await workspaceService.hasRole(workspaceId, user.id, [
    "owner",
    "admin",
  ]);
  if (!isOwnerOrAdmin) {
    return fail(c, 403, "Owner/admin role required");
  }

  return null;
}

/**
 * GET /status -- current billing plan, usage, and subscription info
 */
billingRoutes.openapi(
  createRoute({
    method: "get",
    path: "/status",
    tags: ["Billing"],
    summary: "Get billing status",
    security: AUTH_SECURITY,
    request: { params: WorkspaceParam },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    const workspaceId = c.req.param("workspaceId");
    if (!workspaceId) {
      return fail(c, 400, "Missing workspaceId");
    }

    if (!isBillingEnabled()) {
      return c.json({
        billingEnabled: false,
        plan: "free",
        subscriptionStatus: null,
        currentUsageUsd: 0,
        usageQuotaUsd: 0,
        hardLimitUsd: null,
        invocationCount: 0,
        totalTokens: 0,
        currentPeriodStart: null,
        currentPeriodEnd: null,
        hasStripeCustomer: false,
        hasSubscription: false,
      });
    }

    try {
      const status = await getBillingStatus(workspaceId);
      return c.json({ billingEnabled: true, ...status });
    } catch (err) {
      logger.error("Error fetching billing status", { error: err });
      return fail(c, 500, "Internal server error");
    }
  },
);

/**
 * POST /checkout -- create a Stripe Checkout Session for Pro upgrade
 * Body: { successUrl: string, cancelUrl: string }
 */
billingRoutes.openapi(
  createRoute({
    method: "post",
    path: "/checkout",
    tags: ["Billing"],
    summary: "Create a checkout session",
    security: AUTH_SECURITY,
    request: { params: WorkspaceParam, body: RedirectUrlBody },
    responses: { 200: StripeUrlResponse, ...STD_ERRORS },
  }),
  async c => {
    if (!isBillingEnabled()) {
      return fail(c, 400, "Billing is not enabled");
    }

    const workspaceId = c.req.param("workspaceId");
    if (!workspaceId) {
      return fail(c, 400, "Missing workspaceId");
    }
    const roleError = await assertOwnerOrAdminBillingAccess(c, workspaceId);
    if (roleError) {
      return roleError;
    }

    const user = c.get("user");
    if (!user) {
      return fail(c, 401, "Session auth required for checkout");
    }

    let body: { successUrl?: string; cancelUrl?: string };
    try {
      body = await c.req.json();
    } catch {
      return fail(c, 400, "Invalid request body");
    }

    const clientUrl = process.env.CLIENT_URL || "http://localhost:5173";
    const successUrl =
      body.successUrl || `${clientUrl}/settings?billing=success`;
    const cancelUrl = body.cancelUrl || `${clientUrl}/settings?billing=cancel`;

    const allowedOrigin = new URL(clientUrl).origin;
    try {
      if (new URL(successUrl).origin !== allowedOrigin) {
        return fail(c, 400, "Invalid successUrl");
      }
      if (new URL(cancelUrl).origin !== allowedOrigin) {
        return fail(c, 400, "Invalid cancelUrl");
      }
    } catch {
      return fail(c, 400, "Invalid redirect URL");
    }

    try {
      const workspace = await Workspace.findById(workspaceId);
      if (!workspace) {
        return fail(c, 404, "Workspace not found");
      }

      const subStatus = workspace.billing?.subscriptionStatus;
      if (
        workspace.billing?.plan === "pro" &&
        (subStatus === "active" || subStatus === "trialing")
      ) {
        return fail(c, 400, "Workspace already has an active Pro plan");
      }

      const userDoc = await User.findById(user.id);
      const email = userDoc?.email || "";

      const url = await createCheckoutSession(
        workspace,
        email,
        successUrl,
        cancelUrl,
      );

      return c.json({ url }, 200);
    } catch (err) {
      logger.error("Error creating checkout session", { error: err });
      return fail(c, 500, "Failed to create checkout session");
    }
  },
);

/**
 * POST /portal -- create a Stripe Customer Portal session
 * Body: { returnUrl?: string }
 */
billingRoutes.openapi(
  createRoute({
    method: "post",
    path: "/portal",
    tags: ["Billing"],
    summary: "Create a billing portal session",
    security: AUTH_SECURITY,
    request: { params: WorkspaceParam, body: RedirectUrlBody },
    responses: { 200: StripeUrlResponse, ...STD_ERRORS },
  }),
  async c => {
    if (!isBillingEnabled()) {
      return fail(c, 400, "Billing is not enabled");
    }

    const workspaceId = c.req.param("workspaceId");
    if (!workspaceId) {
      return fail(c, 400, "Missing workspaceId");
    }
    const roleError = await assertOwnerOrAdminBillingAccess(c, workspaceId);
    if (roleError) {
      return roleError;
    }

    const user = c.get("user");
    if (!user) {
      return fail(c, 401, "Session auth required for portal");
    }

    let body: { returnUrl?: string } = {};
    try {
      body = await c.req.json();
    } catch {
      // ok, use default
    }

    const clientUrl = process.env.CLIENT_URL || "http://localhost:5173";
    const returnUrl = body.returnUrl || `${clientUrl}/settings`;

    const allowedOrigin = new URL(clientUrl).origin;
    try {
      if (new URL(returnUrl).origin !== allowedOrigin) {
        return fail(c, 400, "Invalid returnUrl");
      }
    } catch {
      return fail(c, 400, "Invalid redirect URL");
    }

    try {
      const workspace = await Workspace.findById(workspaceId);
      if (!workspace) {
        return fail(c, 404, "Workspace not found");
      }

      if (!workspace.billing?.stripeCustomerId) {
        return fail(c, 400, "No billing account to manage");
      }

      const url = await createPortalSession(workspace, returnUrl);

      return c.json({ url }, 200);
    } catch (err) {
      if (err instanceof PortalUnavailableError) {
        return fail(c, 400, "No billing account to manage");
      }
      logger.error("Error creating portal session", { error: err });
      return fail(c, 500, "Failed to create portal session");
    }
  },
);
