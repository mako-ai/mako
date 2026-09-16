/**
 * Scheduled refresh for Apps data bindings (Block 4 of the bindings plan).
 *
 * Schedules live IN the binding files ("-- schedule: <cron>" front matter on
 * main) — no Mongo copy of the DEFINITION. The apps index (rebuilt on every
 * push to main) carries each app's schedules as a derived column, so the
 * 15-minute tick reads one collection instead of opening every repo. It
 * emits ONE EVENT per due binding; the worker below materializes them with
 * bounded concurrency per workspace, reading the binding from git at that
 * point.
 *
 * It used to materialize inline, sequentially, inside the cron function. With
 * ~170 bindings due at once (the first sweep after a migration) and ~28 of
 * them on a 15-minute schedule, every tick re-ran those 28 first, spent the
 * whole tick on them, and never reached the tail: bindings late in project
 * order were never built while the log showed steady "materialized" lines.
 * A tick now finishes in seconds; the backlog drains in parallel; a slow or
 * broken binding delays nothing but itself.
 *
 */
import { inngest } from "../client";
import { loggers } from "../../logging";
import {
  AppIndexEntry,
  AppProject,
  type IAppIndexEntry,
} from "../../database/workspace-schema";
import {
  getBindingState,
  materializeAppBinding,
  readBindings,
  type AppBinding,
  type AppBindingStateDoc,
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
 *
 * `history` is NEWEST FIRST (recordBindingRun pushes at position 0), so the
 * last attempt is `history[0]`. Reading `history.at(-1)` here — the OLDEST
 * run — made every binding look overdue on every tick: all 173 scheduled
 * bindings re-ran their warehouse queries every 15 minutes.
 */
export function isBindingDueAt(
  binding: Pick<AppBinding, "schedule" | "timezone">,
  state: AppBindingStateDoc | null,
  now = new Date(),
): boolean {
  if (!binding.schedule) return false;
  const lastAttempt = state?.history?.[0]?.at ?? null;
  return isDashboardMaterializationDue({
    schedule: {
      enabled: true,
      cron: binding.schedule,
      timezone: binding.timezone,
    },
    lastRefreshedAt: lastAttempt ?? state?.lastMaterializedAt ?? null,
    now,
  });
}

async function isBindingDue(
  projectId: string,
  binding: AppBinding,
): Promise<boolean> {
  if (!binding.schedule) return false;
  return isBindingDueAt(
    binding,
    await getBindingState(projectId, binding.name),
  );
}

export const appsBindingSchedulerFunction = inngest.createFunction(
  {
    id: "scheduled-apps-binding-refresh",
    name: "Scheduled Apps Binding Refresh",
    triggers: { cron: "*/15 * * * *" },
  },
  async ({ step }) => {
    // Only apps that have a project row are scheduled — the same set as
    // before the index existed (a row appears when an app is published,
    // restricted or shared). A scheduled binding in an app nobody has
    // published would otherwise re-run its warehouse query every tick for
    // no reader.
    const scheduled = (await step.run("list-scheduled", async () => {
      const entries = await AppIndexEntry.find({
        "schedules.0": { $exists: true },
      })
        .select("workspaceId appId schedules")
        .lean();
      if (entries.length === 0) return [];
      const rows = await AppProject.find({
        _id: { $in: entries.map(e => e.appId) },
      })
        .select("_id")
        .lean();
      const withRow = new Set(rows.map(r => r._id.toString()));
      return entries.filter(e => withRow.has(e.appId));
    })) as Array<Pick<IAppIndexEntry, "workspaceId" | "appId" | "schedules">>;

    const due = await step.run("find-due-bindings", async () => {
      const out: MaterializeEventData[] = [];
      for (const entry of scheduled) {
        const projectId = entry.appId;
        for (const schedule of entry.schedules) {
          const binding = {
            schedule: schedule.cron,
            timezone: schedule.timezone,
          };
          try {
            if (
              !isBindingDueAt(
                binding,
                await getBindingState(projectId, schedule.binding),
              )
            ) {
              continue;
            }
          } catch (error) {
            log.warn("Invalid binding schedule", {
              projectId,
              binding: schedule.binding,
              error: error instanceof Error ? error.message : String(error),
            });
            continue;
          }
          out.push({
            workspaceId: entry.workspaceId.toString(),
            projectId,
            binding: schedule.binding,
            key: `${projectId}:${schedule.binding}`,
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
      projects: scheduled.length,
      triggered: due.length,
    });
    return { projects: scheduled.length, triggered: due.length };
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
    triggers: { event: APPS_BINDING_MATERIALIZE_EVENT },
  },
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
