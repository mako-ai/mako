/**
 * The connection proxy: workflows and agents call a service through a source
 * connection without ever seeing its credential.
 *
 * Reads are live reads: on only where a manager turned them on in the Access
 * tab (every connection starts off, and one made before live reads existed,
 * with no `liveReads` stored, is off), and then for everyone in the
 * workspace. GET, HEAD, OPTIONS, a connection's `reads` (a Close search POST)
 * and a GraphQL query are reads; everything else is a write, for the
 * principals on the connection's writers list only (the same list and the
 * same identity rule as database connections, access/connection-writes.ts):
 * a person's own run writes as `user:<id>`, and a request that identifies no
 * one writes nothing, nor does a viewer. Deployed workflows share one
 * identity today (the worker's key; the name a request sends cannot be
 * trusted), so a source connection lists them as one, `workflow:*` ("All
 * deployed workflows"): a deployed workflow writes iff it is listed. Agents
 * only read, also through a run they started: a sandbox run (its key says
 * so) or a deployed run (the run Mako started records it, and the worker
 * names its run with each request, X-Mako-Run; a deployed workflow's write
 * from a run Mako cannot tell is refused). A listed writer writes
 * anywhere through the connection: a `where` stored on a source writer (the
 * list's schema is shared with database connections, where it limits a
 * schema or table) is ignored. Every write, allowed or not, is in the write
 * log, an allowed one before it is sent (none is sent unrecorded) with its
 * outcome after; every read is logged.
 */
import { Types } from "mongoose";
import {
  SourceConnection,
  type IConnectionWriter,
  type ISourceConnection,
} from "../database/workspace-schema";
import { ConnectionWriteEvent } from "../access/connection-write-event";
import { sourceWriterPrincipal } from "../access/connection-writers-list";
import {
  actingPrincipal,
  principalsOutsideWorkspace,
  viewerPrincipals,
} from "../access/connection-writes";
import { isWorkspaceConnectorType } from "../connectors/workspace/SandboxedConnector";
import {
  ConnectorBindingError,
  resolveConnectionBinding,
} from "../connectors/workspace/resolver";
import { sourceConnectionManager } from "../sync/database-data-source-manager";
import { loggers } from "../logging";
import { getRequestContext } from "../logging/context";
import type { RunStarter } from "../workflows/hatchet";
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
  /**
   * Who started the deployed workflow run the request comes from
   * (workflows/runs.ts `runStartedBy`), asked only for a write by a deployed
   * workflow. A run an agent started only reads; a write from a run Mako
   * cannot tell (null, or not given) is refused.
   */
  runStarter?: () => Promise<RunStarter | null>;
  signal?: AbortSignal;
}

export interface ConnectionRequestResult extends ForwardResult {
  /** Whether Mako counted the request as a read. */
  read: boolean;
}

/**
 * Whether `principal` may write through a source connection with `writers`:
 * it is listed, a deployed workflow as `workflow:*` (any `workflow:<name>`
 * stored counts as that, as the Access tab shows it). A stored `where` is
 * ignored (see the header).
 */
