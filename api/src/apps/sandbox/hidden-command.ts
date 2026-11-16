/**
 * A command kept out of argv (SandboxExecOptions.hideCommand).
 *
 * Its own module so both providers and the seam import it without a cycle.
 */

/** The variable a hidden command travels in. */
export const HIDDEN_COMMAND_ENV = "MAKO_HIDDEN_COMMAND";

/**
 * The shell text a provider runs in place of a hidden command. It copies the
 * command into an unexported variable and unsets the exported one before it
 * runs anything, so no child process inherits the command's text. Every
 * provider's argv then holds this fixed text only.
 */
export const HIDDEN_COMMAND_SHIM = `mako_hidden_command=$${HIDDEN_COMMAND_ENV}; unset ${HIDDEN_COMMAND_ENV}; eval "$mako_hidden_command"`;

/** The command and extra env a provider runs for `command`. */
export function commandToRun(
  command: string,
  options: { env?: Record<string, string>; hideCommand?: boolean } = {},
): { command: string; env: Record<string, string> } {
  const env = { ...(options.env ?? {}) };
  if (!options.hideCommand) return { command, env };
  return {
    command: HIDDEN_COMMAND_SHIM,
    env: { ...env, [HIDDEN_COMMAND_ENV]: command },
  };
}
