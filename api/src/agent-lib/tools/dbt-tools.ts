/**
 * Server-side dbt verification tools.
 *
 * The agent edits dbt files through the CLIENT tools (create_dbt_file /
 * modify_dbt_file in @mako/agent-tools) and then verifies its work here:
 *   dbt_parse          — project-wide validation after YAML edits
 *   dbt_compile_model  — Jinja render check, returns compiled SQL
 *   dbt_run_model      — `build --select <model>` on the dev environment,
 *                        returns step results incl. test outcomes
 *   dbt_run_job        — trigger a saved job (requires explicit user
 *                        confirmation in the prompt, like schedule_query)
 *
 * All tools go through the same workspace-scoped ad-hoc service path as the
 * IDE buttons (api/src/dbt/dbt-project.service.ts).
 */

import { tool } from "ai";
import { z } from "zod";
import { Types } from "mongoose";
import { DbtJob, DbtProject } from "../../database/workspace-schema";
import { runAdhocDbtCommand } from "../../dbt/dbt-project.service";
import { triggerDbtJobRun } from "../../dbt/dbt-run.service";
import type { DbtLogLine } from "../../dbt/runner.service";

const MODEL_NAME_PATTERN = /^[\w.]+$/;

const projectIdField = z
  .string()
  .describe("dbt project ID (from read_dbt_project_tree)");

function toolError(error: unknown, fallback: string) {
  return {
    success: false,
    error: error instanceof Error ? error.message : fallback,
  };
}

/** Keep tool outputs small: errors + warnings + last few info lines. */
function summarizeLogs(logs: DbtLogLine[], maxLines = 30): string[] {
  const important = logs.filter(
    log => log.level === "error" || log.level === "warn",
  );
  const rest = logs.filter(
    log => log.level !== "error" && log.level !== "warn",
  );
  const selected = [...important, ...rest.slice(-10)].slice(0, maxLines);
  return selected.map(log => `[${log.level}] ${log.line}`);
}

export const createDbtServerTools = (workspaceId: string) => {
  const assertProject = async (projectId: string) => {
    if (!Types.ObjectId.isValid(projectId)) {
      throw new Error("Invalid dbt project id");
    }
    const project = await DbtProject.findOne({
      _id: new Types.ObjectId(projectId),
      workspaceId: new Types.ObjectId(workspaceId),
    });
    if (!project) throw new Error("dbt project not found or access denied");
    return project;
  };

  return {
    dbt_parse: tool({
      description:
        "Validate the entire dbt project (dbt parse): catches Jinja errors, " +
        "bad refs/sources, and schema.yml problems WITHOUT touching the " +
        "warehouse. Run this after editing YAML or multiple files.",
      inputSchema: z.object({
        projectId: projectIdField,
        environment: z
          .string()
          .optional()
          .describe("Environment name; defaults to the project default (dev)"),
      }),
      execute: async ({ projectId, environment }) => {
        try {
          await assertProject(projectId);
          const result = await runAdhocDbtCommand({
            workspaceId,
            projectId,
            environmentName: environment,
            command: "parse",
            timeoutMs: 2 * 60 * 1000,
          });
          return {
            success: result.success,
            ...(result.success
              ? { message: "Project parsed successfully" }
              : { error: "dbt parse failed" }),
            logs: summarizeLogs(result.logs),
          };
        } catch (error) {
          return toolError(error, "Failed to run dbt parse");
        }
      },
    }),

    dbt_compile_model: tool({
      description:
        "Compile one dbt model (dbt compile --select <model>) and return the " +
        "rendered SQL, or the Jinja/compilation error. No warehouse writes. " +
        "Use after writing or editing a model to verify it renders.",
      inputSchema: z.object({
        projectId: projectIdField,
        model: z
          .string()
          .describe("Model name without extension, e.g. stg_orders"),
        environment: z.string().optional(),
      }),
      execute: async ({ projectId, model, environment }) => {
        try {
          if (!MODEL_NAME_PATTERN.test(model)) {
            return { success: false, error: "Invalid model name" };
          }
          await assertProject(projectId);
          const result = await runAdhocDbtCommand({
            workspaceId,
            projectId,
            environmentName: environment,
            command: `compile --select ${model}`,
            select: model,
            timeoutMs: 3 * 60 * 1000,
          });
          return {
            success: result.success,
            compiledSql: result.compiledSql,
            logs: summarizeLogs(result.logs),
          };
        } catch (error) {
          return toolError(error, "Failed to compile model");
        }
      },
    }),

    dbt_run_model: tool({
      description:
        "Build one dbt model AND its tests (dbt build --select <model>) " +
        "against the project's dev environment (or the given environment). " +
        "This WRITES to the warehouse target schema. Returns per-node status, " +
        "timing, rows affected, and test pass/fail outcomes. Use this as the " +
        "final verification after compile succeeds.",
      inputSchema: z.object({
        projectId: projectIdField,
        model: z
          .string()
          .describe("Model name without extension, e.g. stg_orders"),
        environment: z
          .string()
          .optional()
          .describe(
            "Environment name; defaults to the project default (dev). Only " +
              "use prod when the user explicitly asks.",
          ),
      }),
      execute: async ({ projectId, model, environment }) => {
        try {
          if (!MODEL_NAME_PATTERN.test(model)) {
            return { success: false, error: "Invalid model name" };
          }
          await assertProject(projectId);
          const result = await runAdhocDbtCommand({
            workspaceId,
            projectId,
            environmentName: environment,
            command: `build --select ${model}`,
            select: model,
            timeoutMs: 5 * 60 * 1000,
          });
          return {
            success: result.success,
            stepResults: result.stepResults,
            logs: summarizeLogs(result.logs),
          };
        } catch (error) {
          return toolError(error, "Failed to run model");
        }
      },
    }),

    dbt_run_job: tool({
      description:
        "Trigger a saved dbt job (full command list, possibly against prod). " +
        "Runs asynchronously via the job runner; returns the runId to share " +
        "with the user. Only call after the user explicitly confirms which " +
        "job to run — never trigger prod jobs proactively.",
      inputSchema: z.object({
        projectId: projectIdField,
        jobId: z.string().describe("dbt job ID (from read_dbt_project_tree)"),
      }),
      execute: async ({ projectId, jobId }) => {
        try {
          const project = await assertProject(projectId);
          if (!Types.ObjectId.isValid(jobId)) {
            return { success: false, error: "Invalid job id" };
          }
          const job = await DbtJob.findOne({
            _id: new Types.ObjectId(jobId),
            projectId: project._id,
          });
          if (!job) return { success: false, error: "Job not found" };
          const run = await triggerDbtJobRun({
            workspaceId,
            job,
            trigger: "agent",
            triggeredBy: "agent",
          });
          return {
            success: true,
            runId: run._id.toString(),
            jobName: job.name,
            environment: job.environment,
            commands: job.commands,
            message:
              "Run queued. The user can watch live logs in the job tab " +
              "(Transforms → Jobs).",
          };
        } catch (error) {
          return toolError(error, "Failed to trigger job");
        }
      },
    }),
  };
};
