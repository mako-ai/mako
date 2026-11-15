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
import type { Db } from "mongodb";
import { Interpreter } from "./mongo-shell/interpreter";
import { parseQuery } from "./mongo-shell/parse";
import type { MongoShellOptions, MongoShellResult } from "./mongo-shell/values";

export { findMongoShellWrite } from "./mongo-shell/parse";
export {
  MongoShellError,
  type MongoShellOptions,
  type MongoShellResult,
} from "./mongo-shell/values";

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
