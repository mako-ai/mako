/**
 * Box metrics (RFC connector-runtime §6.9), as structured log lines.
 *
 * The API has no metrics exporter; its logs are structured (logtape, JSON in
 * production). Every line carries `metric` and `value`, so a log-based metric
 * or a warehouse query can sum or chart it without parsing a message.
 */
import { loggers } from "../../../logging";
import type { BoxState } from "./box-store";

const logger = loggers.connector("box");

export type LeaseSource = "idle" | "paused" | "template" | "fresh";

export interface BoxMetrics {
  leaseWait(
    ms: number,
    labels: {
      workspaceId: string;
      connectionId: string;
      command: string;
      source: LeaseSource;
      queued: boolean;
    },
  ): void;
  boxSeconds(
    seconds: number,
    labels: { workspaceId: string; connectionId: string; boxId: string },
  ): void;
  reaped(
    reason: string,
    labels: { workspaceId: string; connectionId: string; boxId: string },
  ): void;
  failedPing(labels: {
    workspaceId: string;
    connectionId: string;
    boxId: string;
  }): void;
  boxCounts(counts: Record<BoxState, number>): void;
  /** A run waits because the account is at its ceiling minus the app reserve. */
  ceilingReached?(labels: { running: number; limit: number }): void;
}

export const logBoxMetrics: BoxMetrics = {
  leaseWait(ms, labels) {
    logger.info("Connector box leased", {
      metric: "connector_box.lease_wait_ms",
      value: ms,
      ...labels,
    });
  },
  boxSeconds(seconds, labels) {
    logger.info("Connector box lease released", {
      metric: "connector_box.box_seconds",
      value: seconds,
      ...labels,
    });
  },
  reaped(reason, labels) {
    logger.info("Connector box killed", {
      metric: "connector_box.reaped",
      value: 1,
      reason,
      ...labels,
    });
  },
  failedPing(labels) {
    logger.warn("Connector box failed its ping; replacing it", {
      metric: "connector_box.failed_ping",
      value: 1,
      ...labels,
    });
  },
  ceilingReached({ running, limit }) {
    logger.warn("Connector box waits for an account slot", {
      metric: "connector_box.ceiling_wait",
      value: 1,
      running,
      limit,
    });
  },
  boxCounts(counts) {
    for (const [state, value] of Object.entries(counts)) {
      logger.info("Connector boxes by state", {
        metric: "connector_box.count",
        value,
        state,
      });
    }
  },
};
