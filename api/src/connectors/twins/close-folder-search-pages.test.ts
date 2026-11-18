/**
 * The Close folder's Search page size (`connectors/close/search.ts`): a page
 * too large for a chunk is read again at half the size, from the same
 * cursor, down to a floor; `__page_size` lowers the page; and the walk loses
 * no row and reads none twice, in one process or chunk by chunk.
 *
 * It runs the folder's own search code against the harness's Close emulator
 * (`connectors/close/fixtures/`), whose cursor is an offset like Close's
 * (`{"skip": n}`), over the synthetic dataset. Nothing calls Close.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  FOLDER,
  freezeClock,
  searchLimits,
  startRecordingServer,
} from "../../../../connectors/close/fixtures/harness.mjs";
import { buildDataset } from "../../../../connectors/close/fixtures/dataset.mjs";

/**
 * The folder's modules, loaded at run time: they import with `.ts`
 * extensions, which the API's own typecheck does not allow.
 */
const load = (file: string) =>
  import(pathToFileURL(path.join(FOLDER, file)).href);

interface SearchState {
  pageSize?: number | null;
  [key: string]: unknown;
}
interface ReadBatch {
  records?: unknown[];
  state?: SearchState;
  hasMore?: boolean;
}
interface SearchModule {
  MIN_SEARCH_PAGE_SIZE: number;
  SEARCH_PAGE_BYTE_BUDGET: number;
  SEARCH_PAGE_SIZE: number;
  readCloseSearch: (
    ctx: unknown,
    entity: string,
    state: SearchState,
    since: Date | undefined,
  ) => AsyncGenerator<ReadBatch>;
  searchPageSize: (value: unknown) => number;
}
let search: SearchModule;
let createCloseClient: (options: {
  apiKey: string;
  baseUrl: string;
  minDelayMs: number;
}) => unknown;
let CloseCustomFieldCache: new (client: () => unknown) => unknown;

type Server = Awaited<ReturnType<typeof startRecordingServer>>;
type Row = Record<string, unknown> & { id: string };

let server: Server;
let restoreClock: () => void;

before(async () => {
  search = (await load("search.ts")) as SearchModule;
  ({ createCloseClient } = await load("client.ts"));
  ({ CloseCustomFieldCache } = await load("custom-fields.ts"));
  restoreClock = freezeClock();
  server = await startRecordingServer(buildDataset());
});

after(async () => {
  await server?.close();
  restoreClock?.();
});

let keys = 0;

/** A fresh process's context: its own client, cache and selector budget. */
function context(
  apiKey: string,
  options: { pageSize?: number; pageByteBudget?: number },
) {
  const logs: string[] = [];
  const api = createCloseClient({
    apiKey,
    baseUrl: server.url,
    minDelayMs: 0,
  });
  return {
    logs,
    ctx: {
      api,
      customFields: new CloseCustomFieldCache(() => api),
      log: (message: string) => logs.push(message),
      pause: () => Promise.resolve(),
      selectorBudget: { size: 60 },
      ...options,
    },
  };
}

/**
 * Read an entity to the end. `pagesPerChunk` cuts it into chunks the way the
 * runner does: a new process per chunk, resumed from the last state after a
 * JSON round trip.
 */
async function readAll(
  entity: string,
  options: { pageSize?: number; pageByteBudget?: number } = {},
  pagesPerChunk = Infinity,
) {
  const apiKey = `api_test_pages_${++keys}`;
  const rows: Row[] = [];
  const states: SearchState[] = [];
  const logs: string[] = [];
  let state: SearchState = {};
  for (let chunk = 0; chunk < 1000; chunk++) {
    const run = context(apiKey, options);
    let pages = 0;
    let more = false;
    for await (const batch of search.readCloseSearch(
      run.ctx,
      entity,
      state,
      undefined,
    )) {
      rows.push(...(batch.records as Row[]));
      state = JSON.parse(JSON.stringify(batch.state ?? {}));
      states.push(state);
      pages++;
      more = batch.hasMore !== false;
      if (!more || pages >= pagesPerChunk) break;
    }
    logs.push(...run.logs);
    if (!more) break;
  }
  const requests = server.requests(apiKey);
  // The window pages: sorted on two fields. Probes and by-id follow-ups
  // carry no sort, the oldest-row lookup one.
  const pages = requests
    .filter(key => key.startsWith("POST /data/search/ "))
    .map(key => JSON.parse(key.slice("POST /data/search/ ".length)))
    .filter(body => body.sort?.length === 2);
  return { rows, states, logs, requests, pages };
}

const ids = (rows: Row[]) => rows.map(row => row.id);
const duplicates = (rows: Row[]) => rows.length - new Set(ids(rows)).size;

type Page = { _limit: number; cursor?: string };

/**
 * The first shrink in a walk: the page that was dropped and its retries,
 * each smaller than the one before. Empty when nothing shrank.
 */
function firstShrink(pages: Page[]): Page[] {
  const start = pages.findIndex(
    (page, i) => i + 1 < pages.length && pages[i + 1]._limit < page._limit,
  );
  if (start < 0) return [];
  const run = [pages[start]];
  for (let i = start + 1; i < pages.length; i++) {
    if (pages[i]._limit >= run[run.length - 1]._limit) break;
    run.push(pages[i]);
  }
  return run;
}

