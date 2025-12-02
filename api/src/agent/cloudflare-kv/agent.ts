// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore – provided at runtime
import { Agent } from "@openai/agents";
import { createCloudflareKVTools } from "./tools";
import { CLOUDFLARE_KV_ASSISTANT_PROMPT } from "./prompt";

export const buildCloudflareKVAgent = (
  workspaceId: string,
  consoles?: any[],
  preferredConsoleId?: string,
) =>
  new Agent({
    name: "Cloudflare KV Assistant",
    handoffDescription:
      "Specialist for Cloudflare Workers KV Store. Use when a task targets key-value data in Cloudflare KV namespaces.",
    instructions: CLOUDFLARE_KV_ASSISTANT_PROMPT,
    tools: createCloudflareKVTools(workspaceId, consoles, preferredConsoleId),
    model: "gpt-5",
  });

