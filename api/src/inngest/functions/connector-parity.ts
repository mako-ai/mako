/**
 * Parity checks of boxed shadows (connectors/boxed-runtime/parity.service.ts).
 *
 * - The scheduler runs hourly and sends one check per active shadow.
 * - `flow_shadow` with `action: "check"` sends the same event on demand.
 * - One check per shadow at a time (singleton, skip): a check that is
 *   already running answers the request.
 *
 * With CONNECTOR_BOXED_SWITCH off nothing is scheduled and a requested
 * check is refused.
 */
import { inngest } from "../client";
import {
  CONNECTOR_PARITY_CHECK_EVENT,
  connectorBoxedSwitchEnabled,
  PARITY_CRON,
} from "../../connectors/boxed-runtime/config";
import {
  activeShadowFlowIds,
  runParityCheck,
} from "../../connectors/boxed-runtime/parity.service";

export { CONNECTOR_PARITY_CHECK_EVENT };

export const connectorParitySchedulerFunction = inngest.createFunction(
  {
    id: "connector-parity-scheduler",
    name: "Connectors: schedule shadow parity checks",
    concurrency: { limit: 1 },
    retries: 0,
    triggers: { cron: PARITY_CRON },
  },
  async ({ step }) => {
    if (!connectorBoxedSwitchEnabled()) return { scheduled: 0 };
    const shadows = (await step.run("find-shadows", () =>
      activeShadowFlowIds(),
    )) as string[];
    if (shadows.length > 0) {
      await step.sendEvent(
        "dispatch",
        shadows.map(shadowFlowId => ({
          name: CONNECTOR_PARITY_CHECK_EVENT,
          data: { shadowFlowId, trigger: "scheduled" },
        })),
      );
    }
    return { scheduled: shadows.length };
  },
);

export const connectorParityCheckFunction = inngest.createFunction(
  {
    id: "connector-parity-check",
    name: "Connectors: shadow parity check",
    retries: 1,
    timeouts: { finish: "30m" },
    singleton: { key: "event.data.shadowFlowId", mode: "skip" },
    concurrency: { limit: 4 },
    triggers: { event: CONNECTOR_PARITY_CHECK_EVENT },
  },
  async ({ event, step }) => {
    if (!connectorBoxedSwitchEnabled()) {
      return { skipped: "CONNECTOR_BOXED_SWITCH is off" };
    }
    const data = event.data as {
      shadowFlowId: string;
      trigger?: "scheduled" | "manual";
    };
    const check = await step.run("check", async () => {
      const result = await runParityCheck({
        shadowFlowId: data.shadowFlowId,
        trigger: data.trigger === "manual" ? "manual" : "scheduled",
      });
      return {
        id: String(result._id),
        clean: result.clean,
        reasons: result.reasons.slice(0, 20),
      };
    });
    return check;
  },
);
