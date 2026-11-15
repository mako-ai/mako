/**
 * The driver calls a MongoDB shell query makes: methods of db, db.admin(),
 * collections and cursors, each tracked and raced against cancellation.
 */
import { type Db, type MongoClient } from "mongodb";
import {
  MongoShellError,
  type MongoShellOptions,
  DbHandle,
  AdminHandle,
  CollectionHandle,
  CursorHandle,
  type CursorKind,
  type MinimalCursor,
  isPromise,
  isPlainObject,
} from "./values";
import {
  stringArg,
  objectArg,
  arrayArg,
  commandArg,
  findOptions,
} from "./arguments";

export abstract class ShellCalls {
  protected readonly tracked: Promise<unknown>[] = [];
  protected readonly trackedErrors: unknown[] = [];
  protected readonly truncatedReads = new WeakSet<object>();

  constructor(
    protected readonly db: Db,
    protected readonly options: MongoShellOptions,
  ) {}

  /**
   * A driver call's promise: recorded, so a failure is reported even if the
   * query drops it, and raced against cancellation. Every call's result is
   * awaited where it is used, as in the shell (`find(db.x.findOne())`
   * passes the document).
   */
  protected track<T>(promise: Promise<T>): Promise<T> {
    promise.catch((error: unknown) => {
      this.trackedErrors.push(error);
    });
    this.tracked.push(promise);
    return this.await(promise);
  }

  protected wrap(result: unknown, kind: CursorKind): unknown {
    if (isPromise(result)) return this.track(result);
    if (result && typeof result === "object" && "toArray" in result) {
      return new CursorHandle(result as MinimalCursor, kind);
    }
    return result;
  }

  protected callDb(db: Db, name: string, args: unknown[]): unknown {
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

  protected callAdmin(db: Db, name: string, args: unknown[]): unknown {
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

  protected callCollection(
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

  protected callCursor(
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
  protected async readCursor(handle: CursorHandle): Promise<unknown[]> {
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

  protected async settleAwait(value: unknown): Promise<unknown> {
    if (isPromise(value)) return this.await(value);
    return value;
  }

  /** `promise`, unless the query is cancelled first. */
  protected await<T>(promise: Promise<T>): Promise<T> {
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
