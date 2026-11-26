/** A webhook per workflow (public; the URL is the credential). */
import { bodyLimit } from "hono/body-limit";
import { Types } from "mongoose";
import { createRouter } from "../../openapi/core";
import { workspaceRepo } from "../../repositories/workspaces";
import { workspaceService } from "../../services/workspace.service";
import { readWorkspaceTenant, startRun } from "../../workflows/hatchet";
import { startSandboxRun } from "../../workflows/sandbox";
import { wakeWorker } from "../../workflows/scale";
import { isWebhookSecret } from "../../workflows/webhook";
import { fail } from "../lib/respond";
import { onRouteError } from "./shared";

// --- Webhooks (public; the URL is the credential) ----------------------------

export const workflowHookRoutes = createRouter();
workflowHookRoutes.onError(onRouteError);

workflowHookRoutes.post(
  "/:workspaceId/:name/:secret",
  bodyLimit({ maxSize: 1024 * 1024 }),
  async c => {
    const { workspaceId, name, secret } = c.req.param();
    const workspace = Types.ObjectId.isValid(workspaceId)
      ? await workspaceRepo.findById(workspaceId)
      : null;
    const { webhooks, active } = workspace?.workflows ?? {};
    // One answer for every wrong URL: it does not say which part was wrong.
    if (!isWebhookSecret(webhooks, name, secret)) {
      return fail(c, 404, "Not found");
    }
    const body: unknown = await c.req.json().catch(() => ({}));
    const input =
      body && typeof body === "object" && !Array.isArray(body)
        ? body
        : { body };
    // The test URL: `?sandbox=<user id>` runs that member's checkout in
    // their sandbox with this body and answers its runId (202). It
    // works whether or not the workflow is active.
    const tester = c.req.query("sandbox");
    if (tester) {
      const member = await workspaceService.hasRole(workspaceId, tester, [
        "owner",
        "admin",
        "member",
      ]);
      if (!member) return fail(c, 404, "Not found");
      return c.json(
        // Anyone with the URL starts it: a test records its writes.
        await startSandboxRun(workspaceId, tester, name, input, {
          writes: "record",
        }),
        202,
      );
    }
    // The production URL works while the workflow is active, like its schedule.
    const tenant = active?.includes(name)
      ? await readWorkspaceTenant(workspaceId)
      : null;
    if (!tenant) return fail(c, 404, "Not found");
    const runId = await startRun(tenant, name, {
      input,
      trigger: "webhook",
      startedBy: "trigger",
    });
    await wakeWorker(workspaceId, "webhook");
    return c.json({ runId }, 202);
  },
);
