/**
 * App-box idle policy on a clock (apps/box-idle.service.ts).
 *
 * - Every 2 minutes: pause running app boxes idle past APPS_BOX_IDLE_MINUTES
 *   (default 10) and log running/paused counts and box-seconds per
 *   workspace.
 * - Hourly, with APPS_BOX_REAPER=dryrun (plan and log every due session,
 *   touch none) or on
 *   (off by default): delete sessions
 *   paused and unused past APPS_BOX_PAUSED_RETENTION_DAYS (default 14),
 *   rescuing uncommitted work to a mako-presave/ branch first, at most
 *   APPS_BOX_REAP_BATCH (default 10) per run, one step per session.
 *
 * APPS_BOX_IDLE_SWEEP=off turns both off. Neither runs without E2B.
 */
import { inngest } from "../client";
import { loggers } from "../../logging";
import {
  boxIdleConfig,
  boxIdleSweepAvailable,
  logBoxUsage,
  realReapDeps,
  planReap,
  realSweepDeps,
  reapSession,
  sweepIdleBoxes,
} from "../../apps/box-idle.service";

const log = loggers.api("apps-box-idle");

export const appsBoxIdleSweepFunction = inngest.createFunction(
  {
    id: "apps-box-idle-sweep",
    name: "Apps: pause idle sandboxes and report box usage",
    concurrency: { limit: 1 },
    // The next tick is two minutes away; a retry would only race it.
    retries: 0,
    triggers: { cron: "*/2 * * * *" },
  },
  async ({ step }) => {
    const config = boxIdleConfig();
    if (!config.enabled) return { skipped: "APPS_BOX_IDLE_SWEEP=off" };
    if (!boxIdleSweepAvailable()) return { skipped: "no e2b provider" };
    return step.run("sweep", async () => {
      const result = await sweepIdleBoxes(realSweepDeps(), config);
      logBoxUsage(result.usage);
      for (const paused of result.pausedNow) {
        log.info("Apps box paused after idle", { ...paused });
      }
      for (const kept of result.kept) {
        log.info("Apps box kept running past idle", { ...kept });
      }
      return {
        running: result.running,
        paused: result.paused,
        pausedNow: result.pausedNow.length,
        kept: result.kept.length,
      };
    });
  },
);

export const appsBoxPausedReaperFunction = inngest.createFunction(
  {
    id: "apps-box-paused-reaper",
    name: "Apps: delete sandboxes paused past retention",
    concurrency: { limit: 1 },
    retries: 0,
    triggers: { cron: "17 * * * *" },
  },
  async ({ step }) => {
    const config = boxIdleConfig();
    // Deletion is opt-in and separate from pausing. Roll out:
    // off -> dryrun (plan and log, touch nothing) -> read the logs -> on.
    if (!config.enabled || config.reaperMode === "off") {
      return { skipped: "APPS_BOX_REAPER is off" };
    }
    if (!boxIdleSweepAvailable()) return { skipped: "no e2b provider" };
    if (config.reaperMode === "dryrun") {
      // Plan only: every due session, none resumed, settled or pushed. A
      // settling dry run would wake the same oldest sessions every hour and
      // push a new rescue branch each time.
      return step.run("dry-run-plan", async () => {
        const planned = await planReap(realReapDeps(), config, { all: true });
        for (const due of planned.due) {
          log.info("Apps paused box would be settled and deleted (dry run)", {
            sessionKey: due.sessionKey,
            boxes: due.sandboxIds,
            idleDays: Math.floor((Date.now() - due.lastUse) / 86_400_000),
          });
        }
        for (const skipped of planned.skipped) {
          log.info("Apps paused box not due", { ...skipped });
        }
        return { mode: "dryrun", due: planned.due.length };
      });
    }
    const plan = await step.run("plan", async () => {
      const planned = await planReap(realReapDeps(), config);
      for (const skipped of planned.skipped) {
        log.info("Apps paused box not due", { ...skipped });
      }
      return planned.due;
    });
    let deleted = 0;
    let kept = 0;
    // One step per session: a slow or failing box costs only its own step,
    // and a retry of the function never repeats a finished deletion.
    for (const candidate of plan) {
      const outcome = await step.run(
        `reap-${candidate.sessionKey}`,
        async () => {
          const result = await reapSession(realReapDeps(), candidate);
          for (const { sandboxId, result: rescue } of result.rescues) {
            // Everything deletion will lose is logged BEFORE the kill below
            // ran: excluded paths (secrets, >10 MB, build output) and ignored
            // files.
            log.info("Apps paused box settled", {
              sessionKey: candidate.sessionKey,
              sandboxId,
              status: rescue.status,
              ...(rescue.status === "saved"
                ? {
                    branch: rescue.branch,
                    commitOid: rescue.commitOid,
                    files: rescue.files,
                  }
                : {}),
              ...(rescue.status === "manual" ? { reason: rescue.reason } : {}),
              excluded: rescue.excluded,
              ignored: rescue.ignored,
            });
          }
          if (result.action === "deleted") {
            log.info("Apps paused box deleted", {
              sessionKey: candidate.sessionKey,
              boxes: candidate.sandboxIds.length,
              idleDays: Math.floor(
                (Date.now() - candidate.lastUse) / 86_400_000,
              ),
              killFailures: result.killFailures,
            });
          } else {
            log.warn("Apps paused box kept", {
              sessionKey: candidate.sessionKey,
              reason: result.reason,
            });
          }
          return { action: result.action };
        },
      );
      if (outcome.action === "deleted") deleted += 1;
      else kept += 1;
    }
    return { mode: config.reaperMode, due: plan.length, deleted, kept };
  },
);
