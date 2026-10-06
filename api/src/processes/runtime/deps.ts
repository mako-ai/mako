/**
 * Runtime dependencies that differ between production and tests: which agent
 * harness and model an unconfigured `ctx.agent()` uses, and how a bound
 * connection id resolves. Production wiring lives in `engine.ts`.
 */
import type { AgentHarness } from "../agents/harness";
import type { ResolvedConnection } from "../sdk";

export interface RuntimeDeps {
  defaultHarness(): AgentHarness;
  defaultModel(): Promise<string>;
  resolveConnection(
    workspaceId: string,
    connectionId: string,
  ): Promise<ResolvedConnection>;
  /** Clock for deadlines (sleeps, request expiry). */
  now(): Date;
}

let deps: RuntimeDeps | null = null;

export function setRuntimeDeps(next: RuntimeDeps): void {
  deps = next;
}

export function getRuntimeDeps(): RuntimeDeps {
  if (!deps) {
    throw new Error(
      "Process runtime dependencies are not configured (call configureProcessRuntime())",
    );
  }
  return deps;
}
