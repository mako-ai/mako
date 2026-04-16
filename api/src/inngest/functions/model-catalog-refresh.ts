/**
 * Model Catalog Refresh — Inngest Cron
 *
 * Runs every hour at :15 past. Each upstream source (gateway, arena) is
 * fetched in an independent Inngest step so one failing doesn't block the
 * other. Zod validation inside each refresh function prevents bad data
 * from overwriting last-known-good DB snapshots.
 */

import { inngest } from "../client";
import {
  refreshGatewaySnapshot,
  refreshArenaSnapshot,
} from "../../services/model-catalog.service";

export const modelCatalogRefreshFunction = inngest.createFunction(
  {
    id: "system/model-catalog-refresh",
    name: "Refresh AI model catalog snapshots",
    retries: 2,
  },
  { cron: "15 * * * *" },
  async ({ step }) => {
    const gw = await step.run("fetch-gateway", async () => {
      return refreshGatewaySnapshot();
    });

    const arena = await step.run("fetch-arena", async () => {
      return refreshArenaSnapshot();
    });

    return { gateway: gw, arena };
  },
);
