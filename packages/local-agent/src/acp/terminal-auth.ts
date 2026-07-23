/**
 * Launch an interactive terminal login for ACP adapters that advertise
 * `type: "terminal"` / `_meta["terminal-auth"]` (Claude Code today).
 *
 * Calling agent.authenticate(methodId) for these methods throws
 * "Method not implemented" — the client must run the CLI login instead.
 */
import { spawn } from "node:child_process";
import { acpLog } from "./log";
import type { AcpProviderId } from "./providers";

export interface TerminalAuthLaunch {
  command: string;
  args: string[];
  label?: string;
}

export function extractTerminalAuthLaunch(method: {
  id?: string;
  type?: string;
  args?: unknown;
  _meta?: unknown;
}): TerminalAuthLaunch | null {
  const meta = method._meta as
    | { "terminal-auth"?: { command?: string; args?: string[]; label?: string } }
    | undefined;
  const ta = meta?.["terminal-auth"];
  if (ta?.command && Array.isArray(ta.args)) {
    return {
      command: ta.command,
      args: ta.args.map(String),
      label: ta.label,
    };
  }

  // Fallback when meta is missing but method is terminal (Claude defaults).
  if (method.type === "terminal" || method.id === "claude-ai-login") {
    return {
      command: "npx",
      args: [
        "--yes",
        "@agentclientprotocol/claude-agent-acp",
        "--cli",
        "auth",
        "login",
        "--claudeai",
      ],
      label: "Claude Login",
    };
  }
  if (method.id === "console-login") {
    return {
      command: "npx",
      args: [
        "--yes",
        "@agentclientprotocol/claude-agent-acp",
        "--cli",
        "auth",
        "login",
        "--console",
      ],
      label: "Anthropic Console Login",
    };
  }
  if (method.id === "claude-login") {
    return {
      command: "npx",
      args: ["--yes", "@agentclientprotocol/claude-agent-acp", "--cli"],
      label: "Claude Login",
    };
  }
  return null;
}

export function formatTerminalAuthCommand(launch: TerminalAuthLaunch): string {
  return [launch.command, ...launch.args]
    .map(part => (/\s/.test(part) ? JSON.stringify(part) : part))
    .join(" ");
}

/** Default CLI login when the adapter omits terminal-auth metadata. */
export function defaultTerminalLoginLaunch(
  providerId: AcpProviderId,
): TerminalAuthLaunch {
  if (providerId === "codex") {
    return {
      command: "codex",
      args: ["login"],
      label: "Codex / ChatGPT Login",
    };
  }
  return {
    command: "npx",
    args: [
      "--yes",
      "@agentclientprotocol/claude-agent-acp",
      "--cli",
      "auth",
      "login",
      "--claudeai",
    ],
    label: "Claude Login",
  };
}

/**
 * Best-effort: open a visible terminal running the login command.
 * Returns the shell command string so the UI can show a copy-paste fallback.
 */
export function launchTerminalAuth(
  launch: TerminalAuthLaunch,
): { commandLine: string; opened: boolean } {
  const commandLine = formatTerminalAuthCommand(launch);
  acpLog.info("Launching terminal ACP auth", {
    label: launch.label,
    commandLine,
    platform: process.platform,
  });

  try {
    if (process.platform === "darwin") {
      // Open Terminal.app with the login command.
      spawn(
        "osascript",
        [
          "-e",
          `tell application "Terminal" to do script ${JSON.stringify(commandLine)}`,
          "-e",
          'tell application "Terminal" to activate',
        ],
        { detached: true, stdio: "ignore" },
      ).unref();
      return { commandLine, opened: true };
    }

    if (process.platform === "win32") {
      spawn("cmd.exe", ["/c", "start", "cmd.exe", "/k", commandLine], {
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      }).unref();
      return { commandLine, opened: true };
    }

    // Linux — try common terminal emulators.
    const linuxTerminals: Array<[string, string[]]> = [
      ["x-terminal-emulator", ["-e", "bash", "-lc", `${commandLine}; exec bash`]],
      ["gnome-terminal", ["--", "bash", "-lc", `${commandLine}; exec bash`]],
      ["konsole", ["-e", "bash", "-lc", `${commandLine}; exec bash`]],
      ["xterm", ["-e", "bash", "-lc", `${commandLine}; exec bash`]],
    ];
    for (const [bin, args] of linuxTerminals) {
      try {
        const child = spawn(bin, args, { detached: true, stdio: "ignore" });
        child.unref();
        return { commandLine, opened: true };
      } catch {
        // try next
      }
    }
  } catch (error) {
    acpLog.error("Failed to open terminal for ACP auth", {
      error: String(error),
      commandLine,
    });
  }

  return { commandLine, opened: false };
}
