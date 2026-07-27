/**
 * Mako Local Agent entrypoint.
 *
 * Run with: pnpm --filter @mako/local-agent dev (or start)
 */
import { startAgent } from "./server";

const agent = startAgent();

let shuttingDown = false;

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await agent.close();
    process.exit(0);
  } catch {
    process.exit(1);
  }
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
