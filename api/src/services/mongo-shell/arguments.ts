/**
 * Argument checks for shell method calls, arithmetic on numbers, and the
 * shell's value helpers (ObjectId, ISODate, NumberLong…).
 */
import {
  Decimal128,
  Int32,
  Long,
  MaxKey,
  MinKey,
  ObjectId,
  Timestamp,
  UUID,
} from "mongodb";
import { MongoShellError, isPlainObject, describe } from "./values";

export function stringArg(value: unknown, where: string): string {
  if (typeof value !== "string") {
    throw new MongoShellError(`${where} needs a string name.`);
  }
  return value;
}

export function objectArg<T extends object = Record<string, unknown>>(
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

export function arrayArg(
  value: unknown,
  where: string,
): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new MongoShellError(`${where} needs an array argument.`);
  }
  return value as Record<string, unknown>[];
}

export function commandArg(
  value: unknown,
  where: string,
): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new MongoShellError(`${where} needs a command document.`);
  }
  return value;
}

/** find() options; a shell-style projection as the 2nd argument works too. */
export function findOptions(
  value: unknown,
): Record<string, unknown> | undefined {
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

export function arithmetic(
  operator: string,
  left: unknown,
  right: unknown,
): unknown {
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

export function primitiveArgs(
  args: unknown[],
  name: string,
): Array<string | number> {
  return args.map(arg => {
    if (typeof arg === "string" || typeof arg === "number") return arg;
    if (arg instanceof Date) return arg.getTime();
    throw new MongoShellError(`${name} takes strings or numbers.`);
  });
}

export function callHelper(
  name: string,
  args: unknown[],
  isNew: boolean,
): unknown {
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
