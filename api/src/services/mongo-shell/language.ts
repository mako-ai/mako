/**
 * What the MongoDB shell language allows: the forbidden properties, the
 * read and write commands and methods, the value helpers, and the methods of
 * each handle.
 */
import type { CursorKind } from "./values";

/** Never readable, on anything: the ways out of data into code. */
export const FORBIDDEN_PROPERTIES = new Set([
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
export const READ_COMMANDS = new Set(
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
export const WRITE_METHODS = new Set([
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
export const COMMAND_METHODS = new Set([
  "command",
  "runCommand",
  "adminCommand",
]);

export const WRITE_STAGES = new Set(["$out", "$merge"]);

export const HELPERS = new Set([
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

export const GLOBAL_VALUES: Record<string, unknown> = {
  undefined: undefined,
  NaN: Number.NaN,
  Infinity: Number.POSITIVE_INFINITY,
};

export const MAX_DEPTH = 256;

export const DB_METHODS = new Set([
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

/** The db.admin() methods a read-only run may call. */
export const READ_ONLY_ADMIN_METHODS = new Set(["listDatabases"]);

export const ADMIN_METHODS = new Set([
  "listDatabases",
  "serverStatus",
  "serverInfo",
  "buildInfo",
  "ping",
  "replSetGetStatus",
  "command",
]);

export const COLLECTION_METHODS = new Set([
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

export const COMMON_CURSOR_METHODS = [
  "toArray",
  "next",
  "hasNext",
  "tryNext",
  "batchSize",
  "maxTimeMS",
  "pretty",
];

export const CURSOR_METHODS: Record<CursorKind, Set<string>> = {
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
