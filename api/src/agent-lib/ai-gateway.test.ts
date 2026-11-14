/**
 * Spend attribution on gateway calls, and the prompt cache options.
 *
 * Vercel's Custom Reporting groups the bill by `user` and by `tag`, and the
 * workspace connector's `usage-by-tag` / `usage-by-user` entities land those
 * groupings in the warehouse. A request without them is a row with an empty
 * tag that nobody can explain, so every helper here must always emit a
 * `type:` tag and a user, falling back to `system`, and stay inside Vercel's
 * limits (≤10 tags of 1–64 chars, user ≤256 chars). The source scan at the end
 * fails on any new gateway call that forgets its attribution.
 *
 * Run: tsx src/agent-lib/ai-gateway.test.ts
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { embed, generateText } from "ai";
import ts from "typescript";
import {
  SYSTEM_ATTRIBUTION_USER,
  attributionProviderOptions,
  buildPromptCacheHeaders,
  buildProviderOptions,
  gatewayAttributionOptions,
  getEmbeddingModel,
  getModel,
  systemProviderOptions,
  withGatewayAttribution,
} from "./ai-gateway";

function t(label: string, fn: () => void) {
  fn();
  process.stdout.write(`ok  ${label}\n`);
}

const WS = "6846e6a01b05af0948070582";

const base = {
  userId: "user-1",
  workspaceId: "ws-1",
  agentId: "unified",
  invocationType: "chat",
};

t("no cache session → gateway metadata only, no caching", () => {
  assert.deepEqual(buildProviderOptions(base), {
    gateway: {
      user: "user-1",
      tags: ["ws:ws-1", "agent:unified", "type:chat"],
    },
  });
});

t("cache session → gateway auto caching + OpenAI cache key", () => {
  const opts = buildProviderOptions({
    ...base,
    promptCacheSessionId: "chat-42",
  });
  assert.equal(opts.gateway.caching, "auto");
  assert.equal(opts.gateway.user, "user-1");
  assert.deepEqual(opts.gateway.tags, [
    "ws:ws-1",
    "agent:unified",
    "type:chat",
  ]);
  assert.deepEqual(opts.openai, { promptCacheKey: "chat-42" });
});

t("cache session leaves room for the caller's anthropic options", () => {
  const opts = buildProviderOptions({
    ...base,
    promptCacheSessionId: "chat-42",
  });
  assert.equal(opts.anthropic, undefined);
});

t("prompt cache headers carry the session affinity id", () => {
  assert.deepEqual(buildPromptCacheHeaders("chat-42"), {
    "x-session-affinity": "chat-42",
  });
});

t("a caller without a type is tagged as chat", () => {
  assert.deepEqual(buildProviderOptions({ userId: "u1", workspaceId: WS }), {
    gateway: { user: "u1", tags: [`ws:${WS}`, "type:chat"] },
  });
});

t("a call nobody triggered lands in the system bucket", () => {
  assert.deepEqual(systemProviderOptions("model_probe"), {
    gateway: { user: SYSTEM_ATTRIBUTION_USER, tags: ["type:model_probe"] },
  });
  assert.deepEqual(systemProviderOptions("embedding", WS), {
    gateway: {
      user: SYSTEM_ATTRIBUTION_USER,
      tags: [`ws:${WS}`, "type:embedding"],
    },
  });
});

t("an empty user id counts as no user", () => {
  assert.equal(
    gatewayAttributionOptions({ userId: "", invocationType: "embedding" }).user,
    SYSTEM_ATTRIBUTION_USER,
  );
});

t("every shape stays inside Vercel's limits", () => {
  for (const options of [
    buildProviderOptions({
      userId: "u".repeat(200),
      workspaceId: WS,
      agentId: "a".repeat(40),
      invocationType: "description_generation",
    }).gateway,
    systemProviderOptions("compaction", WS).gateway,
  ]) {
    assert.ok(options.tags.length <= 10);
    for (const tag of options.tags) {
      assert.ok(tag.length >= 1 && tag.length <= 64, tag);
    }
    assert.ok(options.user.length <= 256);
  }
});

// --- A step's request, forwarded by Mako -------------------------------------

const STEP = { userId: "u1", workspaceId: WS, invocationType: "workflow" };

t("a step's request with no options gains the attribution", () => {
  assert.deepEqual(JSON.parse(withGatewayAttribution('{"prompt":[]}', STEP)), {
    prompt: [],
    providerOptions: {
      gateway: { user: "u1", tags: [`ws:${WS}`, "type:workflow"] },
    },
  });
});

t("a step cannot bill another workspace or name another user", () => {
  const body = JSON.stringify({
    prompt: [],
    providerOptions: {
      anthropic: { thinking: { type: "enabled" } },
      gateway: {
        models: ["openai/gpt-4o-mini"],
        user: "someone@example.com",
        tags: ["ws:other", "type:chat", "agent:x", "team:growth", "", 7],
      },
    },
  });
  assert.deepEqual(JSON.parse(withGatewayAttribution(body, STEP)), {
    prompt: [],
    providerOptions: {
      anthropic: { thinking: { type: "enabled" } },
      gateway: {
        models: ["openai/gpt-4o-mini"],
        user: "u1",
        tags: [`ws:${WS}`, "type:workflow", "team:growth"],
      },
    },
  });
});

t("a step's tags are capped at Vercel's limits", () => {
  const body = JSON.stringify({
    providerOptions: {
      gateway: {
        tags: [
          "x".repeat(65),
          ...Array.from({ length: 20 }, (_, i) => `step:${i}`),
        ],
      },
    },
  });
  const { tags } = JSON.parse(withGatewayAttribution(body, STEP))
    .providerOptions.gateway as { tags: string[] };
  assert.equal(tags.length, 10);
  assert.deepEqual(tags.slice(0, 3), [`ws:${WS}`, "type:workflow", "step:0"]);
});

t("a body that is not a JSON object goes through untouched", () => {
  for (const body of ["not json", "[1]", "null"]) {
    assert.equal(withGatewayAttribution(body, STEP), body);
  }
});

// --- Every gateway call in the codebase carries an attribution ---------------

/** The AI SDK functions and classes that bill a model call. */
const BILLED_SDK_CALLS = new Set([
  "generateText",
  "streamText",
  "generateObject",
  "streamObject",
  "embed",
  "embedMany",
  "rerank",
  "decide",
  "experimental_decide",
  "generateImage",
  "experimental_generateImage",
  "generateSpeech",
  "experimental_generateSpeech",
  "generateVideo",
  "experimental_generateVideo",
  "transcribe",
  "experimental_transcribe",
  "streamTranscribe",
  "experimental_streamTranscribe",
  "streamTranslate",
  "experimental_streamTranslate",
  "streamLanguageModelCall",
  "experimental_streamLanguageModelCall",
  "ToolLoopAgent",
  "Agent",
]);

