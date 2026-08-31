/**
 * Scheduled refresh for Apps data bindings (Block 4 of the bindings plan).
 *
 * Schedules live IN the binding files ("-- schedule: <cron>" front matter on
 * main) — no Mongo copy of the definition. Every 15 minutes this scans v2
 * projects, reads their bindings from git (main), and materializes the due
 * ones. Scale note: fine while project counts are small; the recorded
 * scale-up is a derived schedule index maintained on merge-to-main so the
 * scan does not touch git at all.
 */
import { inngest } from "../client";
import { loggers } from "../../logging";
import { AppProject } from "../../database/workspace-schema";
import {
  getBindingState,
  materializeAppBinding,
  readBindings,
} from "../../apps/bindings.service";
import { isDashboardMaterializationDue } from "../../services/dashboard-materialization-schedule.service";

const log = loggers.inngest();

export const appsBindingSchedulerFunction = inngest.createFunction(
  {
    id: "scheduled-apps-binding-refresh",
    name: "Scheduled Apps Binding Refresh",
  },
  { cron: "*/15 * * * *" },
  async ({ step }) => {
    // `slug` is not optional here: readBindings locates the app's files at
    // `apps/<slug>/…` (appRootFor), and without it the lookup falls back to
    // `apps/<mongoId>/…` — a folder that does not exist — so every project
    // silently read ZERO bindings and this scheduler triggered nothing in
    // production for weeks while reporting success.
    const projects = await step.run("list-projects", async () =>
      AppProject.find({}).select("_id workspaceId defaultBranch slug").lean(),
    );
    let triggered = 0;
    for (const project of projects as Array<{
      _id: { toString(): string };
    }>) {
      const projectId = project._id.toString();
      let bindings;
      try {
        // undefined actor = the user-less view -> the app's main branch.
        bindings = await readBindings(project as never, undefined as never);
      } catch (error) {
        log.warn("Skipping project with unreadable bindings", {
          projectId,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      for (const binding of bindings) {
        if (!binding.schedule) continue;
        let due = false;
        try {
          const state = await getBindingState(projectId, binding.name);
          // The last ATTEMPT, not the last success: a binding whose query is
          // broken would otherwise be due on every tick and re-run its
          // failing warehouse query every 15 minutes forever.
          const lastAttempt = state?.history?.at(-1)?.at ?? null;
          due = isDashboardMaterializationDue({
            schedule: {
              enabled: true,
              cron: binding.schedule,
              timezone: binding.timezone,
            },
            lastRefreshedAt: lastAttempt ?? state?.lastMaterializedAt ?? null,
          });
        } catch (error) {
          log.warn("Invalid binding schedule", {
            projectId,
            binding: binding.name,
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        if (!due) continue;
        // One binding's failure must not abort the run: a thrown step fails
        // the whole function, every binding after it in the list is skipped,
        // and the next tick starts over from the top and hits the same one.
        // materializeAppBinding already records the error in the binding's
        // state (and the backoff above keys on it); here it only needs to be
        // logged and stepped over.
        await step.run(`materialize-${projectId}-${binding.name}`, async () => {
          try {
            await materializeAppBinding(
              project as never,
              binding.name,
              "scheduler",
            );
            return { ok: true };
          } catch (error) {
            log.warn("Scheduled binding materialization failed", {
              projectId,
              binding: binding.name,
              error: error instanceof Error ? error.message : String(error),
            });
            return { ok: false };
          }
        });
        triggered++;
      }
    }
    log.info("Apps binding scheduler run", {
      projects: (projects as unknown[]).length,
      triggered,
    });
    return { projects: (projects as unknown[]).length, triggered };
  },
);
