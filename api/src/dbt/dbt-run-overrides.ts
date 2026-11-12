// Owner: WP3 (run inputs). Stub: the signatures are the contract.
import type { IDbtRunOverrides } from "../database/workspace-schema";
import { DbtCommandValidationError } from "./commands";

export type DbtRunOverrides = IDbtRunOverrides;

/** Extends the command error so existing 400 / tool-error handlers catch it. */
export class DbtRunOverridesError extends DbtCommandValidationError {}

/**
 * Validate untrusted trigger input against the job's commands. Returns the
 * normalized overrides, or undefined when the input is empty. Throws
 * DbtRunOverridesError: vars not a plain object, over 50 keys, a key outside
 * `[A-Za-z_][A-Za-z0-9_]*`, over 4 KB serialized, fullRefresh not a boolean,
 * or vars given while a command already declares `--vars`.
 */
export function validateRunOverrides(
  input: { vars?: unknown; fullRefresh?: unknown } | undefined,
  commands: string[],
): DbtRunOverrides | undefined {
  void input;
  void commands;
  throw new Error("not implemented");
}

/** Append `--full-refresh` to run, build and seed commands that lack it. */
export function applyFullRefresh(commands: string[]): string[] {
  void commands;
  throw new Error("not implemented");
}
