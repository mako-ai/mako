/**
 * Every 5 minutes: end notebook kernel sessions idle past their TTL, then
 * scale the kernel pool down if nothing uses it
 * (services/kernel-provider/kernel-pool-reaper.ts). Without this the pool's
 * first pod, and the node under it, never went away.
 */
import { inngest } from "../client";
import { loggers } from "../../logging";
import { getKernelProvider } from "../../services/kernel-provider";
import { gkeClients } from "../../services/kernel-provider/gke-kernel-provider";
import { reapIdleKernelPool } from "../../services/kernel-provider/kernel-pool-reaper";
import { kernelSessionService } from "../../services/kernel-session.service";

const log = loggers.api("kernel-pool-reaper");

export const kernelPoolReaperFunction = inngest.createFunction(
  {
    id: "kernel-pool-reaper",
    name: "Notebooks: scale the idle kernel pool down",
    concurrency: { limit: 1 },
    retries: 0,
    triggers: { cron: "*/5 * * * *" },
  },
  async ({ step }) => {
    if (getKernelProvider()?.name !== "gke") {
      return { skipped: "no gke kernel provider" };
    }
    // Sessions this instance's store knows about (all of them with Redis).
    const stopped = await step.run("stop-idle-sessions", async () => {
      const idle = await kernelSessionService.idleSessions();
      for (const s of idle) {
        await kernelSessionService
          .stop(s.workspaceId, s.notebookId)
          .catch(error =>
            log.warn("Could not stop an idle kernel session", {
              notebookId: s.notebookId,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
      }
      return idle.length;
    });
    const pool = await step.run("scale-pool", async () =>
      reapIdleKernelPool(await gkeClients()),
    );
    return { stopped, ...pool };
  },
);
