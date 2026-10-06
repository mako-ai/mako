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
  return RENAME_HANDLERS[kind].rename(ctx, request);
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
