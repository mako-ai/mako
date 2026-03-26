/**
 * Billing Routes
 *
 * Workspace-scoped endpoints for subscription management.
 * Mounted at /api/workspaces/:workspaceId/billing
 *
 * When BILLING_ENABLED is false, all endpoints return a "billing disabled" response.
 */

import { Hono } from "hono";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { AuthenticatedContext } from "../middleware/workspace.middleware";
import { workspaceService } from "../services/workspace.service";
import { Workspace } from "../database/workspace-schema";
import { User } from "../database/schema";
import { isBillingEnabled } from "../billing/config";
import {
  createCheckoutSession,
  createPortalSession,
  getBillingStatus,
} from "../billing/billing.service";
import { loggers, enrichContextWithWorkspace } from "../logging";

const logger = loggers.api("billing");

export const billingRoutes = new Hono();

billingRoutes.use("*", unifiedAuthMiddleware);

billingRoutes.use("*", async (c: AuthenticatedContext, next) => {
  const workspaceId = c.req.param("workspaceId");
  if (!workspaceId) return c.json({ error: "Missing workspaceId" }, 400);

  const user = c.get("user");
  const workspace = c.get("workspace");

  if (workspace) {
    if (workspace._id.toString() !== workspaceId) {
      return c.json(
        { error: "API key not authorized for this workspace" },
        403,
      );
    }
  } else if (user) {
    const hasAccess = await workspaceService.hasAccess(workspaceId, user.id);
    if (!hasAccess) {
      return c.json({ error: "Access denied" }, 403);
    }
  } else {
    return c.json({ error: "Unauthorized" }, 401);
  }

  enrichContextWithWorkspace(workspaceId);
  await next();
});

/**
 * GET /status -- current billing plan, usage, and subscription info
 */
billingRoutes.get("/status", async (c: AuthenticatedContext) => {
  const workspaceId = c.req.param("workspaceId")!;

  if (!isBillingEnabled()) {
    return c.json({
      billingEnabled: false,
      plan: "pro",
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
    return c.json({ error: "Internal server error" }, 500);
  }
});

/**
 * POST /checkout -- create a Stripe Checkout Session for Pro upgrade
 * Body: { successUrl: string, cancelUrl: string }
 */
billingRoutes.post("/checkout", async (c: AuthenticatedContext) => {
  if (!isBillingEnabled()) {
    return c.json({ error: "Billing is not enabled" }, 400);
  }

  const user = c.get("user");
  if (!user) {
    return c.json({ error: "Session auth required for checkout" }, 401);
  }

  const workspaceId = c.req.param("workspaceId")!;

  let body: { successUrl?: string; cancelUrl?: string } = {};
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid request body" }, 400);
  }

  const clientUrl = process.env.CLIENT_URL || "http://localhost:5173";
  const successUrl = body.successUrl || `${clientUrl}/settings?billing=success`;
  const cancelUrl = body.cancelUrl || `${clientUrl}/settings?billing=cancel`;

  try {
    const workspace = await Workspace.findById(workspaceId);
    if (!workspace) {
      return c.json({ error: "Workspace not found" }, 404);
    }

    if (
      workspace.billing?.plan === "pro" &&
      workspace.billing?.subscriptionStatus === "active"
    ) {
      return c.json({ error: "Workspace already has an active Pro plan" }, 400);
    }

    const userDoc = await User.findById(user.id);
    const email = userDoc?.email || "";

    const url = await createCheckoutSession(
      workspace,
      email,
      successUrl,
      cancelUrl,
    );

    return c.json({ url });
  } catch (err) {
    logger.error("Error creating checkout session", { error: err });
    return c.json({ error: "Failed to create checkout session" }, 500);
  }
});

/**
 * POST /portal -- create a Stripe Customer Portal session
 * Body: { returnUrl?: string }
 */
billingRoutes.post("/portal", async (c: AuthenticatedContext) => {
  if (!isBillingEnabled()) {
    return c.json({ error: "Billing is not enabled" }, 400);
  }

  const user = c.get("user");
  if (!user) {
    return c.json({ error: "Session auth required for portal" }, 401);
  }

  const workspaceId = c.req.param("workspaceId")!;

  let body: { returnUrl?: string } = {};
  try {
    body = await c.req.json();
  } catch {
    // ok, use default
  }

  const clientUrl = process.env.CLIENT_URL || "http://localhost:5173";
  const returnUrl = body.returnUrl || `${clientUrl}/settings`;

  try {
    const workspace = await Workspace.findById(workspaceId);
    if (!workspace) {
      return c.json({ error: "Workspace not found" }, 404);
    }

    const userDoc = await User.findById(user.id);
    const email = userDoc?.email || "";

    const url = await createPortalSession(workspace, email, returnUrl);

    return c.json({ url });
  } catch (err) {
    logger.error("Error creating portal session", { error: err });
    return c.json({ error: "Failed to create portal session" }, 500);
  }
});
