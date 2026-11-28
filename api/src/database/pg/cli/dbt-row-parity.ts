import { createHash } from "node:crypto";
import { asc, eq, getTableColumns, getTableName, sql } from "drizzle-orm";
import { stableStringify } from "../../../sync-cdc/normalization";
import { insertLogChunks } from "../../../repositories/dbt/pg.repo";
import { logLineToJson } from "../../../repositories/dbt/mapper";
import {
  DBT_RUN_MAX_LOG_LINES,
  type DbtRunLogLine,
} from "../../../repositories/dbt/types";
import { extractRows, type MakoPgDb } from "../client";
import {
  dbtProjects,
  dbtEnvPreferences,
  dbtJobs,
  dbtRuns,
  dbtRunLogs,
} from "../schema";

const dbtTables = {
  projects: dbtProjects,
  preferences: dbtEnvPreferences,
  jobs: dbtJobs,
  runs: dbtRuns,
} as const;
type Table = keyof typeof dbtTables;
type Row = Record<string, unknown>;
const digest = (value: unknown) =>
  createHash("sha256").update(stableStringify(value)).digest("hex");

async function storedLogs(db: MakoPgDb, id: string, total: number) {
  const chunks = await db
    .select()
    .from(dbtRunLogs)
    .where(eq(dbtRunLogs.runId, id))
    .orderBy(asc(dbtRunLogs.seqStart));
  const lines = chunks.flatMap(chunk => chunk.lines);
  let next = total - lines.length;
  let valid = lines.length <= DBT_RUN_MAX_LOG_LINES && next >= 0;
  for (const c of chunks) {
    if (
      !c.lines.length ||
      c.seqStart !== next ||
      c.seqEnd !== next + c.lines.length
    ) {
      valid = false;
    }
    next += c.lines.length;
  }
  return valid ? digest(lines) : "invalid log sequence";
}

export async function reconcileDbtRow(
  db: MakoPgDb,
  name: Table,
  values: Row,
  apply: boolean,
  logs?: readonly DbtRunLogLine[],
) {
  const table = dbtTables[name];
  const id = String(values.id);
  const columns = Object.entries(getTableColumns(table)).filter(
    ([key]) => key !== "backfillHash",
  );
  // Use the same complete column set for Mongo and PG. Missing optionals are
  // SQL NULL, including fields that were cleared between the two passes.
  const normalized = (row: Row) =>
    Object.fromEntries(columns.map(([key]) => [key, row[key] ?? null]));
  const expected = normalized(values);
  const expectedLogs =
    logs && digest(logs.slice(-DBT_RUN_MAX_LOG_LINES).map(logLineToJson));
  const expectedHash = digest([expected, expectedLogs ?? null]);
  const relation = sql.identifier(getTableName(table));
  const payload = Object.fromEntries(
    columns.map(([key, col]) => [col.name, expected[key]]),
  );
  payload.backfill_hash = expectedHash;
  const sourceRow = sql`jsonb_populate_record(NULL::${relation}, ${JSON.stringify(payload)}::jsonb)`;
  const colList = sql.join(
    columns
      .filter(([key]) => key !== "id")
      .map(([, col]) => sql.identifier(col.name))
      .concat(sql.identifier("backfill_hash")),
    sql`, `,
  );
  return db.transaction(
    async tx => {
      const query = tx.select().from(table).where(eq(table.id, id));
      const [row] = await (apply ? query.for("update") : query);
      let status: "inserted" | "reconciled";
      let rewriteLogs = true;
      if (!row) {
        if (!apply) return { status: "wouldInsert" } as const;
        const inserted = await tx.execute(
          sql`insert into ${relation} select * from ${sourceRow} on conflict do nothing returning id`,
        );
        if (!extractRows(inserted).length) {
          return { status: "uniqueConflict" } as const;
        }
        status = "inserted";
      } else {
        const current = normalized(row);
        if (
          current.workspaceId !== expected.workspaceId ||
          current.projectId !== expected.projectId
        ) {
          return { status: "idScopeMismatch" } as const;
        }
        const currentLogs =
          logs && (await storedLogs(tx, id, Number(current.logTotal)));
        const differentFields = columns
          .filter(
            ([key]) =>
              stableStringify(current[key]) !== stableStringify(expected[key]),
          )
          .map(([key]) => key);
        if (currentLogs !== expectedLogs) differentFields.push("retainedLogs");
        if (!differentFields.length) return { status: "existing" } as const;
        const storedHash = digest([current, currentLogs ?? null]);
        if (!row.backfillHash || row.backfillHash !== storedHash) {
          return { status: "targetChanged", differentFields } as const;
        }
        if (!apply) return { status: "wouldUpdate", differentFields } as const;
        // Only this importer sets the receipt. A PG-side edit, even at the same
        // timestamp, changes the digest and fails closed. The row lock also
        // serializes terminal writes and PG log appends against this update.
        await tx.execute(
          sql`update ${relation} set (${colList}) = (select ${colList} from ${sourceRow}) where id=${id}`,
        );
        status = "reconciled";
        rewriteLogs = currentLogs !== expectedLogs;
      }
      if (logs && rewriteLogs) {
        if (status === "reconciled") {
          await tx.delete(dbtRunLogs).where(eq(dbtRunLogs.runId, id));
        }
        await insertLogChunks(tx, id, Number(expected.logTotal), logs, {
          historical: true,
        });
      }
      const [copied] = await tx.select().from(table).where(eq(table.id, id));
      const actualLogs =
        logs && (await storedLogs(tx, id, Number(expected.logTotal)));
      if (
        !copied ||
        digest([normalized(copied), actualLogs ?? null]) !== expectedHash
      ) {
        throw new Error("dbt row or retained log verification failed");
      }
      return { status } as const;
    },
    {
      isolationLevel: "repeatable read",
      accessMode: apply ? "read write" : "read only",
    },
  );
}
