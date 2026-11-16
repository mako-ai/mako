/**
 * The workspace shell over MCP, through the real server and transport:
 * sandbox_bash and sandbox_write_file need BOTH git:write and workflows:run.
 * A key holding only one of them does not see them listed (git:write
 * missing) or is refused when it calls them (workflows:run missing). The
 * read tools need neither. And a key Mako minted for automation is told
 * apart from a personal one.
 */
import assert from "node:assert/strict";
import { Types } from "mongoose";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

import type { WorkspaceApiKeyScope } from "../auth/api-key-scopes";
import { isAutomationKey } from "../routes/mcp-server.routes";
import { buildMakoMcpServer } from "./mako-mcp-server";
import { StatelessMcpTransport } from "./stateless-transport";

const WORKSPACE_ID = new Types.ObjectId().toString();
const SHELL = ["sandbox_bash", "sandbox_write_file"];
const READS = ["sandbox_status", "sandbox_read_file"];

async function exchange(
  scopes: WorkspaceApiKeyScope[],
  messages: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  const server = buildMakoMcpServer({
    workspaceId: WORKSPACE_ID,
    workspaceName: "Acme",
    // No userId: a call that got past the gates would be refused by the
    // tool itself ("not tied to one"), never reach a sandbox.
    memberRole: "member",
    scopes,
  });
  const transport = new StatelessMcpTransport();
  await server.connect(transport);
  try {
    return (await transport.handle(
      messages as unknown as JSONRPCMessage[],
      5_000,
    )) as unknown as Record<string, unknown>[];
  } finally {
    await server.close();
  }
}

async function listed(scopes: WorkspaceApiKeyScope[]): Promise<Set<string>> {
  const [response] = await exchange(scopes, [
    { jsonrpc: "2.0", id: "list", method: "tools/list", params: {} },
  ]);
  const tools = (response.result as { tools: Array<{ name: string }> }).tools;
  return new Set(tools.map(tool => tool.name));
}

async function callText(
  scopes: WorkspaceApiKeyScope[],
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  const [response] = await exchange(scopes, [
    {
      jsonrpc: "2.0",
      id: "call",
      method: "tools/call",
      params: { name, arguments: args },
    },
  ]);
  const result = response.result as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  return { text: result.content[0].text, isError: result.isError === true };
}

async function main() {
  const base: WorkspaceApiKeyScope[] = ["mcp", "query:read"];

  // Only workflows:run: the shell is not listed, and a call is refused for
  // the missing git-write grant.
  const onlyRun = await listed([...base, "workflows:run"]);
  for (const name of SHELL) {
    assert.equal(onlyRun.has(name), false, `${name} hidden without git:write`);
    const call = await callText([...base, "workflows:run"], name, {
      command: "ls",
      path: "a.txt",
      contents: "x",
    });
    assert.equal(call.isError, true, `${name} refused without git:write`);
    assert.match(call.text, /git-write|Unknown tool/);
  }

  // Only git:write: listed, but every call is refused for the missing
  // workflows-run grant, before the tool runs.
  const onlyGit = await listed([...base, "git:write"]);
  for (const name of SHELL) {
    assert.equal(onlyGit.has(name), true, `${name} listed with git:write`);
    const call = await callText([...base, "git:write"], name, {
      command: "ls",
      path: "a.txt",
      contents: "x",
    });
    assert.equal(call.isError, true, `${name} refused without workflows:run`);
    assert.match(call.text, /workflows-run/);
  }

  // Both: listed. The reads need neither scope.
  const both = await listed([...base, "git:write", "workflows:run"]);
  for (const name of SHELL) assert.equal(both.has(name), true, name);
  const neither = await listed(base);
  for (const name of READS) assert.equal(neither.has(name), true, name);
  for (const name of SHELL) assert.equal(neither.has(name), false, name);

  // Automation keys: the worker's, a sandbox run's; a personal key is not.
  assert.equal(
    isAutomationKey({
      name: "Workflows worker prod",
      scopes: ["mcp", "query:write", "workflows:runtime"],
    }),
    true,
  );
  assert.equal(
    isAutomationKey({
      name: "Workflows sandbox 65f sandbox-1",
      agentRun: true,
    }),
    true,
  );
  assert.equal(isAutomationKey({ name: "x", recordWrites: true }), true);
  assert.equal(
    isAutomationKey({
      name: "Joan laptop",
      scopes: ["mcp", "git:write", "workflows:run"],
    }),
    false,
  );
  assert.equal(isAutomationKey(undefined), false);

  console.info("sandbox-grants: ok");
  // The server's imports hold open handles (Mongo, timers): end the run.
  // eslint-disable-next-line no-process-exit
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  // eslint-disable-next-line no-process-exit
  process.exit(1);
});
