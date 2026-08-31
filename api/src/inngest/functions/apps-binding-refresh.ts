/**
 * Scheduled refresh for Apps data bindings (Block 4 of the bindings plan).
 *
 * Schedules live IN the binding files ("-- schedule: <cron>" front matter on
 * main) — no Mongo copy of the definition. Every 15 minutes the scheduler
 * scans projects, reads their bindings from git (main), and emits ONE EVENT
 * per due binding; the worker below materializes them with bounded
 * concurrency per workspace.
 *
 * It used to materialize inline, sequentially, inside the cron function. With
 * ~170 bindings due at once (the first sweep after a migration) and ~28 of
 * them on a 15-minute schedule, every tick re-ran those 28 first, spent the
 * whole tick on them, and never reached the tail: bindings late in project
 * order were never built while the log showed steady "materialized" lines.
 * A tick now finishes in seconds; the backlog drains in parallel; a slow or
 * broken binding delays nothing but itself.
 *
 * Scale note: fine while project counts are small; the recorded scale-up is
 * a derived schedule index maintained on merge-to-main so the scan does not
 * touch git at all.
 */
import { inngest } from "../client";
import { loggers } from "../../logging";
import { AppProject, type IAppProject } from "../../database/workspace-schema";
import {
  getBindingState,
  materializeAppBinding,
  readBindings,
  type AppBinding,
} from "../../apps/bindings.service";
import { isDashboardMaterializationDue } from "../../services/dashboard-materialization-schedule.service";

const log = loggers.inngest();

export const APPS_BINDING_MATERIALIZE_EVENT = "apps/binding.materialize";

interface MaterializeEventData {
  workspaceId: string;
  projectId: string;
  binding: string;
  /** `${projectId}:${binding}` — the concurrency key (one build per binding). */
  key: string;
}

/**
 * Due = the binding's cron has a run after its last ATTEMPT (not its last
 * success): a binding whose query is broken would otherwise be due on every
 * tick and re-run its failing warehouse query every 15 minutes forever.
 */
async function isBindingDue(
  projectId: string,
  binding: AppBinding,
): Promise<boolean> {
  if (!binding.schedule) return false;
  const state = await getBindingState(projectId, binding.name);
  const lastAttempt = state?.history?.at(-1)?.at ?? null;
  return isDashboardMaterializationDue({
    schedule: {
      enabled: true,
      cron: binding.schedule,
      timezone: binding.timezone,
    },
    lastRefreshedAt: lastAttempt ?? state?.lastMaterializedAt ?? null,
  });
}

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
    const projects = (await step.run("list-projects", async () =>
      AppProject.find({}).select("_id workspaceId defaultBranch slug").lean(),
    )) as Array<
      Pick<IAppProject, "_id" | "workspaceId" | "defaultBranch" | "slug">
    >;

    const due = await step.run("find-due-bindings", async () => {
      const out: MaterializeEventData[] = [];
      for (const project of projects) {
        const projectId = project._id.toString();
        let bindings: AppBinding[];
        try {
          // undefined actor = the user-less view -> the app's main branch.
          bindings = await readBindings(
            project as IAppProject,
            undefined as never,
          );
        } catch (error) {
          log.warn("Skipping project with unreadable bindings", {
            projectId,
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        for (const binding of bindings) {
          if (!binding.schedule) continue;
          try {
            if (!(await isBindingDue(projectId, binding))) continue;
          } catch (error) {
            log.warn("Invalid binding schedule", {
              projectId,
              binding: binding.name,
              error: error instanceof Error ? error.message : String(error),
            });
            continue;
          }
          out.push({
            workspaceId: project.workspaceId.toString(),
            projectId,
            binding: binding.name,
            key: `${projectId}:${binding.name}`,
          });
        }
      }
      return out;
    });

    if (due.length > 0) {
      await step.sendEvent(
        "materialize",
        due.map(data => ({ name: APPS_BINDING_MATERIALIZE_EVENT, data })),
      );
    }
    log.info("Apps binding scheduler run", {
      projects: projects.length,
      triggered: due.length,
    });
    return { projects: projects.length, triggered: due.length };
  },
);

export const appsBindingMaterializeFunction = inngest.createFunction(
  {
    id: "apps-binding-materialize",
    name: "Materialize Apps Data Binding",
    concurrency: [
      // A workspace's warehouse sees at most this many builds at once.
      { scope: "fn", key: "event.data.workspaceId", limit: 4 },
      // Never two builds of the same binding at once.
      { scope: "fn", key: "event.data.key", limit: 1 },
    ],
    // materializeAppBinding records the failure in the binding's state and
    // the next due check backs off from it; retrying here would re-run a
    // broken warehouse query for nothing.
    retries: 0,
  },
  { event: APPS_BINDING_MATERIALIZE_EVENT },
  async ({ event, step }) => {
    const { projectId, binding: name } = event.data as MaterializeEventData;
    return step.run("materialize", async () => {
      const project = await AppProject.findById(projectId);
      if (!project) return { skipped: "project-gone" as const };
      const bindings = await readBindings(project, undefined as never);
      const binding = bindings.find(b => b.name === name);
      if (!binding) return { skipped: "binding-gone" as const };
      // A later tick may have queued this binding again while the backlog
      // was still draining; if a build landed in between, this one is moot.
      if (!(await isBindingDue(projectId, binding))) {
        return { skipped: "not-due" as const };
      }
      try {
        const result = await materializeAppBinding(project, name, "scheduler");
        return { ok: true as const, rowCount: result.rowCount };
      } catch (error) {
        log.warn("Scheduled binding materialization failed", {
          projectId,
          binding: name,
          error: error instanceof Error ? error.message : String(error),
        });
        return { ok: false as const };
      }
    });
  },
);
