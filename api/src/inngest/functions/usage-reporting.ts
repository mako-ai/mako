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
import { inngest } from "../client";
import { workspaceRepo } from "../../repositories/workspaces";
import { usageStatsRepo } from "../../repositories/usage-stats";
import {
  isBillingEnabled,
  STRIPE_BILLING_API_VERSION,
  getStripeSecretKey,
  getStripeMeterEventName,
  PLAN_DEFINITIONS,
  startOfUtcMonth,
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

const USAGE_REPORT_CHUNK = 25;

export const usageReportingFunction = inngest.createFunction(
  {
    id: "billing/usage-reporting",
    name: "Report LLM usage to Stripe meters",
    // One sweep at a time; each workspace's report is itself claimed and
    // idempotent (pending cursor + Stripe idempotency key).
    concurrency: { limit: 1 },
    retries: 3,
    triggers: { cron: "0 * * * *" },
  },
  // every hour
  async ({ step }) => {
    if (!isBillingEnabled()) {
      return { skipped: true, reason: "Billing is not enabled" };
    }

    const workspaces = await step.run("fetch-pro-workspaces", async () => {
      const docs = await workspaceRepo.listPaidActiveBilling();

      return docs
        .map((ws): ReportableWorkspaceBilling | null => {
          const stripeCustomerId = ws.billing.stripeCustomerId;
          const stripeSubscriptionId = ws.billing.stripeSubscriptionId;
          if (!stripeCustomerId || !stripeSubscriptionId) {
            return null;
          }

          return {
            id: ws.id,
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

    // Workspaces per step: one step per workspace hit Inngest's per-run
    // step limit as the paying tenant count grew. A retried chunk re-runs
    // workspaces it already reported; that is safe because each report is
    // claimed through the overage cursor and sent with an idempotency key.
    const reportWorkspace = async (
      ws: ReportableWorkspaceBilling,
    ): Promise<"reported" | "skipped"> => {
      const periodStart = ws.currentPeriodStart
        ? new Date(ws.currentPeriodStart)
        : startOfUtcMonth();

      const summary = await usageStatsRepo.getWorkspaceLlmUsageSummary(ws.id, {
        from: periodStart,
      });

      const totalCostUsd = summary.totalCostUsd;
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

        const claimed = await workspaceRepo.claimPendingOverage(
          ws.id,
          ws.lastReportedOverageCents,
          targetOverageCents,
          meterEventIdempotencyKey,
        );

        if (!claimed) {
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
        const stripe = new Stripe(getStripeSecretKey(), {
          apiVersion: STRIPE_BILLING_API_VERSION,
        });

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

        await workspaceRepo.commitPendingOverage(
          ws.id,
          targetOverageCents,
          meterEventIdempotencyKey,
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
    };

    for (let i = 0; i < workspaces.length; i += USAGE_REPORT_CHUNK) {
      const chunk = workspaces.slice(i, i + USAGE_REPORT_CHUNK);
      const results = await step.run(
        `report-usage-${i / USAGE_REPORT_CHUNK}`,
        async () => {
          const out: Array<"reported" | "skipped"> = [];
          for (const ws of chunk) out.push(await reportWorkspace(ws));
          return out;
        },
      );
      for (const result of results) {
        if (result === "reported") reported++;
        else skipped++;
      }
    }

    return { total: workspaces.length, reported, skipped };
  },
);
