import { createHash } from "node:crypto";
import { asc, getTableColumns, getTableName, inArray, sql } from "drizzle-orm";
import { stableStringify } from "../../../sync-cdc/normalization";
import { logLineToJson } from "../../../repositories/dbt/mapper";
import { dbtLogChunks } from "../../../repositories/dbt/pg.repo";
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
  type DbtRunLogRow,
} from "../schema";

const dbtTables = {
  projects: dbtProjects,
  preferences: dbtEnvPreferences,
  jobs: dbtJobs,
  runs: dbtRuns,
} as const;
type Table = keyof typeof dbtTables;
type Row = Record<string, unknown>;
export type DbtImportRow = { values: Row; logs?: readonly DbtRunLogLine[] };
export type DbtRowOutcome =
  | {
      status:
        | "inserted"
        | "reconciled"
        | "existing"
        | "wouldInsert"
        | "uniqueConflict"
        | "idScopeMismatch";
    }
  | { status: "wouldUpdate" | "targetChanged"; differentFields: string[] };

const digest = (value: unknown) =>
  createHash("sha256").update(stableStringify(value)).digest("hex");

function logDigest(chunks: DbtRunLogRow[], total: number) {
  const lines = chunks.flatMap(c => c.lines);
  let next = total - lines.length;
  if (lines.length > DBT_RUN_MAX_LOG_LINES || next < 0) {
    return "invalid log sequence";
  }
  for (const chunk of chunks) {
    if (
      !chunk.lines.length ||
      chunk.seqStart !== next ||
      chunk.seqEnd !== next + chunk.lines.length
    ) {
      return "invalid log sequence";
    }
    next = chunk.seqEnd;
  }
  return digest(lines);
}

async function readBatch(
  db: MakoPgDb,
  name: Table,
  ids: string[],
  lock: boolean,
) {
  const table = dbtTables[name];
  const query = db
    .select()
    .from(table)
    .where(inArray(table.id, ids))
    .orderBy(asc(table.id));
  const rows = await (lock ? query.for("update") : query);
  const chunks = new Map<string, DbtRunLogRow[]>();
  if (name === "runs" && rows.length) {
    const logs = await db
      .select()
      .from(dbtRunLogs)
      .where(
        inArray(
          dbtRunLogs.runId,
          rows.map(row => row.id),
        ),
      )
      .orderBy(asc(dbtRunLogs.runId), asc(dbtRunLogs.seqStart));
    for (const chunk of logs) {
      const group = chunks.get(chunk.runId);
      if (group) group.push(chunk);
      else chunks.set(chunk.runId, [chunk]);
    }
  }
  return new Map(
    rows.map(row => [
      row.id,
      {
        row,
        logsHash:
          "logTotal" in row
            ? logDigest(chunks.get(row.id) ?? [], row.logTotal)
            : null,
      },
    ]),
  );
}

