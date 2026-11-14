/**
 * The MongoDB shell interpreter (mongo-shell-interpreter.ts), against an
 * in-memory Mongo: the queries Mako itself writes and documents still run,
 * nothing reaches the API process (no process, require, constructors…),
 * writes run only for a query classified as one, and a row cap cuts reads.
 *
 * Run with: pnpm --filter api exec tsx src/services/mongo-shell-interpreter.test.ts
 */
import assert from "node:assert/strict";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient, ObjectId, type Db } from "mongodb";

import { isWrite } from "../access/connection-writes";
import {
  findMongoShellWrite,
  MongoShellError,
  runMongoShellQuery,
} from "./mongo-shell-interpreter";
import { databaseConnectionService } from "./database-connection.service";
import type { IDatabaseConnection } from "../database/workspace-schema";

const read = (db: Db, query: string, maxRows?: number) =>
  runMongoShellQuery(db, query, { allowWrites: false, maxRows });
const write = (db: Db, query: string) =>
  runMongoShellQuery(db, query, { allowWrites: true });

async function refused(db: Db, query: string, why?: RegExp): Promise<void> {
  let result: unknown;
  try {
    result = await runMongoShellQuery(db, query, { allowWrites: true });
  } catch (error) {
    assert.ok(
      error instanceof MongoShellError,
      `${query}: expected a MongoShellError, got ${String(error)}`,
    );
    if (why) assert.match(error.message, why, query);
    return;
  }
  assert.fail(`${query} ran and returned ${JSON.stringify(result)}`);
}

