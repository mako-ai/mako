/** Synchronous runner invocations: ad-hoc compile, preview and the command bar. */
import { Hono } from "hono";
import { z } from "zod";
import { AuthenticatedContext } from "../../middleware/workspace.middleware";
import { getCheckoutBranch } from "../../dbt/dbt-working-tree.service";
import { dbtWorkingTreeUserFor } from "../../dbt/rbac";
import {
  DbtCommandValidationError,
  isWarehouseWriteCommand,
  parseDbtCommand,
} from "../../dbt/commands";
import {
  DBT_PREVIEW_DEFAULT_LIMIT,
  DBT_PREVIEW_MAX_LIMIT,
  parseDbtShowPreview,
} from "../../dbt/dbt-show";
import {
  loadDbtDeferState,
  runAdhocDbtCommand,
} from "../../dbt/dbt-project.service";
import { recordCompletedAdhocDbtRun } from "../../dbt/dbt-run.service";
import {
  getUserId,
  badRequest,
  serverError,
  publishDbtEvent,
  findProject,
} from "./context";
import { fail } from "../lib/respond";

export const dbtCommandRoutes = new Hono();

// ---------------------------------------------------------------------------
// Ad-hoc compile / command (synchronous runner invocations)
// ---------------------------------------------------------------------------

const adhocSchema = z.object({
  select: z.string().min(1).max(256).optional(),
  environment: z.string().min(1).optional(),
  /** Slim CI: resolve unselected refs against the last prod manifest. */
  defer: z.boolean().optional(),
});

const commandSchema = z.object({
  command: z.string().min(1).max(512),
  environment: z.string().min(1).optional(),
  defer: z.boolean().optional(),
});

const previewSchema = z.object({
  select: z.string().min(1).max(256),
  environment: z.string().min(1).optional(),
  defer: z.boolean().optional(),
  limit: z.number().int().min(1).max(DBT_PREVIEW_MAX_LIMIT).optional(),
});

const SELECT_PATTERN = /^[\w.+@:*\-/]+$/;

// Shared with the agent tools: reads the last prod manifest for
// `--defer --state` (see dbt-project.service.ts).
const loadDeferState = loadDbtDeferState;

/**
 * Prepend a warning when defer was requested but no prod manifest exists, so
 * the UI doesn't silently run without `--defer`. Mutates and returns `logs`.
 */
function noteDeferUnavailable<
  T extends { ts: Date; level: string; line: string },
>(logs: T[], deferRequested: boolean, deferState: Buffer | undefined): T[] {
  if (deferRequested && !deferState) {
    logs.unshift({
      ts: new Date(),
      level: "warn",
      line: "Defer requested but this project has no production manifest yet — ran without --defer. Run the prod environment once to enable defer.",
    } as T);
  }
  return logs;
}

dbtCommandRoutes.post(
  "/projects/:projectId/compile",
  async (c: AuthenticatedContext) => {
    try {
      const project = await findProject(c);
      if (!project) {
        return fail(c, 404, "dbt project not found");
      }
      const parsed = adhocSchema.safeParse(
        await c.req.json().catch(() => ({})),
      );
      if (!parsed.success) {
        return badRequest(c, parsed.error.issues[0]?.message ?? "Invalid body");
      }
      const { select, environment, defer } = parsed.data;
      if (select && !SELECT_PATTERN.test(select)) {
        return badRequest(c, "Invalid --select value");
      }
      const command = select ? `compile --select ${select}` : "parse";
      const deferState = defer ? await loadDeferState(project) : undefined;
      const result = await runAdhocDbtCommand({
        workspaceId: project.workspaceId.toString(),
        projectId: project._id.toString(),
        environmentName: environment,
        // Members compile the committed tracked branch, never drafts.
        userId: dbtWorkingTreeUserFor(c.get("memberRole"), getUserId(c)),
        command,
        select,
        deferState,
        timeoutMs: 3 * 60 * 1000,
      });
      return c.json({
        success: true,
        compile: {
          ok: result.success,
          exitCode: result.exitCode,
          compiledSql: result.compiledSql,
          logs: noteDeferUnavailable(result.logs, !!defer, deferState),
        },
      });
    } catch (error) {
      return serverError(c, error, "Failed to compile dbt project");
    }
  },
);

