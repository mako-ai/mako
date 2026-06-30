/**
 * AI commit-message generation for repo-bound dbt projects.
 *
 * Builds a compact, bounded unified diff of the working tree (reusing the same
 * status/diff computation as the in-IDE git surface) and asks the cheapest
 * utility model — with gateway failover — to write a conventional-commit
 * message. Mirrors the `version-comment.service.ts` pattern.
 */
import { generateText } from "ai";
import { propagateAttributes } from "@langfuse/tracing";
import { createTwoFilesPatch } from "diff";
import { getModel, buildProviderOptions } from "../agent-lib/ai-gateway";
import { getUtilityModelId } from "../agent-lib/ai-models";
import { getUtilityModelIds } from "../services/model-catalog.service";
import type { GatewayLanguageModelOptions } from "@ai-sdk/gateway";
import { trackUsage } from "../services/llm-usage.service";
import { loggers } from "../logging";
import { extractTokenCounts } from "../utils/safe-num";
import type { IDbtProject } from "../database/workspace-schema";
import { getGitStatus, getProjectFileDiff } from "./dbt-github-git.service";

const logger = loggers.app();

// Bounds to keep the prompt cheap and the GitHub blob fan-out reasonable.
const MAX_FILES = 40;
const MAX_FILE_CONTENT_CHARS = 20_000;
const MAX_PATCH_CHARS_PER_FILE = 3_000;
const MAX_PROMPT_CHARS = 12_000;
const MAX_MESSAGE_CHARS = 500;

const COMMIT_MESSAGE_SYSTEM_PROMPT = `You are an expert dbt analytics engineer writing a git commit message for changes to a dbt project (SQL models, YAML schema/config, macros, seeds, docs).

I will send you a unified diff covering one or more changed files. Convert it into a clean, specific Conventional Commits message.

Format:
- First line: "<type>: <summary>" where <type> is one of feat, fix, refactor, chore, docs, test, perf, style. Max 72 characters. Imperative mood (e.g. "add", "fix", "refactor"), no trailing period.
- If more than one file changed or the change is non-trivial, add a blank line then 1-4 short "- " bullet points describing the key changes.

Rules:
- Be specific: reference model/macro names, column names, materializations, tests, filters, joins — not file paths or line numbers.
- Pick the type from the dominant intent: new model/test/column => feat, bug fix => fix, restructuring without behavior change => refactor, docs/yml descriptions => docs, config/version bumps => chore.
- Do NOT wrap the message in quotes or backticks.
- Do NOT invent changes that are not in the diff.
- Respond with ONLY the commit message, nothing else.`;

export interface CommitMessageTrackingContext {
  workspaceId: string;
  userId: string;
  /** User email, used as the Langfuse user identifier when present. */
  userEmail?: string;
}

export interface CommitMessageOptions {
  /** Project-relative paths to summarize; omitted means the full working tree. */
  paths?: string[];
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}\n…(truncated)…` : value;
}

/** Strip the file-header lines from a unified patch, keeping the hunks. */
function patchBody(patch: string): string {
  const lines = patch.split("\n");
  const start = lines.findIndex(l => l.startsWith("@@"));
  if (start === -1) return "";
  return lines.slice(start).join("\n");
}

/**
 * Assemble a bounded, multi-file unified diff for the project's working tree.
 * Returns null when there is nothing meaningful to summarize.
 */
async function buildWorkingTreeDiff(project: IDbtProject): Promise<{
  diff: string;
  fileCount: number;
} | null>;
async function buildWorkingTreeDiff(
  project: IDbtProject,
  options: CommitMessageOptions,
): Promise<{
  diff: string;
  fileCount: number;
} | null>;
async function buildWorkingTreeDiff(
  project: IDbtProject,
  options: CommitMessageOptions = {},
): Promise<{
  diff: string;
  fileCount: number;
} | null> {
  const status = await getGitStatus(project, { paths: options.paths });
  if (!status.hasChanges) return null;

  const changes = status.changes.slice(0, MAX_FILES);
  const omitted = status.changes.length - changes.length;

  const sections = await Promise.all(
    changes.map(async change => {
      try {
        const { base, working } = await getProjectFileDiff(
          project,
          change.path,
        );
        const patch = createTwoFilesPatch(
          change.path,
          change.path,
          truncate(base, MAX_FILE_CONTENT_CHARS),
          truncate(working, MAX_FILE_CONTENT_CHARS),
          "",
          "",
          { context: 3 },
        );
        const body = truncate(patchBody(patch), MAX_PATCH_CHARS_PER_FILE);
        if (!body.trim()) return null;
        return `### ${change.status.toUpperCase()} ${change.path}\n${body}`;
      } catch (error) {
        logger.warn("Failed to diff dbt file for commit message", {
          path: change.path,
          error,
        });
        return `### ${change.status.toUpperCase()} ${change.path}`;
      }
    }),
  );

  const parts = sections.filter((s): s is string => s !== null);
  if (parts.length === 0) return null;

  let diff = parts.join("\n\n");
  if (diff.length > MAX_PROMPT_CHARS) {
    diff = `${diff.slice(0, MAX_PROMPT_CHARS)}\n…(diff truncated)…`;
  }
  if (omitted > 0) {
    diff += `\n\n(${omitted} more changed file${omitted === 1 ? "" : "s"} omitted)`;
  }

  return { diff, fileCount: status.changes.length };
}

