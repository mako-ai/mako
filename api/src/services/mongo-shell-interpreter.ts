/**
 * A safe interpreter for MongoDB shell-style queries
 * (`db.users.find({ age: { $gt: 30 } }).sort({ age: -1 }).limit(10)`).
 *
 * The query is parsed with acorn and its syntax tree walked. Nothing is ever
 * evaluated as JavaScript: there is no `eval`, `Function` or `vm` here. Only
 * a small language is understood:
 *
 * - a chain rooted at `db` (`db.<collection>`, `db.getCollection("x")`,
 *   `db.getCollectionNames()`, `db.admin().listDatabases()`,
 *   `db.getSiblingDB("other")`…) and calls of the methods listed below on
 *   what it returns (collections, cursors);
 * - literals: strings, numbers, booleans, null, regular expressions,
 *   templates without `${}`, object and array literals, unary `-`/`+`/`!`,
 *   arithmetic on numbers (`Date.now() - 86400000`);
 * - the shell's value helpers: ObjectId, ISODate, Date, NumberInt,
 *   NumberLong, NumberDecimal, UUID, RegExp, Timestamp, MinKey, MaxKey;
 * - `const`/`let`/`var` bindings and `await` (calls are awaited anyway, as
 *   in the shell), several statements in a row,
 *   the value of the last expression statement being the result.
 *
 * Anything else (another identifier such as `process` or `require`, a
 * function, an assignment, `this`, `import()`, a computed key, `constructor`
 * or `__proto__`) is refused before a single call is made, with an error that
 * says what is not allowed. Property reads on returned documents are limited
 * to their own data properties; methods are only those of the tables below.
 *
 * A method that writes runs only when `allowWrites` says the query was
 * classified as a write (and so passed the connection's writers check);
 * `findMongoShellWrite` is that classification's static half.
 */
import {
  parse,
  type Expression,
  type Node,
  type ObjectExpression,
  type Program,
  type Property,
  type SpreadElement,
  type Statement,
} from "acorn";
import {
  Decimal128,
  Int32,
  Long,
  MaxKey,
  MinKey,
  ObjectId,
  Timestamp,
  UUID,
  type Db,
  type MongoClient,
} from "mongodb";

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

// ---------------------------------------------------------------------------
// What the language allows
// ---------------------------------------------------------------------------

/** Never readable, on anything: the ways out of data into code. */
const FORBIDDEN_PROPERTIES = new Set([
  "constructor",
  "__proto__",
  "prototype",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
  "caller",
  "callee",
  "arguments",
  "call",
  "apply",
  "bind",
  "then",
]);

/** Commands `db.command()`/`runCommand()` may run for a query that only reads. */
const READ_COMMANDS = new Set(
  [
    "buildInfo",
    "collStats",
    "connectionStatus",
    "connPoolStats",
    "count",
    "dataSize",
    "dbStats",
    "distinct",
    "getLog",
    "hello",
    "hostInfo",
    "isMaster",
    "listCollections",
    "listDatabases",
    "listIndexes",
    "ping",
    "replSetGetStatus",
    "rolesInfo",
    "serverStatus",
    "top",
    "usersInfo",
  ].map(name => name.toLowerCase()),
);

/** Methods that change data or structure (on a db, collection or cursor). */
const WRITE_METHODS = new Set([
  // db
  "createCollection",
  "dropCollection",
  "dropDatabase",
  "renameCollection",
  "removeUser",
  "setProfilingLevel",
  // collection
  "insert",
  "insertOne",
  "insertMany",
  "update",
  "updateOne",
  "updateMany",
  "replaceOne",
  "remove",
  "deleteOne",
  "deleteMany",
  "bulkWrite",
  "findOneAndUpdate",
  "findOneAndReplace",
  "findOneAndDelete",
  "createIndex",
  "createIndexes",
  "dropIndex",
  "dropIndexes",
  "drop",
  "rename",
  "createSearchIndex",
  "createSearchIndexes",
  "dropSearchIndex",
  "updateSearchIndex",
  // aggregation cursor
  "out",
]);

/** Methods that run a database command: a write unless a READ_COMMANDS one. */
const COMMAND_METHODS = new Set(["command", "runCommand", "adminCommand"]);

const WRITE_STAGES = new Set(["$out", "$merge"]);

const HELPERS = new Set([
  "ObjectId",
  "ObjectID",
  "ISODate",
  "Date",
  "NumberInt",
  "NumberLong",
  "NumberDecimal",
  "UUID",
  "RegExp",
  "Timestamp",
  "MinKey",
  "MaxKey",
]);

const GLOBAL_VALUES: Record<string, unknown> = {
  undefined: undefined,
  NaN: Number.NaN,
  Infinity: Number.POSITIVE_INFINITY,
};

const MAX_DEPTH = 256;

// ---------------------------------------------------------------------------
// Values the interpreter hands around
// ---------------------------------------------------------------------------

/** Driver objects the query holds but never sees inside. */
type MinimalCursor = {
  toArray(): Promise<unknown[]>;
  hasNext(): Promise<boolean>;
  next(): Promise<unknown>;
  close(): Promise<void>;
};

class DbHandle {
  constructor(readonly db: Db) {}
}
class AdminHandle {
  constructor(readonly db: Db) {}
}
class ClientHandle {
  constructor(readonly client: MongoClient) {}
}
class CollectionHandle {
  constructor(
    readonly db: Db,
    readonly name: string,
  ) {}
}
type CursorKind = "find" | "aggregate" | "list";
class CursorHandle {
  constructor(
    readonly cursor: MinimalCursor,
    readonly kind: CursorKind,
  ) {}
}
class MethodRef {
  constructor(
    readonly target: Handle,
    readonly name: string,
    readonly path: string,
  ) {}
}
class HelperRef {
  constructor(readonly name: string) {}
}
type Handle =
  DbHandle | AdminHandle | ClientHandle | CollectionHandle | CursorHandle;

