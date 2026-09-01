// `mako publish [<app>]` — deploy the app's default branch now. Calls the
// MCP app_publish tool (enqueue-and-poll: the same build+deploy the push
// webhook runs, single-build concurrency per app), then polls
// app_publish_status until the enqueued sha is live.
import path from "node:path";
import { findRepoRoot, resolveAppDir } from "./context.js";
import { callMcpTool } from "./status.js";

const POLL_MS = 5000;
const TIMEOUT_MS = 5 * 60 * 1000;
const short = sha => (typeof sha === "string" ? sha.slice(0, 7) : "?");
const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function publish(ctx, positional, io = { log: console.log }) {
  const repoRoot = findRepoRoot();
  const appDir = resolveAppDir(repoRoot, positional[0]);
  const slug = path.basename(appDir);

  const out = await callMcpTool(ctx, "app_publish", { appId: slug });
  if (!out?.success) {
    io.log(`apps/${slug}: ${out?.error ?? "publish refused"}`);
    return 1;
  }
  const sha = out.enqueued?.sha;
  io.log(`apps/${slug}: deploy enqueued at ${short(sha)} — waiting…`);

  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const st = await callMcpTool(ctx, "app_publish_status", { appId: slug }).catch(() => null);
    if (st?.success && st.status?.publishedSha === sha) {
      io.log(`apps/${slug}: LIVE at ${short(sha)}.`);
      return 0;
    }
  }
  io.log(
    `apps/${slug}: still not live after ${TIMEOUT_MS / 60000} min — ` +
      "the build may have failed; check app_build_log or the app header in Mako.",
  );
  return 1;
}