// The caller bounds each batch by document count and source bytes. Parent
// secondary keys are reconciled in source order before their children.
export async function reconcileDbtRows(
  db: MakoPgDb,
  name: Table,
  inputs: DbtImportRow[],
  apply: boolean,
): Promise<DbtRowOutcome[]> {
  if (!inputs.length) return [];
  const table = dbtTables[name];
  const columns = Object.entries(getTableColumns(table)).filter(
    ([key]) => key !== "backfillHash",
  );
  const normalize = (row: Row) =>
    Object.fromEntries(columns.map(([key]) => [key, row[key] ?? null]));
  const expected = inputs.map(({ values, logs }) => {
    const row = normalize(values);
    const id = String(row.id);
    // Derive parity from the source window independently of PG chunk construction.
    const logsHash = logs
      ? digest(logs.slice(-DBT_RUN_MAX_LOG_LINES).map(logLineToJson))
      : null;
    const hash = digest([row, logsHash]);
    return { id, row, hash, logsHash, logs };
  });
  const relation = sql.identifier(getTableName(table));
  type Item = (typeof expected)[number];
  const records = (items: Item[]) => {
    const rows = items.map(item => ({
      ...Object.fromEntries(
        columns.map(([key, col]) => [col.name, item.row[key]]),
      ),
      backfill_hash: item.hash,
    }));
    return sql`jsonb_populate_recordset(null::${relation}, ${JSON.stringify(rows)}::jsonb)`;
  };
  return db.transaction(
    async tx => {
      const current = await readBatch(
        tx,
        name,
        expected.map(item => item.id),
        apply,
      );
      const outcomes = new Map<string, DbtRowOutcome>();
      const inserts: Item[] = [];
      const updates: Item[] = [];
      const replaceLogs = new Set<string>();
      for (const item of expected) {
        const stored = current.get(item.id);
        if (!stored) {
          if (apply) inserts.push(item);
          else outcomes.set(item.id, { status: "wouldInsert" });
          continue;
        }
        const row = normalize(stored.row);
        if (
          row.workspaceId !== item.row.workspaceId ||
          row.projectId !== item.row.projectId
        ) {
          outcomes.set(item.id, { status: "idScopeMismatch" });
          continue;
        }
        const hash = digest([row, stored.logsHash]);
        if (hash === item.hash) {
          outcomes.set(item.id, { status: "existing" });
          continue;
        }
        if (!apply || hash !== stored.row.backfillHash) {
          const differentFields = columns
            .filter(
              ([key]) =>
                stableStringify(row[key]) !== stableStringify(item.row[key]),
            )
            .map(([key]) => key);
          if (stored.logsHash !== item.logsHash) {
            differentFields.push("retainedLogs");
          }
          outcomes.set(item.id, {
            status:
              hash === stored.row.backfillHash
                ? "wouldUpdate"
                : "targetChanged",
            differentFields,
          });
          continue;
        }
        updates.push(item);
        if (stored.logsHash !== item.logsHash) replaceLogs.add(item.id);
        outcomes.set(item.id, { status: "reconciled" });
      }
      const copied: Item[] = [];
      if (inserts.length) {
        const result = await tx.execute(
          sql`insert into ${relation} select * from ${records(inserts)} on conflict do nothing returning id`,
        );
        const ids = new Set(
          extractRows<{ id: string }>(result).map(row => row.id),
        );
        for (const item of inserts) {
          outcomes.set(item.id, {
            status: ids.has(item.id) ? "inserted" : "uniqueConflict",
          });
          if (ids.has(item.id)) copied.push(item);
        }
      }
      if (updates.length) {
        const keys = [
          ...columns.filter(([key]) => key !== "id").map(([, col]) => col.name),
          "backfill_hash",
        ];
        const assignments = keys.map(
          key => sql`${sql.identifier(key)} = src.${sql.identifier(key)}`,
        );
        await tx.execute(
          sql`update ${relation} as dest set ${sql.join(assignments, sql`, `)} from ${records(updates)} as src where dest.id=src.id`,
        );
      }
      if (replaceLogs.size) {
        await tx
          .delete(dbtRunLogs)
          .where(inArray(dbtRunLogs.runId, [...replaceLogs]));
      }
      const chunks = [
        ...copied,
        ...updates.filter(item => replaceLogs.has(item.id)),
      ].flatMap(item =>
        item.logs
          ? dbtLogChunks(item.id, Number(item.row.logTotal), item.logs, {
              historical: true,
            })
          : [],
      );
      if (chunks.length) await tx.insert(dbtRunLogs).values(chunks);
      const written = [...copied, ...updates];
      if (written.length) {
        const persisted = await readBatch(
          tx,
          name,
          written.map(item => item.id),
          false,
        );
        for (const item of written) {
          const actual = persisted.get(item.id);
          if (
            !actual ||
            actual.row.backfillHash !== item.hash ||
            digest([normalize(actual.row), actual.logsHash]) !== item.hash
          ) {
            throw new Error("dbt row or retained log verification failed");
          }
        }
      }
      return expected.map(item => {
        const outcome = outcomes.get(item.id);
        if (!outcome) throw new Error("Missing dbt reconciliation outcome");
        return outcome;
      });
    },
    {
      isolationLevel: "repeatable read",
      accessMode: apply ? "read write" : "read only",
    },
  );
}