function isHandle(value: unknown): value is Handle {
  return (
    value instanceof DbHandle ||
    value instanceof AdminHandle ||
    value instanceof ClientHandle ||
    value instanceof CollectionHandle ||
    value instanceof CursorHandle
  );
}

function isOpaque(value: unknown): boolean {
  return (
    isHandle(value) || value instanceof MethodRef || value instanceof HelperRef
  );
}

function isPromise(value: unknown): value is Promise<unknown> {
  return value instanceof Promise;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// ---------------------------------------------------------------------------
// Parsing and the static write check
// ---------------------------------------------------------------------------

function parseQuery(query: string): Program {
  try {
    return parse(query, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: false,
      allowHashBang: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new MongoShellError(`Could not parse the MongoDB query: ${message}`);
  }
}

/** A static property name: `a.name`, `a["name"]` or `a[0]`; null if computed. */
function staticPropertyName(node: {
  property: Node;
  computed: boolean;
}): string | null {
  const property = node.property as Expression;
  if (!node.computed) {
    return property.type === "Identifier" ? property.name : null;
  }
  if (
    property.type === "Literal" &&
    (typeof property.value === "string" || typeof property.value === "number")
  ) {
    return String(property.value);
  }
  if (
    property.type === "TemplateLiteral" &&
    property.expressions.length === 0
  ) {
    return property.quasis.map(q => q.value.cooked ?? "").join("");
  }
  return null;
}

function staticKeyName(property: Property): string | null {
  if (property.computed) return null;
  const key = property.key;
  if (key.type === "Identifier") return key.name;
  if (key.type === "Literal") return String(key.value);
  return null;
}

/** The name of the command a static `command({...})` argument names. */
function staticCommandName(arg: Node | undefined): string | null {
  if (!arg || arg.type !== "ObjectExpression") return null;
  const first = (arg as ObjectExpression).properties[0];
  if (!first || first.type !== "Property") return null;
  return staticKeyName(first);
}

/** Every child node of `node` (a generic walk over the syntax tree). */
function children(node: Node): Node[] {
  const out: Node[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc" || key === "range") continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === "object" && "type" in item) {
          out.push(item as Node);
        }
      }
    } else if (value && typeof value === "object" && "type" in value) {
      out.push(value as Node);
    }
  }
  return out;
}

/**
 * The write a MongoDB shell query visibly makes, judged from its syntax
 * alone: a call of a write method (`.insertOne(`, `.drop(`…), a command that
 * is not a known read, or a `$out`/`$merge` key or string. Null when it
 * only reads or cannot be parsed (it then never runs).
 */
export function findMongoShellWrite(query: string): string | null {
  let program: Program;
  try {
    program = parseQuery(query);
  } catch {
    return null;
  }
  const stack: Node[] = [program];
  while (stack.length > 0) {
    const node = stack.pop() as Node;
    if (node.type === "CallExpression") {
      const callee = (node as unknown as { callee: Node }).callee;
      if (callee.type === "MemberExpression") {
        const name = staticPropertyName(
          callee as unknown as { property: Node; computed: boolean },
        );
        if (name && WRITE_METHODS.has(name)) return name;
        if (name && COMMAND_METHODS.has(name)) {
          const args = (node as unknown as { arguments: Node[] }).arguments;
          const command = staticCommandName(args[0]);
          if (!command || !READ_COMMANDS.has(command.toLowerCase())) {
            return name;
          }
        }
      }
    } else if (node.type === "Property") {
      const key = staticKeyName(node as Property);
      if (key && WRITE_STAGES.has(key)) return key;
    } else if (node.type === "Literal") {
      const value = (node as unknown as { value: unknown }).value;
      if (typeof value === "string" && WRITE_STAGES.has(value)) return value;
    }
    stack.push(...children(node));
  }
  return null;
}

// ---------------------------------------------------------------------------
// The interpreter
// ---------------------------------------------------------------------------