/** Bytes of `n` lead rows: a budget that fits `n` rows and no more. */
async function bytesOfLeads(n: number) {
  const { rows } = await readAll("leads");
  return new TextEncoder().encode(JSON.stringify(rows.slice(0, n))).length;
}

void test("the budget leaves room in the 32 MiB chunk cap", () => {
  const cap = 32 * 1024 * 1024;
  // The runner ends a chunk after the page that crosses half the cap.
  assert.ok(cap / 2 + search.SEARCH_PAGE_BYTE_BUDGET <= cap * 0.75);
  assert.equal(search.SEARCH_PAGE_SIZE, 200);
  assert.equal(search.MIN_SEARCH_PAGE_SIZE, 10);
});

void test("__page_size lowers the Search page, never above 200", () => {
  assert.equal(search.searchPageSize(undefined), 200);
  assert.equal(search.searchPageSize(50), 50);
  assert.equal(search.searchPageSize(500), 200);
  assert.equal(search.searchPageSize(0), 200);
  assert.equal(search.searchPageSize("abc"), 200);
});

void test("a set page size is what Close is asked for", async () => {
  const full = await readAll("leads");
  const small = await readAll("leads", { pageSize: 50 });
  assert.deepEqual(ids(small.rows), ids(full.rows));
  assert.deepEqual([...new Set(small.pages.map(p => p._limit))], [50]);
  // A page size the caller chose is no shrink: nothing in the state.
  assert.ok(small.states.every(s => s.pageSize === undefined));
});

void test("an oversized page is read again at half the size, from the same cursor", async () => {
  const full = await readAll("leads");
  assert.equal(full.rows.length, 215);
  assert.deepEqual([...new Set(full.pages.map(p => p._limit))], [200]);

  // 30 rows fit: 200 -> 100 -> 50 -> 25.
  const budget = await bytesOfLeads(30);
  const split = await readAll("leads", { pageByteBudget: budget });

  assert.deepEqual(ids(split.rows), ids(full.rows));
  assert.equal(duplicates(split.rows), 0);
  // The 200-row page is dropped twice and read again at 100, 50 and 25.
  const shrink = firstShrink(split.pages);
  assert.deepEqual(
    shrink.map(p => p._limit),
    [200, 100, 50, 25],
  );
  // Each retry starts where the dropped page started.
  assert.equal(new Set(shrink.map(p => p.cursor ?? null)).size, 1);
  // The smaller page is kept for the rest of the walk.
  const after = split.pages.slice(split.pages.indexOf(shrink[3]));
  assert.ok(after.every(p => p._limit === 25));
  assert.equal(
    split.logs.filter(l => /over the \d+-byte page budget/.test(l)).length,
    3,
  );
  // From the shrink on, the state carries the smaller page.
  assert.equal(split.states.at(-1)?.pageSize, 25);
});

void test("chunk by chunk, a resumed walk keeps the smaller page and its cursor", async () => {
  const full = await readAll("leads");
  const budget = await bytesOfLeads(30);
  const chunked = await readAll("leads", { pageByteBudget: budget }, 1);

  assert.deepEqual(ids(chunked.rows), ids(full.rows));
  assert.equal(duplicates(chunked.rows), 0);
  // The oversized page is read once: every chunk after the shrink starts
  // at 25 from its state, and none asks for more.
  const shrink = firstShrink(chunked.pages);
  assert.deepEqual(
    shrink.map(p => p._limit),
    [200, 100, 50, 25],
  );
  const after = chunked.pages.slice(chunked.pages.indexOf(shrink[3]));
  assert.ok(after.length > 1);
  assert.ok(after.every(p => p._limit === 25));
  assert.equal(chunked.states.at(-1)?.pageSize, 25);
});

void test("the page stops shrinking at the floor and the walk still ends", async () => {
  const full = await readAll("leads");
  const floor = await readAll("leads", { pageByteBudget: 1 });

  assert.deepEqual(ids(floor.rows), ids(full.rows));
  assert.equal(duplicates(floor.rows), 0);
  const shrink = firstShrink(floor.pages);
  assert.deepEqual(
    shrink.map(p => p._limit),
    [200, 100, 50, 25, 12, search.MIN_SEARCH_PAGE_SIZE],
  );
  // At the floor a page over the budget is kept: no further shrink.
  const after = floor.pages.slice(floor.pages.indexOf(shrink[5]));
  assert.ok(after.every(p => p._limit === search.MIN_SEARCH_PAGE_SIZE));
});

void test("activities split the same way", async () => {
  // The case that broke: emails. Every window here is small, so a budget of
  // 1 byte forces the shrink on the first page and keeps it at the floor.
  const full = await readAll("activities:Email");
  const split = await readAll("activities:Email", { pageByteBudget: 1 }, 1);
  assert.equal(full.rows.length, 30);
  assert.deepEqual(ids(split.rows), ids(full.rows));
  assert.equal(duplicates(split.rows), 0);
  assert.ok(searchLimits(split.requests).includes(search.MIN_SEARCH_PAGE_SIZE));
});
