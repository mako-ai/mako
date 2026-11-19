/**
 * Default-branch guard — keeps MCP and API-key callers off the workspace
 * repo's default branch.
 *
 * On 19 Nov 2026 two agents used Mako MCP write tools on a customer workspace
 * and committed straight to `main`: no pull request, no CI. The cause is in
 * branch-policy.ts: an actor's session branch defaults to the default branch,
 * so every dbt save, app commit and flow write an MCP client made landed there.
 * That default is right for a person watching the editor. It is wrong for a
 * headless caller nobody reviews.
 *
 * How it works:
 *
 * - The MCP CallTool handler runs every tool inside {@link runUnderDefaultBranchGuard}
 *   (an AsyncLocalStorage scope). The in-app agent never enters it, so its
 *   behaviour does not change.
 * - A tool that writes asks {@link activeDefaultBranchGuard} whether the scope
 *   is on for this workspace (setting `settings.protectDefaultBranch`, default
 *   ON) and, if so, writes to the branch {@link guardBranchFor} names.
 * - Reaching the default branch takes the family's `*_merge_to_main` tool, which
 *   becomes "open a merge request" (merge-request.service.ts).
 *
 * The scope is the one seam. dbt reads and writes follow it through
 * `commitBranchFor`, so a read after a write sees the same branch.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { Types } from "mongoose";
import { Workspace } from "../database/models/workspace";
import { DEFAULT_BRANCH } from "./repository.service";

/** Every guard branch starts with this, so a reviewer can spot one. */
export const MCP_BRANCH_PREFIX = "mcp";

/** The content families a guard branch holds. One branch per family and person. */
export type GuardKind = "dbt" | "flows" | "app";

/** The tool that opens a merge request for each family. */
export const MERGE_TOOL_FOR_KIND = {
  dbt: "dbt_merge_to_main",
  flows: "flow_merge_to_main",
  app: "app_merge_to_main",
} as const satisfies Record<GuardKind, string>;

interface GuardScope {
  workspaceId: string;
  userId?: string;
  /** Memoised so a call that consults the guard ten times reads Mongo once. */
  protectedPromise?: Promise<boolean>;
}

const scopes = new AsyncLocalStorage<GuardScope>();

/**
 * Whether the workspace protects its default branch from MCP/API-key writes.
 * ON unless an owner or admin switched it off (`false`).
 */
export async function isDefaultBranchProtected(
  workspaceId: string,
): Promise<boolean> {
  const workspace = await Workspace.findById(new Types.ObjectId(workspaceId))
    .select("settings.protectDefaultBranch")
    .lean();
  return workspace?.settings?.protectDefaultBranch !== false;
}

/** Run `fn` as an MCP/API-key caller: its writes honour the guard. */
export function runUnderDefaultBranchGuard<T>(
  scope: { workspaceId: string; userId?: string },
  fn: () => Promise<T>,
): Promise<T> {
  return scopes.run({ ...scope }, fn);
}

/** Whether this call runs inside a guard scope, ignoring the setting (no I/O). */
export function inDefaultBranchGuardScope(workspaceId: string): boolean {
  return scopes.getStore()?.workspaceId === workspaceId;
}

/**
 * The guard for this call, or null when the caller is not guarded (the in-app
 * agent, a person in the editor, a job) or the workspace turned it off.
 */
export async function activeDefaultBranchGuard(
  workspaceId: string,
): Promise<{ userId?: string } | null> {
  const scope = scopes.getStore();
  if (!scope || scope.workspaceId !== workspaceId) return null;
  scope.protectedPromise ??= isDefaultBranchProtected(workspaceId);
  return (await scope.protectedPromise) ? { userId: scope.userId } : null;
}

/** Git ref segment: letters, digits, dot, dash, underscore. */
function refSegment(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return cleaned || "agent";
}

/**
 * The branch a guarded caller writes to: `mcp/<person>/<kind>[/<scope>]`.
 * One per person and family, so two people never replace each other's work and
 * a merge request carries one kind of change (the checks follow from it).
 * `person` is the handle when the workspace has one, else the user id.
 */
export function guardBranchName(
  person: string,
  kind: GuardKind,
  scope?: string,
): string {
  return [MCP_BRANCH_PREFIX, refSegment(person), kind, scope]
    .filter((part): part is string => Boolean(part))
    .map((part, i) => (i === 0 ? part : refSegment(part)))
    .join("/");
}

/** Whether a branch name is one of the guard's. */
export function isGuardBranch(branch: string): boolean {
  return branch.startsWith(`${MCP_BRANCH_PREFIX}/`);
}

/**
 * The refusal a guarded caller gets when a tool would commit to the default
 * branch: it names the branch the writes go to and the tool that opens the
 * merge.
 */
export function defaultBranchWriteRefusal(
  branch: string,
  mergeTool: string,
): string {
  return `Writes go to branch ${branch}. Open a merge with ${mergeTool}.`;
}

export class DefaultBranchWriteRefusedError extends Error {
  readonly branch: string;
  readonly mergeTool: string;
  constructor(branch: string, mergeTool: string) {
    super(defaultBranchWriteRefusal(branch, mergeTool));
    this.name = "DefaultBranchWriteRefusedError";
    this.branch = branch;
    this.mergeTool = mergeTool;
  }
}

/**
 * Safety net under the redirect: a write that still resolves to the default
 * branch while the guard is on is a bug in the caller, and fails loudly with
 * the branch it should have used instead of committing to main.
 */
export async function assertNotDefaultBranchWrite(input: {
  workspaceId: string;
  branch: string;
  guardBranch: string;
  mergeTool: string;
}): Promise<void> {
  if (input.branch !== DEFAULT_BRANCH) return;
  if (!(await activeDefaultBranchGuard(input.workspaceId))) return;
  throw new DefaultBranchWriteRefusedError(input.guardBranch, input.mergeTool);
}

/**
 * Refuse a tool that has no branch to write to: its result is a row derived
 * from the default branch (a dbt job, a project), so it cannot wait on a
 * branch for review the way a file can.
 */
export function refusalForUnbranchableWrite(tool: string): string {
  return (
    `${tool} writes to the default branch and its result cannot wait on a branch. ` +
    "This workspace protects its default branch from MCP and API-key writes: " +
    "make the change in the Mako app, or ask an owner or admin to turn off " +
    "default-branch protection."
  );
}
