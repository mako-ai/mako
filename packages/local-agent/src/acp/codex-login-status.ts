/**
 * Detect whether Codex already has ChatGPT credentials on disk.
 *
 * Critical: `codex login` starts a new OAuth flow and can wipe
 * `~/.codex/auth.json`. Never launch it when the user is already signed in.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathWithNpmGlobals } from "./path-env";
import { resolveOnPath } from "./resolve-command";

export function codexAuthJsonPath(home = homedir()): string {
  return join(home, ".codex", "auth.json");
}

/** Fast path — presence of auth.json usually means a prior successful login. */
export function hasCodexAuthFile(home = homedir()): boolean {
  try {
    return existsSync(codexAuthJsonPath(home));
  } catch {
    return false;
  }
}

/**
 * Run `codex login status`. Returns true when stdout indicates a ChatGPT /
 * API-key session is active.
 */
export async function probeCodexLoginStatus(options?: {
  timeoutMs?: number;
  run?: () => Promise<{ code: number | null; stdout: string; stderr: string }>;
}): Promise<boolean> {
  if (options?.run) {
    const result = await options.run();
    return parseCodexLoginStatusOutput(result.stdout, result.stderr);
  }

  const codex = resolveOnPath(
    process.platform === "win32" ? "codex.cmd" : "codex",
  );
  if (!codex) {
    // Fall back to file presence when CLI is missing from PATH.
    return hasCodexAuthFile();
  }

  const timeoutMs = options?.timeoutMs ?? 8000;
  const result = await new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
  }>(resolve => {
    const child = spawn(codex, ["login", "status"], {
      env: {
        ...process.env,
        PATH: pathWithNpmGlobals(process.env.PATH || ""),
      },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", chunk => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", chunk => {
      stderr += String(chunk);
    });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      resolve({ code: null, stdout, stderr: `${stderr}\ntimed out` });
    }, timeoutMs);
    child.on("error", err => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: `${stderr}\n${err.message}` });
    });
    child.on("close", code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });

  if (parseCodexLoginStatusOutput(result.stdout, result.stderr)) {
    return true;
  }
  // CLI may be broken while auth.json still exists from a prior login.
  return hasCodexAuthFile();
}

export function parseCodexLoginStatusOutput(
  stdout: string,
  stderr = "",
): boolean {
  const text = `${stdout}\n${stderr}`;
  if (/not logged in/i.test(text)) return false;
  if (/logged in/i.test(text)) return true;
  if (/chatgpt/i.test(text) && /auth|session|signed/i.test(text)) return true;
  return false;
}

/**
 * Whether session/new should auto-call authenticate().
 *
 * Claude and Codex both use Terminal CLI login — auto-running that on every
 * session/new opens Terminal (and for Codex, can wipe auth.json).
 */
export function shouldAutoAuthenticateOnSessionNew(args: {
  providerId: string;
  authRequired: boolean;
  authenticated: boolean;
  authMethods: Array<{ type?: string; terminalAuth?: unknown }>;
}): boolean {
  if (!args.authRequired || args.authenticated) return false;
  // Codex advertises api-key / chat-gpt (non-terminal) methods, but Sign in
  // must own the CLI login — never auto-run `codex login` on session/new.
  // Cursor is the same shape (`cursor-agent login` CLI flow).
  if (args.providerId === "codex" || args.providerId === "cursor") return false;
  const terminalOnly =
    args.authMethods.length > 0 &&
    args.authMethods.every(m => m.type === "terminal" || Boolean(m.terminalAuth));
  // Claude: terminal-only → skip. Other adapters with non-terminal methods
  // may still use agent.authenticate RPC.
  if (terminalOnly) return false;
  return true;
}
