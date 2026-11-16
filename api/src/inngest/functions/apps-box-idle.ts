/**
 * App-box idle policy on a clock (apps/box-idle.service.ts).
 *
 * - Every 2 minutes: pause running app boxes idle past APPS_BOX_IDLE_MINUTES
 *   (default 10) and log running/paused counts and box-seconds per
 *   workspace.
 * - Hourly: delete sessions paused and unused past
 *   APPS_BOX_PAUSED_RETENTION_DAYS (default 14), committing uncommitted
 *   work to the session branch first, at most APPS_BOX_REAP_BATCH (default
 *   10) per run.
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
  realSweepDeps,
  reapPausedBoxes,
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
    if (!config.enabled) return { skipped: "APPS_BOX_IDLE_SWEEP=off" };
    if (!boxIdleSweepAvailable()) return { skipped: "no e2b provider" };
    return step.run("reap", async () => {
      const result = await reapPausedBoxes(realReapDeps(), config);
      for (const deleted of result.deleted) {
        log.info("Apps paused box deleted", { ...deleted });
      }
      for (const skipped of result.skipped) {
        log.warn("Apps paused box kept", { ...skipped });
      }
      return {
        due: result.due,
        deleted: result.deleted.length,
        skipped: result.skipped.length,
      };
    });
  },
);