function describe(value: unknown): string {
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
function containsWriteStage(value: unknown, depth = 0): boolean {
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

function commandName(arg: unknown): string | null {
  if (!isPlainObject(arg)) return null;
  const first = Object.keys(arg)[0];
  return first ?? null;
}

class Interpreter {
  private readonly scope = new Map<string, unknown>();
  private readonly tracked: Promise<unknown>[] = [];
  private readonly trackedErrors: unknown[] = [];
  private readonly truncatedReads = new WeakSet<object>();

  constructor(
    private readonly db: Db,
    private readonly options: MongoShellOptions,
  ) {}

  async run(program: Program): Promise<MongoShellResult> {
    let last: unknown = undefined;
    for (const statement of program.body) {
      last = await this.statement(statement as Statement);
    }
    const value = await this.settle(last);
    if (this.tracked.length > 0) {
      await Promise.allSettled(this.tracked);
      if (this.trackedErrors.length > 0) throw this.trackedErrors[0];
    }
    if (isOpaque(value) && !(value instanceof CollectionHandle)) {
      throw new MongoShellError(
        `The query ends in ${describe(value)}, which is not a result. Call a method such as find(), aggregate() or toArray().`,
      );
    }
    const truncated =
      value !== null &&
      typeof value === "object" &&
      this.truncatedReads.has(value);
    if (value instanceof CollectionHandle) {
      return {
        value: { _type: "Collection", name: value.name },
        truncated: false,
      };
    }
    return { value, truncated };
  }

  /** The final value: a promise awaited, a cursor read. */
  private async settle(value: unknown): Promise<unknown> {
    if (isPromise(value)) return this.await(value);
    if (value instanceof CursorHandle) return this.readCursor(value);
    return value;
  }

  private async statement(node: Statement): Promise<unknown> {
    switch (node.type) {
      case "ExpressionStatement":
        return this.expression(node.expression, 0);
      case "EmptyStatement":
        return undefined;
      case "VariableDeclaration": {
        for (const declarator of node.declarations) {
          if (declarator.id.type !== "Identifier") {
            throw new MongoShellError(
              "Only simple variable names are supported (no destructuring).",
            );
          }
          const name = declarator.id.name;
          if (
            name === "db" ||
            HELPERS.has(name) ||
            name in GLOBAL_VALUES ||
            this.scope.has(name)
          ) {
            throw new MongoShellError(
              `The name ${name} is already taken; choose another variable name.`,
            );
          }
          if (!declarator.init) {
            throw new MongoShellError(
              `The variable ${name} needs a value (const ${name} = …).`,
            );
          }
          this.scope.set(name, await this.expression(declarator.init, 0));
        }
        return undefined;
      }
      default:
        throw new MongoShellError(
          `Unsupported statement in a MongoDB query: ${node.type}. Only expressions and const/let declarations are allowed.`,
        );
    }
  }

  private async expression(node: Expression, depth: number): Promise<unknown> {
    if (depth > MAX_DEPTH) {
      throw new MongoShellError("The MongoDB query is nested too deeply.");
    }
    const next = depth + 1;
    switch (node.type) {
      case "Literal": {
        if (node.regex) return new RegExp(node.regex.pattern, node.regex.flags);
        if (typeof node.value === "bigint") {
          return Long.fromBigInt(node.value);
        }
        return node.value;
      }
      case "TemplateLiteral": {
        if (node.expressions.length > 0) {
          throw new MongoShellError(
            "Template strings with ${…} are not supported in MongoDB queries; use a plain string.",
          );
        }
        return node.quasis.map(q => q.value.cooked ?? "").join("");
      }
      case "Identifier":
        return this.identifier(node.name);
      case "ArrayExpression": {
        const out: unknown[] = [];
        for (const element of node.elements) {
          if (element === null) {
            out.push(undefined);
            continue;
          }
          if (element.type === "SpreadElement") {
            out.push(...this.spreadArray(await this.spread(element, next)));
            continue;
          }
          out.push(this.data(await this.expression(element, next)));
        }
        return out;
      }
      case "ObjectExpression":
        return this.object(node, next);
      case "UnaryExpression": {
        if (!["-", "+", "!"].includes(node.operator)) {
          throw new MongoShellError(
            `The operator ${node.operator} is not supported in MongoDB queries.`,
          );
        }
        const value = this.data(await this.expression(node.argument, next));
        switch (node.operator) {
          case "-":
          case "+":
            if (typeof value !== "number") {
              throw new MongoShellError(
                `Unary ${node.operator} needs a number.`,
              );
            }
            return node.operator === "-" ? -value : value;
          case "!":
            return !value;
          default:
            throw new MongoShellError(
              `The operator ${node.operator} is not supported in MongoDB queries.`,
            );
        }
      }
      case "BinaryExpression": {
        if (node.left.type === "PrivateIdentifier") {
          throw new MongoShellError("Unsupported syntax in a MongoDB query.");
        }
        const left = this.data(await this.expression(node.left, next));
        const right = this.data(await this.expression(node.right, next));
        return arithmetic(node.operator, left, right);
      }
      case "AwaitExpression":
        return this.settleAwait(await this.expression(node.argument, next));
      case "MemberExpression": {
        if (node.object.type === "Super") {
          throw new MongoShellError("Unsupported syntax in a MongoDB query.");
        }
        if (node.optional) {
          throw new MongoShellError(
            "Optional chaining (?.) is not supported in MongoDB queries.",
          );
        }
        const name = staticPropertyName(node);
        if (name === null) {
          throw new MongoShellError(
            'Computed property access (x[expr]) is not supported in MongoDB queries; use x.name, x["name"] or x[0].',
          );
        }
        const object = await this.expression(node.object, next);
        return this.member(object, name);
      }
      case "CallExpression": {
        if (node.optional) {
          throw new MongoShellError(
            "Optional calls (?.()) are not supported in MongoDB queries.",
          );
        }
        if (node.callee.type === "Super") {
          throw new MongoShellError("Unsupported syntax in a MongoDB query.");
        }
        const callee = await this.expression(node.callee, next);
        const args = await this.arguments(node.arguments, next);
        return this.call(callee, args, false);
      }
      case "NewExpression": {
        const callee = await this.expression(node.callee, next);
        if (!(callee instanceof HelperRef)) {
          throw new MongoShellError(
            `new is only supported with ${[...HELPERS].join(", ")}.`,
          );
        }
        const args = await this.arguments(node.arguments, next);
        return this.call(callee, args, true);
      }
      case "ChainExpression":
        throw new MongoShellError(
          "Optional chaining (?.) is not supported in MongoDB queries.",
        );
      case "ThisExpression":
        throw new MongoShellError(
          "`this` is not available in MongoDB queries.",
        );
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        throw new MongoShellError(
          "Functions are not supported in MongoDB queries. Use aggregation operators ($map, $filter, $reduce…) instead.",
        );
      case "AssignmentExpression":
      case "UpdateExpression":
        throw new MongoShellError(
          "Assignments are not supported in MongoDB queries; use const name = value.",
        );
      case "ImportExpression":
        throw new MongoShellError(
          "import() is not available in MongoDB queries.",
        );
      default:
        throw new MongoShellError(
          `Unsupported syntax in a MongoDB query: ${node.type}.`,
        );
    }
  }

  private identifier(name: string): unknown {
    if (this.scope.has(name)) return this.scope.get(name);
    if (name === "db") return new DbHandle(this.db);
    if (HELPERS.has(name)) return new HelperRef(name);
    if (name in GLOBAL_VALUES) return GLOBAL_VALUES[name];
    throw new MongoShellError(
      `${name} is not available in MongoDB queries. Start from db (e.g. db.users.find({})); the helpers ${[...HELPERS].join(", ")} are also available.`,
    );
  }

  private async spread(node: SpreadElement, depth: number): Promise<unknown> {
    return this.data(await this.expression(node.argument, depth));
  }

  private spreadArray(value: unknown): unknown[] {
    if (!Array.isArray(value)) {
      throw new MongoShellError("Only arrays can be spread (...) into arrays.");
    }
    return value;
  }

  private async object(
    node: ObjectExpression,
    depth: number,
  ): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    const define = (key: string, value: unknown) => {
      if (FORBIDDEN_PROPERTIES.has(key) && key !== "then") {
        throw new MongoShellError(
          `The key ${key} is not allowed in MongoDB queries.`,
        );
      }
      // defineProperty, never `out[key] =`: a key can never reach a setter.
      Object.defineProperty(out, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    };
    for (const property of node.properties) {
      if (property.type === "SpreadElement") {
        const value = await this.spread(property, depth);
        if (!isPlainObject(value)) {
          throw new MongoShellError(
            "Only plain objects can be spread (...) into objects.",
          );
        }
        for (const [key, item] of Object.entries(value)) define(key, item);
        continue;
      }
      if (property.kind !== "init" || property.method) {
        throw new MongoShellError(
          "Getters, setters and methods are not supported in MongoDB queries.",
        );
      }
      const key = staticKeyName(property);
      if (key === null) {
        throw new MongoShellError(
          "Computed keys ({[expr]: …}) are not supported in MongoDB queries.",
        );
      }
      define(key, this.data(await this.expression(property.value, depth)));
    }
    return out;
  }

  private async arguments(
    nodes: Array<Expression | SpreadElement>,
    depth: number,
  ): Promise<unknown[]> {
    const args: unknown[] = [];
    for (const node of nodes) {
      if (node.type === "SpreadElement") {
        args.push(...this.spreadArray(await this.spread(node, depth)));
        continue;
      }
      args.push(this.data(await this.expression(node, depth)));
    }
    return args;
  }

  /** `value` as data: driver handles, methods and helpers are not data. */
  private data(value: unknown): unknown {
    if (isOpaque(value) || isPromise(value)) {
      throw new MongoShellError(
        `${describe(value)} cannot be used as a value here.`,
      );
    }
    return value;
  }

  private member(object: unknown, name: string): unknown {
    if (FORBIDDEN_PROPERTIES.has(name)) {
      throw new MongoShellError(
        `Access to ${name} is not allowed in MongoDB queries.`,
      );
    }
    if (object instanceof DbHandle) {
      if (name === "client") {
        return new ClientHandle(
          (object.db as unknown as { client: MongoClient }).client,
        );
      }
      if (name === "databaseName") return object.db.databaseName;
      if (DB_METHODS.has(name)) {
        return new MethodRef(object, name, `db.${name}`);
      }
      return new CollectionHandle(object.db, name);
    }
    if (object instanceof CollectionHandle) {
      if (name === "collectionName") return object.name;
      if (name === "dbName") return object.db.databaseName;
      if (name === "namespace") {
        return `${object.db.databaseName}.${object.name}`;
      }
      if (COLLECTION_METHODS.has(name)) {
        return new MethodRef(object, name, `db.${object.name}.${name}`);
      }
      // The shell's db.system.users: a dotted collection name.
      return new CollectionHandle(object.db, `${object.name}.${name}`);
    }
    if (object instanceof CursorHandle) {
      if (CURSOR_METHODS[object.kind].has(name)) {
        return new MethodRef(object, name, `cursor.${name}`);
      }
      throw new MongoShellError(
        `${name} is not a supported cursor method. Supported: ${[...CURSOR_METHODS[object.kind]].join(", ")}.`,
      );
    }
    if (object instanceof AdminHandle) {
      if (ADMIN_METHODS.has(name)) {
        return new MethodRef(object, name, `db.admin().${name}`);
      }
      throw new MongoShellError(
        `${name} is not a supported db.admin() method. Supported: ${[...ADMIN_METHODS].join(", ")}.`,
      );
    }
    if (object instanceof ClientHandle) {
      if (name === "db") return new MethodRef(object, name, "db.client.db");
      throw new MongoShellError(
        "Only db.client.db(<name>) is supported on db.client.",
      );
    }
    if (object instanceof HelperRef) {
      if (object.name === "Date" && name === "now") {
        return new MethodRef(new DbHandle(this.db), "__dateNow", "Date.now");
      }
      throw new MongoShellError(
        `${object.name}.${name} is not supported in MongoDB queries.`,
      );
    }
    if (object instanceof MethodRef || isPromise(object)) {
      throw new MongoShellError(`Cannot read ${name} of ${describe(object)}.`);
    }
    // Plain data: own data properties of arrays, plain objects and strings.
    if (typeof object === "string") {
      if (name === "length") return object.length;
      if (/^\d+$/.test(name)) return object[Number(name)];
    }
    if (Array.isArray(object)) {
      if (name === "length") return object.length;
      if (/^\d+$/.test(name)) return object[Number(name)];
      throw new MongoShellError(
        `Arrays only support [index] and .length in MongoDB queries, not .${name}.`,
      );
    }
    if (isPlainObject(object)) {
      const descriptor = Object.getOwnPropertyDescriptor(object, name);
      if (!descriptor) return undefined;
      if (!("value" in descriptor) || typeof descriptor.value === "function") {
        throw new MongoShellError(`Cannot read ${name} here.`);
      }
      return descriptor.value;
    }
    if (object === null || object === undefined) {
      throw new MongoShellError(`Cannot read ${name} of ${String(object)}.`);
    }
    throw new MongoShellError(
      `Cannot read ${name} of ${describe(object)} in a MongoDB query.`,
    );
  }

  private async call(
    callee: unknown,
    args: unknown[],
    isNew: boolean,
  ): Promise<unknown> {
    if (callee instanceof HelperRef) {
      return callHelper(callee.name, args, isNew);
    }
    if (!(callee instanceof MethodRef)) {
      if (callee instanceof CollectionHandle) {
        throw new MongoShellError(
          `${describe(callee)} is not a function: ${callee.name.split(".").pop()} is not a supported collection method.`,
        );
      }
      throw new MongoShellError(`${describe(callee)} is not a function.`);
    }
    if (callee.name === "__dateNow") return Date.now();
    this.checkWrite(callee, args);
    const { target, name } = callee;
    if (target instanceof DbHandle) return this.callDb(target.db, name, args);
    if (target instanceof CollectionHandle) {
      return this.callCollection(target, name, args);
    }
    if (target instanceof CursorHandle) {
      return this.callCursor(target, name, args);
    }
    if (target instanceof AdminHandle) {
      return this.callAdmin(target.db, name, args);
    }
    if (target instanceof ClientHandle) {
      return new DbHandle(target.client.db(stringArg(args[0], "db.client.db")));
    }
    throw new MongoShellError(`${callee.path} is not a function.`);
  }

  private checkWrite(method: MethodRef, args: unknown[]): void {
    let write: string | null = null;
    if (WRITE_METHODS.has(method.name)) {
      write = method.name;
    } else if (COMMAND_METHODS.has(method.name)) {
      const command = commandName(args[0]);
      if (!command || !READ_COMMANDS.has(command.toLowerCase())) {
        write = command ?? method.name;
      }
    } else if (
      (method.name === "aggregate" || method.name === "addStage") &&
      containsWriteStage(args)
    ) {
      write = "$out/$merge";
    }
    if (write && !this.options.allowWrites) {
      throw new MongoShellError(
        `This query writes (${write}) but was checked as a read, so it was refused. Write the call plainly (e.g. db.coll.${method.name}(…)) so the write check can see it.`,
      );
    }
  }

  /**
   * A driver call's promise: recorded, so a failure is reported even if the
   * query drops it, and raced against cancellation. Every call's result is
   * awaited where it is used, as in the shell (`find(db.x.findOne())`
   * passes the document).
   */
  private track<T>(promise: Promise<T>): Promise<T> {
    promise.catch((error: unknown) => {
      this.trackedErrors.push(error);
    });
    this.tracked.push(promise);
    return this.await(promise);
  }

  private wrap(result: unknown, kind: CursorKind): unknown {
    if (isPromise(result)) return this.track(result);
    if (result && typeof result === "object" && "toArray" in result) {
      return new CursorHandle(result as MinimalCursor, kind);
    }
    return result;
  }

  private callDb(db: Db, name: string, args: unknown[]): unknown {
    switch (name) {
      case "getCollection":
      case "collection":
        return new CollectionHandle(db, stringArg(args[0], `db.${name}`));
      case "getSiblingDB":
        return new DbHandle(
          (db as unknown as { client: MongoClient }).client.db(
            stringArg(args[0], "db.getSiblingDB"),
          ),
        );
      case "getName":
        return db.databaseName;
      case "admin":
        return new AdminHandle(db);
      case "getCollectionInfos":
        return this.track(
          db.listCollections(objectArg(args[0]), objectArg(args[1])).toArray(),
        );
      case "getCollectionNames":
        return this.track(
          db
            .listCollections(objectArg(args[0]), { nameOnly: true })
            .toArray()
            .then(infos => infos.map(info => info.name)),
        );
      case "listCollections":
        return this.wrap(
          db.listCollections(objectArg(args[0]), objectArg(args[1])),
          "list",
        );
      case "aggregate":
        return this.wrap(
          db.aggregate(arrayArg(args[0], "db.aggregate"), objectArg(args[1])),
          "aggregate",
        );
      case "stats":
        return this.track(db.stats(objectArg(args[0])));
      case "command":
      case "runCommand":
        return this.track(
          db.command(commandArg(args[0], `db.${name}`), objectArg(args[1])),
        );
      case "adminCommand":
        return this.track(
          db
            .admin()
            .command(
              commandArg(args[0], "db.adminCommand"),
              objectArg(args[1]),
            ),
        );
      case "createCollection":
        return this.track(
          db
            .createCollection(
              stringArg(args[0], "db.createCollection"),
              objectArg(args[1]),
            )
            .then(collection => ({ ok: 1, name: collection.collectionName })),
        );
      case "dropCollection":
        return this.track(
          db.dropCollection(stringArg(args[0], "db.dropCollection")),
        );
      case "dropDatabase":
        return this.track(db.dropDatabase());
      case "renameCollection":
        return this.track(
          db
            .renameCollection(
              stringArg(args[0], "db.renameCollection"),
              stringArg(args[1], "db.renameCollection"),
              objectArg(args[2]),
            )
            .then(collection => ({ ok: 1, name: collection.collectionName })),
        );
      case "createIndex":
        return this.track(
          db.createIndex(
            stringArg(args[0], "db.createIndex"),
            args[1] as Parameters<Db["createIndex"]>[1],
            objectArg(args[2]),
          ),
        );
      case "removeUser":
        return this.track(db.removeUser(stringArg(args[0], "db.removeUser")));
      case "setProfilingLevel":
        return this.track(
          db.setProfilingLevel(
            args[0] as Parameters<Db["setProfilingLevel"]>[0],
          ),
        );
      case "profilingLevel":
        return this.track(db.profilingLevel());
      case "indexInformation":
        return this.track(
          db.indexInformation(stringArg(args[0], "db.indexInformation")),
        );
      default:
        throw new MongoShellError(`db.${name} is not supported.`);
    }
  }

  private callAdmin(db: Db, name: string, args: unknown[]): unknown {
    const admin = db.admin();
    switch (name) {
      case "listDatabases":
        return this.track(admin.listDatabases(objectArg(args[0])));
      case "serverStatus":
        return this.track(admin.serverStatus());
      case "serverInfo":
      case "buildInfo":
        return this.track(admin.buildInfo());
      case "ping":
        return this.track(admin.ping());
      case "replSetGetStatus":
        return this.track(admin.replSetGetStatus());
      case "command":
        return this.track(
          admin.command(commandArg(args[0], "db.admin().command")),
        );
      default:
        throw new MongoShellError(`db.admin().${name} is not supported.`);
    }
  }

  private callCollection(
    handle: CollectionHandle,
    name: string,
    args: unknown[],
  ): unknown {
    const collection = handle.db.collection(handle.name);
    const a0 = args[0];
    const a1 = args[1];
    const a2 = args[2];
    type C = typeof collection;
    switch (name) {
      case "find":
        return this.wrap(
          collection.find(objectArg(a0) ?? {}, findOptions(a1)),
          "find",
        );
      case "findOne":
        return this.track(
          collection.findOne(objectArg(a0) ?? {}, findOptions(a1)),
        );
      case "aggregate":
        return this.wrap(
          collection.aggregate(arrayArg(a0 ?? [], name), objectArg(a1)),
          "aggregate",
        );
      case "count":
      case "countDocuments":
        return this.track(
          collection.countDocuments(objectArg(a0) ?? {}, objectArg(a1)),
        );
      case "estimatedDocumentCount":
        return this.track(collection.estimatedDocumentCount(objectArg(a0)));
      case "distinct":
        return this.track(
          collection.distinct(
            stringArg(a0, "distinct"),
            objectArg(a1) ?? {},
            objectArg(a2) ?? {},
          ),
        );
      case "indexes":
      case "getIndexes":
        return this.track(collection.indexes());
      case "listIndexes":
        return this.wrap(collection.listIndexes(objectArg(a0)), "list");
      case "indexExists":
        return this.track(
          collection.indexExists(a0 as Parameters<C["indexExists"]>[0]),
        );
      case "indexInformation":
        return this.track(collection.indexInformation());
      case "options":
        return this.track(collection.options());
      case "isCapped":
        return this.track(collection.isCapped());
      case "listSearchIndexes":
        return this.wrap(
          typeof a0 === "string"
            ? collection.listSearchIndexes(a0, objectArg(a1))
            : collection.listSearchIndexes(objectArg(a0)),
          "list",
        );
      case "insertOne":
        return this.track(
          collection.insertOne(objectArg(a0) ?? {}, objectArg(a1)),
        );
      case "insertMany":
        return this.track(
          collection.insertMany(
            arrayArg(a0, name) as Parameters<C["insertMany"]>[0],
            objectArg(a1),
          ),
        );
      case "insert":
        return Array.isArray(a0)
          ? this.track(
              collection.insertMany(
                a0 as Parameters<C["insertMany"]>[0],
                objectArg(a1),
              ),
            )
          : this.track(
              collection.insertOne(objectArg(a0) ?? {}, objectArg(a1)),
            );
      case "updateOne":
        return this.track(
          collection.updateOne(
            objectArg(a0) ?? {},
            a1 as Parameters<C["updateOne"]>[1],
            objectArg(a2),
          ),
        );
      case "updateMany":
        return this.track(
          collection.updateMany(
            objectArg(a0) ?? {},
            a1 as Parameters<C["updateMany"]>[1],
            objectArg(a2),
          ),
        );
      case "update": {
        const options = objectArg(a2) ?? {};
        const { multi, ...rest } = options as { multi?: unknown };
        return this.track(
          multi
            ? collection.updateMany(
                objectArg(a0) ?? {},
                a1 as Parameters<C["updateMany"]>[1],
                rest,
              )
            : collection.updateOne(
                objectArg(a0) ?? {},
                a1 as Parameters<C["updateOne"]>[1],
                rest,
              ),
        );
      }
      case "replaceOne":
        return this.track(
          collection.replaceOne(
            objectArg(a0) ?? {},
            objectArg(a1) ?? {},
            objectArg(a2),
          ),
        );
      case "deleteOne":
        return this.track(
          collection.deleteOne(objectArg(a0) ?? {}, objectArg(a1)),
        );
      case "deleteMany":
        return this.track(
          collection.deleteMany(objectArg(a0) ?? {}, objectArg(a1)),
        );
      case "remove": {
        const justOne =
          a1 === true ||
          (isPlainObject(a1) && (a1 as { justOne?: unknown }).justOne === true);
        return this.track(
          justOne
            ? collection.deleteOne(objectArg(a0) ?? {})
            : collection.deleteMany(objectArg(a0) ?? {}),
        );
      }
      case "bulkWrite":
        return this.track(
          collection.bulkWrite(
            arrayArg(a0, name) as unknown as Parameters<C["bulkWrite"]>[0],
            objectArg(a1),
          ),
        );
      case "findOneAndUpdate":
        return this.track(
          collection.findOneAndUpdate(
            objectArg(a0) ?? {},
            a1 as Parameters<C["findOneAndUpdate"]>[1],
            objectArg(a2) ?? {},
          ),
        );
      case "findOneAndReplace":
        return this.track(
          collection.findOneAndReplace(
            objectArg(a0) ?? {},
            objectArg(a1) ?? {},
            objectArg(a2) ?? {},
          ),
        );
      case "findOneAndDelete":
        return this.track(
          collection.findOneAndDelete(objectArg(a0) ?? {}, objectArg(a1) ?? {}),
        );
      case "createIndex":
        return this.track(
          collection.createIndex(
            a0 as Parameters<C["createIndex"]>[0],
            objectArg(a1),
          ),
        );
      case "createIndexes":
        return this.track(
          collection.createIndexes(
            arrayArg(a0, name) as unknown as Parameters<C["createIndexes"]>[0],
            objectArg(a1),
          ),
        );
      case "dropIndex":
        return this.track(
          collection.dropIndex(stringArg(a0, name), objectArg(a1)),
        );
      case "dropIndexes":
        return this.track(collection.dropIndexes(objectArg(a0)));
      case "drop":
        return this.track(collection.drop(objectArg(a0)));
      case "rename":
        return this.track(
          collection
            .rename(stringArg(a0, name), objectArg(a1))
            .then(renamed => ({ ok: 1, name: renamed.collectionName })),
        );
      case "createSearchIndex":
        return this.track(
          collection.createSearchIndex(
            a0 as Parameters<C["createSearchIndex"]>[0],
          ),
        );
      case "createSearchIndexes":
        return this.track(
          collection.createSearchIndexes(
            arrayArg(a0, name) as Parameters<C["createSearchIndexes"]>[0],
          ),
        );
      case "dropSearchIndex":
        return this.track(collection.dropSearchIndex(stringArg(a0, name)));
      case "updateSearchIndex":
        return this.track(
          collection.updateSearchIndex(
            stringArg(a0, name),
            objectArg(a1) ?? {},
          ),
        );
      default:
        throw new MongoShellError(
          `db.${handle.name}.${name} is not supported.`,
        );
    }
  }

  private callCursor(
    handle: CursorHandle,
    name: string,
    args: unknown[],
  ): unknown {
    if (name === "toArray") return this.track(this.readCursor(handle));
    if (name === "pretty") return handle;
    const cursor = handle.cursor as unknown as Record<
      string,
      (...a: unknown[]) => unknown
    >;
    const method = cursor[name];
    if (typeof method !== "function") {
      throw new MongoShellError(`cursor.${name} is not supported here.`);
    }
    const result = method.apply(handle.cursor, args);
    if (result === handle.cursor) return handle;
    return this.wrap(result, handle.kind);
  }

  /** Every document of a cursor, at most `maxRows` (then marked truncated). */
  private async readCursor(handle: CursorHandle): Promise<unknown[]> {
    const { cursor } = handle;
    const { maxRows, signal } = this.options;
    if (maxRows === undefined) return this.await(cursor.toArray());
    const rows: unknown[] = [];
    let truncated = false;
    try {
      while (await this.await(cursor.hasNext())) {
        if (rows.length >= maxRows) {
          truncated = true;
          break;
        }
        if (signal?.aborted) throw new Error("Query cancelled");
        rows.push(await this.await(cursor.next()));
      }
    } finally {
      await cursor.close().catch(() => undefined);
    }
    if (truncated) this.truncatedReads.add(rows);
    return rows;
  }

  private async settleAwait(value: unknown): Promise<unknown> {
    if (isPromise(value)) return this.await(value);
    return value;
  }

  /** `promise`, unless the query is cancelled first. */
  private await<T>(promise: Promise<T>): Promise<T> {
    const { signal } = this.options;
    if (!signal) return promise;
    return Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        if (signal.aborted) reject(new Error("Query cancelled"));
        signal.addEventListener(
          "abort",
          () => reject(new Error("Query cancelled")),
          { once: true },
        );
      }),
    ]);
  }
}

