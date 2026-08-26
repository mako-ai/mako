import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { AcpProviderDefinition } from "./providers";
import { pathWithNpmGlobals } from "./path-env";

/**
 * Resolve an executable on PATH (or absolute path). Returns null when missing.
 * Searches an npm-global-augmented PATH so Desktop (stripped GUI PATH) still
 * finds `claude-agent-acp` after `npm i -g`.
 */
export function resolveOnPath(command: string): string | null {
  if (!command) return null;
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    try {
      accessSync(command, constants.X_OK);
      return command;
    } catch {
      return null;
    }
  }

  const pathEnv = pathWithNpmGlobals(process.env.PATH || "");
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

export interface ResolvedAdapterCommand {
  command: string;
  args: string[];
  /** How we resolved it — useful for status/debug. */
  via: "env" | "path" | "npx";
}

/**
 * Resolve the adapter launch command for a provider.
 *
 * Override with `MAKO_ACP_AGENT_COMMAND` (full command) and optional
 * `MAKO_ACP_AGENT_ARGS` (JSON array or shell-split-ish whitespace) for tests
 * and custom installs. When `MAKO_ACP_PROVIDER` is set, the env override only
 * applies to that provider id.
 */
export function resolveAdapterCommand(
  provider: AcpProviderDefinition,
): ResolvedAdapterCommand | null {
  const envCommand = process.env.MAKO_ACP_AGENT_COMMAND?.trim();
  const envProvider = process.env.MAKO_ACP_PROVIDER?.trim();
  if (envCommand && (!envProvider || envProvider === provider.id)) {
    const envArgsRaw = process.env.MAKO_ACP_AGENT_ARGS?.trim();
    let args: string[] = [];
    if (envArgsRaw) {
      try {
        const parsed = JSON.parse(envArgsRaw);
        if (Array.isArray(parsed)) {
          args = parsed.map(String);
        } else {
          args = envArgsRaw.split(/\s+/).filter(Boolean);
        }
      } catch {
        args = envArgsRaw.split(/\s+/).filter(Boolean);
      }
    }
    return { command: envCommand, args, via: "env" };
  }

  for (const name of provider.commands) {
    // Bare binary names on PATH
    if (!name.startsWith("@")) {
      const resolved = resolveOnPath(name);
      if (resolved) {
        return {
          command: resolved,
          args: provider.commandArgs ? [...provider.commandArgs] : [],
          via: "path",
        };
      }
    }
  }

  // No npx fallback for CLIs that aren't npm-distributed (Cursor).
  if (!provider.npxPackage) return null;

  const npx = resolveOnPath(process.platform === "win32" ? "npx.cmd" : "npx");
  if (npx) {
    return {
      command: npx,
      args: ["--yes", provider.npxPackage],
      via: "npx",
    };
  }

  return null;
}
