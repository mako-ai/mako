import { EventEmitter, once } from "node:events";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import {
  backfillDbt,
  dbtParityComplete,
} from "../../database/pg/cli/backfill-dbt";
import { newDualId } from "../../database/pg/id-codec";
import type { MakoPgDb } from "../../database/pg/client";
import { runPgMigrations } from "../../database/pg/migrate";
import * as schema from "../../database/pg/schema";
import {
  activateDbtStore,
  createDbtCutoverRepo,
  dbtUsesPostgres,
} from "./cutover";
import { MongoDbtRepository } from "./mongo.repo";
import {
  dbtWriterGeneration,
  generationChanged,
  withDbtWriteFence,
} from "./mongo-fence";
import { PgDbtRepository } from "./pg.repo";

// Independent backend sessions exercise the handoff lock across Cloud Run instances.
describe.skipIf(process.env.RUN_DBT_CUTOVER_INTEGRATION !== "1")(
  "dbt handoff on disposable databases",
  () => {
    let container: StartedPostgreSqlContainer;
    let replica: MongoMemoryReplSet;
    let client: ReturnType<typeof postgres>;
    let db: MakoPgDb;
    const source = () => mongoose.connection.db!;
    beforeAll(async () => {
      replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
      await mongoose.connect(replica.getUri());
      container = await new PostgreSqlContainer(
        "pgvector/pgvector:pg18-trixie",
      ).start();
      const url = container.getConnectionUri();
      client = postgres(url);
      db = drizzle(client, { schema }) as unknown as MakoPgDb;
      await runPgMigrations({ connectionString: url });
    }, 120_000);
    afterEach(async () => {
      vi.restoreAllMocks();
      await client`delete from migration_domain_state where domain='dbt'`;
      await source().collection("migration_writer_fences").deleteMany({});
    });
    afterAll(async () => {
      await client?.end();
      await mongoose.disconnect();
      await replica?.stop();
      await container?.stop();
    });
    it("routes callers queued during the final pass to the committed store", async () => {
      const gates = new EventEmitter();
      const pause = once(gates, "release");
      const scanning = once(gates, "scanning");
      const pg = new PgDbtRepository({ getDb: () => db });
      const mongo = new MongoDbtRepository();
      const next = vi.spyOn(pg, "workspaceHasProject").mockResolvedValue(true);
      const prior = vi.spyOn(mongo, "workspaceHasProject");
      const bridge = createDbtCutoverRepo(pg, mongo, () => db);
      const activate = activateDbtStore(db, source(), async () => {
        gates.emit("scanning");
        await pause;
      });
      try {
        await scanning;
        const pending = bridge.workspaceHasProject("ws");
        gates.emit("release");
        await activate;
        expect(await pending).toBe(true);
        expect(prior).not.toHaveBeenCalled();
        expect(next).toHaveBeenCalledOnce();
      } finally {
        gates.emit("release");
        await activate;
      }
    });

    it("drains a dispatched Mongo append after losing its PG backend and fences delayed dispatches", async () => {
      const ws = newDualId();
      const [user] =
        await client`insert into users (email) values ('lost-writer@example.test') returning id`;
      await client`insert into workspaces (id, name, slug, created_by) values (${ws.uuid}, 'dbt', 'dbt-cutover', ${user.id})`;
      const mongo = new MongoDbtRepository();
      const project = await mongo.createProject({
        workspaceId: ws.oid,
        name: "Lost writer",
        createdBy: user.id,
      });
      const run = await mongo.createRun({
        workspaceId: ws.oid,
        projectId: project._id,
        status: "running",
        environment: "dev",
        commands: ["build"],
        trigger: "manual",
        triggeredBy: user.id,
      });
      const writer = postgres(container.getConnectionUri(), {
        max: 1,
        connection: { application_name: "dbt-delayed-writer" },
      });
      const writerDb = drizzle(writer, { schema }) as unknown as MakoPgDb;
      const pg = new PgDbtRepository({ getDb: () => db });
      const bridge = createDbtCutoverRepo(pg, mongo, () => writerDb);
      const gates = new EventEmitter();
      const dispatched = once(gates, "dispatched");
      const release = once(gates, "release");
      const original = MongoDbtRepository.prototype.appendRunLogs;
      vi.spyOn(
        MongoDbtRepository.prototype,
        "appendRunLogs",
      ).mockImplementation(async function (this: MongoDbtRepository, ...args) {
        await original.apply(this, args);
        gates.emit("dispatched");
        await release;
      });
      const line = {
        ts: new Date(),
        level: "info",
        line: "last line before handoff",
      };
      const admittedGeneration = await dbtWriterGeneration();
      const writing = bridge.appendRunLogs(run._id, [line]).then(
        () => "ok",
        () => "lost PG",
      );
      const scan = (tx: MakoPgDb) =>
        backfillDbt(source(), tx, new Date(0), {
          apply: true,
          async onException() {
            throw new Error("Unexpected orphan");
          },
        });
      try {
        await dispatched;
        const [terminated] =
          await client`select pg_terminate_backend(pid) as killed from pg_stat_activity where application_name='dbt-delayed-writer'`;
        expect(terminated.killed).toBe(true);
        // The activator holds the PG lock and is still waiting for the Mongo
        // transaction. Its parity read must include the already-dispatched append.
        const firstActivator = activateDbtStore(db, source(), async () => {
          throw new Error("first activator lost its parity check");
        }).then(
          () => "unexpected activation",
          error => String(error),
        );
        let secondActivator: ReturnType<typeof scan> | undefined;
        try {
          await vi.waitFor(async () => {
            const [locks] =
              await client`select count(*)::int as n from pg_locks where locktype='advisory' and granted and mode='ExclusiveLock'`;
            expect(locks.n).toBeGreaterThan(0);
          });
          secondActivator = activateDbtStore(db, source(), scan);
          await vi.waitFor(async () => {
            const [locks] =
              await client`select count(*)::int as n from pg_locks where locktype='advisory' and not granted and mode='ExclusiveLock'`;
            expect(locks.n).toBe(1);
          });
          expect(await dbtUsesPostgres(db)).toBe(false);
          expect((await mongo.findRunWithLogs(run._id))?.logTotal).toBe(0);
        } finally {
          gates.emit("release");
        }
        expect(await writing).toBe("ok");
        expect(await firstActivator).toMatch(/lost its parity check/);
        expect(dbtParityComplete(await secondActivator!)).toBe(true);
        expect((await mongo.findRunWithLogs(run._id))?.logs).toEqual([line]);
        const delayed = await withDbtWriteFence(admittedGeneration, repo =>
          repo.appendRunLogs(run._id, [{ ...line, line: "too late" }]),
        );
        expect(delayed).toBe(generationChanged);
        expect((await mongo.findRunWithLogs(run._id))?.logTotal).toBe(1);
        expect(await pg.findRunWithLogs(run._id)).toMatchObject({
          logTotal: 1,
          logs: [line],
        });
        expect(await dbtUsesPostgres(db)).toBe(true);
      } finally {
        gates.emit("release");
        await writing;
        await writer.end();
      }
    }, 60_000);
  },
);
