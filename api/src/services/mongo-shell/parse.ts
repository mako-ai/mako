/**
 * Parsing a MongoDB shell query, and the static write check
 * (`findMongoShellWrite`) the connection's writers check uses.
 */
import {
  parse,
  type Expression,
  type Node,
  type ObjectExpression,
  type Program,
  type Property,
} from "acorn";
import { MongoShellError } from "./values";
import {
  READ_COMMANDS,
  WRITE_METHODS,
  COMMAND_METHODS,
  WRITE_STAGES,
} from "./language";

export function parseQuery(query: string): Program {
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
export function staticPropertyName(node: {
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

export function staticKeyName(property: Property): string | null {
  if (property.computed) return null;
  const key = property.key;
  if (key.type === "Identifier") return key.name;
  if (key.type === "Literal") return String(key.value);
  return null;
}

/** The name of the command a static `command({...})` argument names. */
export function staticCommandName(arg: Node | undefined): string | null {
  if (!arg || arg.type !== "ObjectExpression") return null;
  const first = (arg as ObjectExpression).properties[0];
  if (!first || first.type !== "Property") return null;
  return staticKeyName(first);
}

/** Every child node of `node` (a generic walk over the syntax tree). */
export function children(node: Node): Node[] {
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
