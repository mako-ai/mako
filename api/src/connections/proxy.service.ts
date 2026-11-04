/**
 * The connection proxy: workflows and agents call a service through a source
 * connection without ever seeing its credential.
 *
 * Reads are live reads: on only where an admin turned them on in the Access
 * tab (a new Custom API connection starts on; every older connection, with
 * no `liveReads` stored, is off), and then for everyone in the workspace.
 * GET, HEAD, OPTIONS, a connection's `reads` (a Close search POST) and a
 * GraphQL query are reads; everything
 * else is a write, for the principals on the connection's writers list only
 * (the same list and the same identity rule as database connections,
 * access/connection-writes.ts): a deployed workflow writes as
 * `workflow:<name>`, a person's own run as `user:<id>`, and a request that
 * identifies no one writes nothing, nor does a viewer. Agents only read. A listed writer writes
 * anywhere through the connection: a `where` stored on a source writer (the
 * list's schema is shared with database connections, where it limits a
 * schema or table) is ignored. Every write is recorded in the write log,
 * allowed or not; every read is logged.
 */
import { Types } from "mongoose";
import {
  SourceConnection,
  type IConnectionWriter,
  type ISourceConnection,
} from "../database/workspace-schema";
import { ConnectionWriteEvent } from "../access/connection-write-event";
import { actingPrincipal, viewerPrincipals } from "../access/connection-writes";
import { sourceConnectionManager } from "../sync/database-data-source-manager";
import { loggers } from "../logging";
import { getRequestContext } from "../logging/context";
import { callableFor, isReadRequest } from "./callable";
import {
  ConnectionRequestError,
  resolveRequest,
  send,
  type ForwardInput,
  type ForwardResult,
} from "./forward";

const logger = loggers.connector("proxy");

export interface ConnectionRequestParams {
  workspaceId: string;
  /** The connection's id or its name. */
  connection: string;
  request: ForwardInput;
  /** An agent: reads only, whoever it acts for. */
  readOnly?: boolean;
  /** Who is acting, when not the request's own person or workflow. */
  actor?: string;
  signal?: AbortSignal;
}

export interface ConnectionRequestResult extends ForwardResult {
  /** Whether Mako counted the request as a read. */
  read: boolean;
}

/**
 * Whether `principal` may write through a source connection with `writers`:
 * it is listed. A stored `where` is ignored (see the header).
 */
export function mayWrite(
  writers: IConnectionWriter[] | undefined,
  principal: string,
): boolean {
  return (writers ?? []).some(w => w.principal === principal);
}

/**
 * The connection `idOrName` names in the workspace: by id first, else by
 * name, refused when several share that name.
 */
async function findConnection(
  workspaceId: string,
  idOrName: string,
): Promise<ISourceConnection | null> {
  if (!Types.ObjectId.isValid(workspaceId)) return null;
  const workspace = new Types.ObjectId(workspaceId);
  if (Types.ObjectId.isValid(idOrName)) {
    const byId = await SourceConnection.findOne({
      _id: new Types.ObjectId(idOrName),
      workspaceId: workspace,
    });
    if (byId) return byId;
  }
  const byName = await SourceConnection.find({
    workspaceId: workspace,
    name: idOrName,
  }).limit(2);
  if (byName.length > 1) {
    throw new ConnectionRequestError(
      `Several connections are called ${idOrName}; use its id.`,
      409,
    );
  }
  return byName[0] ?? null;
}

function recordProxyWrite(
  connection: Pick<ISourceConnection, "_id" | "workspaceId">,
  principal: string,
  target: string,
  allowed: boolean,
): void {
  void ConnectionWriteEvent.create({
    workspaceId: new Types.ObjectId(String(connection.workspaceId)),
    connectionId: new Types.ObjectId(String(connection._id)),
    principal,
    target,
    allowed,
  }).catch(error =>
    logger.warn("Could not record a connection write", { error }),
  );
}

/**
 * Send one request through a source connection, after the read/write check.
 * Throws ConnectionRequestError for a refusal or a caller mistake.
 */
export async function connectionRequest(
  params: ConnectionRequestParams,
): Promise<ConnectionRequestResult> {
  const row = await findConnection(params.workspaceId, params.connection);
  if (!row) {
    throw new ConnectionRequestError(
      `No connection ${params.connection} in this workspace.`,
      404,
    );
  }
  const callable = callableFor(row.type);
  if (!callable) {
    throw new ConnectionRequestError(
      `${row.name} is a ${row.type} connection, which cannot be called directly yet.`,
    );
  }
  if (row.isActive === false) {
    throw new ConnectionRequestError(`${row.name} is disabled.`, 403);
  }
  // The stored credential, decrypted by the connector's own schema.
  const loaded = await sourceConnectionManager.getSourceConnection(
    String(row._id),
  );
  if (!loaded) {
    throw new ConnectionRequestError(
      `No connection ${params.connection}.`,
      404,
    );
  }
  const config = loaded.connection ?? {};
  // Refuses a method or a path outside the base URL before anything else.
  const request = resolveRequest(callable, config, params.request);
  const { path } = request;
  const read = isReadRequest(callable, request, config);
  const principal = actingPrincipal(params.actor);
  const target = `${request.method} ${path}`;
  const where = {
    workspaceId: params.workspaceId,
    connectionId: String(row._id),
    principal,
    target,
    path: getRequestContext()?.path,
  };

  if (read) {
    // Off unless an admin turned it on (a Custom API starts on): a missing
    // field on a connection made before live reads existed means off.
    if (row.liveReads !== true) {
      throw new ConnectionRequestError(
        `Live reads are off for ${row.name}: read its synced tables, or ask an admin to turn live reads on in its Access tab.`,
        403,
      );
    }
    logger.info("Connection read", where);
  } else {
    if (params.readOnly) {
      // Recorded as the agent's, which no list can name: never offered to allow.
      if (principal) recordProxyWrite(row, `agent:${principal}`, target, false);
      logger.warn("Refused an agent write through a connection", where);
      throw new ConnectionRequestError(
        `Agents only read through connections; ${target} on ${row.name} is a write. Write from a workflow on the connection's writers list.`,
        403,
      );
    }
    if (!principal) {
      logger.warn("Refused a connection write by no identified caller", where);
      throw new ConnectionRequestError(
        `Mako could not tell who is writing to ${row.name}, so the write was refused. Writes need a signed-in person, an API key, or a workflow on the connection's writers list.`,
        403,
      );
    }
    // A viewer never writes, even when listed (the role may have changed).
    const viewer =
      (await viewerPrincipals(params.workspaceId, [principal])).length > 0;
    const allowed = !viewer && mayWrite(row.writers, principal);
    recordProxyWrite(row, principal, target, allowed);
    if (!allowed) {
      logger.warn("Refused a connection write", where);
      // Not the database wording ("everyone can read it"): here reading
      // depends on live reads being on.
      if (viewer) {
        throw new ConnectionRequestError(
          `Viewers can't write through a connection; ${principal} is a viewer of this workspace.`,
          403,
        );
      }
      throw new ConnectionRequestError(
        `${principal} is not allowed to write to ${row.name}. An admin can allow ${principal} on the connection's Access tab.`,
        403,
      );
    }
    logger.info("Connection write", where);
  }

  const answer = await send(
    {
      _id: row._id,
      type: row.type,
      config,
      settings: loaded.settings as ISourceConnection["settings"],
    },
    callable,
    request,
    { signal: params.signal },
  );
  return { ...answer, read };
}