const DB_METHODS = new Set([
  "getCollection",
  "collection",
  "getSiblingDB",
  "getName",
  "admin",
  "getCollectionInfos",
  "getCollectionNames",
  "listCollections",
  "aggregate",
  "stats",
  "command",
  "runCommand",
  "adminCommand",
  "createCollection",
  "dropCollection",
  "dropDatabase",
  "renameCollection",
  "createIndex",
  "removeUser",
  "setProfilingLevel",
  "profilingLevel",
  "indexInformation",
]);

const ADMIN_METHODS = new Set([
  "listDatabases",
  "serverStatus",
  "serverInfo",
  "buildInfo",
  "ping",
  "replSetGetStatus",
  "command",
]);

const COLLECTION_METHODS = new Set([
  "find",
  "findOne",
  "aggregate",
  "count",
  "countDocuments",
  "estimatedDocumentCount",
  "distinct",
  "indexes",
  "getIndexes",
  "listIndexes",
  "indexExists",
  "indexInformation",
  "options",
  "isCapped",
  "listSearchIndexes",
  "insert",
  "insertOne",
  "insertMany",
  "update",
  "updateOne",
  "updateMany",
  "replaceOne",
  "remove",
  "deleteOne",
  "deleteMany",
  "bulkWrite",
  "findOneAndUpdate",
  "findOneAndReplace",
  "findOneAndDelete",
  "createIndex",
  "createIndexes",
  "dropIndex",
  "dropIndexes",
  "drop",
  "rename",
  "createSearchIndex",
  "createSearchIndexes",
  "dropSearchIndex",
  "updateSearchIndex",
]);

