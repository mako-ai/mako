/**
 * Errors, options and results of the MongoDB shell interpreter, and the
 * values it hands around (driver objects the query holds but never sees
 * inside).
 */
import type { Db, MongoClient } from "mongodb";
import { WRITE_STAGES, MAX_DEPTH } from "./language";

/** A query the interpreter refuses or cannot run; the message is for the user. */
export class MongoShellError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MongoShellError";
  }
}

export interface MongoShellOptions {
  /**
   * Whether the query was classified as a write (and so passed the
   * connection's writers check). A write method of a query classified as a
   * read is refused.
   */
  allowWrites: boolean;
  /**
   * A read-only run (an MCP key, a viewer): no database command at all,
   * read ones included, and no db.admin() method but listDatabases.
   * usersInfo, getLog or serverStatus return credentials, logs and server
   * state, not data.
   */
  readOnly?: boolean;
  signal?: AbortSignal;
  /**
   * The most documents a cursor read returns; one more is looked for, so a
   * longer result is known to be cut. Unset: every document.
   */
  maxRows?: number;
}

export interface MongoShellResult {
  /** The value of the last expression statement, promises and cursors read. */
  value: unknown;
  /** The value is a cursor read cut at `maxRows`. */
  truncated: boolean;
}

/** Driver objects the query holds but never sees inside. */
export type MinimalCursor = {
  toArray(): Promise<unknown[]>;
  hasNext(): Promise<boolean>;
  next(): Promise<unknown>;
  close(): Promise<void>;
};

export class DbHandle {
  constructor(readonly db: Db) {}
}
export class AdminHandle {
  constructor(readonly db: Db) {}
}
export class ClientHandle {
  constructor(readonly client: MongoClient) {}
}
export class CollectionHandle {
  constructor(
    readonly db: Db,
    readonly name: string,
  ) {}
}
export type CursorKind = "find" | "aggregate" | "list";
export class CursorHandle {
  constructor(
    readonly cursor: MinimalCursor,
    readonly kind: CursorKind,
  ) {}
}
export class MethodRef {
  constructor(
    readonly target: Handle,
    readonly name: string,
    readonly path: string,
  ) {}
}
export class HelperRef {
  constructor(readonly name: string) {}
}
export type Handle =
  DbHandle | AdminHandle | ClientHandle | CollectionHandle | CursorHandle;

export function isHandle(value: unknown): value is Handle {
  return (
    value instanceof DbHandle ||
    value instanceof AdminHandle ||
    value instanceof ClientHandle ||
    value instanceof CollectionHandle ||
    value instanceof CursorHandle
  );
}

export function isOpaque(value: unknown): boolean {
  return (
    isHandle(value) || value instanceof MethodRef || value instanceof HelperRef
  );
}

export function isPromise(value: unknown): value is Promise<unknown> {
  return value instanceof Promise;
}

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function describe(value: unknown): string {
  if (value instanceof DbHandle) return "db";
  if (value instanceof AdminHandle) return "db.admin()";
  if (value instanceof ClientHandle) return "db.client";
  if (value instanceof CollectionHandle) return `db.${value.name}`;
  if (value instanceof CursorHandle) return "a cursor";
  if (value instanceof MethodRef) return value.path;
  if (value instanceof HelperRef) return value.name;
  if (isPromise(value)) return "a pending result (add await)";
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value === "object" ? "an object" : typeof value;
}

/** Whether `value` (an evaluated argument) holds a `$out`/`$merge` stage. */
export function containsWriteStage(value: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH) return false;
  if (typeof value === "string") return WRITE_STAGES.has(value);
  if (Array.isArray(value)) {
    return value.some(item => containsWriteStage(item, depth + 1));
  }
  if (isPlainObject(value)) {
    return Object.entries(value).some(
      ([key, item]) =>
        WRITE_STAGES.has(key) || containsWriteStage(item, depth + 1),
    );
  }
  return false;
}

export function commandName(arg: unknown): string | null {
  if (!isPlainObject(arg)) return null;
  const first = Object.keys(arg)[0];
  return first ?? null;
}
