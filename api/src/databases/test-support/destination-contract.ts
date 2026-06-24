import { describe, it, expect } from "vitest";
import { DatabaseDriver } from "../driver";

/**
 * A capability is either intentionally not implemented by a driver (callers
 * fall back to conventional-SQL defaults) or implemented with specific outputs.
 */
type Absent = { absent: true };
const isAbsent = (c: unknown): c is Absent =>
  !!c && (c as Absent).absent === true;

export interface DestinationContractExpectations {
  /** Driver type label, used for the describe block name. */
  type: string;

  /** `getStagingSchema(primary)` — staging/working dataset isolation. */
  stagingSchema:
    | Absent
    | { cases: Array<{ primary?: string; expected: string }> };

  /** `requiresSoftDeleteForCdc()` — CDC tombstone requirement. */
  softDeleteForCdc: Absent | { value: boolean };

  /** `requiresTypedColumns()` — typed-write column map requirement. */
  typedColumns: Absent | { value: boolean };

  /** `mapColumnType(source)` — source→native type mapping. */
  mapColumnType: Absent | { cases: Array<[string, string]> };

  /** `formatTableRef(schema, table, opts)` — quoted, qualified table ref. */
  formatTableRef:
    | Absent
    | {
        cases: Array<{
          schema?: string;
          table: string;
          projectId?: string;
          expected: string;
        }>;
      };

  /** `buildRowCountBatchQuery(schema, tables, opts)` — cheap row-count query. */
  rowCountBatchQuery:
    | Absent
    | {
        schema: string;
        tables: string[];
        projectId?: string;
        expected: string;
      };
}

/**
 * Shared contract every sync destination driver must satisfy. The exact outputs
 * are load-bearing: generic sync/route code (destination-writer, backfill,
 * flows) relies on them to stay engine-agnostic. A new destination opts in by
 * adding one entry to the `describe.each` in destination-contract.test.ts.
 */
export function runDestinationContract(
  driver: DatabaseDriver,
  e: DestinationContractExpectations,
): void {
  describe(`getStagingSchema`, () => {
    if (isAbsent(e.stagingSchema)) {
      it("is not implemented (callers fall back to the primary schema)", () => {
        expect(driver.getStagingSchema).toBeUndefined();
      });
      return;
    }
    for (const c of e.stagingSchema.cases) {
      it(`maps primary=${String(c.primary)} -> ${c.expected}`, () => {
        expect(driver.getStagingSchema?.(c.primary)).toBe(c.expected);
      });
    }
  });

  describe(`requiresSoftDeleteForCdc`, () => {
    if (isAbsent(e.softDeleteForCdc)) {
      it("is not implemented (defaults to hard delete)", () => {
        expect(driver.requiresSoftDeleteForCdc).toBeUndefined();
      });
      return;
    }
    it(`returns ${e.softDeleteForCdc.value}`, () => {
      expect(driver.requiresSoftDeleteForCdc?.()).toBe(
        (e.softDeleteForCdc as { value: boolean }).value,
      );
    });
  });

  describe(`requiresTypedColumns`, () => {
    if (isAbsent(e.typedColumns)) {
      it("is not implemented (defaults to untyped writes)", () => {
        expect(driver.requiresTypedColumns).toBeUndefined();
      });
      return;
    }
    it(`returns ${e.typedColumns.value}`, () => {
      expect(driver.requiresTypedColumns?.()).toBe(
        (e.typedColumns as { value: boolean }).value,
      );
    });
  });

  describe(`mapColumnType`, () => {
    if (isAbsent(e.mapColumnType)) {
      it("is not implemented (callers keep the source type)", () => {
        expect(driver.mapColumnType).toBeUndefined();
      });
      return;
    }
    for (const [input, expected] of e.mapColumnType.cases) {
      it(`maps ${input} -> ${expected}`, () => {
        expect(driver.mapColumnType?.(input)).toBe(expected);
      });
    }
  });

  describe(`formatTableRef`, () => {
    if (isAbsent(e.formatTableRef)) {
      it('is not implemented (callers use "schema"."table")', () => {
        expect(driver.formatTableRef).toBeUndefined();
      });
      return;
    }
    for (const c of e.formatTableRef.cases) {
      const opts = c.projectId ? { projectId: c.projectId } : undefined;
      it(`formats ${String(c.schema)}.${c.table} (projectId=${String(
        c.projectId,
      )}) -> ${c.expected}`, () => {
        expect(driver.formatTableRef?.(c.schema, c.table, opts)).toBe(
          c.expected,
        );
      });
    }
  });

  describe(`buildRowCountBatchQuery`, () => {
    if (isAbsent(e.rowCountBatchQuery)) {
      it("is not implemented (callers skip row counting)", () => {
        expect(driver.buildRowCountBatchQuery).toBeUndefined();
      });
      return;
    }
    const { schema, tables, projectId, expected } = e.rowCountBatchQuery;
    const opts = projectId ? { projectId } : undefined;
    it("builds the batch row-count query", () => {
      expect(driver.buildRowCountBatchQuery?.(schema, tables, opts)).toBe(
        expected,
      );
    });
    it("returns null for an empty table list", () => {
      expect(driver.buildRowCountBatchQuery?.(schema, [], opts)).toBeNull();
    });
  });
}
