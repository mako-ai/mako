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
    const projects = await step.run("list-projects", async () =>
      AppProject.find({}).select("_id workspaceId defaultBranch").lean(),
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
          due = isDashboardMaterializationDue({
            schedule: {
              enabled: true,
              cron: binding.schedule,
              timezone: binding.timezone,
            },
            lastRefreshedAt: state?.lastMaterializedAt ?? null,
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
        await step.run(`materialize-${projectId}-${binding.name}`, () =>
          materializeAppBinding(project as never, binding.name, "scheduler"),
        );
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
