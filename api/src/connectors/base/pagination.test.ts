/**
 * Shared pagination loops (pagination.ts).
 *
 * Run: npx tsx src/connectors/base/pagination.test.ts
 */
import assert from "node:assert/strict";

import { paginateByCursor, paginateByOffset } from "./pagination";

async function testOffsetDrain() {
  const rows = Array.from({ length: 7 }, (_, i) => i);
  const requested: number[] = [];
  const batches: number[][] = [];
  const progress: number[] = [];
  let pauses = 0;
  const result = await paginateByOffset<number>({
    pageSize: 3,
    fetchPage: async offset => {
      requested.push(offset);
      const records = rows.slice(offset, offset + 3);
      return { records, hasMore: offset + 3 < rows.length };
    },
    onBatch: async batch => {
      batches.push(batch);
    },
    onProgress: n => progress.push(n),
    pause: async () => {
      pauses++;
    },
  });
  assert.deepEqual(requested, [0, 3, 6]);
  assert.deepEqual(batches, [[0, 1, 2], [3, 4, 5], [6]]);
  assert.deepEqual(progress, [3, 6, 7]);
  assert.equal(pauses, 2, "no pause after the last page");
  assert.deepEqual(result, {
    offset: 6,
    totalProcessed: 7,
    hasMore: false,
    iterations: 2,
  });
}

async function testOffsetBudgetAndResume() {
  let pauses = 0;
  const result = await paginateByOffset<string>({
    pageSize: 10,
    startOffset: 20,
    startCount: 20,
    maxIterations: 2,
    fetchPage: async () => ({ records: ["x"], hasMore: true }),
    onBatch: async () => {},
    pause: async () => {
      pauses++;
    },
  });
  assert.deepEqual(result, {
    offset: 40,
    totalProcessed: 22,
    hasMore: true,
    iterations: 2,
  });
  assert.equal(pauses, 2);
}

async function testOffsetEmptyPageNotHandedOver() {
  let batches = 0;
  const result = await paginateByOffset<string>({
    pageSize: 5,
    fetchPage: async () => ({ records: [], hasMore: false }),
    onBatch: async () => {
      batches++;
    },
    pause: async () => {},
  });
  assert.equal(batches, 0);
  assert.equal(result.totalProcessed, 0);
  assert.equal(result.hasMore, false);
}

async function testCursorDrain() {
  const pages: Record<string, { records: string[]; next: string | null }> = {
    start: { records: ["a", "b"], next: "p2" },
    p2: { records: ["c"], next: "" },
  };
  const seen: Array<string | undefined> = [];
  let pauses = 0;
  const result = await paginateByCursor<string>({
    maxIterations: 10,
    fetchPage: async cursor => {
      seen.push(cursor);
      return pages[cursor ?? "start"];
    },
    onBatch: async () => {},
    pause: async () => {
      pauses++;
    },
  });
  assert.deepEqual(seen, [undefined, "p2"]);
  assert.equal(pauses, 1);
  assert.deepEqual(result, {
    cursor: null,
    totalProcessed: 3,
    hasMore: false,
    iterations: 2,
  });
}

async function testCursorBudget() {
  const result = await paginateByCursor<string>({
    maxIterations: 2,
    startCursor: "c0",
    startCount: 5,
    fetchPage: async cursor => ({
      records: ["r"],
      next: `${cursor}+`,
    }),
    onBatch: async () => {},
    pause: async () => {},
  });
  assert.deepEqual(result, {
    cursor: "c0++",
    totalProcessed: 7,
    hasMore: true,
    iterations: 2,
  });
}

async function main() {
  await testOffsetDrain();
  await testOffsetBudgetAndResume();
  await testOffsetEmptyPageNotHandedOver();
  await testCursorDrain();
  await testCursorBudget();
  console.info("pagination tests passed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
