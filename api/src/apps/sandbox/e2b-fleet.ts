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
import type { BoxRun } from "../box/rescue-commit";

/**
 * A person's session box: `<24-hex workspaceId>:<userId>`. Connector boxes
 * (`connector-sync:<ws>`, `connector-build:<ws>`) and anything else on the
 * account never match.
 */
const APP_SESSION_KEY = /^[0-9a-f]{24}:/;

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
      if (!sessionKey || !APP_SESSION_KEY.test(sessionKey)) continue;
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

/** Output kept per command; more is reported as truncated. */
const RUN_OUTPUT_CAP = 4 * 1024 * 1024;

/**
 * Attach to THIS box by id and return a runner for commands in it.
 *
 * Connect-only: `Sandbox.connect` resumes a paused box and nothing else. It
 * never lists by session key, never kills a duplicate and never creates a
 * replacement, which e2b-provider's connectSession does on purpose for live
 * work and must never do for a box being inspected before deletion. A box
 * that will not connect throws, and the caller keeps it.
 */
export async function openAppBoxById(sandboxId: string): Promise<BoxRun> {
  const sandbox = await Sandbox.connect(sandboxId, { apiKey: apiKey() });
  return async (command, options = {}) => {
    let stdout = "";
    let stderr = "";
    let truncated = false;
    const keep = (prev: string, data: string) => {
      if (prev.length >= RUN_OUTPUT_CAP) {
        truncated = true;
        return prev;
      }
      const next = prev + data;
      if (next.length > RUN_OUTPUT_CAP) truncated = true;
      return next.slice(0, RUN_OUTPUT_CAP);
    };
    try {
      const result = await sandbox.commands.run(command, {
        user: "user",
        cwd: "/home/user",
        timeoutMs: options.timeoutMs ?? 120_000,
        envs: { HOME: "/home/user", LANG: "C.UTF-8", GIT_TERMINAL_PROMPT: "0" },
        onStdout: d => {
          stdout = keep(stdout, d);
        },
        onStderr: d => {
          stderr = keep(stderr, d);
        },
      });
      return { exitCode: result.exitCode, stdout, stderr, truncated };
    } catch (error) {
      const err = error as {
        exitCode?: number;
        stdout?: string;
        stderr?: string;
      };
      if (typeof err.exitCode === "number") {
        return {
          exitCode: err.exitCode,
          stdout: stdout || err.stdout || "",
          stderr: stderr || err.stderr || "",
          truncated,
        };
      }
      throw error;
    }
  };
}
