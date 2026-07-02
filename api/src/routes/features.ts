// Intentionally public: exposes non-sensitive server feature flags so the
// frontend can gate UI variants. No auth required (booleans only, no data).
import { createRoute, z } from "@hono/zod-openapi";
import { createRouter, OPEN_RESPONSES } from "../openapi/core";
import { isUnifiedSyncFlowsEnabled } from "../services/flow-triggers.service";

export const featureRoutes = createRouter();

featureRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Features"],
    summary: "GET / (server feature flags)",
    responses: {
      200: {
        description: "Server feature flags",
        content: {
          "application/json": {
            schema: z.object({
              unifiedSyncFlows: z.boolean(),
            }),
          },
        },
      },
      ...OPEN_RESPONSES,
    },
  }),
  c => {
    return c.json({ unifiedSyncFlows: isUnifiedSyncFlowsEnabled() }, 200);
  },
);
