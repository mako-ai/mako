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
 * deployed workflows"): a deployed workflow writes iff it is listed. An
 * agent (an MCP login) only reads when it calls a connection itself. A run
 * it starts writes like any run, as the person (sandbox) or the workflow
 * (deployed), except a run started with an API key (CI, a script), whose
 * writes are refused. A dry run records its writes instead (`record`): not
 * sent, answered 202, and kept whole under the run, credential redacted
 * (workflows/recorded-writes.ts), so the agent can check what it would have
 * sent. Mako knows a deployed run by the run the worker names with each
 * request (X-Mako-Run, workflows/runs.ts `runStartedBy`); a deployed
 * workflow's write from a run Mako cannot tell is refused, as is one
 * naming a run of another workflow or a run no longer executing. A listed
 * writer writes
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
import type { RunOrigin } from "../workflows/runs";
import {
  keepRecordedWrite,
  MAX_RECORDED_PER_RUN,
  type RecordRun,
} from "../workflows/recorded-writes";
import {
  callableFor,
  isReadRequest,
  type CallableConnection,
} from "./callable";
import {
  ConnectionRequestError,
  describeRequest,
  resolveRequest,
  send,
  type ForwardInput,
  type ForwardResult,
  type ResolvedRequest,
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
   * Who started the deployed workflow run the request comes from and what
   * its writes do (workflows/runs.ts `runStartedBy`), asked only for a write
   * by a deployed workflow. A write from a run Mako cannot tell (null, or
   * not given) is refused: also a run of another workflow, or one no
   * longer executing.
   */
  runStarter?: () => Promise<RunOrigin | null>;
  /**
   * The dry run the request comes from: a sandbox one (with `readOnly`), or
   * a deployed one (used only when `runStarter` says it records writes). Its
   * writes are recorded there, never sent. Without it a refused write stays
   * refused.
   */
  record?: RecordRun;
  signal?: AbortSignal;
}

export interface ConnectionRequestResult extends ForwardResult {
  /** Whether Mako counted the request as a read. */
  read: boolean;
  /** A dry run's write: recorded, not sent. */
  recorded?: boolean;
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
 * A dry run's write: in the write log as a dry run's attempt (`dry-run:`,
 * which no list can name), kept whole under the run, and answered 202
 * without reaching the service. The answer says whether the run's writer
 * (the person or the deployed workflow) is on the connection's writers
 * list, so a dry run that passes does not hide a real run's refusal.
 */
async function recordInstead(
  row: ISourceConnection,
  config: ISourceConnection["config"],
  callable: CallableConnection,
  request: ResolvedRequest,
  workspaceId: string,
  run: RecordRun,
  principal: string,
  where: Record<string, unknown>,
): Promise<ConnectionRequestResult> {
  const target = `${request.method} ${request.path}`;
  await recordProxyWrite(row, `dry-run:${principal}`, target, false);
  const viewer =
    (await viewerPrincipals(workspaceId, [principal]).catch(() => [])).length >
    0;
  const wouldSend = !viewer && mayWrite(row.writers, principal);
  const kept = await keepRecordedWrite(
    workspaceId,
    run,
    row,
    describeRequest({ config }, callable, request),
    { wouldSend },
  );
  if (kept === "full") {
    throw new ConnectionRequestError(
      `This run recorded ${MAX_RECORDED_PER_RUN} writes already; ${target} on ${row.name} was neither sent nor recorded.`,
      409,
    );
  }
  if (kept === "failed") {
    throw new ConnectionRequestError(
      `Mako could not record ${target} on ${row.name}, so it was neither sent nor recorded.`,
      503,
    );
  }
  logger.info("Recorded a dry run's write", where);
  const shown = principal.startsWith("workflow:")
    ? "All deployed workflows"
    : principal;
  return {
    status: 202,
    headers: { "content-type": "application/json", "x-mako-recorded": "true" },
    body: {
      recorded: true,
      sent: false,
      wouldSend,
      message: wouldSend
        ? `Recorded, not sent (a dry run). ${target} on ${row.name} is in this run's recordedWrites (workflows_status).`
        : `Recorded, not sent (a dry run). ${target} on ${row.name} is in this run's recordedWrites (workflows_status). A real run would be refused: ${shown} is not on ${row.name}'s writers list (its Access tab).`,
    },
    read: false,
    recorded: true,
  };
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
      // A sandbox dry run: recorded under the run, not sent.
      if (params.record && principal) {
        return recordInstead(
          row,
          config,
          callable,
          request,
          params.workspaceId,
          params.record,
          principal,
          where,
        );
      }
      // Recorded as the agent's, which no list can name: never offered to allow.
      if (principal) {
        await recordProxyWrite(row, `agent:${principal}`, target, false);
      }
      logger.warn("Refused an agent write through a connection", where);
      throw new ConnectionRequestError(
        `Agents and runs started with an API key only read through connections; ${target} on ${row.name} is a write. Start a run (workflows_run) to write, or pass dryRun: true to record the write instead.`,
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
      const origin = params.runStarter
        ? await params.runStarter().catch(() => null)
        : null;
      if (origin?.writes === "record" && params.record) {
        return recordInstead(
          row,
          config,
          callable,
          request,
          params.workspaceId,
          params.record,
          principal,
          where,
        );
      }
      if (origin && origin.writes !== "send") {
        // Recorded as the agent's, as an agent's own attempt is.
        await recordProxyWrite(row, `agent:${principal}`, target, false);
        logger.warn("Refused a write by a run that does not write", where);
        throw new ConnectionRequestError(
          origin.writes === "record"
            ? `This run is a dry run, and the worker did not name its run (X-Mako-Run), so ${target} on ${row.name} was neither sent nor recorded.`
            : `This run was started with an API key, and such a run only reads through connections; ${target} on ${row.name} is a write. Start it from the app, the agent's workflows_run, a schedule or a webhook to write.`,
          403,
        );
      }
      if (!origin) {
        await recordProxyWrite(row, principal, target, false);
        logger.warn("Refused a write by a run Mako could not tell", where);
        throw new ConnectionRequestError(
          `Mako could not tell which run of ${principal.slice("workflow:".length)} this write comes from, so it was not sent. A write must come from a run of this workflow that is still executing, named with each request (X-Mako-Run); update the workflows runtime, or try again if Hatchet was unreachable.`,
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
