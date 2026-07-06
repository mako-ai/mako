import { generateText } from "ai";
import { propagateAttributes } from "@langfuse/tracing";
import { getModel, buildProviderOptions } from "../agent-lib/ai-gateway";
import { getUtilityModelId } from "../agent-lib/ai-models";
import { getUtilityModelIds } from "./model-catalog.service";
import type { GatewayLanguageModelOptions } from "@ai-sdk/gateway";
import { trackUsage } from "./llm-usage.service";
import { loggers } from "../logging";
import { extractTokenCounts } from "../utils/safe-num";
import { createTwoFilesPatch } from "diff";

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
  /** User email, used as the Langfuse user identifier when present. */
  userEmail?: string;
}

function computeUnifiedDiff(a: string, b: string): string {
  const patch = createTwoFilesPatch("previous", "current", a, b, "", "", {
    context: 3,
  });
  const lines = patch.split("\n");
  const headerEnd = lines.findIndex(l => l.startsWith("@@"));
  if (headerEnd === -1) return "";
  return lines.slice(headerEnd).join("\n");
}

function hasRealChanges(unifiedDiff: string): boolean {
  return unifiedDiff
    .split("\n")
    .some(
      l =>
        (l.startsWith("+") || l.startsWith("-")) &&
        !l.startsWith("+++") &&
        !l.startsWith("---") &&
        !l.startsWith("@@") &&
        l.slice(1).trim() !== "",
    );
}

export function computeDiff(
  previousContent: string,
  newContent: string,
): string | null {
  if (previousContent === newContent) return null;
  if (previousContent.trim() === newContent.trim()) return null;

  const diff = computeUnifiedDiff(previousContent, newContent);
  if (!diff || !hasRealChanges(diff)) return null;
  return diff.substring(0, 4000);
}

export interface VersionCommentResult {
  comment: string | null;
  diff: string | null;
}

/**
 * Shared utility-model call that turns a prompt into a single commit-message
 * line. Routes through the cheapest utility model with gateway failover and
 * tracks usage. Returns null on any failure or an empty/too-short result.
 */
