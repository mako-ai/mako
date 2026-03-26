/**
 * Usage Reporting Inngest Function
 *
 * Periodically reports Pro workspace LLM usage to Stripe Meters
 * so that overage appears on the next invoice.
 *
 * Runs every hour. For each Pro workspace with a Stripe subscription,
 * aggregates LlmUsage.costUsd for the current billing period and reports
 * the total to Stripe's meter events API.
 */

import Stripe from "stripe";
import { ObjectId } from "mongodb";
import { inngest } from "../client";
import { Workspace } from "../../database/workspace-schema";
import { LlmUsage } from "../../database/schema";
import {
  isBillingEnabled,
  getStripeSecretKey,
  getStripeMeterEventName,
  PLAN_DEFINITIONS,
} from "../../billing/config";
import { loggers } from "../../logging";

const logger = loggers.inngest();

export const usageReportingFunction = inngest.createFunction(
  {
    id: "billing/usage-reporting",
    name: "Report LLM usage to Stripe meters",
  },
  { cron: "0 * * * *" }, // every hour
  async ({ step }) => {
    if (!isBillingEnabled()) {
      return { skipped: true, reason: "Billing is not enabled" };
    }

    const workspaces = await step.run("fetch-pro-workspaces", async () => {
      const docs = await Workspace.find({
        "billing.plan": { $in: ["pro", "enterprise"] },
        "billing.stripeCustomerId": { $ne: null },
        "billing.stripeSubscriptionId": { $ne: null },
        "billing.subscriptionStatus": "active",
      }).select("_id billing");

      return docs.map(ws => ({
        id: ws._id.toString(),
        stripeCustomerId: ws.billing.stripeCustomerId!,
        stripeSubscriptionId: ws.billing.stripeSubscriptionId!,
        currentPeriodStart:
          ws.billing.currentPeriodStart?.toISOString() ?? null,
        usageQuotaUsd: ws.billing.usageQuotaUsd,
        plan: ws.billing.plan,
        lastReportedOverageCents: ws.billing.lastReportedOverageCents ?? 0,
      }));
    });

    if (workspaces.length === 0) {
      return { skipped: true, reason: "No active Pro/Enterprise workspaces" };
    }

    let reported = 0;
    let skipped = 0;

    for (const ws of workspaces) {
      const result = await step.run(`report-usage-${ws.id}`, async () => {
        const periodStart = ws.currentPeriodStart
          ? new Date(ws.currentPeriodStart)
          : new Date(new Date().getFullYear(), new Date().getMonth(), 1);

        const [agg] = await LlmUsage.aggregate([
          {
            $match: {
              workspaceId: new ObjectId(ws.id),
              createdAt: { $gte: periodStart },
            },
          },
          {
            $group: {
              _id: null,
              totalCostUsd: { $sum: "$costUsd" },
            },
          },
        ]);

        const totalCostUsd = agg?.totalCostUsd ?? 0;
        const includedQuota =
          ws.usageQuotaUsd ??
          PLAN_DEFINITIONS[ws.plan as keyof typeof PLAN_DEFINITIONS]
            ?.usageQuotaUsd ??
          0;
        const overageUsd = Math.max(0, totalCostUsd - includedQuota);
        const overageCents = Math.round(overageUsd * 100);

        const deltaCents = overageCents - ws.lastReportedOverageCents;

        if (deltaCents <= 0) {
          return "skipped" as const;
        }

        try {
          const stripe = new Stripe(getStripeSecretKey(), {
            apiVersion: "2025-12-18.acacia" as Stripe.LatestApiVersion,
          });

          await stripe.billing.meterEvents.create({
            event_name: getStripeMeterEventName(),
            payload: {
              stripe_customer_id: ws.stripeCustomerId,
              value: String(deltaCents),
            },
            timestamp: Math.floor(Date.now() / 1000),
          });

          await Workspace.updateOne(
            { _id: new ObjectId(ws.id) },
            { $set: { "billing.lastReportedOverageCents": overageCents } },
          );

          logger.info("Reported usage overage to Stripe meter", {
            workspaceId: ws.id,
            totalCostUsd,
            overageUsd,
            deltaCents,
            overageCents,
          });

          return "reported" as const;
        } catch (err) {
          logger.error("Failed to report usage to Stripe meter", {
            workspaceId: ws.id,
            error: err,
          });
          return "skipped" as const;
        }
      });

      if (result === "reported") {
        reported++;
      } else {
        skipped++;
      }
    }

    return { total: workspaces.length, reported, skipped };
  },
);