const COMMON_CURSOR_METHODS = [
  "toArray",
  "next",
  "hasNext",
  "tryNext",
  "batchSize",
  "maxTimeMS",
  "pretty",
];

const CURSOR_METHODS: Record<CursorKind, Set<string>> = {
  find: new Set([
    ...COMMON_CURSOR_METHODS,
    "limit",
    "skip",
    "sort",
    "project",
    "filter",
    "hint",
    "min",
    "max",
    "returnKey",
    "showRecordId",
    "comment",
    "collation",
    "allowDiskUse",
    "count",
    "explain",
  ]),
  aggregate: new Set([
    ...COMMON_CURSOR_METHODS,
    "limit",
    "skip",
    "sort",
    "project",
    "match",
    "group",
    "unwind",
    "lookup",
    "redact",
    "geoNear",
    "addStage",
    "out",
    "explain",
  ]),
  list: new Set(COMMON_CURSOR_METHODS),
};

// ---------------------------------------------------------------------------
// Argument checks and helpers
// ---------------------------------------------------------------------------

function stringArg(value: unknown, where: string): string {
  if (typeof value !== "string") {
    throw new MongoShellError(`${where} needs a string name.`);
  }
  return value;
}

function objectArg<T extends object = Record<string, unknown>>(
  value: unknown,
): T | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new MongoShellError(
      `Expected an object argument, got ${describe(value)}.`,
    );
  }
  return value as T;
}

