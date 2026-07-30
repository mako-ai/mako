/**
 * Mako Local Agent entrypoint.
 *
 * Run with: pnpm --filter @mako/local-agent dev (or start)
 */
import { startAgent } from "./server";

const agent = startAgent();

let shuttingDown = false;

/**
 * `agent.close()` awaits `server.close()`, which never settles while an ACP
 * SSE stream (`/acp/sessions/:id/events`) is still connected — so cap the
 * graceful drain to keep SIGTERM guaranteed to exit.
 */
const SHUTDOWN_TIMEOUT_MS = 5000;

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await Promise.race([
      agent.close(),
      new Promise<void>(resolve => {
        setTimeout(resolve, SHUTDOWN_TIMEOUT_MS).unref?.();
      }),
    ]);
    process.exit(0);
  } catch {
    process.exit(1);
  }
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
