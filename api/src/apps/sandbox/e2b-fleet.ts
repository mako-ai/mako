/**
 * The account-wide view of app boxes: list them, pause one, kill one.
 *
 * e2b-provider.ts addresses ONE box by session key and is built around
 * "connect or create". The idle sweep (box-idle.service.ts) needs the other
 * direction: every app box the account holds, running or paused, without
 * connecting to any of them. Connecting resumes a paused box, so a fleet view
 * that connected would wake the very boxes it is meant to put to sleep.
 *
 * Only boxes tagged `makoAppsSessionKey` are app boxes. Anything else on the
 * account (connector boxes, benchmarks, other products) is never touched.
 */
import { Sandbox } from "e2b";

export interface AppBoxInfo {
  sandboxId: string;
  /** `<workspaceId>:<userId>` (worktree/box-session.ts sessionKeyFor). */
  sessionKey: string;
  state: "running" | "paused";
  startedAt: Date;
  cpuCount: number;
  memoryMB: number;
}

function apiKey(): string {
  const key = process.env.E2B_API_KEY;
  if (!key) throw new Error("E2B_API_KEY is not set");
  return key;
}

/** Every app box on the account in the given states. Pages until done. */
export async function listAppBoxes(
  states: Array<"running" | "paused"> = ["running", "paused"],
): Promise<AppBoxInfo[]> {
  const paginator = Sandbox.list({
    apiKey: apiKey(),
    query: { state: states },
    limit: 100,
  });
  const out: AppBoxInfo[] = [];
  while (paginator.hasNext) {
    for (const box of await paginator.nextItems()) {
      const sessionKey = box.metadata?.makoAppsSessionKey;
      if (!sessionKey) continue;
      out.push({
        sandboxId: box.sandboxId,
        sessionKey,
        state: box.state,
        startedAt: new Date(box.startedAt),
        cpuCount: box.cpuCount,
        memoryMB: box.memoryMB,
      });
    }
  }
  return out;
}

/**
 * Pause WITH memory, the same snapshot kind as the idle timeout
 * (`lifecycle.onTimeout.keepMemory` in e2b-provider.ts): tmux sessions and
 * dev servers come back exactly where they were on the next connect.
 * False when E2B says the box is not running (already paused).
 */
export async function pauseAppBox(sandboxId: string): Promise<boolean> {
  return Sandbox.pause(sandboxId, { apiKey: apiKey(), keepMemory: true });
}

export async function killAppBox(sandboxId: string): Promise<boolean> {
  return Sandbox.kill(sandboxId, { apiKey: apiKey() });
}
