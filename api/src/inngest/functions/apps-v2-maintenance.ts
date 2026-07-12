import { reconcilePendingAppsV2ChatTurns } from "../../apps-v2/chat-turn-finalizer";
import { isAppsV2Enabled } from "../../apps-v2/config";
import { AppV2ProvisioningReconcileService } from "../../apps-v2/provisioning-reconcile.service";
import { getAppV2Services } from "../../apps-v2/service-factory";
import { loggers } from "../../logging";
import { inngest } from "../client";

const log = loggers.inngest();
const CHAT_TURN_RECONCILIATION_LIMIT = 25;
const PROVISIONING_RECONCILIATION_LIMIT = 100;

export interface AppsV2ChatTurnMaintenanceResult {
  examined: number;
  reconciled: number;
  failed: number;
}

export interface AppsV2ProvisioningMaintenanceResult {
  skipped: boolean;
  reason?: "sandbox_provider_unavailable";
  examined: number;
  cleaned: number;
}

export async function reconcileAppsV2ChatTurnsMaintenance(): Promise<AppsV2ChatTurnMaintenanceResult> {
  const results = await reconcilePendingAppsV2ChatTurns({
    limit: CHAT_TURN_RECONCILIATION_LIMIT,
  });
  const result = {
    examined: results.length,
    reconciled: results.filter(item => item.result !== undefined).length,
    failed: results.filter(item => item.error !== undefined).length,
  };
  log.info("Reconciled pending Apps v2 chat turns", result);
  return result;
}

export async function reconcileAppsV2ProvisioningMaintenance(): Promise<AppsV2ProvisioningMaintenanceResult> {
  const executor = getAppV2Services().sessionExecutor;
  if (!executor) {
    const result = {
      skipped: true,
      reason: "sandbox_provider_unavailable" as const,
      examined: 0,
      cleaned: 0,
    };
    log.info("Skipped Apps v2 provisioning reconciliation", result);
    return result;
  }

  const sweep = await new AppV2ProvisioningReconcileService(executor).sweep(
    PROVISIONING_RECONCILIATION_LIMIT,
  );
  const result = { skipped: false, ...sweep };
  log.info("Reconciled stale Apps v2 provisioning sessions", result);
  return result;
}

export const appsV2MaintenanceFunction = inngest.createFunction(
  {
    id: "apps-v2-maintenance",
    name: "Reconcile Apps v2 maintenance",
    retries: 3,
    concurrency: {
      limit: 1,
      key: "event.data.cron",
    },
  },
  { cron: "*/5 * * * *" },
  async ({ step }) => {
    if (!isAppsV2Enabled()) {
      return { skipped: true, reason: "apps_v2_disabled" as const };
    }

    const chatTurns = await step.run(
      "reconcile-pending-apps-v2-chat-turns",
      reconcileAppsV2ChatTurnsMaintenance,
    );
    const provisioning = await step.run(
      "reconcile-stale-apps-v2-provisioning",
      reconcileAppsV2ProvisioningMaintenance,
    );

    return { skipped: false, chatTurns, provisioning };
  },
);
