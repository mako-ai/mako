import { Types } from "mongoose";
import { RepoRequiredError } from "../../apps/config";
import { Flow } from "../../database/workspace-schema";
import { deleteFlowFile } from "../../services/flow-config.service";
import {
  attachFlowLookups,
  projectFlowListItem,
} from "../../services/flow-lookups.service";
import {
  applyFlowUpdate,
  buildNewFlow,
  finishFlowCreate,
  finishFlowUpdate,
  webhookStateBefore,
} from "../../services/flow-mutation.service";
import { FlowRequestError } from "../../services/flow-request-error";
import {
  liveFlowToPlain,
  loadLiveFlowById,
  loadLiveFlows,
} from "../../services/flow-sync.service";
import { isWebhookFlow } from "../../services/flow-triggers.service";
import { getRequestBaseUrl } from "../../services/flow-webhook-url";
import { teardownFlow } from "../../sync-cdc/flow-reconcile";
import { generateWebhookEndpoint } from "../../utils/webhook.utils";
import { workspaceService } from "../../services/workspace.service";
import { fail } from "../lib/respond";
import {
  ANY_JSON_BODY,
  assertFlowRepo,
  commitFlowFileOrFail,
  findFlow,
  flowFailure,
  flowRoute,
  logger,
  repoRequired,
  thrownMessage,
  type FlowRouter,
} from "./shared";