function arrayArg(value: unknown, where: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new MongoShellError(`${where} needs an array argument.`);
  }
  return value as Record<string, unknown>[];
}

function commandArg(value: unknown, where: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new MongoShellError(`${where} needs a command document.`);
  }
  return value;
}

/** find() options; a shell-style projection as the 2nd argument works too. */
function findOptions(value: unknown): Record<string, unknown> | undefined {
  const options = objectArg(value);
  if (!options) return undefined;
  const optionKeys = new Set([
    "projection",
    "sort",
    "limit",
    "skip",
    "hint",
    "maxTimeMS",
    "collation",
    "batchSize",
    "comment",
    "allowDiskUse",
    "min",
    "max",
    "returnKey",
    "showRecordId",
  ]);
  const keys = Object.keys(options);
  if (keys.length > 0 && keys.every(key => !optionKeys.has(key))) {
    return { projection: options };
  }
  return options;
}

function arithmetic(operator: string, left: unknown, right: unknown): unknown {
  if (
    operator === "+" &&
    (typeof left === "string" || typeof right === "string")
  ) {
    if (
      (typeof left === "string" || typeof left === "number") &&
      (typeof right === "string" || typeof right === "number")
    ) {
      return String(left) + String(right);
    }
  }
  if (typeof left !== "number" || typeof right !== "number") {
    throw new MongoShellError(
      `The operator ${operator} is only supported between numbers (or + between strings).`,
    );
  }
  switch (operator) {
    case "+":
      return left + right;
    case "-":
      return left - right;
    case "*":
      return left * right;
    case "/":
      return left / right;
    case "%":
      return left % right;
    case "**":
      return left ** right;
    default:
      throw new MongoShellError(
        `The operator ${operator} is not supported in MongoDB queries.`,
      );
  }
}

