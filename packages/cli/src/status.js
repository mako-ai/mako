// `mako status [<app>]` — what is LIVE for an app: the published deployment's
// commit vs the tip of main. Speaks MCP over HTTP (`POST /api/mcp`,
// tools/call app_publish_status): the login token minted by `mako login` is
// restricted to the MCP endpoint (plus binding reads), so MCP *is* the
// supported wire for it — no extra REST scope needed.
import path from "node:path";
import { getAccessToken } from "@makoai/app-sdk/credentials";
import { findRepoRoot, resolveAppDir } from "./context.js";

function short(sha) {
  return typeof sha === "string" ? sha.slice(0, 7) : "?";
}

/** Unwrap a streamable-HTTP MCP response (plain JSON or SSE-framed). */
async function readMcpResult(res) {
  const raw = await res.text();
  let body = raw;
  for (const line of raw.split("\n")) {
    if (line.startsWith("data:")) {
      body = line.slice(5);
      break;
    }
  }
  const rpc = JSON.parse(body);
  if (rpc.error) throw new Error(rpc.error.message ?? JSON.stringify(rpc.error));
  const text = rpc.result?.content?.find(c => c.type === "text")?.text;
  return text ? JSON.parse(text) : rpc.result;
}

export async function callMcpTool(ctx, name, args) {
  const token =
    ctx.apiKey || (await getAccessToken(ctx.apiUrl, ctx.workspaceId));
  if (!token) {
    throw new Error(`not signed in to ${ctx.apiUrl} — run \`mako login\``);
  }
  const res = await fetch(`${ctx.apiUrl}/api/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  if (!res.ok) {
    throw new Error(`MCP call failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  return readMcpResult(res);
}

export async function status(ctx, positional, io = { log: console.log }) {
  const repoRoot = findRepoRoot();
  const appDir = resolveAppDir(repoRoot, positional[0]);
  const slug = path.basename(appDir);

  const out = await callMcpTool(ctx, "app_publish_status", { appId: slug });
  if (!out?.success) {
    io.log(`apps/${slug}: ${out?.error ?? "no status returned"}`);
    return 1;
  }
  const s = out.status;
  if (!s.published) {
    io.log(`apps/${slug}: never published (branch ${s.branch} at ${short(s.branchSha)}).`);
    return 0;
  }
  const when = s.publishedAt ? ` (published ${s.publishedAt})` : "";
  if (s.upToDate) {
    io.log(`apps/${slug}: LIVE at ${short(s.publishedSha)}${when} — up to date with ${s.branch}.`);
    return 0;
  }
  io.log(
    `apps/${slug}: LIVE at ${short(s.publishedSha)}${when} — ${s.branch} is at ${short(s.branchSha)}, ` +
      `newer commits are building or the build failed (check the app header in Mako).`,
  );
  return 1;
}