async function main() {
  const mongo = await MongoMemoryServer.create();
  const client = new MongoClient(mongo.getUri());
  await client.connect();
  const db = client.db("shop");
  try {
    const anaId = new ObjectId();
    await db.collection("users").insertMany([
      { _id: anaId, name: "ana", age: 41, createdAt: new Date() },
      { name: "bob", age: 29, createdAt: new Date(Date.now() - 9e9) },
      { name: "cyd", age: 35, createdAt: new Date() },
    ]);
    await db.collection("orders").insertMany([
      {
        userId: anaId,
        status: "completed",
        productName: "pen",
        saleAmount: 3,
        orderDate: new Date("2024-01-15"),
      },
      {
        userId: anaId,
        status: "completed",
        productName: "pen",
        saleAmount: 4,
        orderDate: new Date("2024-02-03"),
      },
      {
        status: "completed",
        productName: "ink",
        saleAmount: 7,
        orderDate: new Date("2024-02-11"),
      },
    ]);
    await db
      .collection("big")
      .insertMany(Array.from({ length: 25 }, (_, i) => ({ i })));
    await db.collection("logs.audit").insertOne({ dotted: true });

    // ── Legitimate queries ───────────────────────────────────────────
    const value = async (query: string) => (await read(db, query)).value;
    const rows = async (query: string) => {
      const v = await value(query);
      assert.ok(Array.isArray(v), `${query} returns an array`);
      return v as Record<string, unknown>[];
    };

    assert.equal((await rows("db.users.find({})")).length, 3);
    assert.deepEqual(
      (
        await rows(
          "db.users.find({ age: { $gt: 30 } }).sort({ age: -1 }).limit(2)",
        )
      ).map(u => u.name),
      ["ana", "cyd"],
    );
    // The console template (console-template.ts, database-schemas.ts).
    assert.equal(
      (await rows('db.getCollection("users").find({}).limit(500)')).length,
      3,
    );
    // The agent's collection inspection (mongodb-tools.ts).
    assert.equal(
      (
        await rows(
          'db.collection("users").aggregate([{ $sample: { size: 2 } }]).toArray()',
        )
      ).length,
      2,
    );
    // The mongodb-queries skill's example, comment and ISODate included.
    const pivot = await rows(`// db: ecommerce
db.orders.aggregate([
  {
    $match: {
      status: "completed",
      orderDate: { $gte: ISODate("2024-01-01"), $lt: ISODate("2025-01-01") }
    }
  },
  {
    $group: {
      _id: {
        product: "$productName",
        month: { $dateToString: { format: "%Y-%m", date: "$orderDate" } }
      },
      total_sales: { $sum: "$saleAmount" }
    }
  },
  {
    $group: {
      _id: "$_id.product",
      monthly_sales: { $push: { k: "$_id.month", v: "$total_sales" } }
    }
  },
  {
    $replaceRoot: {
      newRoot: {
        $mergeObjects: [ { product: "$_id" }, { $arrayToObject: "$monthly_sales" } ]
      }
    }
  }
]).limit(500);`);
    const pen = pivot.find(r => r.product === "pen");
    assert.deepEqual(pen, { product: "pen", "2024-01": 3, "2024-02": 4 });
    // A saved console file's header comments (workspace-consoles).
    assert.equal(
      (
        await rows(
          "// collection: users\n// operation: find\n\ndb.users.find({})\n",
        )
      ).length,
      3,
    );
    assert.deepEqual(
      [...((await value("db.getCollectionNames()")) as string[])].sort(),
      ["big", "logs.audit", "orders", "users"],
    );
    assert.ok(Array.isArray(await value("db.getCollectionInfos()")));
    assert.equal(await value("db.users.countDocuments({})"), 3);
    assert.equal(await value("db.users.count()"), 3);
    assert.equal(await value("db.users.estimatedDocumentCount()"), 3);
    assert.deepEqual(
      [...((await value('db.users.distinct("name")')) as string[])].sort(),
      ["ana", "bob", "cyd"],
    );
    assert.equal(
      ((await value('db.users.findOne({ name: "bob" })')) as { age: number })
        .age,
      29,
    );
    assert.equal(
      (await rows(`db.users.find({ _id: ObjectId("${anaId.toHexString()}") })`))
        .length,
      1,
    );
    assert.equal(
      (await rows(`db.users.find({ _id: new ObjectId("${anaId}") })`)).length,
      1,
    );
    assert.equal(
      (
        await rows(
          "db.users.find({ createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } })",
        )
      ).length,
      2,
    );
    assert.deepEqual(
      (await rows("db.users.find({ name: /^A/i })")).map(u => u.name),
      ["ana"],
    );
    assert.deepEqual(
      (await rows("db.users.find({ name: RegExp('^b') })")).map(u => u.name),
      ["bob"],
    );
    assert.deepEqual(
      await rows("db.users.find({ age: { $lt: 30 } }, { name: 1, _id: 0 })"),
      [{ name: "bob" }],
    );
    assert.deepEqual(
      await rows(
        "db.users.find({}, { projection: { name: 1, _id: 0 }, sort: { name: 1 }, limit: 1 })",
      ),
      [{ name: "ana" }],
    );
    assert.equal(
      (await rows("db.users.find({}).skip(1).project({ name: 1 }).pretty()"))
        .length,
      2,
    );
    assert.equal(
      (await rows("db.users.aggregate([{ $match: {} }]).limit(1)")).length,
      1,
    );
    // Several statements, const bindings and await.
    assert.equal(
      (
        await rows(
          "const minAge = 30;\nconst filter = { age: { $gte: minAge } };\ndb.users.find(filter)",
        )
      ).length,
      2,
    );
    assert.equal(
      (
        await rows(
          'const ana = await db.users.findOne({ name: "ana" });\ndb.orders.find({ userId: ana._id })',
        )
      ).length,
      2,
    );
    assert.equal(
      await value(
        "const all = await db.big.find({}).toArray(); all.length + 0",
      ),
      25,
    );
    // Other databases of the connection, as the materialization tests do.
    assert.equal(
      (
        await rows(
          "db.client.db('shop').collection('users').aggregate([]).toArray()",
        )
      ).length,
      3,
    );
    assert.equal(
      (await rows('db.getSiblingDB("shop").users.find({})')).length,
      3,
    );
    // The shell's dotted collection names.
    assert.equal((await rows("db.logs.audit.find({})")).length, 1);
    assert.equal((await rows('db["logs.audit"].find({})')).length, 1);
    assert.equal(
      (await value("db.adminCommand({ ping: 1 })")) instanceof Object,
      true,
    );
    assert.equal(
      ((await value("db.command({ dbStats: 1 })")) as { db: string }).db,
      "shop",
    );
    assert.ok(await value("db.admin().listDatabases()"));
    assert.ok(Array.isArray(await value("db.users.getIndexes()")));
    assert.ok(await value("db.users.find({}).explain()"));
    assert.deepEqual(await value("db.users"), {
      _type: "Collection",
      name: "users",
    });
    // The Db's own fields are collection names here, never driver internals.
    assert.deepEqual(await value("db.s"), { _type: "Collection", name: "s" });
    assert.equal(await value("-1"), -1);
    assert.equal(await value("`plain`"), "plain");

    // ── Injection attempts: refused before anything runs ─────────────
    const attempts: Array<[string, RegExp?]> = [
      ["process.env", /process is not available/],
      ["process", /process is not available/],
      ['require("child_process").execSync("id")', /require is not available/],
      ["globalThis.process", /globalThis is not available/],
      ["global.process.mainModule", /global is not available/],
      ['this.constructor.constructor("return process")()', /this/],
      ["db.constructor", /constructor is not allowed/],
      ['db["constructor"]', /constructor is not allowed/],
      ["db[`constructor`]", /constructor is not allowed/],
      ['db["__proto__"]', /__proto__ is not allowed/],
      ["db.users.constructor", /constructor is not allowed/],
      ["db.users.find.constructor", /constructor is not allowed/],
      ["db.users.find({}).constructor", /constructor is not allowed/],
      ['db.users.find.call(null, "x")', /call is not allowed/],
      ["db.users.find.apply", /apply is not allowed/],
      ["db.users.find({}).toArray().then", /then is not allowed/],
      ["({}).__proto__", /__proto__ is not allowed/],
      ["({}).constructor", /constructor is not allowed/],
      ["({ __proto__: { polluted: 1 } })", /__proto__ is not allowed/],
      ['({ "constructor": 1 })', /constructor is not allowed/],
      ["[].constructor", /constructor is not allowed/],
      ['[].constructor.constructor("return process")()', /constructor/],
      ['"".constructor', /constructor is not allowed/],
      ['ObjectId.constructor("return process")()', /constructor/],
      ["ObjectId.prototype", /prototype is not allowed/],
      ["Date.constructor", /constructor is not allowed/],
      ["new Date().getTime", /Cannot read getTime/],
      ['import("child_process")', /import\(\) is not available/],
      ["eval('1')", /eval is not available/],
      ["Function('return process')()", /Function is not available/],
      ["new Proxy({}, {})", /Proxy is not available/],
      ["new Function('return 1')", /Function is not available/],
      ["(() => process)()", /Functions are not supported/],
      ["(function () { return 1 })()", /Functions are not supported/],
      ["function f() {}", /Unsupported statement/],
      ["class A {}", /Unsupported statement/],
      ["while (true) {}", /Unsupported statement/],
      ["for (;;) {}", /Unsupported statement/],
      ["if (1) db.users.find({})", /Unsupported statement/],
      ["x = 1", /Assignments are not supported/],
      ["db.users = 1", /Assignments are not supported/],
      ["const a = 1; a = 2", /Assignments are not supported/],
      ["const db = 1", /already taken/],
      ["const ObjectId = 1", /already taken/],
      ["const { env } = db", /destructuring/],
      ["`${process.env}`", /Template strings/],
      ["String.raw`x`", /TaggedTemplateExpression/],
      ["db[process]", /Computed property access/],
      ["db[1 + 1]", /Computed property access/],
      ["({ [1 + 1]: 1 })", /Computed keys/],
      ["({ get x() { return 1 } })", /Getters, setters and methods/],
      ["({ x() {} })", /Getters, setters and methods/],
      ["db?.users", /Optional chaining/],
      ["db.client.options", /Only db.client.db/],
      ["db.client.close()", /Only db.client.db/],
      [
        'const u = await db.users.findOne({ name: "ana" }); u._id.constructor',
        /constructor is not allowed/,
      ],
      [
        'const u = await db.users.findOne({ name: "ana" }); u._id.toHexString',
        /Cannot read toHexString/,
      ],
      ["db.users.find({}).toArray().constructor", /constructor is not allowed/],
      ["[1, 2].map", /Arrays only support/],
      ["db.users.find({}).map((d) => d.name)", /map is not a supported/],
      ["db.users.find({}).forEach(printjson)", /forEach is not a supported/],
      ["db.users.watch()", /watch is not a function|not a supported/],
      ["db.users.fnd({})", /not a supported collection method/],
      ["db.getCollection(process)", /process is not available/],
      ["db.getCollection({})", /needs a string name/],
      ["db.users.find(db)", /cannot be used as a value/],
      ["typeof db", /typeof is not supported/],
      ["delete db.users", /delete is not supported/],
      ["void 0", /void is not supported/],
      ["1, process", /SequenceExpression/],
      ["new db.users()", /new is only supported/],
      ["db.users.find({})`x`", /TaggedTemplateExpression/],
      ["db.users.find({ $where: () => true })", /Functions are not supported/],
      ["#!/bin/sh\ndb.users.find({})", /Could not parse/],
      ["db.users.find({", /Could not parse/],
      ["return process", /Could not parse/],
    ];
    for (const [query, why] of attempts) await refused(db, query, why);
    assert.equal(
      Object.prototype.hasOwnProperty.call(Object.prototype, "polluted"),
      false,
      "no prototype was polluted",
    );
    // Deep nesting fails cleanly, not with a stack overflow.
    await refused(
      db,
      `db.users.find(${"[".repeat(400)}${"]".repeat(400)})`,
      /nested too deeply/,
    );

    // ── Writes: only for a query classified as a write ───────────────
    const before = await db.collection("users").countDocuments();
    const writeAttempts = [
      "db.users.insertOne({ name: 'eve' })",
      "db.users.insertMany([{ name: 'eve' }])",
      "db.users.insert({ name: 'eve' })",
      "db.users.updateMany({}, { $set: { x: 1 } })",
      "db.users.deleteMany({})",
      "db.users.remove({})",
      "db.users.drop()",
      "db.users.createIndex({ name: 1 })",
      "db.users.bulkWrite([{ insertOne: { document: { a: 1 } } }])",
      "db.users.findOneAndDelete({})",
      "db.users.aggregate([{ $out: 'copy' }])",
      "db.users.aggregate([{ $merge: { into: 'copy' } }])",
      "db.users.aggregate([]).out('copy')",
      "db.users.aggregate([]).addStage({ $out: 'copy' })",
      "db.command({ drop: 'users' })",
      "db.runCommand({ dropDatabase: 1 })",
      "db.adminCommand({ shutdown: 1 })",
      "db.admin().command({ shutdown: 1 })",
      "db.dropDatabase()",
      "db.createCollection('x')",
      "db.getSiblingDB('shop').users.deleteMany({})",
    ];
    for (const query of writeAttempts) {
      await assert.rejects(
        read(db, query),
        (error: unknown) =>
          error instanceof MongoShellError &&
          /was checked as a read/.test(error.message),
        query,
      );
      // ...and each of them is classified as a write, so a real run goes
      // through the writers check first.
      assert.equal(isWrite("mongodb", query), true, `isWrite: ${query}`);
    }
    assert.equal(await db.collection("users").countDocuments(), before);
    assert.deepEqual(
      (await db.listCollections({ name: "copy" }).toArray()).length,
      0,
    );

    // The text classification catches what the old pattern missed.
    for (const query of [
      "db.users.insertOne /* sneaky */ ({ a: 1 })",
      'db.users["insertOne"]({ a: 1 })',
      'db.users.aggregate([{ "\\u0024out": "copy" }])',
      "db.command({ drop: 'users' })",
      "db.users.drop\n()",
    ]) {
      assert.ok(findMongoShellWrite(query), `findMongoShellWrite: ${query}`);
      assert.equal(isWrite("mongodb", query), true, `isWrite: ${query}`);
    }
    for (const query of [
      "db.users.find({})",
      "db.out.find({})",
      "db.drop.find({})",
      "db.command({ ping: 1 })",
      "db.admin().command({ listDatabases: 1 })",
      'db.collection("users").aggregate([{ $sample: { size: 10 } }]).toArray()',
    ]) {
      assert.equal(findMongoShellWrite(query), null, `read: ${query}`);
      assert.equal(isWrite("mongodb", query), false, `isWrite: ${query}`);
    }

    // Allowed, they run.
    const inserted = (await write(
      db,
      "db.users.insertOne({ name: 'eve', n: NumberLong('5'), i: NumberInt(3), d: NumberDecimal('1.5'), u: UUID(), t: Timestamp(1, 2), lo: MinKey(), hi: MaxKey() })",
    )) as { value: { acknowledged: boolean } };
    assert.equal(inserted.value.acknowledged, true);
    await write(db, "db.users.updateMany({ name: 'eve' }, { $set: { x: 1 } })");
    assert.equal(
      await db.collection("users").countDocuments({ name: "eve", x: 1 }),
      1,
    );
    await write(db, "db.users.createIndex({ name: 1 })");
    await write(db, "db.users.aggregate([{ $out: 'copy' }])");
    assert.equal(await db.collection("copy").countDocuments(), 4);
    await write(db, "db.copy.drop()");
    await write(db, "db.users.remove({ name: 'eve' })");
    assert.equal(await db.collection("users").countDocuments(), 3);
    // A rejected un-awaited write still fails the query (tracked promises).
    await assert.rejects(
      write(
        db,
        'db.users.insertOne({ _id: ObjectId("' +
          anaId.toHexString() +
          '") }); db.users.find({})',
      ),
      /duplicate key/,
    );

    // ── Row cap ──────────────────────────────────────────────────────
    const capped = await read(db, "db.big.find({})", 10);
    assert.equal((capped.value as unknown[]).length, 10);
    assert.equal(capped.truncated, true);
    const cappedArray = await read(db, "db.big.find({}).toArray()", 10);
    assert.equal((cappedArray.value as unknown[]).length, 10);
    assert.equal(cappedArray.truncated, true);
    const cappedAgg = await read(db, "db.big.aggregate([])", 24);
    assert.equal(cappedAgg.truncated, true);
    const exact = await read(db, "db.big.find({})", 25);
    assert.equal((exact.value as unknown[]).length, 25);
    assert.equal(exact.truncated, false, "exactly the cap is not cut");
    const limited = await read(db, "db.big.find({}).limit(5)", 10);
    assert.equal(limited.truncated, false);
    const counted = await read(
      db,
      "const all = await db.big.find({}).toArray(); all.length",
      10,
    );
    assert.equal(counted.value, 10);
    assert.equal(counted.truncated, false, "only a cut result is marked");

    // ── Through the service: no eval, errors are results ─────────────
    const connection = {
      _id: new ObjectId(),
      name: "test",
      type: "mongodb",
      connection: { connectionString: mongo.getUri(), database: "shop" },
    } as unknown as IDatabaseConnection;
    const leaked = await databaseConnectionService.executeQuery(
      connection,
      "process.env",
    );
    assert.equal(leaked.success, false);
    assert.match(leaked.error ?? "", /process is not available/);
    assert.equal(leaked.data, undefined);
    const ok = await databaseConnectionService.executeQuery(
      connection,
      "db.users.find({}).sort({ name: 1 })",
    );
    assert.equal(ok.success, true);
    assert.deepEqual(
      (ok.data as { name: string }[]).map(u => u.name),
      ["ana", "bob", "cyd"],
    );
    const cut = await databaseConnectionService.executeQuery(
      connection,
      "db.big.find({})",
      { maxRows: 7 },
    );
    assert.equal(cut.success, true);
    assert.equal(cut.truncated, true);
    assert.equal((cut.data as unknown[]).length, 7);
    const structured = await databaseConnectionService.executeQuery(
      connection,
      { collection: "big", operation: "find", filter: {} },
      { maxRows: 7 },
    );
    assert.equal(
      (structured.data as unknown[]).length,
      8,
      "a structured find reads one row past the cap",
    );

    console.info("mongo-shell-interpreter tests passed");
  } finally {
    await client.close();
    await databaseConnectionService.closeAllConnections();
    await mongo.stop();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
