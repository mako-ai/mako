/**
 * The connection proxy: workflows, agents and (later) custom connectors call
 * a service through a source connection without ever seeing its credential.
 *
 * Everyone in the workspace reads. GET, HEAD, OPTIONS, a credential type's
 * `reads` (a Close search POST) and a GraphQL query are reads; everything
 * else is a write, for the principals on the connection's writers list only
 * (the same list and the same identity rule as database connections,
 * access/connection-writes.ts): a deployed workflow writes as
 * `workflow:<name>`, a person's own run as `user:<id>`, and a request that
 * identifies no one writes nothing. Agents only read. A writer may be limited
 * to one path (`where: "/task/"`). Every write is recorded in the write log,
 * allowed or not; every read is logged.
 */
import { Types } from "mongoose";
import {
  SourceConnection,
  type IConnectionWriter,
  type ISourceConnection,
} from "../database/workspace-schema";
import { ConnectionWriteEvent } from "../access/connection-write-event";
import {
  actingPrincipal,
  notAWriterRefusal,
} from "../access/connection-writes";
import { sourceConnectionManager } from "../sync/database-data-source-manager";
import { loggers } from "../logging";
import { getRequestContext } from "../logging/context";
import { credentialTypeFor, isReadRequest } from "./credential-types";
import {
  ConnectionRequestError,
  forward,
  relativePath,
  urlUnder,
  callerHeaders,
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

/** A path writer `where` covers: itself and everything under it. */
function coversPath(where: string, path: string): boolean {
  const prefix = where.replace(/\/+$/, "");
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** Whether `principal` may send the write `path` under `writers`. */
export function mayWrite(
  writers: IConnectionWriter[] | undefined,
  principal: string,
  path: string,
): boolean {
  const mine = (writers ?? []).filter(w => w.principal === principal);
  return mine.some(w => !w.where || coversPath(w.where, path));
}

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
  return SourceConnection.findOne({ workspaceId: workspace, name: idOrName });
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
  const credentialType = credentialTypeFor(row.type);
  if (!credentialType) {
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
  const method = params.request.method.toUpperCase();
  const baseUrl = credentialType.baseUrl(config);
  // Refuses a path outside the base URL before anything else.
  const url = urlUnder(baseUrl, params.request.path, params.request.query);
  const path = relativePath(baseUrl, url);
  const read = isReadRequest(
    credentialType,
    {
      method,
      path,
      headers: callerHeaders(params.request.headers),
      body: params.request.body,
    },
    config,
  );
  const principal = actingPrincipal(params.actor);
  const target = `${method} ${path}`;
  const where = {
    workspaceId: params.workspaceId,
    connectionId: String(row._id),
    principal,
    target,
    path: getRequestContext()?.path,
  };

  if (read) {
    if (row.liveReads === false) {
      throw new ConnectionRequestError(
        `Live reads are off for ${row.name}: read its synced tables instead.`,
        403,
      );
    }
    logger.info("Connection read", where);
  } else {
    if (params.readOnly) {
      if (principal) recordProxyWrite(row, principal, target, false);
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
    const allowed = mayWrite(row.writers, principal, path);
    recordProxyWrite(row, principal, target, allowed);
    if (!allowed) {
      logger.warn("Refused a connection write", where);
      throw new ConnectionRequestError(
        notAWriterRefusal(principal, row.name),
        403,
      );
    }
    logger.info("Connection write", where);
  }

  const answer = await forward(
    {
      _id: row._id,
      type: row.type,
      config,
      settings: loaded.settings as ISourceConnection["settings"],
    },
    credentialType,
    params.request,
    { signal: params.signal, lane: "proxy" },
  );
  return { ...answer, read };
}