function primitiveArgs(args: unknown[], name: string): Array<string | number> {
  return args.map(arg => {
    if (typeof arg === "string" || typeof arg === "number") return arg;
    if (arg instanceof Date) return arg.getTime();
    throw new MongoShellError(`${name} takes strings or numbers.`);
  });
}

function callHelper(name: string, args: unknown[], isNew: boolean): unknown {
  try {
    switch (name) {
      case "ObjectId":
      case "ObjectID": {
        const [id] = args;
        if (id === undefined) return new ObjectId();
        if (typeof id !== "string" && !(id instanceof ObjectId)) {
          throw new MongoShellError(`${name} takes a hex string.`);
        }
        return new ObjectId(id);
      }
      case "ISODate":
      case "Date": {
        const values = primitiveArgs(args, name);
        if (name === "Date" && !isNew) return new Date().toString();
        const date =
          values.length === 0
            ? new Date()
            : values.length === 1
              ? new Date(values[0])
              : new Date(
                  ...(values.map(Number) as [number, number, ...number[]]),
                );
        if (Number.isNaN(date.getTime())) {
          throw new MongoShellError(
            `${name}(${values.join(", ")}) is not a valid date.`,
          );
        }
        return date;
      }
      case "NumberInt": {
        const [value] = primitiveArgs(args, name);
        return new Int32(Number(value ?? 0));
      }
      case "NumberLong": {
        const [value] = primitiveArgs(args, name);
        return Long.fromString(String(value ?? 0));
      }
      case "NumberDecimal": {
        const [value] = primitiveArgs(args, name);
        return Decimal128.fromString(String(value ?? 0));
      }
      case "UUID": {
        const [value] = args;
        if (value === undefined) return new UUID();
        if (typeof value !== "string") {
          throw new MongoShellError("UUID takes a string.");
        }
        return new UUID(value);
      }
      case "RegExp": {
        const [pattern, flags] = args;
        if (pattern instanceof RegExp && flags === undefined) {
          return new RegExp(pattern.source, pattern.flags);
        }
        if (
          typeof pattern !== "string" ||
          (flags !== undefined && typeof flags !== "string")
        ) {
          throw new MongoShellError(
            "RegExp takes a pattern and flags as strings.",
          );
        }
        return new RegExp(pattern, flags);
      }
      case "Timestamp": {
        const [t, i] = primitiveArgs(args, name);
        return new Timestamp({ t: Number(t ?? 0), i: Number(i ?? 0) });
      }
      case "MinKey":
        return new MinKey();
      case "MaxKey":
        return new MaxKey();
      default:
        throw new MongoShellError(`${name} is not supported.`);
    }
  } catch (error) {
    if (error instanceof MongoShellError) throw error;
    throw new MongoShellError(
      `${name}(): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Run a MongoDB shell-style query against `db`, safely (see the top of this
 * file). Throws MongoShellError for a query that is not allowed, and the
 * driver's error for one the database refuses.
 */
export async function runMongoShellQuery(
  db: Db,
  query: string,
  options: MongoShellOptions,
): Promise<MongoShellResult> {
  if (options.signal?.aborted) throw new Error("Query cancelled");
  const program = parseQuery(query);
  return new Interpreter(db, options).run(program);
}
