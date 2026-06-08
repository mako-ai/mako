/**
 * Workspace-scoped Reverse ETL flows.
 * Authenticated + workspace member access; activation and runs require owner/admin.
 */
import { Hono } from "hono";
import { Types } from "mongoose";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import {
  ReverseFlow,
  ReverseFlowRun,
  type IReverseFlow,
} from "../database/workspace-schema";
import {
  AuthenticatedContext,
  requireWorkspace,
  requireWorkspaceRole,
} from "../middleware/workspace.middleware";
import { loggers } from "../logging";
import {
  DEFAULT_REVERSE_FLOW_SPEC,
  REVERSE_FLOW_SPEC_SCHEMA,
  applyReverseFlowDefaults,
} from "../schemas/reverse-flow.schema";
import { dryRunReverseEtl } from "../services/reverse-etl/dry-run.service";
import { getOutboundConnector } from "../services/reverse-etl/outbound";
import { inngest } from "../inngest";
import {
  getNextScheduledConsoleRunAt,
  normalizeScheduledConsoleSchedule,
} from "../services/scheduled-query-schedule.service";

const logger = loggers.api("reverse-flows");

export const reverseFlowRoutes = new Hono();

reverseFlowRoutes.use("*", unifiedAuthMiddleware);
reverseFlowRoutes.use("*", requireWorkspace);

function objectId(id: string): Types.ObjectId | null {
  return Types.ObjectId.isValid(id) ? new Types.ObjectId(id) : null;
}

function serializeFlow(flow: IReverseFlow) {
  const object = flow.toObject({ getters: true });
  return {
    ...object,
    id: object._id?.toString(),
    _id: object._id?.toString(),
    workspaceId: object.workspaceId?.toString(),
  };
}

reverseFlowRoutes.get("/", async c => {
  const workspaceId = c.req.param("workspaceId");
  try {
    const flows = await ReverseFlow.find({
      workspaceId: new Types.ObjectId(workspaceId),
    }).sort({ updatedAt: -1 });
    return c.json({
      success: true,
      data: flows.map(flow => serializeFlow(flow)),
    });
  } catch (error) {
    logger.error("Failed to list reverse flows", { error, workspaceId });
    return c.json(
      { success: false, error: "Failed to list reverse flows" },
      500,
    );
  }
});

reverseFlowRoutes.post("/", async (c: AuthenticatedContext) => {
  const workspaceId = c.req.param("workspaceId");
  const user = c.get("user");
  try {
    const body = (await c.req.json()) as Record<string, unknown>;
    const spec = applyReverseFlowDefaults(
      body.spec || DEFAULT_REVERSE_FLOW_SPEC,
    );
    const created = await ReverseFlow.create({
      workspaceId: new Types.ObjectId(workspaceId),
      name:
        typeof body.name === "string" && body.name.trim()
          ? body.name.trim()
          : "Untitled Reverse ETL",
      createdBy: user?.id || "unknown",
      status: "draft",
      spec,
      version: 1,
      versions: [
        {
          version: 1,
          spec,
          authoredBy: user?.id || "unknown",
          reason: "created",
          createdAt: new Date(),
        },
      ],
      scheduledRun: {
        runCount: 0,
        consecutiveFailures: 0,
      },
    });
    return c.json({ success: true, data: serializeFlow(created) }, 201);
  } catch (error) {
    logger.error("Failed to create reverse flow", { error, workspaceId });
    return c.json(
      { success: false, error: "Failed to create reverse flow" },
      400,
    );
  }
});

reverseFlowRoutes.get("/connectors/:connectorId/outbound-schema", async c => {
  const entity = c.req.query("entity") || "leads";
  try {
    const outbound = await getOutboundConnector(c.req.param("connectorId"));
    const schema = await outbound.resolveOutboundSchema(entity);
    return c.json({ success: true, data: schema });
  } catch (error) {
    logger.error("Failed to resolve outbound schema", { error, entity });
    return c.json(
      { success: false, error: "Failed to resolve outbound schema" },
      400,
    );
  }
});

