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

interface ReportableWorkspaceBilling {
  id: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  currentPeriodStart: string | null;
  usageQuotaUsd: number;
  plan: "free" | "pro" | "enterprise";
  lastReportedOverageCents: number;
  pendingReportedOverageCents: number | null;
  pendingMeterEventIdempotencyKey: string | null;
}

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

      return docs
        .map((ws): ReportableWorkspaceBilling | null => {
          const stripeCustomerId = ws.billing.stripeCustomerId;
          const stripeSubscriptionId = ws.billing.stripeSubscriptionId;
          if (!stripeCustomerId || !stripeSubscriptionId) {
            return null;
          }

          return {
            id: ws._id.toString(),
            stripeCustomerId,
            stripeSubscriptionId,
            currentPeriodStart:
              ws.billing.currentPeriodStart?.toISOString() ?? null,
            usageQuotaUsd: ws.billing.usageQuotaUsd,
            plan: ws.billing.plan,
            lastReportedOverageCents: ws.billing.lastReportedOverageCents ?? 0,
            pendingReportedOverageCents:
              ws.billing.pendingReportedOverageCents ?? null,
            pendingMeterEventIdempotencyKey:
              ws.billing.pendingMeterEventIdempotencyKey ?? null,
          };
        })
        .filter((ws): ws is ReportableWorkspaceBilling => ws !== null);
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
        const pendingTargetOverageCents = ws.pendingReportedOverageCents;
        let targetOverageCents = pendingTargetOverageCents;
        let meterEventIdempotencyKey = ws.pendingMeterEventIdempotencyKey;

        if (targetOverageCents == null) {
          if (overageCents <= ws.lastReportedOverageCents) {
            return "skipped" as const;
          }

          targetOverageCents = overageCents;
          meterEventIdempotencyKey = [
            "billing-overage",
            ws.id,
            periodStart.toISOString(),
            ws.lastReportedOverageCents,
            targetOverageCents,
          ].join(":");

          const claimResult = await Workspace.updateOne(
            {
              _id: new ObjectId(ws.id),
              "billing.lastReportedOverageCents": ws.lastReportedOverageCents,
              $or: [
                { "billing.pendingReportedOverageCents": null },
                { "billing.pendingReportedOverageCents": { $exists: false } },
              ],
            },
            {
              $set: {
                "billing.pendingReportedOverageCents": targetOverageCents,
                "billing.pendingMeterEventIdempotencyKey":
                  meterEventIdempotencyKey,
              },
            },
          );

          if (claimResult.modifiedCount !== 1) {
            logger.warn("Skipped usage report because overage cursor changed", {
              workspaceId: ws.id,
            });
            return "skipped" as const;
          }
        }

        const deltaCents = targetOverageCents - ws.lastReportedOverageCents;
        if (deltaCents <= 0 || !meterEventIdempotencyKey) {
          return "skipped" as const;
        }

        try {
          const stripe = new Stripe(getStripeSecretKey());

          await stripe.billing.meterEvents.create(
            {
              event_name: getStripeMeterEventName(),
              payload: {
                stripe_customer_id: ws.stripeCustomerId,
                value: String(deltaCents),
              },
              timestamp: Math.floor(Date.now() / 1000),
            },
            {
              idempotencyKey: meterEventIdempotencyKey,
            },
          );

          await Workspace.updateOne(
            {
              _id: new ObjectId(ws.id),
              "billing.pendingReportedOverageCents": targetOverageCents,
              "billing.pendingMeterEventIdempotencyKey":
                meterEventIdempotencyKey,
            },
            {
              $set: { "billing.lastReportedOverageCents": targetOverageCents },
              $unset: {
                "billing.pendingReportedOverageCents": "",
                "billing.pendingMeterEventIdempotencyKey": "",
              },
            },
          );

          logger.info("Reported usage overage to Stripe meter", {
            workspaceId: ws.id,
            totalCostUsd,
            overageUsd,
            deltaCents,
            overageCents: targetOverageCents,
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