/**
 * Generate a Conventional Commits message from a repo-bound dbt project's
 * working-tree changes. Returns null when there are no changes or generation
 * fails (callers should fall back to a manual message).
 */
export async function generateDbtCommitMessage(
  project: IDbtProject,
  trackingCtx?: CommitMessageTrackingContext,
  options: CommitMessageOptions = {},
): Promise<string | null> {
  try {
    const built = await buildWorkingTreeDiff(project, options);
    if (!built) return null;

    const utilityModel = await getUtilityModelId();
    if (!utilityModel) {
      logger.warn("No AI provider configured, skipping commit message");
      return null;
    }
    const failoverModels = await getUtilityModelIds(3);

    const baseOpts = trackingCtx
      ? buildProviderOptions({
          userId: trackingCtx.userId,
          workspaceId: trackingCtx.workspaceId,
          invocationType: "commit_message",
        })
      : {};
    const gatewayBase = (baseOpts.gateway ?? {}) as Record<string, unknown>;

    const prompt = `${built.fileCount} changed file${
      built.fileCount === 1 ? "" : "s"
    }:\n\n${built.diff}`;

    const { text, usage, response } = await propagateAttributes(
      {
        traceName: "dbt-commit-message",
        userId: trackingCtx?.userEmail ?? trackingCtx?.userId,
        tags: ["type:commit_message"],
        metadata: trackingCtx
          ? { workspaceId: trackingCtx.workspaceId }
          : undefined,
      },
      () =>
        generateText({
          model: getModel(utilityModel),
          system: COMMIT_MESSAGE_SYSTEM_PROMPT,
          prompt,
          providerOptions: {
            gateway: {
              ...gatewayBase,
              models: [
                utilityModel,
                ...failoverModels.filter(id => id !== utilityModel),
              ],
            } satisfies GatewayLanguageModelOptions,
          },
          experimental_telemetry: {
            isEnabled: true,
            functionId: "dbt-commit-message",
            metadata: {
              workspaceId: trackingCtx?.workspaceId ?? "unknown",
              invocationType: "commit_message",
            },
          },
        }),
    );

    const actualModelId = (response as Record<string, unknown>)?.modelId as
      | string
      | undefined;
    const modelId = actualModelId || utilityModel;

    if (trackingCtx) {
      const { inputTokens, outputTokens } = extractTokenCounts(
        usage as Record<string, unknown>,
      );
      void trackUsage({
        workspaceId: trackingCtx.workspaceId,
        userId: trackingCtx.userId,
        invocationType: "commit_message",
        modelId,
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      }).catch(err =>
        logger.warn("Failed to track commit message usage", { error: err }),
      );
    }

    let message = text.trim();
    // Strip a wrapping code fence if the model added one.
    message = message.replace(/^```[a-z]*\n?|\n?```$/g, "").trim();
    message = message.substring(0, MAX_MESSAGE_CHARS).trim();

    if (message.length < 3) return null;
    return message;
  } catch (error) {
    logger.error("dbt commit message generation failed", { error });
    return null;
  }
}
