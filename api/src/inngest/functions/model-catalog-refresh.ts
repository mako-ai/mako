/**
 * Model Catalog Refresh — Inngest Cron
 *
 * Runs every hour at :15 past. Pulls the latest model list + pricing from the
 * Vercel AI Gateway and persists the snapshot. Tier + visibility are driven by
 * the super-admin-curated `curation` doc, not by this cron.
 */

import { inngest } from "../client";
import { refreshGatewaySnapshot } from "../../services/model-catalog.service";

export const modelCatalogRefreshFunction = inngest.createFunction(
  {
    id: "system/model-catalog-refresh",
    name: "Refresh AI model catalog snapshots",
    retries: 2,
  },
  { cron: "15 * * * *" },
  async ({ step }) => {
    const gateway = await step.run("fetch-gateway", async () => {
      return refreshGatewaySnapshot();
    });

    return { gateway };
  },
);
