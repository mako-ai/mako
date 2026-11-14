/**
 * The rename handlers, one per kind (see ./types.ts for the contract).
 *
 * The map is partial on purpose: a kind is added with its handler file and
 * one line here. Until then it answers "not supported yet" (501) on every
 * surface, instead of a 404 that reads as "your object is gone".
 */
import { connectionRenameHandler } from "./handlers/connection";
import { dbtJobRenameHandler } from "./handlers/dbt-job";
import { flowRenameHandler } from "./handlers/flow";
import { normalizeDisplayName } from "./title-rules";
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

export const RENAME_HANDLERS: Partial<Record<RenameKind, RenameHandler>> = {
  flow: flowRenameHandler,
  dbt_job: dbtJobRenameHandler,
  connection: connectionRenameHandler,
};

export function isRenameKind(value: string): value is RenameKind {
  return (RENAME_KINDS as readonly string[]).includes(value);
}

/** The kinds that have a handler today, in `RENAME_KINDS` order. */
export function supportedRenameKinds(): RenameKind[] {
  return RENAME_KINDS.filter(kind => RENAME_HANDLERS[kind] !== undefined);
}

const KIND_LABEL: Record<RenameKind, string> = {
  app: "an app",
  console: "a console",
  notebook: "a notebook",
  flow: "a flow",
  dbt_job: "a dbt job",
  dbt_file: "a dbt file",
  skill: "a skill",
  connector: "a connector",
  connection: "a connection",
};

function handlerFor(kind: RenameKind): RenameHandler {
  const handler = RENAME_HANDLERS[kind];
  if (!handler) {
    throw new RenameError(
      `Renaming ${KIND_LABEL[kind]} is not supported yet.`,
      501,
    );
  }
  return handler;
}

export async function renameObject(
  ctx: RenameContext,
  kind: RenameKind,
  request: RenameRequest,
): Promise<RenameResult> {
  const handler = handlerFor(kind);
  if (request.title === undefined && request.slug === undefined) {
    throw new RenameError("Give a new title, a new slug, or both.");
  }
  // The same ref the resolve endpoint accepts: a padded id or name must not
  // resolve there and 404 here.
  const ref = request.ref.trim();
  // A rename to what the object is already called succeeds with nothing to
  // do — one answer for every kind, decided here rather than per handler.
  const current = await handler.resolve(ctx, ref);
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
  return handler.rename(ctx, { ...request, ref });
}

function isNoOp(request: RenameRequest, current: RenameLocation): boolean {
  const titleSame =
    request.title === undefined ||
    normalizeDisplayName(request.title) === current.title;
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
  const handler = handlerFor(kind);
  const clean = ref.trim();
  if (!clean) return null;
  return handler.resolve(ctx, clean);
}
