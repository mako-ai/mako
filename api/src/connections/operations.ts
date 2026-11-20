/**
 * Named read operations on a source connection: "search Close leads", "run
 * a HogQL query", "get a Stripe customer", without knowing the vendor's API.
 *
 * Code, not stored. An operation only builds an ordinary request (method,
 * path, query, body) from a few parameters. That request then goes through
 * the proxy like any other (connections/proxy.service.ts): the path must stay
 * under the base URL, the call profile decides whether it reads
 * (connections/callable.ts), and the connection's live-read settings decide
 * who may send it. So an operation adds no right; it is a shortcut to a read
 * the raw request could already make.
 *
 * Every operation here reads. A write operation does not belong in this
 * list: agents only read through connections.
 */
import type { ISourceConnection } from "../database/workspace-schema";
import { ConnectionRequestError, type ForwardInput } from "./forward";
import { callableProfileOperations } from "./callable-profiles";

type Config = ISourceConnection["config"];
type Params = Record<string, unknown>;

export interface OperationParam {
  name: string;
  required: boolean;
  description: string;
}

export interface ConnectionOperation {
  name: string;
  description: string;
  params: OperationParam[];
  /** The request it sends. Throws ConnectionRequestError for a bad param. */
  build(params: Params, config: Config): ForwardInput;
}

/** Default and maximum page size an operation asks a service for. */
export const OPERATION_DEFAULT_LIMIT = 20;
export const OPERATION_MAX_LIMIT = 100;

export function param(name: string, description: string, required = false) {
  return { name, description, required };
}

/** A required non-empty string parameter. */
export function required(params: Params, name: string): string {
  const value = params[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new ConnectionRequestError(
      `Pass params.${name}, a non-empty string.`,
    );
  }
  return value.trim();
}

/** An optional string parameter. */
export function optional(params: Params, name: string): string | undefined {
  const value = params[name];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new ConnectionRequestError(`params.${name} must be a string.`);
  }
  return value.trim();
}

/** An id that goes into a path: one segment, nothing a server could split. */
export function idParam(params: Params, name: string): string {
  const value = required(params, name);
  if (!/^[A-Za-z0-9_.:@-]+$/.test(value) || /^\.+$/.test(value)) {
    throw new ConnectionRequestError(
      `params.${name} must be a plain id (letters, digits, _ . : @ -).`,
    );
  }
  return encodeURIComponent(value);
}

/** `params.limit`, bounded: default OPERATION_DEFAULT_LIMIT, at most OPERATION_MAX_LIMIT. */
export function limitParam(params: Params): number {
  const raw = params.limit;
  if (raw === undefined || raw === null) return OPERATION_DEFAULT_LIMIT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new ConnectionRequestError(
      "params.limit must be a positive integer.",
    );
  }
  return Math.min(value, OPERATION_MAX_LIMIT);
}

/** `params.skip`: a non-negative integer, default 0. */
export function skipParam(params: Params): number {
  const value = Number(params.skip ?? 0);
  if (!Number.isInteger(value) || value < 0) {
    throw new ConnectionRequestError(
      "params.skip must be a non-negative integer.",
    );
  }
  return value;
}

export const LIMIT = param(
  "limit",
  `Records per page (default ${OPERATION_DEFAULT_LIMIT}, max ${OPERATION_MAX_LIMIT}).`,
);

/** The named operations of a connection type (none for most). */
export function operationsFor(type: string): ConnectionOperation[] {
  return callableProfileOperations(type);
}

/** The operations of `type` as an agent sees them: name, description, params. */
export function describeOperations(type: string) {
  return operationsFor(type).map(({ name, description, params }) => ({
    name,
    description,
    params,
  }));
}

/**
 * The request operation `name` of a `type` connection sends, or a refusal
 * naming the operations that exist.
 */
export function operationRequest(
  type: string,
  config: Config,
  name: string,
  params: Params = {},
): ForwardInput {
  const operations = operationsFor(type);
  const operation = operations.find(op => op.name === name);
  if (!operation) {
    throw new ConnectionRequestError(
      operations.length
        ? `A ${type} connection has no operation ${name}. Its operations: ${operations.map(op => op.name).join(", ")}.`
        : `A ${type} connection has no named operations; send a request with method and path instead.`,
    );
  }
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new ConnectionRequestError("params must be an object.");
  }
  return operation.build(params, config ?? {});
}