export function registerCrudRoutes(flowRoutes: FlowRouter): void {
  // GET /api/workspaces/:workspaceId/flows - List all flows
  // Git at main is the definition; Mongo is overlay (runtime / SHA / webhook).
  // No GitHub binding → 200 empty list, not 412. Leftover local git is ignored.
  flowRoutes.openapi(flowRoute("get", "/"), async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const sourceType = c.req.query("sourceType"); // Optional filter

      const live = await loadLiveFlows(workspaceId);
      const plains = live
        .map(item => liveFlowToPlain(item, workspaceId))
        .filter(flow => !sourceType || flow.sourceType === sourceType);
      plains.sort((a, b) => {
        const aTime = a.createdAt instanceof Date ? a.createdAt.getTime() : 0;
        const bTime = b.createdAt instanceof Date ? b.createdAt.getTime() : 0;
        return bTime - aTime;
      });
      await attachFlowLookups(workspaceId, plains);
      const requestBaseUrl = getRequestBaseUrl(c);
      const normalizedFlows = plains.map(flow => {
        const projected = projectFlowListItem(flow);
        if (!isWebhookFlow(projected as never) || !projected._id) {
          return projected;
        }
        const endpoint = generateWebhookEndpoint(
          workspaceId,
          String(projected._id),
          requestBaseUrl,
        );
        return {
          ...projected,
          webhookConfig: {
            ...((projected.webhookConfig as Record<string, unknown>) || {}),
            endpoint,
          },
        };
      });

      return c.json({
        success: true,
        data: normalizedFlows,
      });
    } catch (error) {
      if (error instanceof RepoRequiredError) {
        return c.json({ success: true, data: [] }, 200);
      }
      logger.error("Error listing flows", { error });
      return fail(c, 500, thrownMessage(error));
    }
  });

  // POST /api/workspaces/:workspaceId/flows - Create a new flow
  flowRoutes.openapi(
    flowRoute("post", "/", { body: ANY_JSON_BODY }),
    async c => {
      try {
        const workspaceId = c.req.param("workspaceId");
        if (!workspaceId) {
          return fail(c, 400, "Workspace ID is required");
        }
        // A flow's definition lives in the repo, so refuse before creating one
        // that would have nowhere durable to live (RFC #904 decision 1).
        await assertFlowRepo(workspaceId);
        const body = await c.req.json();

        const {
          flow,
          flowData,
          sourceType,
          warnings: syncConfigWarnings,
        } = await buildNewFlow({
          workspaceId,
          body,
          requestBaseUrl: getRequestBaseUrl(c),
        });

        {
          const failed = await commitFlowFileOrFail(c, flow, c.get("user")?.id);
          if (failed) return failed;
        }
        await flow.save();
        await finishFlowCreate({ flow, flowData, sourceType });

        return c.json({
          success: true,
          data: flow,
          ...(syncConfigWarnings.length > 0
            ? { warnings: syncConfigWarnings }
            : {}),
        });
      } catch (error) {
        // The repo gate is a precondition, not a failure: 412 with an
        // actionable message rather than a 500 the user cannot act on.
        if (error instanceof RepoRequiredError) return repoRequired(c, error);
        if (error instanceof FlowRequestError) {
          return flowFailure(c, error, 500);
        }
        logger.error("Error creating flow", { error });
        return fail(c, 500, thrownMessage(error));
      }
    },
  );

  // GET /api/workspaces/:workspaceId/flows/:flowId - Get flow details
  flowRoutes.openapi(flowRoute("get", "/{flowId}"), async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const flowId = c.req.param("flowId") as string;

      const live = await loadLiveFlowById(workspaceId, flowId);
      if (!live) {
        return fail(c, 404, "Flow not found");
      }

      const flow = liveFlowToPlain(live, workspaceId);
      await attachFlowLookups(workspaceId, [flow], {
        includeSourceConfig: true,
      });
      if (isWebhookFlow(flow as never)) {
        const webhookConfig = {
          ...((flow.webhookConfig as Record<string, unknown> | undefined) ??
            {}),
          endpoint: generateWebhookEndpoint(
            workspaceId,
            String(flow._id),
            getRequestBaseUrl(c),
          ),
        };
        flow.webhookConfig = webhookConfig;
      }

      return c.json({
        success: true,
        data: flow,
      });
    } catch (error) {
      if (error instanceof RepoRequiredError) {
        return fail(c, 404, "Flow not found");
      }
      logger.error("Error getting flow", { error });
      return fail(c, 500, thrownMessage(error));
    }
  });

  // PUT /api/workspaces/:workspaceId/flows/:flowId - Update flow
  flowRoutes.openapi(
    flowRoute("put", "/{flowId}", { body: ANY_JSON_BODY }),
    async c => {
      try {
        const workspaceId = c.req.param("workspaceId");
        const flowId = c.req.param("flowId");
        if (!workspaceId) {
          return fail(c, 400, "Workspace ID is required");
        }
        // An edit rewrites `flows/<slug>.yml`; refuse when there is no repo to
        // write it to (RFC #904 decision 1).
        await assertFlowRepo(workspaceId);
        const body = await c.req.json();

        // Find and validate flow
        const flow = await findFlow(workspaceId, flowId);
        if (!flow) {
          return fail(c, 404, "Flow not found");
        }
        // Entities before this edit: a change re-targets the provider-side
        // webhook subscription after save (see flow-webhook-subscription).
        const before = webhookStateBefore(flow);

        const syncConfigWarnings = await applyFlowUpdate({
          workspaceId,
          flow,
          body,
          requestBaseUrl: getRequestBaseUrl(c),
        });

        {
          const failed = await commitFlowFileOrFail(c, flow, c.get("user")?.id);
          if (failed) return failed;
        }
        await flow.save();
        // Only an owner/admin save may create a provider subscription.
        const userId = c.get("user")?.id;
        const mayProvision = userId
          ? await workspaceService.hasRole(workspaceId, userId, [
              "owner",
              "admin",
            ])
          : false;
        await finishFlowUpdate({
          flow,
          before,
          syncConfigWarnings,
          mayProvision,
        });

        return c.json({
          success: true,
          data: flow,
          ...(syncConfigWarnings.length > 0
            ? { warnings: syncConfigWarnings }
            : {}),
        });
      } catch (error) {
        // The repo gate is a precondition, not a failure: 412 with an
        // actionable message rather than a 500 the user cannot act on.
        if (error instanceof RepoRequiredError) return repoRequired(c, error);
        if (error instanceof FlowRequestError) {
          return flowFailure(c, error, 500);
        }
        logger.error("Error updating flow", { error });
        return fail(c, 500, thrownMessage(error));
      }
    },
  );

  // DELETE /api/workspaces/:workspaceId/flows/:flowId - Delete flow
  flowRoutes.openapi(flowRoute("delete", "/{flowId}"), async c => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const flowId = c.req.param("flowId");
      if (!workspaceId) {
        return fail(c, 400, "Workspace ID is required");
      }
      // Deleting tears the stream down AND removes the file. Refuse before
      // `teardownFlow` disposes CDC state we could not then explain by a
      // commit (RFC #904 decision 1).
      await assertFlowRepo(workspaceId);
      const flowOid = new Types.ObjectId(flowId);
      const wsOid = new Types.ObjectId(workspaceId);

      const flow = await Flow.findOne({ _id: flowOid, workspaceId: wsOid });
      if (!flow) {
        return fail(c, 404, "Flow not found");
      }

      // Cancel + cascade + row delete live in one place, shared with the
      // repo reconciler (sync-cdc/flow-reconcile.ts). Two copies of a
      // five-collection teardown would drift, and the halves that drifted
      // would be the ones nobody deletes.
      await deleteFlowFile(flow, c.get("user")?.id);
      await teardownFlow(flow);

      return c.json({
        success: true,
        message: "Flow deleted successfully",
      });
    } catch (error) {
      // The repo gate is a precondition, not a failure: 412 with an
      // actionable message rather than a 500 the user cannot act on.
      if (error instanceof RepoRequiredError) return repoRequired(c, error);
      logger.error("Error deleting flow", { error });
      return fail(c, 500, thrownMessage(error));
    }
  });
}
