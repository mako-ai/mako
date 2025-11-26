// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore – provided at runtime
import { Agent } from "@openai/agents";
import { createSqliteTools } from "./tools";
import { SQLITE_ASSISTANT_PROMPT } from "./prompt";

export const buildSqliteAgent = (
  workspaceId: string,
  consoles?: any[],
  preferredConsoleId?: string,
) =>
  new Agent({
    name: "SQLite Assistant",
    handoffDescription:
      "Specialist for SQLite and Cloudflare D1 databases. Use when a task targets SQLite data or D1 databases.",
    instructions: SQLITE_ASSISTANT_PROMPT,
    tools: createSqliteTools(workspaceId, consoles, preferredConsoleId),
    model: "gpt-5",
  });