reverseFlowRoutes.get("/:id", async c => {
  const workspaceId = c.req.param("workspaceId");
  const id = objectId(c.req.param("id"));
  if (!id) {
    return c.json({ success: false, error: "Invalid reverse flow ID" }, 400);
  }
  const flow = await ReverseFlow.findOne({
    _id: id,
    workspaceId: new Types.ObjectId(workspaceId),
  });
  if (!flow) {
    return c.json({ success: false, error: "Reverse flow not found" }, 404);
  }
  return c.json({ success: true, data: serializeFlow(flow) });
});

reverseFlowRoutes.put("/:id", async (c: AuthenticatedContext) => {
  const workspaceId = c.req.param("workspaceId");
  const id = objectId(c.req.param("id"));
  const user = c.get("user");
  if (!id) {
    return c.json({ success: false, error: "Invalid reverse flow ID" }, 400);
  }

  try {
    const body = (await c.req.json()) as Record<string, unknown>;
    const flow = await ReverseFlow.findOne({
      _id: id,
      workspaceId: new Types.ObjectId(workspaceId),
    });
    if (!flow) {
      return c.json({ success: false, error: "Reverse flow not found" }, 404);
    }

    const nextSpec =
      body.spec === undefined
        ? flow.spec
        : REVERSE_FLOW_SPEC_SCHEMA.parse(body.spec);
    const nextVersion = flow.version + 1;
    flow.name =
      typeof body.name === "string" && body.name.trim()
        ? body.name.trim()
        : flow.name;
    flow.spec = nextSpec;
    flow.status = "draft";
    flow.version = nextVersion;
    flow.versions.push({
      version: nextVersion,
      spec: nextSpec,
      authoredBy: user?.id || "unknown",
      reason: typeof body.reason === "string" ? body.reason : "updated",
      createdAt: new Date(),
    });
    await flow.save();
    return c.json({ success: true, data: serializeFlow(flow) });
  } catch (error) {
    logger.error("Failed to update reverse flow", { error, workspaceId });
    return c.json(
      { success: false, error: "Failed to update reverse flow" },
      400,
    );
  }
});

reverseFlowRoutes.delete(
  "/:id",
  requireWorkspaceRole(["owner", "admin"]),
  async c => {
    const workspaceId = c.req.param("workspaceId");
    const id = objectId(c.req.param("id"));
    if (!id) {
      return c.json({ success: false, error: "Invalid reverse flow ID" }, 400);
    }
    await ReverseFlow.deleteOne({
      _id: id,
      workspaceId: new Types.ObjectId(workspaceId),
    });
    return c.json({ success: true });
  },
);

reverseFlowRoutes.post("/:id/dry-run", async c => {
  const workspaceId = c.req.param("workspaceId");
  const id = objectId(c.req.param("id"));
  if (!workspaceId) {
    return c.json({ success: false, error: "Workspace ID is required" }, 400);
  }
  if (!id) {
    return c.json({ success: false, error: "Invalid reverse flow ID" }, 400);
  }
  try {
    const body = (await c.req.json().catch(() => ({}))) as {
      sampleSize?: number;
      spec?: unknown;
    };
    const flow = await ReverseFlow.findOne({
      _id: id,
      workspaceId: new Types.ObjectId(workspaceId),
    });
    if (!flow) {
      return c.json({ success: false, error: "Reverse flow not found" }, 404);
    }
    const spec = body.spec
      ? REVERSE_FLOW_SPEC_SCHEMA.parse(body.spec)
      : flow.spec;
    const result = await dryRunReverseEtl(
      workspaceId,
      spec,
      Math.min(body.sampleSize || 25, 100),
    );
    flow.lastDryRun = { at: new Date(), ...result.summary };
    await flow.save();
    return c.json({ success: true, data: result });
  } catch (error) {
    logger.error("Reverse flow dry run failed", { error, workspaceId });
    return c.json(
      { success: false, error: "Reverse flow dry run failed" },
      400,
    );
  }
});