const ATTRIBUTION_HELPER =
  /\b(buildProviderOptions|systemProviderOptions|attributionProviderOptions|gatewayAttributionOptions|withGatewayAttribution)\b/;

/** Where the gateway key may be read, and why it bills nothing untagged. */
const GATEWAY_KEY_READERS = new Map([
  ["agent-lib/ai-gateway.ts", "the SDK client every tagged call goes through"],
  ["routes/workflows.ts", "forwards through withGatewayAttribution"],
  ["services/embedding.service.ts", "checks that the key exists"],
  ["index.ts", "warns when the key is missing"],
]);

/** The billed SDK calls in a source file that carry no `providerOptions`. */
function untaggedSdkCalls(fileName: string, source: string): string[] {
  const usesSdk = /from "ai"|import\("ai"\)/.test(source);
  if (!usesSdk) return [];
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isCallExpression(node) || ts.isNewExpression(node)) &&
      ts.isIdentifier(node.expression) &&
      BILLED_SDK_CALLS.has(node.expression.text)
    ) {
      const options = node.arguments?.[0];
      const tagged =
        options !== undefined &&
        ts.isObjectLiteralExpression(options) &&
        options.properties.some(
          property =>
            property.name !== undefined &&
            ts.isIdentifier(property.name) &&
            property.name.text === "providerOptions",
        ) &&
        ATTRIBUTION_HELPER.test(source);
      if (!tagged) {
        const { line } = file.getLineAndCharacterOfPosition(
          node.getStart(file),
        );
        found.push(`${fileName}:${line + 1} ${node.expression.text}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** The files outside the allowlist that hold the gateway key. */
function holdsGatewayKey(source: string): boolean {
  return /process\.env\.AI_GATEWAY_API_KEY|createGateway\(/.test(source);
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
      ? [path]
      : [];
  });
}

t("the scan catches an untagged call", () => {
  const imports = 'import { streamText, embed, ToolLoopAgent } from "ai";\n';
  assert.deepEqual(
    untaggedSdkCalls(
      "bad.ts",
      `${imports}streamText({ model });\nembed(opts);\nnew ToolLoopAgent({ model });\n`,
    ),
    ["bad.ts:2 streamText", "bad.ts:3 embed", "bad.ts:4 ToolLoopAgent"],
  );
  // Options that name a provider alone attribute nothing.
  assert.deepEqual(
    untaggedSdkCalls(
      "bad.ts",
      `${imports}streamText({ model, providerOptions: { anthropic: {} } });\n`,
    ),
    ["bad.ts:2 streamText"],
  );
  assert.deepEqual(
    untaggedSdkCalls(
      "good.ts",
      `${imports}streamText({ model, providerOptions: systemProviderOptions("x") });\n`,
    ),
    [],
  );
});

t("every billed SDK call in api/src carries an attribution", () => {
  const src = join(__dirname, "..");
  const files = sourceFiles(src);
  const untagged = files.flatMap(path =>
    untaggedSdkCalls(relative(src, path), readFileSync(path, "utf8")),
  );
  assert.deepEqual(
    untagged,
    [],
    "Tag these gateway calls: pass providerOptions from buildProviderOptions or systemProviderOptions",
  );
  // A scan that finds nothing proves nothing.
  const calls = files
    .map(path => readFileSync(path, "utf8"))
    .filter(source => /from "ai"|import\("ai"\)/.test(source))
    .join("\n")
    .match(/\b(generateText|streamText|embed|embedMany)\(/g);
  assert.ok((calls?.length ?? 0) >= 8, `only ${calls?.length} calls found`);
});

t("only the known files can reach the gateway with its key", () => {
  const src = join(__dirname, "..");
  const readers = sourceFiles(src)
    .filter(path => holdsGatewayKey(readFileSync(path, "utf8")))
    .map(path => relative(src, path))
    .sort();
  assert.deepEqual(readers, [...GATEWAY_KEY_READERS.keys()].sort());
  assert.match(
    readFileSync(join(src, "routes/workflows.ts"), "utf8"),
    /body: withGatewayAttribution\(/,
  );
});

// --- The real SDK puts the attribution on the wire ---------------------------

async function main() {
  process.env.AI_GATEWAY_API_KEY = "test-key";
  const realFetch = globalThis.fetch;
  const sent: { url: string; body: any }[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    sent.push({ url, body: JSON.parse(String(init?.body)) });
    return new Response(
      JSON.stringify(
        url.endsWith("/embedding-model")
          ? { embeddings: [[1, 0]], usage: { tokens: 1 } }
          : {
              content: [{ type: "text", text: "ok" }],
              finishReason: { unified: "stop", raw: "stop" },
              usage: {
                inputTokens: { total: 1 },
                outputTokens: { total: 1 },
              },
              warnings: [],
            },
      ),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    await embed({
      model: getEmbeddingModel("openai/text-embedding-3-small"),
      value: "hello",
      providerOptions: attributionProviderOptions({
        workspaceId: WS,
        invocationType: "embedding",
      }),
      telemetry: { isEnabled: false },
    });
    assert.ok(sent[0].url.endsWith("/embedding-model"), sent[0].url);
    assert.deepEqual(sent[0].body.providerOptions.gateway, {
      user: SYSTEM_ATTRIBUTION_USER,
      tags: [`ws:${WS}`, "type:embedding"],
    });
    process.stdout.write("ok  embed sends the attribution on the wire\n");

    await generateText({
      model: getModel("openai/gpt-4o-mini"),
      prompt: "ok",
      providerOptions: buildProviderOptions({
        userId: "u1",
        workspaceId: WS,
        agentId: "unified",
        invocationType: "workflow",
      }),
      telemetry: { isEnabled: false },
    });
    assert.ok(sent[1].url.endsWith("/language-model"), sent[1].url);
    assert.deepEqual(sent[1].body.providerOptions.gateway, {
      user: "u1",
      tags: [`ws:${WS}`, "agent:unified", "type:workflow"],
    });
    process.stdout.write(
      "ok  generateText sends the attribution on the wire\n",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
