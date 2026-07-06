/**
 * Tests for the deterministic tool-call input repair
 * (agent-lib/tool-input-repair.ts).
 *
 * Covers the schema-guided coercion unit (stringified arrays/objects/numbers/
 * booleans, no-ops on already-valid input) and an end-to-end generateText run
 * through the AI SDK's experimental_repairToolCall hook with a mock model that
 * emits a dbt_create_job-style call whose `commands` array arrives
 * JSON-stringified.
 *
 * Run: tsx src/agent-lib/tool-input-repair.test.ts
 */
import assert from "node:assert/strict";
import { generateText, stepCountIs, tool, type JSONSchema7 } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import {
  coerceValueToSchema,
  repairStringifiedToolInputs,
} from "./tool-input-repair";

type GenerateResult = Awaited<
  ReturnType<MockLanguageModelV3["doGenerate"]>
>;

/**
 * Sequential mock model. (MockLanguageModelV3's built-in array form indexes
 * by post-push call count and skips the first element, so we sequence with
 * our own counter.)
 */
function mockModel(results: GenerateResult[]): MockLanguageModelV3 {
  let call = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => results[Math.min(call++, results.length - 1)],
  });
}

function t(label: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve(fn()).then(() => {
    process.stdout.write(`ok  ${label}\n`);
  });
}

const jobSchema: JSONSchema7 = {
  type: "object",
  properties: {
    projectId: { type: "string" },
    name: { type: "string" },
    commands: { type: "array", items: { type: "string", minLength: 1 } },
    schedule: {
      type: "object",
      properties: { cron: { type: "string" }, timezone: { type: "string" } },
    },
    enabled: { type: "boolean" },
    prNumber: { type: "integer" },
  },
};

async function main() {
  await t("parses a stringified array when the schema expects array", () => {
    const coerced = coerceValueToSchema(
      { commands: '["build --select tag:nightly", "test"]' },
      jobSchema,
    );
    assert.deepEqual(coerced, {
      commands: ["build --select tag:nightly", "test"],
    });
  });

  await t("parses a stringified object when the schema expects object", () => {
    const coerced = coerceValueToSchema(
      { schedule: '{"cron":"0 6 * * *","timezone":"UTC"}' },
      jobSchema,
    );
    assert.deepEqual(coerced, {
      schedule: { cron: "0 6 * * *", timezone: "UTC" },
    });
  });

  await t("coerces numeric and boolean strings", () => {
    const coerced = coerceValueToSchema(
      { prNumber: "42", enabled: "true" },
      jobSchema,
    );
    assert.deepEqual(coerced, { prNumber: 42, enabled: true });
  });

  await t("leaves already-valid input untouched", () => {
    const input = {
      projectId: "p1",
      commands: ["build"],
      schedule: { cron: "0 6 * * *", timezone: "UTC" },
      enabled: false,
    };
    assert.deepEqual(coerceValueToSchema(input, jobSchema), input);
  });

  await t("never coerces when the schema also allows string", () => {
    const schema: JSONSchema7 = {
      type: "object",
      properties: { id: { type: ["string", "integer"] } },
    };
    assert.deepEqual(coerceValueToSchema({ id: "42" }, schema), { id: "42" });
  });

  await t("leaves non-JSON strings alone even when array expected", () => {
    const coerced = coerceValueToSchema({ commands: "build" }, jobSchema);
    assert.deepEqual(coerced, { commands: "build" });
  });

  await t("walks nested anyOf variants", () => {
    const schema: JSONSchema7 = {
      type: "object",
      properties: {
        paths: { anyOf: [{ type: "array", items: { type: "string" } }] },
      },
    };
    assert.deepEqual(coerceValueToSchema({ paths: '["a.sql"]' }, schema), {
      paths: ["a.sql"],
    });
  });

  // End-to-end: the SDK rejects the stringified `commands`, the repair hook
  // fixes it, and the tool executes with the parsed array.
  await t("repairs a stringified array through generateText", async () => {
    const received: unknown[] = [];
    const model = mockModel([
      {
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "dbt_create_job",
            input: JSON.stringify({
              projectId: "p1",
              name: "one-off",
              commands:
                '["build --select int_engagement__org_team_expansion+"]',
            }),
          },
        ],
        finishReason: "tool-calls",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      },
      {
        content: [{ type: "text", text: "done" }],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      },
    ]);

    const result = await generateText({
      model,
      prompt: "create the job",
      stopWhen: stepCountIs(3),
      experimental_repairToolCall: repairStringifiedToolInputs,
      tools: {
        dbt_create_job: tool({
          description: "Create a saved dbt job",
          inputSchema: z.object({
            projectId: z.string(),
            name: z.string(),
            commands: z.array(z.string().min(1)).min(1).max(10),
          }),
          execute: async input => {
            received.push(input);
            return { success: true };
          },
        }),
      },
    });

    assert.equal(received.length, 1);
    assert.deepEqual(received[0], {
      projectId: "p1",
      name: "one-off",
      commands: ["build --select int_engagement__org_team_expansion+"],
    });
    assert.equal(result.text, "done");
  });

  // Genuinely invalid input (wrong shape that coercion cannot fix) must NOT
  // be silently executed — the SDK surfaces the standard invalid-input error
  // result and the tool never runs.
  await t("does not mask genuinely invalid input", async () => {
    const received: unknown[] = [];
    const model = mockModel([
      {
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "dbt_create_job",
            input: JSON.stringify({ projectId: "p1" }),
          },
        ],
        finishReason: "tool-calls",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      },
      {
        content: [{ type: "text", text: "done" }],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      },
    ]);

    const result = await generateText({
      model,
      prompt: "create the job",
      stopWhen: stepCountIs(3),
      experimental_repairToolCall: repairStringifiedToolInputs,
      tools: {
        dbt_create_job: tool({
          description: "Create a saved dbt job",
          inputSchema: z.object({
            projectId: z.string(),
            commands: z.array(z.string().min(1)).min(1),
          }),
          execute: async input => {
            received.push(input);
            return { success: true };
          },
        }),
      },
    });

    assert.equal(received.length, 0);
    const errorParts = result.steps
      .flatMap(step => step.content)
      .filter(part => part.type === "tool-error");
    assert.ok(errorParts.length > 0, "expected a tool-error content part");
  });

  process.stdout.write("tool-input-repair tests passed\n");
}

void main();