export function mayWrite(
  writers: IConnectionWriter[] | undefined,
  principal: string,
): boolean {
  const wanted = sourceWriterPrincipal(principal);
  return (writers ?? []).some(
    w => sourceWriterPrincipal(w.principal) === wanted,
  );
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

/**
 * Record a write attempt in the write log; answers the row's id, or null when
 * it could not be recorded.
 */
async function recordProxyWrite(
  connection: Pick<ISourceConnection, "_id" | "workspaceId">,
  principal: string,
  target: string,
  allowed: boolean,
): Promise<Types.ObjectId | null> {
  try {
    const row = await ConnectionWriteEvent.create({
      workspaceId: new Types.ObjectId(String(connection.workspaceId)),
      connectionId: new Types.ObjectId(String(connection._id)),
      principal,
      target,
      allowed,
    });
    return row._id;
  } catch (error) {
    logger.warn("Could not record a connection write", { error });
    return null;
  }
}

/** What became of a recorded write: the service's status, or why none. */
async function recordOutcome(
  id: Types.ObjectId,
  outcome: { status: number } | { error: string },
): Promise<void> {
  await ConnectionWriteEvent.updateOne({ _id: id }, { $set: outcome }).catch(
    error =>
      logger.warn("Could not record a connection write's outcome", { error }),
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
  // A workspace connector's connection resolves through the definition it
  // was saved under (connectors/workspace/resolver.ts). One whose binding
  // does not resolve is closed here too, with the way to re-bind it.
  if (isWorkspaceConnectorType(row.type)) {
    const binding = await resolveConnectionBinding(params.workspaceId, row);
    if (!binding.ok) throw new ConnectionRequestError(binding.message, 409);
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
  const loaded = await sourceConnectionManager
    .getSourceConnection(String(row._id))
    .catch(error => {
      // The config is decrypted through the binding as well (the manager).
      if (error instanceof ConnectorBindingError) {
        throw new ConnectionRequestError(error.message, 409);
      }
      throw error;
    });
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
  /** The write log's row for an allowed write, to add its outcome to. */
  let logId: Types.ObjectId | null = null;
  const where = {
    workspaceId: params.workspaceId,
    connectionId: String(row._id),
    principal,
    target,
    path: getRequestContext()?.path,
  };

  // A person acts only while a member: a key (a sandbox run's included)
  // outlives its owner's membership, its rights do not. Reads too.
  if (
    principal?.startsWith("user:") &&
    (await principalsOutsideWorkspace(params.workspaceId, [principal])).length >
      0
  ) {
    await recordProxyWrite(row, principal, target, false);
    logger.warn("Refused a connection request by a former member", where);
    throw new ConnectionRequestError(
      `${principal} is not a member of this workspace, so it cannot call ${row.name}.`,
      403,
    );
  }

  if (read) {
    // Off unless a manager turned it on: a missing field on a connection
    // made before live reads existed means off.
    if (row.liveReads !== true) {
      throw new ConnectionRequestError(
        `Live reads are off for ${row.name}: read its synced tables, or ask one of this connection's managers or the workspace owner to turn live reads on in its Access tab.`,
        403,
      );
    }
    logger.info("Connection read", where);
  } else {
    if (params.readOnly) {
      // Recorded as the agent's, which no list can name: never offered to allow.
      if (principal) {
        await recordProxyWrite(row, `agent:${principal}`, target, false);
      }
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
    if (principal.startsWith("workflow:")) {
      const starter = params.runStarter
        ? await params.runStarter().catch(() => null)
        : null;
      if (starter === "agent") {
        // Recorded as the agent's, as an agent's own attempt is.
        await recordProxyWrite(row, `agent:${principal}`, target, false);
        logger.warn("Refused a write by a run an agent started", where);
        throw new ConnectionRequestError(
          `This run was started by an agent, and a run an agent starts only reads through connections; ${target} on ${row.name} is a write. Start the workflow from the app, a schedule or a webhook to write.`,
          403,
        );
      }
      if (!starter) {
        await recordProxyWrite(row, principal, target, false);
        logger.warn("Refused a write by a run Mako could not tell", where);
        throw new ConnectionRequestError(
          `Mako could not tell which run of ${principal.slice("workflow:".length)} this write comes from, so it was not sent. The worker sends its run with each request (X-Mako-Run); update the workflows runtime, or try again if Hatchet was unreachable.`,
          403,
        );
      }
    }
    // A viewer never writes, even when listed (the role may have changed).
    const viewer =
      (await viewerPrincipals(params.workspaceId, [principal])).length > 0;
    const allowed = !viewer && mayWrite(row.writers, principal);
    const recorded = await recordProxyWrite(row, principal, target, allowed);
    if (allowed && !recorded) {
      logger.warn(
        "Refused a connection write that could not be recorded",
        where,
      );
      throw new ConnectionRequestError(
        "Mako could not record this write, so it was not sent.",
        503,
      );
    }
    logId = recorded;
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
      // A workflow is allowed as every deployed workflow.
      const shown = principal.startsWith("workflow:")
        ? "All deployed workflows"
        : principal;
      throw new ConnectionRequestError(
        `${principal} is not allowed to write to ${row.name}. Ask one of this connection's managers or the workspace owner to allow ${shown} on the connection's Access tab.`,
        403,
      );
    }
    logger.info("Connection write", where);
  }

  let answer: ForwardResult;
  try {
    answer = await send(
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
  } catch (error) {
    // `send` strips every credential from its errors.
    if (logId) {
      await recordOutcome(logId, {
        error: (error instanceof Error ? error.message : String(error)).slice(
          0,
          500,
        ),
      });
    }
    throw error;
  }
  if (logId) await recordOutcome(logId, { status: answer.status });
  return { ...answer, read };
}