// Preview (editor Preview button / ⌘↵). Runs `show --select <node> --limit N
// --output json`: a bounded SELECT over the model's compiled SQL that never
// materializes anything, so it is safe on every environment including prod and
// is deliberately NOT recorded into run history. Returns structured rows for
// the Results grid; `preview: null` means dbt produced no ShowNode payload
// (compile error — read `logs`).
dbtCommandRoutes.post(
  "/projects/:projectId/preview",
  async (c: AuthenticatedContext) => {
    try {
      const project = await findProject(c);
      if (!project) {
        return fail(c, 404, "dbt project not found");
      }
      const parsed = previewSchema.safeParse(
        await c.req.json().catch(() => ({})),
      );
      if (!parsed.success) {
        return badRequest(c, parsed.error.issues[0]?.message ?? "Invalid body");
      }
      const { select, environment, defer, limit } = parsed.data;
      if (!SELECT_PATTERN.test(select)) {
        return badRequest(c, "Invalid --select value");
      }
      const rowLimit = limit ?? DBT_PREVIEW_DEFAULT_LIMIT;
      const deferState = defer ? await loadDeferState(project) : undefined;
      const result = await runAdhocDbtCommand({
        workspaceId: project.workspaceId.toString(),
        projectId: project._id.toString(),
        environmentName: environment,
        // Members preview the committed tracked branch, never drafts.
        userId: dbtWorkingTreeUserFor(c.get("memberRole"), getUserId(c)),
        command: `show --select ${select} --limit ${rowLimit} --output json`,
        deferState,
        timeoutMs: 3 * 60 * 1000,
      });
      const preview = parseDbtShowPreview(result.logs);
      return c.json({
        success: true,
        preview: {
          ok: result.success && preview !== null,
          exitCode: result.exitCode,
          limit: rowLimit,
          columns: preview?.columns ?? [],
          rows: preview?.rows ?? [],
          node: preview?.node,
          logs: noteDeferUnavailable(result.logs, !!defer, deferState),
        },
      });
    } catch (error) {
      return serverError(c, error, "Failed to preview dbt model");
    }
  },
);

// Free-form command bar + editor Run menu (dbt Cloud parity). The command is
// tokenized and validated against the same allowlist as stored jobs before it
// reaches the runner, so no extra CLI surface (--profiles-dir, shell
// metachars) leaks in. Runs synchronously against the CALLER's working tree
// (checkout + drafts); warehouse-writing commands are recorded post-hoc into
// dbt_runs so editor runs appear in the Runs history with provenance.
dbtCommandRoutes.post(
  "/projects/:projectId/command",
  async (c: AuthenticatedContext) => {
    try {
      const project = await findProject(c);
      if (!project) {
        return fail(c, 404, "dbt project not found");
      }
      const parsed = commandSchema.safeParse(
        await c.req.json().catch(() => ({})),
      );
      if (!parsed.success) {
        return badRequest(c, parsed.error.issues[0]?.message ?? "Invalid body");
      }
      const { command, environment, defer } = parsed.data;
      // Accept an optional leading "dbt" so users can paste full commands.
      const normalized = command.trim().replace(/^dbt\s+/i, "");
      let validated;
      try {
        validated = parseDbtCommand(normalized);
      } catch (error) {
        if (error instanceof DbtCommandValidationError) {
          return badRequest(c, error.message);
        }
        throw error;
      }
      // Members may run read-only commands (parse/compile/show/ls) only;
      // anything that writes the warehouse is admin+ (see dbt/rbac.ts).
      const role = c.get("memberRole");
      if (
        isWarehouseWriteCommand(validated) &&
        role !== "owner" &&
        role !== "admin"
      ) {
        return fail(
          c,
          403,
          "Commands that write the warehouse require the admin or owner workspace role",
        );
      }
      const userId = getUserId(c);
      const startedAt = new Date();
      const deferState = defer ? await loadDeferState(project) : undefined;
      const result = await runAdhocDbtCommand({
        workspaceId: project.workspaceId.toString(),
        projectId: project._id.toString(),
        environmentName: environment,
        // Members run read-only commands on the committed tracked branch.
        userId: dbtWorkingTreeUserFor(role, userId),
        command: normalized,
        deferState,
        timeoutMs: 9 * 60 * 1000,
      });

      // Editor/console runs that WROTE to the warehouse join the same run
      // history as agent/job runs. Read-only commands (parse/compile/show)
      // stay ephemeral — recording every live compile would flood the list.
      if (isWarehouseWriteCommand(validated)) {
        const recorded = await recordCompletedAdhocDbtRun({
          workspaceId: project.workspaceId.toString(),
          projectId: project._id.toString(),
          environment: environment ?? project.defaultEnvironment,
          command: normalized,
          triggeredBy: userId,
          workingTreeUserId: userId,
          sourceBranch: await getCheckoutBranch(project, userId),
          deferToProduction: Boolean(defer && deferState),
          startedAt,
          result,
        });
        if (recorded) {
          publishDbtEvent(c, {
            type: "dbt.run.updated",
            projectId: project._id.toString(),
            runId: recorded._id.toString(),
          });
        }
      }

      return c.json({
        success: true,
        result: {
          ok: result.success,
          exitCode: result.exitCode,
          subcommand: validated.subcommand,
          stepResults: result.stepResults,
          logs: noteDeferUnavailable(result.logs, !!defer, deferState),
        },
      });
    } catch (error) {
      return serverError(c, error, "Failed to run dbt command");
    }
  },
);