reverseFlowRoutes.post(
  "/:id/activate",
  requireWorkspaceRole(["owner", "admin"]),
  async c => {
    const workspaceId = c.req.param("workspaceId");
    const id = objectId(c.req.param("id"));
    if (!id) {
      return c.json({ success: false, error: "Invalid reverse flow ID" }, 400);
    }
    try {
      const flow = await ReverseFlow.findOne({
        _id: id,
        workspaceId: new Types.ObjectId(workspaceId),
      });
      if (!flow) {
        return c.json({ success: false, error: "Reverse flow not found" }, 404);
      }
      if (
        flow.spec.safety.dryRunRequiredBeforeActivate &&
        !flow.lastDryRun?.passed
      ) {
        return c.json(
          { success: false, error: "A passing dry run is required first" },
          400,
        );
      }
      const outbound = await getOutboundConnector(
        flow.spec.destination.connectorId,
      );
      await outbound.resolveOutboundSchema(flow.spec.destination.entity);
      const schedule = flow.spec.schedule;
      flow.status = "active";
      flow.scheduledRun = {
        ...(flow.scheduledRun || { runCount: 0, consecutiveFailures: 0 }),
        nextAt:
          schedule.enabled && schedule.cron
            ? getNextScheduledConsoleRunAt(
                normalizeScheduledConsoleSchedule(schedule),
              )
            : undefined,
      };
      await flow.save();
      return c.json({ success: true, data: serializeFlow(flow) });
    } catch (error) {
      logger.error("Failed to activate reverse flow", { error, workspaceId });
      return c.json(
        { success: false, error: "Failed to activate reverse flow" },
        400,
      );
    }
  },
);

reverseFlowRoutes.post("/:id/pause", async c => {
  const workspaceId = c.req.param("workspaceId");
  const id = objectId(c.req.param("id"));
  if (!id) {
    return c.json({ success: false, error: "Invalid reverse flow ID" }, 400);
  }
  const flow = await ReverseFlow.findOneAndUpdate(
    { _id: id, workspaceId: new Types.ObjectId(workspaceId) },
    { $set: { status: "paused", "scheduledRun.nextAt": undefined } },
    { new: true },
  );
  if (!flow) {
    return c.json({ success: false, error: "Reverse flow not found" }, 404);
  }
  return c.json({ success: true, data: serializeFlow(flow) });
});

reverseFlowRoutes.post(
  "/:id/run",
  requireWorkspaceRole(["owner", "admin"]),
  async (c: AuthenticatedContext) => {
    const workspaceId = c.req.param("workspaceId");
    const id = objectId(c.req.param("id"));
    const user = c.get("user");
    if (!id) {
      return c.json({ success: false, error: "Invalid reverse flow ID" }, 400);
    }
    const flow = await ReverseFlow.findOne({
      _id: id,
      workspaceId: new Types.ObjectId(workspaceId),
    }).lean();
    if (!flow) {
      return c.json({ success: false, error: "Reverse flow not found" }, 404);
    }
    if (flow.status !== "active") {
      return c.json(
        { success: false, error: "Reverse flow must be active" },
        400,
      );
    }
    await inngest.send({
      name: "reverse_etl/execute",
      data: {
        workspaceId,
        reverseFlowId: id.toString(),
        triggerType: "manual",
        triggeredBy: user?.id,
      },
    });
    return c.json({ success: true });
  },
);

reverseFlowRoutes.get("/:id/runs", async c => {
  const workspaceId = c.req.param("workspaceId");
  const id = objectId(c.req.param("id"));
  if (!id) {
    return c.json({ success: false, error: "Invalid reverse flow ID" }, 400);
  }
  const runs = await ReverseFlowRun.find({
    workspaceId: new Types.ObjectId(workspaceId),
    reverseFlowId: id,
  })
    .sort({ triggeredAt: -1 })
    .limit(100)
    .lean();
  return c.json({ success: true, data: runs });
});

reverseFlowRoutes.get("/:id/versions", async c => {
  const workspaceId = c.req.param("workspaceId");
  const id = objectId(c.req.param("id"));
  if (!id) {
    return c.json({ success: false, error: "Invalid reverse flow ID" }, 400);
  }
  const flow = await ReverseFlow.findOne({
    _id: id,
    workspaceId: new Types.ObjectId(workspaceId),
  })
    .select("versions")
    .lean();
  if (!flow) {
    return c.json({ success: false, error: "Reverse flow not found" }, 404);
  }
  return c.json({ success: true, data: flow.versions || [] });
});
