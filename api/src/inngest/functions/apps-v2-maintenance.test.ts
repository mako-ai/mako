import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enabled: true,
  executor: {} as object | undefined,
  reconcileChatTurns: vi.fn(),
  sweepProvisioning: vi.fn(),
  provisioningExecutors: [] as unknown[],
  info: vi.fn(),
}));

vi.mock("../../apps-v2/config", () => ({
  isAppsV2Enabled: () => mocks.enabled,
}));

vi.mock("../../apps-v2/chat-turn-finalizer", () => ({
  reconcilePendingAppsV2ChatTurns: mocks.reconcileChatTurns,
}));

vi.mock("../../apps-v2/service-factory", () => ({
  getAppV2Services: () => ({ sessionExecutor: mocks.executor }),
}));

vi.mock("../../apps-v2/provisioning-reconcile.service", () => ({
  AppV2ProvisioningReconcileService: class {
    constructor(executor: unknown) {
      mocks.provisioningExecutors.push(executor);
    }

    sweep(limit: number) {
      return mocks.sweepProvisioning(limit);
    }
  },
}));

vi.mock("../../logging", () => ({
  loggers: {
    inngest: () => ({ info: mocks.info }),
  },
}));

import {
  appsV2MaintenanceFunction,
  reconcileAppsV2ChatTurnsMaintenance,
  reconcileAppsV2ProvisioningMaintenance,
} from "./apps-v2-maintenance";

type MaintenanceHandler = (context: {
  step: {
    run: (id: string, callback: () => Promise<unknown>) => Promise<unknown>;
  };
}) => Promise<unknown>;

const maintenanceHandler = (
  appsV2MaintenanceFunction as unknown as { fn: MaintenanceHandler }
).fn;

beforeEach(() => {
  mocks.enabled = true;
  mocks.executor = {};
  mocks.reconcileChatTurns.mockReset().mockResolvedValue([
    { turnId: "turn-reconciled", result: { status: "completed" } },
    { turnId: "turn-failed", error: "retry later" },
  ]);
  mocks.sweepProvisioning
    .mockReset()
    .mockResolvedValue({ examined: 2, cleaned: 1 });
  mocks.provisioningExecutors.length = 0;
  mocks.info.mockReset();
});

describe("Apps v2 maintenance", () => {
  it("declares an explicitly bounded five-minute cron", () => {
    expect(appsV2MaintenanceFunction.opts).toMatchObject({
      id: "apps-v2-maintenance",
      retries: 3,
      concurrency: { limit: 1, key: "event.data.cron" },
      triggers: [{ cron: "*/5 * * * *" }],
    });
  });

  it("is a no-op when Apps v2 is disabled", async () => {
    mocks.enabled = false;
    const run = vi.fn();

    await expect(maintenanceHandler({ step: { run } })).resolves.toEqual({
      skipped: true,
      reason: "apps_v2_disabled",
    });
    expect(run).not.toHaveBeenCalled();
    expect(mocks.reconcileChatTurns).not.toHaveBeenCalled();
    expect(mocks.sweepProvisioning).not.toHaveBeenCalled();
  });

  it("runs both callable reconciliation steps repeatedly", async () => {
    const stepNames: string[] = [];
    const run = vi.fn(async (id: string, callback: () => Promise<unknown>) => {
      stepNames.push(id);
      return callback();
    });

    const first = await maintenanceHandler({ step: { run } });
    const second = await maintenanceHandler({ step: { run } });

    expect(first).toEqual({
      skipped: false,
      chatTurns: { examined: 2, reconciled: 1, failed: 1 },
      provisioning: { skipped: false, examined: 2, cleaned: 1 },
    });
    expect(second).toEqual(first);
    expect(stepNames).toEqual([
      "reconcile-pending-apps-v2-chat-turns",
      "reconcile-stale-apps-v2-provisioning",
      "reconcile-pending-apps-v2-chat-turns",
      "reconcile-stale-apps-v2-provisioning",
    ]);
    expect(mocks.reconcileChatTurns).toHaveBeenCalledTimes(2);
    expect(mocks.reconcileChatTurns).toHaveBeenCalledWith({ limit: 25 });
    expect(mocks.sweepProvisioning).toHaveBeenCalledTimes(2);
    expect(mocks.sweepProvisioning).toHaveBeenCalledWith(100);
    expect(mocks.provisioningExecutors).toEqual([
      mocks.executor,
      mocks.executor,
    ]);
  });

  it("skips provisioning reconciliation without the shared executor", async () => {
    mocks.executor = undefined;

    await expect(reconcileAppsV2ProvisioningMaintenance()).resolves.toEqual({
      skipped: true,
      reason: "sandbox_provider_unavailable",
      examined: 0,
      cleaned: 0,
    });
    expect(mocks.sweepProvisioning).not.toHaveBeenCalled();
  });

  it("keeps both reconciliation entry points directly callable", async () => {
    await expect(reconcileAppsV2ChatTurnsMaintenance()).resolves.toEqual({
      examined: 2,
      reconciled: 1,
      failed: 1,
    });
    await expect(reconcileAppsV2ProvisioningMaintenance()).resolves.toEqual({
      skipped: false,
      examined: 2,
      cleaned: 1,
    });
  });
});
