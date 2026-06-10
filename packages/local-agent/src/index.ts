/**
 * Mako Local Agent entrypoint.
 *
 * Run with: pnpm --filter @mako/local-agent dev (or start)
 */
import { startAgent } from "./server";

const agent = startAgent();

function shutdown() {
  agent.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
