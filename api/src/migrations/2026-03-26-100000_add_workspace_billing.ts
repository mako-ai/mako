import { Db } from "mongodb";
import { loggers } from "../logging";
import { PLAN_DEFINITIONS } from "../billing/config";

const log = loggers.migration();

export const description =
  "Add billing subdocument to all workspaces (defaults to free plan)";

export async function up(db: Db): Promise<void> {
  const workspaces = db.collection("workspaces");

  const result = await workspaces.updateMany(
    { billing: { $exists: false } },
    {
      $set: {
        billing: {
          stripeCustomerId: null,
          stripeSubscriptionId: null,
          subscriptionStatus: null,
          currentPeriodStart: null,
          currentPeriodEnd: null,
          usageQuotaUsd: 0.5,
          hardLimitUsd: 0.5,
          plan: "free",
        },
      },
    },
  );

  log.info("Added billing subdocument to workspaces", {
    matched: result.matchedCount,
    modified: result.modifiedCount,
  });

  // Migrate any workspaces that had billingTier manually set to "pro" or "enterprise"
  for (const tier of ["pro", "enterprise"] as const) {
    const planDef = PLAN_DEFINITIONS[tier];
    const tierResult = await workspaces.updateMany(
      { "settings.billingTier": tier, "billing.plan": "free" },
      {
        $set: {
          "billing.plan": tier,
          "billing.usageQuotaUsd": planDef.usageQuotaUsd,
          "billing.hardLimitUsd": planDef.hardLimitUsd,
        },
      },
    );

    if (tierResult.modifiedCount > 0) {
      log.info(`Migrated ${tier} workspaces`, {
        modified: tierResult.modifiedCount,
      });
    }
  }
}
