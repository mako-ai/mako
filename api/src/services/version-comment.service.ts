import { generateText } from "ai";
import { getModel, buildProviderOptions } from "../agent-lib/ai-gateway";
import { getUtilityModelId } from "../agent-lib/ai-models";
import { getUtilityModelIds } from "./model-catalog.service";
import type { GatewayLanguageModelOptions } from "@ai-sdk/gateway";
import { trackUsage } from "./llm-usage.service";
import { loggers } from "../logging";
import { extractTokenCounts } from "../utils/safe-num";

const logger = loggers.app();

const VERSION_COMMENT_SYSTEM_PROMPT = `You are to act as an author of a version comment for a saved database query (SQL, MongoDB, etc).
Your mission is to create a clean and comprehensive commit message that explains WHAT changed and WHY.
I'll send you a diff of the query changes, and you convert it into a commit message.

Rules:
- Use present tense, imperative mood (e.g. "Add filter", "Refactor subquery", "Fix join condition")
- Be specific: mention table names, column names, filters, joins, aggregations — not line numbers
- Maximum 72 characters
- Do NOT wrap the message in quotes or backticks
- Do NOT add a trailing period
- Do NOT add any prefix like "feat:" or "fix:"
- Do NOT add explanations or descriptions beyond the single commit line
- Your entire response will be used directly as the version comment
- Respond with ONLY the commit message text, nothing else

Example:
Given a diff that changes \`WHERE status = 'active'\` to \`WHERE status = 'active' AND created_at > '2024-01-01'\`, you respond:
Add created_at filter to restrict to records after 2024-01-01`;

export interface VersionCommentContext {
  previousContent: string;
  newContent: string;
  language: string;
  source: "user" | "ai";
  title?: string;
  aiPrompt?: string;
}

export interface VersionCommentTrackingContext {
  workspaceId: string;
  userId: string;
}

function computeSimpleLineDiff(a: string, b: string): string {
  const aLines = a.split("\n");
  const bLines = b.split("\n");
  const result: string[] = [];

  const maxLen = Math.max(aLines.length, bLines.length);
  for (let i = 0; i < maxLen; i++) {
    const aLine = i < aLines.length ? aLines[i] : undefined;
    const bLine = i < bLines.length ? bLines[i] : undefined;

    if (aLine === bLine) continue;
    if (aLine !== undefined && (bLine === undefined || aLine !== bLine)) {
      result.push(`- ${aLine}`);
    }
    if (bLine !== undefined && (aLine === undefined || aLine !== bLine)) {
      result.push(`+ ${bLine}`);
    }
  }

  return result.join("\n");
}

function isWhitespaceOnly(diff: string): boolean {
  return diff.split("\n").every(line => {
    if (!line.startsWith("+ ") && !line.startsWith("- ")) return true;
    const content = line.slice(2);
    return content.trim() === "";
  });
}

export async function generateVersionComment(
  context: VersionCommentContext,
  trackingCtx?: VersionCommentTrackingContext,
): Promise<string | null> {
  if (context.previousContent === context.newContent) return null;
  if (context.previousContent.trim() === context.newContent.trim()) return null;

  const diff = computeSimpleLineDiff(
    context.previousContent.substring(0, 3000),
    context.newContent.substring(0, 3000),
  );

  if (!diff || isWhitespaceOnly(diff)) return null;

  const truncatedDiff = diff.substring(0, 3000);

  const parts: string[] = [];

  if (context.source === "ai" && context.aiPrompt) {
    parts.push(
      `The user asked the AI assistant to: ${context.aiPrompt.substring(0, 500)}`,
    );
    parts.push("");
  }

  parts.push(`\`\`\`diff`);
  parts.push(truncatedDiff);
  parts.push(`\`\`\``);

  const prompt = parts.join("\n");

  try {
    const utilityModel = await getUtilityModelId();
    if (!utilityModel) return null;

    const failoverModels = await getUtilityModelIds(3);

    const baseOpts = trackingCtx
      ? buildProviderOptions({
          userId: trackingCtx.userId,
          workspaceId: trackingCtx.workspaceId,
          invocationType: "version_comment",
        })
      : {};
    const gatewayBase = (baseOpts.gateway ?? {}) as Record<string, unknown>;

    const { text, usage, response } = await generateText({
      model: getModel(utilityModel),
      system: VERSION_COMMENT_SYSTEM_PROMPT,
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
    });

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
        invocationType: "version_comment",
        modelId,
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      }).catch(err =>
        logger.warn("Failed to track version comment usage", { error: err }),
      );
    }

    let comment = text.trim();
    comment = comment.replace(/^["']|["']$/g, "");
    comment = comment.replace(/\.+$/, "");
    comment = comment.substring(0, 72);

    if (comment.length < 3) return null;
    return comment;
  } catch (err) {
    logger.error("Version comment generation failed", { error: err });
    return null;
  }
}
