/**
 * The MongoDB shell interpreter: walks a parsed query's syntax tree,
 * statement by statement, refusing anything outside the language
 * (language.ts) before a call is made.
 */
import {
  type Expression,
  type ObjectExpression,
  type Program,
  type SpreadElement,
  type Statement,
} from "acorn";
import { Long, type MongoClient } from "mongodb";
import {
  MongoShellError,
  type MongoShellResult,
  DbHandle,
  AdminHandle,
  ClientHandle,
  CollectionHandle,
  CursorHandle,
  MethodRef,
  HelperRef,
  isOpaque,
  isPromise,
  isPlainObject,
  describe,
  containsWriteStage,
  commandName,
} from "./values";
import {
  FORBIDDEN_PROPERTIES,
  READ_COMMANDS,
  WRITE_METHODS,
  COMMAND_METHODS,
  HELPERS,
  GLOBAL_VALUES,
  MAX_DEPTH,
  DB_METHODS,
  ADMIN_METHODS,
  READ_ONLY_ADMIN_METHODS,
  COLLECTION_METHODS,
  CURSOR_METHODS,
} from "./language";
import { staticPropertyName, staticKeyName } from "./parse";
import { stringArg, arithmetic, callHelper } from "./arguments";
import { ShellCalls } from "./shell-calls";

export class Interpreter extends ShellCalls {
  private readonly scope = new Map<string, unknown>();

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
    // The parsed name decides, whatever the spelling in the text.
    if (
      this.options.readOnly &&
      (COMMAND_METHODS.has(method.name) ||
        (method.target instanceof AdminHandle &&
          !READ_ONLY_ADMIN_METHODS.has(method.name)))
    ) {
      throw new MongoShellError(
        `${method.path} runs a database command, and a read-only run takes none. Read data with find, findOne, aggregate, countDocuments or distinct.`,
      );
    }
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
}