async function generateCommitMessage(
  system: string,
  prompt: string,
  trackingCtx?: VersionCommentTrackingContext,
): Promise<string | null> {
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

  const { text, usage, response } = await propagateAttributes(
    {
      traceName: "version-comment",
      userId: trackingCtx?.userEmail ?? trackingCtx?.userId,
      tags: ["type:version_comment"],
      metadata: trackingCtx
        ? { workspaceId: trackingCtx.workspaceId }
        : undefined,
    },
    () =>
      generateText({
        model: getModel(utilityModel),
        system,
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
          functionId: "version-comment",
          metadata: {
            workspaceId: trackingCtx?.workspaceId ?? "unknown",
            invocationType: "version_comment",
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
}

export async function generateVersionComment(
  context: VersionCommentContext,
  trackingCtx?: VersionCommentTrackingContext,
): Promise<VersionCommentResult> {
  const diff = computeDiff(context.previousContent, context.newContent);
  if (!diff) return { comment: null, diff: null };

  const parts: string[] = [];

  if (context.source === "ai" && context.aiPrompt) {
    parts.push(
      `The user asked the AI assistant to: ${context.aiPrompt.substring(0, 500)}`,
    );
    parts.push("");
  }

  parts.push(diff);

  const prompt = parts.join("\n");

  try {
    const comment = await generateCommitMessage(
      VERSION_COMMENT_SYSTEM_PROMPT,
      prompt,
      trackingCtx,
    );
    return { comment, diff };
  } catch (err) {
    logger.error("Version comment generation failed", { error: err });
    return { comment: null, diff };
  }
}

// ---------------------------------------------------------------------------
// Dashboard version comments
// ---------------------------------------------------------------------------

const DASHBOARD_VERSION_COMMENT_SYSTEM_PROMPT = `You are to act as an author of a version comment for a saved BI dashboard.
Your mission is to create a clean, specific commit message that explains WHAT changed in the dashboard and WHY.
I'll send you a JSON diff of the dashboard definition (widgets, data sources, layout, filters, relationships) and, when available, the chat prompts the user gave the AI that produced the change. You convert this into a single commit message.

Rules:
- Use present tense, imperative mood (e.g. "Add revenue-by-country pie chart", "Switch demos data source to last 40 weeks")
- Be specific: mention widget titles/types, data source names, filters, metrics — not raw JSON keys or array indices
- Prefer the user's intent from the chat prompts when it clarifies the change
- Maximum 72 characters
- Do NOT wrap the message in quotes or backticks
- Do NOT add a trailing period
- Do NOT add any prefix like "feat:" or "fix:"
- Do NOT add explanations beyond the single commit line
- Respond with ONLY the commit message text, nothing else`;

export interface DashboardVersionCommentContext {
  previousSnapshot: Record<string, unknown> | null;
  newSnapshot: Record<string, unknown>;
  /** User prompts from chat sessions that contributed to the change, if any. */
  chatPrompts?: string[];
}

// Server-managed / materialization state that is irrelevant to a human-facing
// "what changed" commit message and only adds noise to the JSON diff.
const VOLATILE_SNAPSHOT_KEYS = new Set(["cache", "snapshots"]);

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      if (VOLATILE_SNAPSHOT_KEYS.has(key)) continue;
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(sortKeysDeep(value), null, 2);
  } catch {
    return "";
  }
}

/**
 * Diff two dashboard snapshots by stable-stringifying their JSON (sorted keys
 * so unrelated reordering doesn't show up) and producing a unified diff.
 */
export function computeSnapshotDiff(
  previousSnapshot: Record<string, unknown> | null,
  newSnapshot: Record<string, unknown>,
): string | null {
  const prev = previousSnapshot ? stableStringify(previousSnapshot) : "";
  const next = stableStringify(newSnapshot);
  return computeDiff(prev, next);
}

/**
 * Shared "diff + chat prompts → single commit line" pipeline used by the
 * dashboard and app version-comment generators. The caller supplies the
 * entity-appropriate system prompt, precomputed diff and diff label; this
 * folds in the chat prompts block and calls the utility model.
 */
async function generateSnapshotVersionComment(opts: {
  systemPrompt: string;
  diff: string | null;
  diffLabel: string;
  chatPrompts?: string[];
  entityLabel: string;
  trackingCtx?: VersionCommentTrackingContext;
}): Promise<VersionCommentResult> {
  const { diff } = opts;
  if (!diff) return { comment: null, diff: null };

  const parts: string[] = [];

  const prompts = (opts.chatPrompts ?? [])
    .map(p => p.trim())
    .filter(Boolean)
    .slice(-6);
  if (prompts.length > 0) {
    parts.push(`Chat prompts that drove these ${opts.entityLabel} changes:`);
    for (const p of prompts) {
      parts.push(`- ${p.substring(0, 300)}`);
    }
    parts.push("");
  }

  parts.push(`${opts.diffLabel}:`);
  parts.push(diff);

  try {
    const comment = await generateCommitMessage(
      opts.systemPrompt,
      parts.join("\n"),
      opts.trackingCtx,
    );
    return { comment, diff };
  } catch (err) {
    logger.error(`${opts.entityLabel} version comment generation failed`, {
      error: err,
    });
    return { comment: null, diff };
  }
}

export async function generateDashboardVersionComment(
  context: DashboardVersionCommentContext,
  trackingCtx?: VersionCommentTrackingContext,
): Promise<VersionCommentResult> {
  return generateSnapshotVersionComment({
    systemPrompt: DASHBOARD_VERSION_COMMENT_SYSTEM_PROMPT,
    diff: computeSnapshotDiff(context.previousSnapshot, context.newSnapshot),
    diffLabel: "Dashboard definition diff",
    chatPrompts: context.chatPrompts,
    entityLabel: "dashboard",
    trackingCtx,
  });
}

// ---------------------------------------------------------------------------
// App version comments (multi-file)
// ---------------------------------------------------------------------------

const APP_VERSION_COMMENT_SYSTEM_PROMPT = `You are to act as an author of a version comment for a saved React app built in a BI tool.
Your mission is to create a clean, specific commit message that explains WHAT changed in the app and WHY.
I'll send you per-file diffs of the app's source files (plus a JSON diff of metadata like data bindings and dependencies) and, when available, the chat prompts the user gave the AI that produced the change. You convert this into a single commit message.

Rules:
- Use present tense, imperative mood (e.g. "Add revenue chart to overview page", "Wire orders table to live query")
- Summarize the overall intent across all files — do not list file names one by one
- Be specific: mention component names, features, data bindings, dependencies — not line numbers
- Prefer the user's intent from the chat prompts when it clarifies the change
- Maximum 72 characters
- Do NOT wrap the message in quotes or backticks
- Do NOT add a trailing period
- Do NOT add any prefix like "feat:" or "fix:"
- Do NOT add explanations beyond the single commit line
- Respond with ONLY the commit message text, nothing else`;

export interface AppVersionCommentContext {
  previousSnapshot: Record<string, unknown> | null;
  newSnapshot: Record<string, unknown>;
  /** User prompts from chat sessions that contributed to the change, if any. */
  chatPrompts?: string[];
}

interface SnapshotFileEntry {
  path: string;
  contents: string;
}

function asFileEntries(
  snapshot: Record<string, unknown> | null,
): SnapshotFileEntry[] {
  if (!snapshot || !Array.isArray(snapshot.files)) return [];
  return (snapshot.files as unknown[]).flatMap(f => {
    if (!f || typeof f !== "object") return [];
    const { path, contents } = f as Record<string, unknown>;
    if (typeof path !== "string") return [];
    return [{ path, contents: typeof contents === "string" ? contents : "" }];
  });
}

function countDiffLines(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    else if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  return { added, removed };
}

// Apps diff over many files, so the budget is larger than the single-query
// console cap but still bounded for the utility model. Files that don't fit
// degrade to one-line "+N/-M lines" stats instead of being dropped.
const APP_DIFF_TOTAL_BUDGET = 9000;
const APP_DIFF_PER_FILE_BUDGET = 1800;

/**
 * Diff two app snapshots as a git-style multi-file diff: a per-file unified
 * diff for each added/removed/modified source file plus a JSON diff of the
 * non-file metadata (title, data bindings, dependencies, ...). Once the total
 * budget is spent, remaining files are summarized as line-count stats.
 */
export function computeAppMultiFileDiff(
  previousSnapshot: Record<string, unknown> | null,
  newSnapshot: Record<string, unknown>,
): string | null {
  const stripFiles = (s: Record<string, unknown> | null) => {
    if (!s) return null;
    const { files: _files, ...rest } = s;
    return rest;
  };

  const metaDiff = computeSnapshotDiff(
    stripFiles(previousSnapshot),
    stripFiles(newSnapshot) ?? {},
  );

  const prevMap = new Map(
    asFileEntries(previousSnapshot).map(f => [f.path, f.contents]),
  );
  const nextMap = new Map(
    asFileEntries(newSnapshot).map(f => [f.path, f.contents]),
  );
  const paths = [...new Set([...prevMap.keys(), ...nextMap.keys()])].sort();

  const sections: string[] = [];
  let used = metaDiff?.length ?? 0;

  for (const path of paths) {
    const prev = prevMap.get(path);
    const next = nextMap.get(path);
    if (prev === next) continue;

    let header: string;
    let body: string | null;
    if (prev === undefined) {
      header = `Added file: ${path}`;
      body = computeUnifiedDiff("", next ?? "");
    } else if (next === undefined) {
      header = `Deleted file: ${path}`;
      body = null;
    } else {
      header = `Modified file: ${path}`;
      body = computeUnifiedDiff(prev, next);
      if (!body || !hasRealChanges(body)) continue;
    }

    let section = header;
    if (body) {
      const { added, removed } = countDiffLines(body);
      const fits =
        used + body.length <= APP_DIFF_TOTAL_BUDGET &&
        body.length <= APP_DIFF_PER_FILE_BUDGET;
      section = fits
        ? `${header}\n${body}`
        : `${header} (+${added}/-${removed} lines, diff omitted)`;
    }
    used += section.length;
    sections.push(section);
  }

  const parts: string[] = [];
  if (sections.length > 0) parts.push(sections.join("\n\n"));
  if (metaDiff) parts.push(`App metadata diff (non-file fields):\n${metaDiff}`);
  if (parts.length === 0) return null;
  return parts.join("\n\n");
}

export async function generateAppVersionComment(
  context: AppVersionCommentContext,
  trackingCtx?: VersionCommentTrackingContext,
): Promise<VersionCommentResult> {
  return generateSnapshotVersionComment({
    systemPrompt: APP_VERSION_COMMENT_SYSTEM_PROMPT,
    diff: computeAppMultiFileDiff(
      context.previousSnapshot,
      context.newSnapshot,
    ),
    diffLabel: "App definition diff",
    chatPrompts: context.chatPrompts,
    entityLabel: "app",
    trackingCtx,
  });
}
