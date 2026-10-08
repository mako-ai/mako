/**
 * The rename handlers, one per kind (see ./types.ts for the contract).
 */
import { appRenameHandler } from "./handlers/app";
import { consoleRenameHandler } from "./handlers/console";
import { notebookRenameHandler } from "./handlers/notebook";
import { dashboardRenameHandler } from "./handlers/dashboard";
import { flowRenameHandler } from "./handlers/flow";
import { dbtFileRenameHandler } from "./handlers/dbt-file";
import { dbtJobRenameHandler } from "./handlers/dbt-job";
import { skillRenameHandler } from "./handlers/skill";
import { connectorRenameHandler } from "./handlers/connector";
import { connectionRenameHandler } from "./handlers/connection";
import {
  RENAME_KINDS,
  RenameError,
  type RenameContext,
  type RenameHandler,
  type RenameKind,
  type RenameLocation,
  type RenameRequest,
  type RenameResult,
  type ResolvedRef,
} from "./types";

export const RENAME_HANDLERS: Record<RenameKind, RenameHandler> = {
  app: appRenameHandler,
  console: consoleRenameHandler,
  notebook: notebookRenameHandler,
  dashboard: dashboardRenameHandler,
  flow: flowRenameHandler,
  dbt_file: dbtFileRenameHandler,
  dbt_job: dbtJobRenameHandler,
  skill: skillRenameHandler,
  connector: connectorRenameHandler,
  connection: connectionRenameHandler,
};

export function isRenameKind(value: string): value is RenameKind {
  return (RENAME_KINDS as readonly string[]).includes(value);
}

export async function renameObject(
  ctx: RenameContext,
  kind: RenameKind,
  request: RenameRequest,
): Promise<RenameResult> {
  if (request.title === undefined && request.slug === undefined) {
    throw new RenameError("Give a new title, a new slug, or both.");
  }
  // A rename to what the object is already called succeeds with nothing to
  // do, the same answer for every kind (handlers used to disagree: 200, 409,
  // 400, or a save that bumped a version for nothing).
  // The same ref the resolve endpoint accepts: a padded id or name must not
  // resolve there and 404 here.
  const ref = request.ref.trim();
  const current = await RENAME_HANDLERS[kind].resolve(ctx, ref);
  if (current && isNoOp(request, current.current)) {
    return {
      kind,
      id: current.id,
      before: current.current,
      after: current.current,
      aliasesAdded: [],
      warnings: ["Nothing to change: it already has that name."],
    };
  }
  return RENAME_HANDLERS[kind].rename(ctx, { ...request, ref });
}

function isNoOp(request: RenameRequest, current: RenameLocation): boolean {
  const titleSame =
    request.title === undefined || request.title.trim() === current.title;
  const slugSame =
    request.slug === undefined ||
    request.slug.trim() === current.slug ||
    request.slug.trim() === current.path;
  return titleSame && slugSame;
}

export async function resolveObjectRef(
  ctx: RenameContext,
  kind: RenameKind,
  ref: string,
): Promise<ResolvedRef | null> {
  const clean = ref.trim();
  if (!clean) return null;
  return RENAME_HANDLERS[kind].resolve(ctx, clean);
}
